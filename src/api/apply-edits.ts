/**
 * Applying people's app edits (docs/stay-in-trace.md "Applying"): decision A, an admin's own edit applies once its
 * checks pass, with nobody going to GitHub to merge it.
 *
 *   applyEdits(ctx, repo)   for each recorded edit with an open pull request, read its status fresh, then:
 *     merged or closed on GitHub   the record is done (removed)
 *     head moved                   left alone: it is not trace's edit any more (editOf), so it is never applied
 *     auto and ready               merged with the head the record names, the hold label taken off, decision
 *                                  change.applied recorded, the record done
 *     behind or in conflict        made again, when it can be (redo): the branch is reset to the default branch's head
 *                                  and the edit committed again from it; the pull request keeps its number
 *     anything else                waits: the next event looks again
 *
 * What calls it: hook.apply (src/api/actions-hooks.ts), which the hooks function calls for every accepted delivery of a
 * project (a check finished, a pull request moved), and changes.list at most once every LIST_EVERY_MS per repository
 * per container (when hooks are not set up). Never a timer. One run per repository at a time per container.
 *
 * A review edit (someone who is not an admin made it) is never merged here: an admin accepts it (change.accept).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setValue, unset } from '../core/config.js'
import type { AppEdit, RedoSpec } from '../core/app-edits.js'
import { copyJourneyTables, decide, loadJourney } from '../core/journey.js'
import { type PromptWrite, writeProject } from '../prompts/store.js'
import { ActionError, type Context, PROJECT_DB_PATH, journeyStore, openProjectDb, tempDb, writeJourney } from './action-kit.js'
import { mergeMethod, projectRule } from './actions-changes.js'
import { editFacts, verdictOf } from './changes.js'
import { editStore } from './edits.js'
import type { GitHubApi, PullStatus } from './github.js'

/** changes.list looks at most this often per repository and container (the hooks are the usual way). */
export const LIST_EVERY_MS = 30_000

export interface Applied { branch: string; number: number | null; did: 'applied' | 'redone' | 'done' | 'waiting' | 'left'; why: string }

const running = new Map<string, Promise<Applied[]>>()
const lastListed = new Map<string, number>()

/** Apply what can be, once at a time per repository (a second call while one runs gets the same answer). */
export function applyEdits(ctx: Context, repo: string): Promise<Applied[]> {
  const key = repo.toLowerCase()
  const now = running.get(key)
  if (now) return now
  const p = applyAll(ctx, repo).finally(() => running.delete(key))
  running.set(key, p)
  return p
}

/** changes.list's fallback: at most once every LIST_EVERY_MS per repository; never waits, never throws. */
export function applyEditsSoon(ctx: Context, repo: string, now = Date.now()): void {
  const key = repo.toLowerCase()
  if (now - (lastListed.get(key) ?? 0) < LIST_EVERY_MS) return
  lastListed.set(key, now)
  void applyEdits(ctx, repo).catch(() => undefined)
}

async function applyAll(ctx: Context, repo: string): Promise<Applied[]> {
  const store = editStore(ctx)
  const edits = await store.list(repo)
  if (!edits.length) return []
  const gh = await ctx.deps.github()
  const out: Applied[] = []
  for (const e of edits) {
    try {
      out.push(await applyOne(ctx, gh, repo, e))
    } catch (err) {
      out.push({ branch: e.branch, number: e.number, did: 'waiting', why: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) })
    }
  }
  if (out.some((a) => a.did !== 'waiting' && a.did !== 'left')) ctx.deps.githubCache?.bust(repo)
  return out
}

/** The edit's pull request number: the record's, else the open one for its branch (the harness may have opened it). */
async function numberOf(ctx: Context, gh: GitHubApi, repo: string, e: AppEdit): Promise<number | null> {
  if (e.number) return e.number
  const open = (await gh.openPulls(repo)).find((p) => p.head === e.branch && (p.headRepo ?? '').toLowerCase() === repo.toLowerCase())
  if (!open) return null
  await editStore(ctx).put({ ...e, number: open.number })
  return open.number
}

export async function applyOne(ctx: Context, gh: GitHubApi, repo: string, e: AppEdit): Promise<Applied> {
  const store = editStore(ctx)
  const number = await numberOf(ctx, gh, repo, e)
  if (!number) return { branch: e.branch, number: null, did: 'waiting', why: 'Its pull request is not open yet.' }
  if (!gh.pullDetail || !gh.pullStatus) return { branch: e.branch, number, did: 'waiting', why: 'This installation cannot read pull requests.' }
  const pull = await gh.pullDetail(repo, number)
  if (!pull || pull.state !== 'open') {
    await store.remove(repo, e.branch)
    return { branch: e.branch, number, did: 'done', why: pull?.state === 'merged' ? 'It was merged.' : 'It was closed.' }
  }
  if (pull.head.sha !== e.commit) return { branch: e.branch, number, did: 'left', why: 'Someone pushed to its branch: it is not the edit trace made.' }
  const status = await gh.pullStatus(repo, number)
  if (!status) return { branch: e.branch, number, did: 'waiting', why: 'GitHub did not answer.' }
  const facts = editFacts({ state: status.state, draft: status.draft, mergeable: status.mergeable, checks: status.checks, ...(status.checks_denied ? { checks_denied: true } : {}) }, e.kind)
  const verdict = verdictOf(facts)
  if ((status.mergeable === 'behind' || status.mergeable === 'dirty') && e.redo) {
    await redo(ctx, gh, repo, e)
    return { branch: e.branch, number, did: 'redone', why: 'The design moved on since it was made: trace made it again on the newest design.' }
  }
  if (e.applies !== 'auto') return { branch: e.branch, number, did: 'waiting', why: 'An admin accepts it.' }
  if (verdict !== 'ready') return { branch: e.branch, number, did: 'waiting', why: `It is ${verdict}.` }
  return merge(ctx, gh, repo, e, number, status)
}

async function merge(ctx: Context, gh: GitHubApi, repo: string, e: AppEdit, number: number, status: PullStatus): Promise<Applied> {
  if (!gh.mergePull) return { branch: e.branch, number, did: 'waiting', why: 'This installation cannot merge.' }
  const method = mergeMethod(await gh.mergeMethods?.(repo).catch(() => ['squash' as const]) ?? ['squash'])
  // GitHub merges only the commit trace wrote: a push since makes it refuse
  const { sha } = await gh.mergePull(repo, number, { method, sha: e.commit })
  const rule = await projectRule(ctx, repo).catch(() => null)
  await gh.removeLabel?.(repo, number, rule?.hold ?? 'no-automerge').catch(() => false)
  await editStore(ctx).remove(repo, e.branch)
  await writeJourney(ctx, repo, (db) => {
    const r = loadJourney(db)
    if (!r) return { result: null, changed: false }
    decide(db, {
      kind: 'change.applied', stage: r.journey.currentStage, ref: String(number), by: e.by,
      summary: `trace applied ${e.title} (made in trace by ${e.by_name}) once its checks passed.`,
      detail: { number, sha, method, head: e.commit, kind: e.kind, checks: status.checks },
    })
    return { result: null }
  }).catch(() => undefined)
  return { branch: e.branch, number, did: 'applied', why: 'Its checks passed: applied.' }
}

/**
 * Make the edit again on the default branch's newest commit: the project database read from there, the edit applied
 * to it as it was the first time, the branch reset to that commit (forced: it is trace's own branch) and the database
 * committed on it. The record's commit becomes the new one.
 */
export async function redo(ctx: Context, gh: GitHubApi, repo: string, e: AppEdit): Promise<string> {
  if (!e.redo) throw new ActionError('This change cannot be made again: discard it and make it again in trace.')
  if (!gh.resetBranch) throw new ActionError('This installation cannot bring a change up to date.')
  const { branch: base, sha } = await gh.defaultBranch(repo)
  if (e.branch === base) throw new ActionError('refusing to write the default branch')
  const blob = await gh.fileSha(repo, PROJECT_DB_PATH, base)
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, base))
  try {
    await applyRedo(ctx, repo, e.redo, t.root, t.db, e.by)
    await gh.resetBranch(repo, e.branch, sha)
    const { commit } = await gh.putFile(repo, {
      path: PROJECT_DB_PATH, branch: e.branch, content: readFileSync(t.db), sha: blob,
      message: `${e.title} (made again on ${sha.slice(0, 7)})\n\nMade in trace by ${e.by}; brought up to date by trace.`,
    })
    await editStore(ctx).put({ ...e, commit })
    return commit
  } finally {
    t.cleanup()
  }
}

/** Apply one edit's change to a project database in a scratch folder (`root`, with the database at `db`). */
async function applyRedo(ctx: Context, repo: string, r: RedoSpec, root: string, db: string, by: string): Promise<void> {
  switch (r.op) {
    case 'setting':
      if (r.unset) unset(r.key, root)
      else setValue(r.key, r.value, root, by)
      return
    case 'prompt':
      writeProject(r.write as unknown as PromptWrite, root)
      return
    case 'release': {
      const bytes = await journeyStore(ctx, repo).bytes()
      if (!bytes) throw new ActionError('This project has no journey to copy.')
      const src = join(root, 'journey.db')
      writeFileSync(src, bytes)
      const d = openProjectDb(db)
      try {
        copyJourneyTables(d, src)
      } finally {
        d.close()
      }
    }
  }
}
