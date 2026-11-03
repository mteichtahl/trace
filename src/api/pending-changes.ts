/**
 * What is still changing in a project's design, read for the journey (docs/user-journey.md "Nothing goes to Fabricate
 * while it is changing"):
 *
 *   pendingOf            the open changes trace made, as the gates into Fabricate read them (core PendingChanges)
 *   changedRequirements  the requirements changed after the baseline and not agreed again
 *   backToDefine         takes the project back to Define for them (core returnForChange)
 *
 * journey.get and gate.sign (src/api/actions-journey.ts) and change.accept (src/api/actions-changes.ts) use them.
 */
import { type JourneyRecord, type PendingChanges, loadJourney, returnForChange } from '../core/journey.js'
import { type Context, plainly, withRecordDb, writeJourney } from './action-kit.js'
import { requirementEvidence } from './record-read.js'

/** The changes still open, as the gates into Fabricate read them (`error`: why they could not be listed). */
export function pendingOf(open: readonly { change: { number: number; title: string; verdict: string } }[], error: string | null, requirements: readonly string[] = []): PendingChanges {
  return { changes: open.map(({ change: c }) => ({ number: c.number, title: c.title, ready: c.verdict === 'ready' })), requirements, unknown: error ? error.slice(0, 200) : null }
}

/** The requirements changed after the baseline and not agreed again (empty before the baseline is signed). */
export async function changedRequirements(ctx: Context, repo: string, r: JourneyRecord): Promise<string[]> {
  if (!pastDefine(r)) return []
  return withRecordDb(ctx, repo, (db) => requirementEvidence(db, r).filter((q) => q.status === 'proposed').map((q) => q.id))
}

const pastDefine = (r: Pick<JourneyRecord, 'stages' | 'journey'>): boolean =>
  (r.stages.find((s) => s.id === r.journey.currentStage)?.ord ?? 0) > (r.stages.find((s) => s.id === 'define')?.ord ?? 0)

/** The words a return to Define gives for changed requirements. */
export const changedWords = (ids: readonly string[]): string =>
  `${ids.length === 1 ? `requirement ${ids[0]} was` : `requirements ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)} were`} changed after the requirements baseline`

/**
 * Take the project back to Define when requirements changed after the baseline (core returnForChange): the changed
 * requirements are agreed again in Requirements review, and every gate from Define on is signed again. Null when
 * nothing changed or the project is not past Define.
 */
export async function backToDefine(ctx: Context, repo: string, r: JourneyRecord, ids: readonly string[], by: string): Promise<{ record: JourneyRecord; version: number; reason: string } | null> {
  if (!ids.length || !pastDefine(r)) return null
  const reason = changedWords(ids)
  const out = await plainly(() => writeJourney(ctx, repo, (db) => {
    const back = returnForChange(db, 'define', reason, by)
    return { result: { back, record: loadJourney(db) }, changed: back !== null }
  }))
  return out.back && out.record ? { record: out.record, version: out.version, reason } : null
}

