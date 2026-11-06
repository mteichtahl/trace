/**
 * What is still changing in a project's design, read for the journey (docs/user-journey.md "Nothing goes to Fabricate
 * while it is changing"):
 *
 *   pendingOf            the open changes and the jobs still working, as every gate reads them (core PendingChanges)
 *   stillWorking         the agents' jobs still queued, running or paused
 *   changedRequirements  the requirements changed after the baseline and not agreed again
 *   backToDefine         takes the project back to Define for them (core returnForChange)
 *
 * journey.get and gate.sign (src/api/actions-journey.ts) and change.accept (src/api/actions-changes.ts) use them.
 */
import { type JobRow, isLive } from '../core/job-index.js'
import { type JourneyRecord, type PendingChanges, type StageId, applyChange, changeWords, loadJourney } from '../core/journey.js'
import { type Context, plainly, withRecordDb, writeJourney } from './action-kit.js'
import { requirementEvidence } from './record-read.js'

/**
 * The work still pending, as the gates read it (`error`: why the changes could not be listed): the open changes with
 * their stage, and the agents' jobs still working (`jobs`: the project's job index rows; absent when not looked at).
 */
export function pendingOf(open: readonly { change: { number: number; title: string; verdict: string; stage?: StageId | null }; content?: 'record' | 'docs' | null | undefined }[], error: string | null, requirements: readonly string[] = [], jobs?: readonly JobRow[]): PendingChanges {
  return {
    changes: open.map(({ change: c, content }) => ({ number: c.number, title: c.title, ready: c.verdict === 'ready', stage: c.stage ?? null, ...(content ? { content } : {}) })), requirements,
    ...(jobs ? { work: stillWorking(jobs) } : {}),
    unknown: error ? error.slice(0, 200) : null,
  }
}

/**
 * The agents' jobs still working on the project: queued, paused, or running and alive (a running job whose heartbeat
 * stopped is lost, not working). The weekly look for work (sweep) and a specialist's own sub-jobs are left out.
 */
export function stillWorking(jobs: readonly JobRow[], at = Date.now() / 1000): { id: string; title: string; state: string }[] {
  return jobs
    .filter((j) => j.kind !== 'sweep' && !j.parentJob && (j.state === 'queued' || j.state === 'paused' || (j.state === 'running' && isLive(j, at))))
    .map((j) => ({ id: j.handle ?? j.id, title: j.title, state: j.state }))
}

/** The requirements changed after the baseline and not agreed again (empty before the baseline is signed). */
export async function changedRequirements(ctx: Context, repo: string, r: JourneyRecord): Promise<string[]> {
  if (!pastDefine(r)) return []
  return withRecordDb(ctx, repo, (db) => requirementEvidence(db, r).filter((q) => q.status === 'proposed').map((q) => q.id))
}

/** Whether the project is past Define: a changed requirement then takes it back there. */
export const pastDefine = (r: Pick<JourneyRecord, 'stages' | 'journey'>): boolean =>
  (r.stages.find((s) => s.id === r.journey.currentStage)?.ord ?? 0) > (r.stages.find((s) => s.id === 'define')?.ord ?? 0)

/** The words a return to Define gives for changed requirements. */
export const changedWords = (ids: readonly string[]): string =>
  `${ids.length === 1 ? `requirement ${ids[0]} was` : `requirements ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)} were`} changed after the requirements baseline`

/**
 * Act on requirements changed after the baseline (core applyChange): before release the project goes back to Define,
 * after it the next revision starts there. The changed requirements are agreed again in Requirements review, and
 * every gate from Define on is signed again. Null when nothing changed or the project is not past Define. `words`:
 * what happened, for a person ("The project went back to Define").
 */
export async function backToDefine(ctx: Context, repo: string, r: JourneyRecord, ids: readonly string[], by: string): Promise<{ record: JourneyRecord; version: number; reason: string; words: string; outcome: { stage: StageId; revision: string | null } } | null> {
  if (!ids.length || !pastDefine(r)) return null
  const reason = changedWords(ids)
  const out = await plainly(() => writeJourney(ctx, repo, (db) => {
    // the requirements go with the reopen, so the stages they do not reach keep their evidence (src/api/reopen-scope.ts)
    const back = applyChange(db, 'define', reason, by, { requirements: ids })
    return { result: { back, record: loadJourney(db) }, changed: back !== null }
  }))
  return out.back && out.record ? { record: out.record, version: out.version, reason, words: changeWords(out.back), outcome: out.back } : null
}
