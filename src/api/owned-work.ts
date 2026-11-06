/**
 * trace's own criteria with nothing working on them (test-esp32 log #161), and a person's review with nothing to review
 * yet (#33, #92). The journey's next step (src/core/journey.ts nextStep) reads a criterion trace owns as trace working on
 * it, and a criterion a person owns as the person's move, without asking whether any job is doing anything. In run 2,
 * after the last Sign-off change was accepted, the Overview said "trace is working on Sign-off: every requirement is
 * verified or waived" for 85 minutes while "trace is doing (0)": the stage's job had ended without meeting it, and
 * nothing started another. Straight after signing a gate, it said "Your move: the blocks and key parts are approved"
 * while trace was still proposing them.
 *
 *   ownedDue          trace's criterion is the next step, and nothing of trace's works on it: no job queued or
 *                     running, none queued until the project's agent is set up, no open change, and nothing started or
 *                     ended in the last STARTING_S (a job just started is not listed yet; one just ended may be opening
 *                     its change). Then:
 *                       start     nothing was started for it since the stage opened: journey.get starts its work, once
 *                       starting  trace started it a moment ago (its decision is in the record, the job not listed yet)
 *                       stopped   trace started it once already and the criterion is still not met, or the start was
 *                                 refused: the step says so, and its Start button (journey.start_work) starts it again.
 *                                 trace never starts it a second time on its own, so a criterion its agent cannot meet
 *                                 does not loop
 *   reviewWaits       a person's criterion is the next step, the same gate still has trace's work to land, and a job
 *                     started since the stage opened is queued or running (or the stage opened a moment ago and its job
 *                     is not listed yet): trace is working, and the person reviews once it is ready
 *
 * Each start is a decision (OWNED_STARTED, the same kind FOLLOW_ON logs) with the criterion as its ref; a refused start
 * is one too (OWNED_REFUSED), with the reason. Pure.
 */
import { type JobRow, indexedHandle, isLive } from '../core/job-index.js'
import { type GateView, type JourneyRecord, type NextStep, STAGE_NAMES, type StageId, type Viewer } from '../core/journey.js'
import { STARTING_S } from './drafting.js'

/** The decision a start of a stage's work for a criterion logs (FOLLOW_ON's too), with the criterion as its ref. */
export const OWNED_STARTED = 'work.started'
/** The decision a start trace tried and the jobs API refused logs, with the reason in its detail. */
export const OWNED_REFUSED = 'work.not_started'

export type OwnedState = 'start' | 'starting' | 'stopped'
export interface OwnedDue {
  state: OwnedState
  criterion: string; text: string; gate: string; stage: StageId
  /** the job the last start answered (the API's id), when the record has it */
  job: string | null
  /** stopped: why, in words ("Its work ended without meeting it.") */
  why: string | null
}

type Gates = readonly Pick<GateView, 'id' | 'criteria'>[]
type Rec = Pick<JourneyRecord, 'journey' | 'stages' | 'decisions'>

const lower = (s: string): string => s.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())

/** When the current stage opened, or opened again (seconds); 0 when the record does not say. */
export function stageSince(r: Rec): number {
  const s = r.stages.find((x) => x.id === r.journey.currentStage)
  return Math.max(s?.started ?? 0, s?.reopenedAt ?? 0)
}

/** The criterion `id` with its gate, from the gates as journey.get shows them. */
function criterionOf(gates: Gates, id: string): { gate: string; c: GateView['criteria'][number] } | null {
  for (const g of gates) {
    const c = g.criteria.find((x) => x.id === id)
    if (c) return { gate: g.id, c }
  }
  return null
}

const done = (c: Pick<GateView['criteria'][number], 'status'>): boolean => c.status === 'met' || c.status === 'waived'
/** A job of trace's own (not a sweep, not a delegated worker). */
const own = (j: JobRow): boolean => j.kind !== 'sweep' && !j.parentJob
/** When a job last did anything the index saw: queued, started, ended or updated (seconds). */
const touched = (j: JobRow): number => Math.max(j.queuedAt ?? 0, j.startedAt ?? 0, j.endedAt ?? 0, j.updatedAt)

/**
 * Whether trace's criterion, the next step, has nothing working on it, and what to do (above); null when something is
 * (or may be) working on it, or the step is not trace's criterion. `working`: how many of trace's jobs are queued or
 * running alive (waits-on.ts workingNow); `queued`: starts queued until the project's agent is set up; `changes`: open
 * changes of trace's.
 */
export function ownedDue(next: NextStep, r: Rec, o: { gates: Gates; rows: readonly JobRow[]; working: number; queued: number; changes: number; at: number }): OwnedDue | null {
  if (next.kind !== 'working' || next.ref?.kind !== 'criterion') return null
  const found = criterionOf(o.gates, next.ref.id)
  if (!found || found.c.owner !== 'trace' || done(found.c)) return null
  if (o.working > 0 || o.queued > 0 || o.changes > 0) return null
  const since = stageSince(r)
  // the stage opened a moment ago (its own job may not be listed yet), or a job started or ended a moment ago
  if (o.at - since < STARTING_S || o.rows.some((j) => own(j) && o.at - touched(j) < STARTING_S)) return null
  const id = next.ref.id
  const base = { criterion: id, text: found.c.text, gate: found.gate, stage: r.journey.currentStage }
  // the record's decisions are newest first
  const last = r.decisions.find((d) => (d.kind === OWNED_STARTED || d.kind === OWNED_REFUSED) && d.ref === id && d.at >= since)
  if (!last) return { state: 'start', ...base, job: null, why: null }
  const detail = (last.detail ?? {}) as { job?: unknown; reason?: unknown }
  const job = typeof detail.job === 'string' ? detail.job : null
  if (last.kind === OWNED_REFUSED) {
    const reason = typeof detail.reason === 'string' && detail.reason ? detail.reason.replace(/\.$/, '') : 'it did not accept the job'
    return { state: 'stopped', ...base, job, why: `trace could not start its work: ${reason}.` }
  }
  if (o.at - last.at < STARTING_S) return { state: 'starting', ...base, job, why: null }
  return { state: 'stopped', ...base, job, why: 'trace started its work once, and that work ended without meeting it.' }
}

/**
 * The next step for an owned criterion with nothing working on it (ownedDue): trace working once it started the work
 * (`started`: the agent it started, in words, and its job), or the person's Start step when it is stopped. The owner of
 * the stage's step "now" goes with it: null while trace works.
 */
export function ownedStep(next: NextStep, d: OwnedDue, viewer: Pick<Viewer, 'admin' | 'part'>, started?: { words: string; job: string | null }): { step: NextStep; stopped: boolean } {
  const stage = STAGE_NAMES[d.stage]
  if (d.state !== 'stopped') {
    const job = started?.job ?? d.job
    return {
      stopped: false,
      step: {
        ...next, kind: 'working', belongs_to: 'trace', yours: false,
        summary: `trace started work on ${stage}: ${lower(d.text)}.`,
        why: `Nothing was working on it, so trace started it${started?.words ? `: ${lower(started.words)}` : ''}. ${next.why}`,
        button: 'Watch', ...(job ? { job_id: job } : {}),
      },
    }
  }
  const mine = viewer.admin || viewer.part === 'contributor'
  const { job_id: _job, ...rest } = next
  return {
    stopped: true,
    step: {
      ...rest, kind: 'task', belongs_to: mine ? 'you' : 'contributors', yours: mine,
      summary: `trace is not working on ${stage}: ${lower(d.text)}. ${d.why ?? ''}`.trim(),
      why: `Nothing is working on it now, and ${lower(next.why)}`.replace(/\.?$/, '.'),
      recommendation: mine ? 'trace recommends starting it: its agent picks up from what the record and the default branch hold.' : null,
      button: mine ? 'Start it' : 'Read the stage',
      ref: mine ? { kind: 'action', id: 'journey.start_work' } : { kind: 'gate', id: d.gate },
      after: 'Once it is started, trace works on it, and the next step says so.',
    },
  }
}

/**
 * A person's criterion as the next step while trace's work for it is still under way (#33, #92): the same gate has a
 * criterion of trace's not met yet, and a job of trace's started since the stage opened is queued or running (or the
 * stage opened less than STARTING_S ago, its job not listed yet). The step says trace is working (`words`: what the
 * stage's work does, STAGE_WORK's), and the person's review follows. Any other step is left as it is.
 */
export function reviewWaits(next: NextStep, r: Rec, o: { gates: Gates; rows: readonly JobRow[]; repo: string; at: number; words?: string | undefined }): NextStep {
  if (next.kind !== 'task' || next.ref?.kind !== 'criterion') return next
  const found = criterionOf(o.gates, next.ref.id)
  if (!found || found.c.owner !== 'person') return next
  const gate = o.gates.find((g) => g.id === found.gate)
  if (!gate?.criteria.some((c) => c.owner === 'trace' && !done(c))) return next
  const since = stageSince(r)
  const live = o.rows.find((j) => own(j) && (j.queuedAt ?? j.startedAt ?? 0) >= since && (j.state === 'queued' || (j.state === 'running' && isLive(j, o.at))))
  if (!live && o.at - since >= STARTING_S) return next
  const stage = STAGE_NAMES[r.journey.currentStage]
  const { job_id: _job, ...rest } = next
  return {
    ...rest, kind: 'working', belongs_to: 'trace', yours: false,
    summary: `trace is working on ${stage}${o.words ? `: ${lower(o.words)}` : ''}.`,
    why: `There is nothing for you to review yet: "${found.c.text.replace(/\.$/, '')}" is yours once trace's work is ready.`,
    recommendation: null, button: 'Watch', ref: { kind: 'stage', id: r.journey.currentStage },
    after: `Then it is your move: ${lower(found.c.text)}.`,
    ...(live ? { job_id: indexedHandle(o.repo, live.session, live.id) } : {}),
  }
}
