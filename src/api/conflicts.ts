/**
 * Changes in conflict, found and resolved by trace itself, so a conflict never waits on a person to notice it.
 *
 * Every accepted change moves the default branch, and any open change that touched the same files falls into conflict.
 * GitHub sends nothing when that happens (it works out mergeability lazily, and says "unknown" for a few seconds after
 * the push), so a conflict used to sit until the hourly safety net, looking as if it needed a person.
 *
 *   when      hook.conflicts (src/api/actions-hooks.ts): the web backend calls it for every push to a project's
 *             default branch (src/web/hooks.ts), the moment other changes can fall into conflict. And change.resolve:
 *             a person on the project asks from the change's page ("Bring it up to date")
 *   find      findConflicts: every open, non-draft change's mergeability, read again while GitHub still says "unknown"
 *             (SETTLE_ROUNDS rounds SETTLE_MS apart); what is still unknown is reported as `checking`
 *   resolve   resolveConflicts, per change in conflict:
 *               an edit made in trace that can be made again   remade on the newest design (apply-edits.ts, its
 *                                                              one-run-per-repository lock): the pull request keeps
 *                                                              its number
 *               an edit made in trace that cannot              left: the app says to discard it and make it again
 *               (or whose remaking failed)
 *               anything else (a specialist's change, a        the worker (trace-worker.yml, workflow_dispatch) is
 *               person's branch)                               started once for all of them: it merges the default
 *                                                              branch in, never a rebase or a force-push
 *             `retry` (change.resolve): the worker is told which ones were asked for (input `retry`), so attempts it gave
 *             up on are set aside and a person's branch is not waited on. An older workflow without the input refuses it
 *             (422): it is started without, and the answer says so
 *   tell      the caller publishes the numbers (no titles, no content) as a live event; the app shows them
 */
import { ActionError, type Context } from './action-kit.js'
import { applyEdits } from './apply-edits.js'
import { editStore } from './edits.js'
import { GitHubError, type GitHubApi, type PullStatus } from './github.js'

/** The worker's workflow in a project (templates/workflows/trace-worker.yml, as `tracectl onboard` names it). */
export const WORKER_WORKFLOW = 'trace-worker.yml'
export const SETTLE_ROUNDS = 4
export const SETTLE_MS = 2_500
/** Changes looked at in one go: more than this open at once is not a project trace drives change by change. */
export const MAX_LOOKED_AT = 30

export interface ConflictReport {
  repo: string
  /** the changes in conflict with the default branch, once GitHub settled */
  conflicts: number[]
  /** edits made in trace, made again on the newest design */
  remade: number[]
  /** handed to the worker: it merges the default branch into each */
  worker: number[]
  /** edits made in trace that cannot be made again: a person discards and makes them again */
  left: number[]
  /** still "unknown" after settling: the next event looks again */
  checking: number[]
  /** what happened to the worker's start: started, started without the retry (an older workflow), or why not */
  started: 'yes' | 'without-retry' | 'not-needed' | 'unavailable' | 'failed'
}

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

/** The open changes' status, read again while GitHub still works out whether they can merge. */
export async function findConflicts(gh: GitHubApi, repo: string, o: { rounds?: number; waitMs?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<{ conflicts: PullStatus[]; checking: number[] }> {
  if (!gh.pullStatus) return { conflicts: [], checking: [] }
  const open = (await gh.openPulls(repo)).filter((p) => !p.draft).slice(0, MAX_LOOKED_AT)
  const read = async (n: number): Promise<PullStatus | null> => gh.pullStatus!(repo, n).catch(() => null)
  const now = new Map<number, PullStatus | null>()
  for (const p of open) now.set(p.number, await read(p.number))
  const rounds = o.rounds ?? SETTLE_ROUNDS
  for (let round = 1; round < rounds; round++) {
    const waiting = [...now].filter(([, s]) => s?.state === 'open' && s.mergeable === 'unknown').map(([n]) => n)
    if (!waiting.length) break
    await (o.wait ?? sleep)(o.waitMs ?? SETTLE_MS)
    for (const n of waiting) now.set(n, await read(n))
  }
  const live = [...now.values()].filter((s): s is PullStatus => s?.state === 'open')
  return { conflicts: live.filter((s) => s.mergeable === 'dirty'), checking: live.filter((s) => s.mergeable === 'unknown').map((s) => s.number) }
}

/**
 * Find the project's changes in conflict and set each one going (see the file's comment). `only`: the changes a person
 * asked about (change.resolve); absent, every one in conflict (hook.conflicts). Never throws for one change's sake: what
 * could not be done is in the report.
 */
export async function resolveConflicts(ctx: Context, repo: string, o: { only?: readonly number[]; retry?: boolean; wait?: (ms: number) => Promise<void> } = {}): Promise<ConflictReport> {
  const gh = await ctx.deps.github()
  const found = await findConflicts(gh, repo, o.wait ? { wait: o.wait } : {})
  const conflicts = o.only ? found.conflicts.filter((c) => o.only!.includes(c.number)) : found.conflicts
  const report: ConflictReport = { repo, conflicts: conflicts.map((c) => c.number), remade: [], worker: [], left: [], checking: found.checking, started: 'not-needed' }
  if (!conflicts.length) return report

  const edits = await editStore(ctx).list(repo).catch(() => [])
  const mine: number[] = []
  for (const c of conflicts) {
    const e = edits.find((x) => x.number === c.number || (x.number === null && x.branch === c.head))
    // an edit someone pushed to since is not trace's edit any more: the worker merges it like anyone's branch
    if (!e || e.commit !== c.sha) report.worker.push(c.number)
    else mine.push(c.number)
  }
  if (mine.length) {
    // through applyEdits, one run per repository at a time, so a hook.apply running beside this never makes one twice;
    // GitHub has settled by now, so it reads them as in conflict and makes each again (apply-edits.ts redo)
    const done = await applyEdits(ctx, repo).catch(() => [])
    for (const n of mine) (done.some((a) => a.number === n && a.did === 'redone') ? report.remade : report.left).push(n)
  }
  if (report.worker.length) report.started = await startWorker(gh, repo, o.retry ? report.worker : [])
  if (report.remade.length) ctx.deps.githubCache?.bust(repo)
  return report
}

/** Start the worker's pick on the default branch, naming `retry` when there are any. */
export async function startWorker(gh: GitHubApi, repo: string, retry: readonly number[]): Promise<ConflictReport['started']> {
  if (!gh.dispatchWorkflow && !gh.dispatchWorkflowWith) return 'unavailable'
  try {
    const { branch } = await gh.defaultBranch(repo)
    if (retry.length && gh.dispatchWorkflowWith) {
      try {
        await gh.dispatchWorkflowWith(repo, WORKER_WORKFLOW, branch, { retry: retry.join(',') })
        return 'yes'
      } catch (e) {
        // a project whose workflow predates the input: GitHub refuses unknown inputs (422); start it plainly
        if (!(e instanceof GitHubError && e.status === 422) || !gh.dispatchWorkflow) throw e
        await gh.dispatchWorkflow(repo, WORKER_WORKFLOW, branch)
        return 'without-retry'
      }
    }
    if (gh.dispatchWorkflow) await gh.dispatchWorkflow(repo, WORKER_WORKFLOW, branch)
    else await gh.dispatchWorkflowWith!(repo, WORKER_WORKFLOW, branch, {})
    return 'yes'
  } catch {
    return 'failed'
  }
}

/** What change.resolve tells the person, in plain words, for the one change they asked about. */
export function resolveWords(number: number, r: ConflictReport): string {
  if (r.remade.includes(number)) return 'trace made it again on the newest design. Its checks run again now, and it comes back to you when they pass.'
  if (r.left.includes(number)) throw new ActionError('This change was made in trace and cannot be made again on the newest design. Discard it and make it again.')
  if (r.worker.includes(number)) {
    switch (r.started) {
      case 'yes': return 'trace is bringing it up to date with the newest design now. Its checks run again once it has, and it comes back to you.'
      case 'without-retry': return 'trace is bringing it up to date. This project\'s workflows are older than this button: if trace gave up on it before, an admin refreshes them in Settings.'
      case 'unavailable': throw new ActionError('This installation cannot start trace\'s worker from the app yet. An admin updates the installation.')
      default: throw new ActionError('GitHub would not start trace\'s worker just now. Try again in a minute.')
    }
  }
  if (r.checking.includes(number)) return 'GitHub is still working out whether it conflicts. trace looks again by itself when it has.'
  return 'It does not conflict with the newest design any more: nothing to bring up to date.'
}
