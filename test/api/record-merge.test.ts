/**
 * mergeRecordOnly (src/api/record-merge.ts): a change whose only conflict is the project record, its rows apart from
 * the default branch's, is brought up to date by the API with a merge commit, no agent (test-esp32 log #191, #213).
 * Anything else is left, with the reason, for the worker.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '../../src/api/action-kit.js'
import type { GitHubApi, PullDetail } from '../../src/api/github.js'
import { RECORD, mergeRecordOnly, tracesBranch } from '../../src/api/record-merge.js'
import { openProject } from '../../src/core/store.js'

const REPO = 'acme/board'
const scratch = mkdtempSync(join(tmpdir(), 'trace-recmerge-'))
const ctx = { deps: { scratch } } as unknown as Context

/** The record's bytes at the ancestor, then on each side with `sql` run. */
function record(sql = ''): Uint8Array {
  const dir = mkdtempSync(join(scratch, 'db-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  db.exec("INSERT INTO runs (id, kind, subject, started, status, summary) VALUES ('run-base', 'kicad.erc', 'hw', 1, 'pass', 'ok')")
  if (sql) db.exec(sql)
  db.close()
  return readFileSync(join(dir, '.trace', 'project.db'))
}
const run = (id: string): string => `INSERT INTO runs (id, kind, subject, started, status, summary) VALUES ('${id}', 'render.showcase', 'hw', 2, 'pass', 'ok')`
const runsIn = (bytes: Uint8Array): string[] => {
  const p = join(mkdtempSync(join(scratch, 'out-')), 'x.db')
  writeFileSync(p, bytes)
  const db = new DatabaseSync(p, { readOnly: true })
  try { return (db.prepare('SELECT id FROM runs ORDER BY id').all() as { id: string }[]).map((r) => r.id) } finally { db.close() }
}

class FakeGit {
  head = 'claude/task-renders'
  headRepo = REPO
  /** the files each side changed since the ancestor */
  prFiles: { filename: string; status: string }[] = [{ filename: RECORD, status: 'modified' }, { filename: 'renders/a.png', status: 'added' }]
  mainFiles: { filename: string; status: string }[] = [{ filename: RECORD, status: 'modified' }, { filename: 'docs/guide.md', status: 'modified' }]
  db: Record<string, Uint8Array> = { ancestor: record(), 'sha-pr': record(run('run-renders')), 'sha-main': record(run('run-docs')) }
  moved = false
  calls: string[] = []
  blobs: string[] = []
  trees: unknown[] = []
  commits: unknown[] = []
  refs: unknown[] = []

  api(): GitHubApi {
    const detail = (): PullDetail => ({
      number: 43, title: 'Revision A renders', url: '', state: 'open', draft: false, mergeable: 'dirty', body: '', labels: [], created_at: '', updated_at: '',
      head: { ref: this.head, sha: 'sha-pr', repo: this.headRepo }, base: { ref: 'main', sha: 'sha-main' }, author: 'trace-bot',
    } as PullDetail)
    return {
      pullDetail: async () => detail(),
      branchSha: async () => 'sha-main',
      rawFile: async (_r: string, path: string, ref: string) => (path === RECORD ? this.db[ref] ?? null : null),
      request: async (method: string, path: string, body?: unknown) => {
        this.calls.push(`${method} ${path}`)
        if (path.includes('/compare/sha-main...sha-pr')) return { merge_base_commit: { sha: 'ancestor' }, files: this.prFiles }
        if (path.includes('/compare/ancestor...sha-main')) return { merge_base_commit: { sha: 'ancestor' }, files: this.mainFiles }
        if (path.includes('/git/trees/sha-pr')) return { truncated: false, tree: [{ path: 'renders/a.png', mode: '100644', type: 'blob', sha: 'blob-png' }, { path: RECORD, mode: '100644', type: 'blob', sha: 'blob-old' }] }
        if (path.endsWith('/git/commits/sha-main')) return { tree: { sha: 'tree-main' } }
        if (path.endsWith('/git/blobs')) { this.blobs.push((body as { content: string }).content); return { sha: 'blob-merged' } }
        if (path.endsWith('/git/trees')) { this.trees.push(body); return { sha: 'tree-merged' } }
        if (path.endsWith('/git/commits')) { this.commits.push(body); return { sha: 'sha-merged' } }
        if (method === 'PATCH') { if (this.moved) throw new Error('GitHub PATCH: 422'); this.refs.push({ path, body }); return {} }
        throw new Error(`unexpected ${method} ${path}`)
      },
    } as unknown as GitHubApi
  }
}

let g: FakeGit
beforeEach(() => { g = new FakeGit() })

describe('mergeRecordOnly', () => {
  it('the renders change after the docs change: the default branch merged in, the record holding both sides\' runs', async () => {
    expect(await mergeRecordOnly(ctx, g.api(), REPO, 43, 'claude/')).toEqual({ ok: true, commit: 'sha-merged' })
    expect(runsIn(Buffer.from(g.blobs[0]!, 'base64'))).toEqual(['run-base', 'run-docs', 'run-renders'])
    // the change's own files on the default branch's tree, the record merged
    expect(g.trees).toEqual([{ base_tree: 'tree-main', tree: [
      { path: 'renders/a.png', mode: '100644', type: 'blob', sha: 'blob-png' },
      { path: RECORD, mode: '100644', type: 'blob', sha: 'blob-merged' },
    ] }])
    // a merge commit (the change first), and the branch moved without force
    expect(g.commits).toEqual([expect.objectContaining({ tree: 'tree-merged', parents: ['sha-pr', 'sha-main'], message: expect.stringMatching(/^Merge main into claude\/task-renders/) })])
    expect(g.refs).toEqual([{ path: `/repos/acme/board/git/refs/heads/claude/task-renders`, body: { sha: 'sha-merged', force: false } }])
  })

  it('a file changed on both sides: nothing pushed, the reason given', async () => {
    g.mainFiles.push({ filename: 'renders/a.png', status: 'added' })
    expect(await mergeRecordOnly(ctx, g.api(), REPO, 43, 'claude/')).toEqual({ ok: false, why: 'renders/a.png changed on both sides' })
    expect(g.calls.filter((c) => !c.startsWith('GET'))).toEqual([])
  })

  it('the same row changed on both sides: nothing pushed', async () => {
    g.db['sha-pr'] = record("UPDATE runs SET summary='mine' WHERE id='run-base'")
    g.db['sha-main'] = record("UPDATE runs SET summary='theirs' WHERE id='run-base'")
    expect(await mergeRecordOnly(ctx, g.api(), REPO, 43, 'claude/')).toMatchObject({ ok: false, why: expect.stringMatching(/same rows of the record \(table runs\)/) })
    expect(g.calls.filter((c) => !c.startsWith('GET'))).toEqual([])
  })

  it('a person\'s branch, or a fork\'s, is never touched', async () => {
    g.head = 'marc/tweak'
    expect(await mergeRecordOnly(ctx, g.api(), REPO, 43, 'claude/')).toMatchObject({ ok: false, why: expect.stringMatching(/not one of trace's own/) })
    g.head = 'claude/task-renders'
    g.headRepo = 'someone/board'
    expect(await mergeRecordOnly(ctx, g.api(), REPO, 43, 'claude/')).toMatchObject({ ok: false, why: expect.stringMatching(/another repository/) })
    expect(g.calls).toEqual([])
  })

  it('the branch moved since it was read: refused, never forced', async () => {
    g.moved = true
    expect(await mergeRecordOnly(ctx, g.api(), REPO, 43, 'claude/')).toMatchObject({ ok: false, why: expect.stringMatching(/422/) })
  })

  it('trace\'s branches: the project\'s prefix, or the API\'s trace/ ones; never the default branch', () => {
    expect(tracesBranch('claude/x', 'claude/', 'main')).toBe(true)
    expect(tracesBranch('trace/release-a-1', 'claude/', 'main')).toBe(true)
    expect(tracesBranch('bot/x', 'bot/', 'main')).toBe(true)
    expect(tracesBranch('claude/', 'claude/', 'main')).toBe(false)
    expect(tracesBranch('feature/x', 'claude/', 'main')).toBe(false)
  })
})
