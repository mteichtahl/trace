/**
 * The two merges GitLab's API cannot make (src/harness/gitlab-octokit.ts): one branch merged into another outside a
 * merge request (the restack's repos.merge), and a change brought up to date by merging its target in
 * (pulls.updateBranch). Done with git in the pipeline job, as the project's agents, into a branch of theirs (never the
 * protected default branch, which refuses their push anyway), with a merge commit, never a rebase or a force-push:
 * the branches above a stacked change hold its commits (docs/stacked-changes.md).
 *
 * Answers as GitHub's API does: 201 and the merge commit, 204 when there was nothing to merge, 409 on a conflict (the
 * branch is left as it was). The token reaches git only through an auth header in the process environment for that one
 * command, never a remote URL or a file.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Exec = (args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => string

const realExec: Exec = (args, o) => execFileSync('git', args, { cwd: o.cwd, env: o.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export interface GitMerge { url: string; token: string; project: string; into: string; from: string; message: string; exec?: Exec; workdir?: string }

export async function gitMerge(o: GitMerge): Promise<{ status: 201 | 204 | 409; sha: string | null }> {
  const exec = o.exec ?? realExec
  const dir = o.workdir ?? mkdtempSync(join(tmpdir(), 'trace-merge-'))
  const remote = `${o.url.replace(/\/+$/, '')}/${o.project}.git`
  // the token as an HTTP header for this process's git commands only (GitLab takes a bearer token on git over HTTPS)
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${o.token}`,
    GIT_AUTHOR_NAME: 'trace', GIT_AUTHOR_EMAIL: 'trace@noreply', GIT_COMMITTER_NAME: 'trace', GIT_COMMITTER_EMAIL: 'trace@noreply',
  }
  const git = (...args: string[]): string => exec(args, { cwd: dir, env })
  try {
    git('init', '-q')
    git('fetch', '-q', '--no-tags', remote, `+refs/heads/${o.into}:refs/remotes/o/into`, `+refs/heads/${o.from}:refs/remotes/o/from`)
    git('checkout', '-q', '-B', 'work', 'refs/remotes/o/into')
    const before = git('rev-parse', 'HEAD').trim()
    try {
      git('merge', '--no-ff', '--no-edit', '-m', o.message, 'refs/remotes/o/from')
    } catch {
      return { status: 409, sha: null }
    }
    const after = git('rev-parse', 'HEAD').trim()
    if (after === before) return { status: 204, sha: null }
    git('push', '-q', remote, `HEAD:refs/heads/${o.into}`)
    return { status: 201, sha: after }
  } finally {
    if (!o.workdir) rmSync(dir, { recursive: true, force: true })
  }
}
