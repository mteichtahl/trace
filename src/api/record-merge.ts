/**
 * A change whose only conflict with the default branch is the project record (.trace/project.db), brought up to date by
 * the API itself in seconds, with no agent job (test-esp32 log #191, #213).
 *
 * Every specialist's change records its runs in that one file, so a change cut before the one accepted just before it
 * always conflicts there: git sees two different versions of a binary file. GitHub's merge button cannot run trace's
 * merge driver (src/core/dbmerge.ts), and the update queue's merge (src/harness/db-conflict.ts) runs only after a build
 * on the default branch or on its half-hourly schedule. Until then the change waited, and a person who pressed "Bring
 * it up to date" started the worker: an agent job of minutes, to merge rows that never overlapped.
 *
 *   which      an open change from a branch of trace's own in the repository itself (worker.own_branch_prefix, or
 *              trace/ for the API's own branches); a person's branch is never touched
 *   when       the files both sides changed since their common ancestor are the record alone, and the two sides
 *              changed different rows of it (mergeRows: a row both changed is a conflict, never settled by a rule)
 *   how        the Git Data API: the record merged here, a tree on the default branch's tree with the change's own
 *              files and the merged record, a merge commit whose parents are the change and the default branch (no
 *              rebase), and the branch moved to it only if it is still where it was read (never forced)
 *   otherwise  nothing is pushed and the reason is answered: the caller hands the change to the worker as before
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { mergeRows } from '../core/dbmerge.js'
import { type Context, tempDb } from './action-kit.js'
import type { GitHubApi } from './github.js'

export const RECORD = '.trace/project.db'
/** GitHub lists at most this many files in a comparison: a side with more is not judged here. */
const MAX_FILES = 300

export type RecordMerge = { ok: true; commit: string } | { ok: false; why: string }

const Sha = z.object({ sha: z.string() }).loose()
const Compare = z.object({
  merge_base_commit: Sha,
  files: z.array(z.object({ filename: z.string(), status: z.string(), previous_filename: z.string().optional() }).loose()).default([]),
}).loose()
const Tree = z.object({
  truncated: z.boolean().default(false),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() }).loose()),
}).loose()

type Files = z.output<typeof Compare>['files']
/** Every path a side touched: a renamed file's old path too. */
const touched = (files: Files): Set<string> => new Set(files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])))
const seg = (s: string): string => s.split('/').map(encodeURIComponent).join('/')

/** Whether a branch is one trace made: its agents' (the project's prefix) or the API's own (trace/). */
export const tracesBranch = (branch: string, prefix: string, defaultBranch: string): boolean =>
  branch !== defaultBranch && [prefix || 'claude/', 'trace/'].some((p) => branch.startsWith(p) && branch.length > p.length)

/**
 * Bring change `number` up to date with its base when the record is its only conflict and the rows do not overlap (see
 * the file's comment). `prefix`: the project's own branch prefix.
 */
export async function mergeRecordOnly(ctx: Context, gh: GitHubApi, repo: string, number: number, prefix: string): Promise<RecordMerge> {
  if (!gh.request || !gh.pullDetail || !gh.rawFile) return { ok: false, why: 'this installation cannot merge the record itself' }
  const request = gh.request.bind(gh)
  try {
    const d = await gh.pullDetail(repo, number)
    if (!d || d.state !== 'open') return { ok: false, why: 'it is not open' }
    if (d.head.repo?.toLowerCase() !== repo.toLowerCase()) return { ok: false, why: 'its branch is in another repository' }
    if (!tracesBranch(d.head.ref, prefix, d.base.ref)) return { ok: false, why: 'its branch is not one of trace\'s own' }
    const base = (await gh.branchSha(repo, d.base.ref)) ?? d.base.sha
    const p = `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`

    // what each side changed since their common ancestor
    const mine = Compare.parse(await request('GET', `${p}/compare/${base}...${d.head.sha}`))
    const ancestor = mine.merge_base_commit.sha
    const theirs = Compare.parse(await request('GET', `${p}/compare/${ancestor}...${base}`))
    if (mine.files.length >= MAX_FILES || theirs.files.length >= MAX_FILES) return { ok: false, why: 'it changes more files than GitHub lists' }
    const t = touched(theirs.files)
    const both = [...touched(mine.files)].filter((f) => t.has(f))
    if (both.length !== 1 || both[0] !== RECORD) {
      const others = both.filter((f) => f !== RECORD)
      return { ok: false, why: others.length ? `${others.slice(0, 3).join(', ')} changed on both sides` : 'the record is not what conflicts' }
    }

    // the record, merged row by row
    const [ab, ob, tb] = await Promise.all([gh.rawFile(repo, RECORD, ancestor), gh.rawFile(repo, RECORD, d.head.sha), gh.rawFile(repo, RECORD, base)])
    if (!ab || !ob || !tb) return { ok: false, why: 'the record was added or removed on one side' }
    const work = tempDb(ctx.deps.scratch, ob)
    let merged: Buffer
    try {
      const [bp, tp] = [join(work.root, 'base.db'), join(work.root, 'theirs.db')]
      writeFileSync(bp, ab)
      writeFileSync(tp, tb)
      const conflicts = mergeRows(bp, work.db, tp)
      if (conflicts.length) return { ok: false, why: `both sides changed the same rows of the record (${conflicts.slice(0, 3).join(', ')})` }
      merged = readFileSync(work.db)
    } finally {
      work.cleanup()
    }

    // the change's own files, as its head has them, on the default branch's tree, with the merged record
    const head = Tree.parse(await request('GET', `${p}/git/trees/${d.head.sha}?recursive=1`))
    if (head.truncated) return { ok: false, why: 'its tree is larger than GitHub lists' }
    const at = new Map(head.tree.map((e) => [e.path, e]))
    const entries: { path: string; mode: string; type: string; sha: string | null }[] = []
    for (const f of mine.files) {
      if (f.filename === RECORD) continue
      if (f.previous_filename && f.previous_filename !== f.filename) entries.push({ path: f.previous_filename, mode: '100644', type: 'blob', sha: null })
      const e = at.get(f.filename)
      // removed on the change: a tree entry with no sha removes it
      entries.push(e ? { path: e.path, mode: e.mode, type: e.type, sha: e.sha } : { path: f.filename, mode: '100644', type: 'blob', sha: null })
    }
    const blob = Sha.parse(await request('POST', `${p}/git/blobs`, { content: merged.toString('base64'), encoding: 'base64' }))
    entries.push({ path: RECORD, mode: '100644', type: 'blob', sha: blob.sha })
    const baseTree = z.object({ tree: Sha }).loose().parse(await request('GET', `${p}/git/commits/${base}`)).tree.sha
    const tree = Sha.parse(await request('POST', `${p}/git/trees`, { base_tree: baseTree, tree: entries }))
    const message = `Merge ${d.base.ref} into ${d.head.ref} (trace: the project record merged row by row)\n\n`
      + `The change and ${d.base.ref} changed different rows of ${RECORD}, so trace merged it without an agent.`
    const commit = Sha.parse(await request('POST', `${p}/git/commits`, { message, tree: tree.sha, parents: [d.head.sha, base] }))
    // only if the branch is still where it was read: a push since is never overwritten
    await request('PATCH', `${p}/git/refs/heads/${seg(d.head.ref)}`, { sha: commit.sha, force: false })
    return { ok: true, commit: commit.sha }
  } catch (e) {
    return { ok: false, why: `GitHub: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }
  }
}
