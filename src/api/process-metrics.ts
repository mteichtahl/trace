/**
 * The process metrics the API runtime records (src/core/telemetry.ts PROCESS METRICS), at the moment a person acts:
 *
 *   wait     trace.project.wait, seconds from when trace was ready to when the person acted, by kind:
 *              question  asked → answered (question.answer, and the Question answer skill's submit: both through
 *                        answerQuestion, each recording after its write is saved, from the saved question)
 *              change    ready → accepted (change.accept): ready is when the head commit's last check finished, or when
 *                        the pull request was opened when GitHub gives no finishing time (src/api/changes.ts readySince)
 *              gate      ready → signed (gate.sign): ready is when its last criterion was met or waived, up to the
 *                        signature (src/core/process-time.ts gateReadyAt)
 *   rework   trace.project.rework, one per piece of work done twice, by cause:
 *              job_restarted     a stopped job started again as a new attempt (src/api/drafting.ts draftRequirements,
 *                                attempt 2 and up: the one start-again trace has)
 *              sent_back         "Ask for changes" on a change (change.ask)
 *              conflict_resolved and asked_again are recorded on the project's worker: a conflict work item's job
 *                                starting (src/agents/runtime/observe.ts observeJob), and an agent asking again what
 *                                an answered question already decided (src/tools/journey/tools.ts journey.ask)
 *
 * Each is recorded once, after the act is saved (a journey write re-runs on a lost race: never from inside it), with
 * the project given (the act passed its access check on it). A wait that comes out negative or absurd (a clock
 * difference, a record edited by hand) is dropped, not recorded as zero. Telemetry never fails the act.
 */
import { MAX_WAIT_S, type ReworkCause, type WaitKind, recordProcessMetric } from '../core/telemetry.js'

const seconds = (t: number | string): number => (typeof t === 'number' ? t : Date.parse(t) / 1000)

/** Seconds from `from` to `to` (epoch seconds or ISO), or null when either is unknown or the span is negative or absurd. */
export function waitedS(from: number | string | null | undefined, to: number | string | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null
  const s = seconds(to) - seconds(from)
  return Number.isFinite(s) && s >= 0 && s <= MAX_WAIT_S ? s : null
}

/** Record one wait on a person (dropped when waitedS drops it). */
export function recordWait(repo: string, kind: WaitKind, from: number | string | null | undefined, to: number | string | null | undefined): number | null {
  const s = waitedS(from, to)
  if (s === null) return null
  try { recordProcessMetric('trace.project.wait', s, { kind }, repo) } catch { /* telemetry never fails the act */ }
  return s
}

/** A question just answered: asked → answered, from the saved question. */
export const recordAnswered = (repo: string, q: { asked_at: string; answered: { at: string } | null } | null | undefined): number | null =>
  (q?.answered ? recordWait(repo, 'question', q.asked_at, q.answered.at) : null)

/** Record one piece of work done twice. */
export function recordRework(repo: string, cause: ReworkCause): void {
  try { recordProcessMetric('trace.project.rework', 1, { cause }, repo) } catch { /* telemetry never fails the act */ }
}
