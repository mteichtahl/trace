/**
 * A trace pull request whose only conflict with the default branch is the project database (.trace/project.db), made
 * mergeable without an agent: the default branch is merged into the PR's branch and the database is merged the way the
 * trace-db git driver merges it (src/core/dbmerge.ts), then pushed. GitHub's merge button cannot run a custom driver,
 * and every agent job adds its runs to that one file, so each merge used to leave the other open PRs in conflict.
 *
 *   which PRs   trace's own branches only (worker.own_branch_prefix), held ones too: merging the default branch
 *               into a PR never merges the PR; a person's branch is never touched
 *   when not    another file conflicts, the database merge reports a conflict (a setting both sides changed, a table
 *               whose columns differ), or the push is refused: nothing is pushed, and the PR is left for the worker
 *   how         a fresh clone in a temporary directory; the token goes in an HTTP header, never in a URL or the log;
 *               a merge commit (no rebase, no force-push)
 */
import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { merge } from '../core/dbmerge.js'

export const PROJECT_DB = '.trace/project.db'

export interface DbConflictInput {
  /** the repository to clone and push to: https://github.com/<owner>/<repo>.git, or a path (tests) */
  remote: string
  /** the PR's branch, and the branch it merges into */
  head: string
  base: string
  /** sent as an HTTP Authorization header, never put in the URL */
  token?: string | undefined
  /** git, by default the one on PATH */
  git?: string | undefined
}

export type DbConflictResult = { ok: true; commit: string } | { ok: false; why: string }

const run = promisify(execFile)

/** Merge `base` into `head`, resolving .trace/project.db with the trace-db merge, and push; or say why not. */
export async function resolveDbConflict(i: DbConflictInput): Promise<DbConflictResult> {
  const dir = mkdtempSync(join(tmpdir(), 'trace-dbmerge-'))
  const auth = i.token ? ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${i.token}`).toString('base64')}`] : []
  const git = async (args: readonly string[], o: { buffer?: boolean } = {}): Promise<{ stdout: string | Buffer }> =>
    run(i.git ?? 'git', [...auth, ...args], { cwd: dir, maxBuffer: 256 * 1024 * 1024, encoding: o.buffer ? 'buffer' : 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  try {
    await git(['init', '-q'])
    await git(['config', 'user.name', 'trace'])
    await git(['config', 'user.email', 'noreply@anthropic.com'])
    await git(['remote', 'add', 'origin', i.remote])
    await git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${i.head}:refs/remotes/origin/${i.head}`, `+refs/heads/${i.base}:refs/remotes/origin/${i.base}`])
    await git(['checkout', '-q', '-B', i.head, `origin/${i.head}`])
    try {
      await git(['merge', '--no-ff', '--no-edit', '-m', `Merge ${i.base} into ${i.head} (trace: the project database merged)`, `origin/${i.base}`])
    } catch {
      const conflicted = String((await git(['diff', '--name-only', '--diff-filter=U'])).stdout).split('\n').filter(Boolean)
      const others = conflicted.filter((f) => f !== PROJECT_DB)
      if (!conflicted.includes(PROJECT_DB) || others.length) {
        return { ok: false, why: `${others.length ? others.join(', ') : 'something other than the project database'} conflicts too: a person or the worker merges it` }
      }
      // the three sides git has for the file: the common ancestor (may be absent), ours (the PR), theirs (the base)
      const side = async (stage: number): Promise<Buffer | null> => {
        try { return (await git(['show', `:${stage}:${PROJECT_DB}`], { buffer: true })).stdout as Buffer } catch { return null }
      }
      const [b, o, t] = [await side(1), await side(2), await side(3)]
      if (!o || !t) return { ok: false, why: 'the project database was added or deleted on one side: a person merges it' }
      const work = mkdtempSync(join(tmpdir(), 'trace-dbmerge-sides-'))
      try {
        const [bp, op, tp] = ['base.db', 'ours.db', 'theirs.db'].map((n) => join(work, n)) as [string, string, string]
        writeFileSync(bp, b ?? Buffer.alloc(0))
        writeFileSync(op, o)
        writeFileSync(tp, t)
        const conflicts = merge(bp, op, tp)
        if (conflicts.length) return { ok: false, why: `the project database changed differently on both sides (${conflicts.join(', ')}): a person merges it` }
        copyFileSync(op, join(dir, PROJECT_DB))
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
      await git(['add', PROJECT_DB])
      await git(['commit', '-q', '--no-edit'])
    }
    await git(['push', '-q', 'origin', `HEAD:refs/heads/${i.head}`])
    return { ok: true, commit: String((await git(['rev-parse', 'HEAD'])).stdout).trim() }
  } catch (e) {
    // a git failure (fetch, push refused because the branch moved on): say so without the token
    const msg = (e instanceof Error ? e.message : String(e)).replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/g, 'AUTHORIZATION: ***')
    return { ok: false, why: `git: ${msg.split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 300)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
