/**
 * Who the next step waits on when it would say "trace is working" (test-esp32 log #146, #147). The journey's own next
 * step (src/core/journey.ts nextStep) reads trace's criterion as trace's work. In run 2 the Overview said "trace is
 * working on Layout" while "trace is doing (0)": the design rule check's criterion waited on two waivers, a person's,
 * and two changes waited on checks no runner would ever start. journey.get gives the step to whoever it waits on:
 *
 *   findings     nothing of trace's is queued or running, and the criterion's check found things (its evidence of kind
 *                finding, src/tools/shape/tools.ts): a person waives each, or asks trace to fix them
 *   stuck        open changes whose checks cannot start (src/api/stuck-checks.ts): an admin fixes the runner, then
 *                "Run the checks again" (changes.rerun_stuck), which trace also tries on its own
 *   checks       nothing of trace's is working, and open changes' checks are running: it waits on those checks
 *
 * Only a step that says trace is working gives way: a question, a gate, a change to review, a failure, a lost job and
 * drafting the requirements stay first. Pure.
 */
import type { JobRow } from '../core/job-index.js'
import { isLive } from '../core/job-index.js'
import { type GateView, type NextStep, STAGE_NAMES, type StageView, type StepOwner, type Viewer } from '../core/journey.js'
import { type ChangeSummary, criteriaNamed, jobRequest } from './changes.js'
import { waitedFor } from './stuck-checks.js'

type Change = Pick<ChangeSummary, 'number' | 'title' | 'stuck' | 'checks' | 'state'>

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const named = (cs: readonly Change[]): string => `${cs.length === 1 ? 'change' : 'changes'} ${list(cs.slice(0, 3).map((c) => `#${c.number}`))}${cs.length > 3 ? ` and ${cs.length - 3} more` : ''}`

/** How many of trace's jobs are doing something now: queued, or running and alive (paused and lost ones are not). */
export const workingNow = (rows: readonly JobRow[], at = Date.now() / 1000): number =>
  rows.filter((j) => j.kind !== 'sweep' && !j.parentJob && (j.state === 'queued' || (j.state === 'running' && isLive(j, at)))).length

/**
 * Whether one of trace's jobs is running on the criterion `id` now: running and alive (queued, paused and lost ones are
 * not), and its request names that criterion or none (a job that names none may be on it). Pure.
 */
export const runningOn = (rows: readonly JobRow[], id: string, at = Date.now() / 1000): boolean =>
  rows.some((j) => j.kind !== 'sweep' && !j.parentJob && j.state === 'running' && isLive(j, at) && ((named) => !named.length || named.includes(id))(criteriaNamed(jobRequest(j), j.title)))

/** The findings on the criterion `id` that a person can waive (its evidence of kind finding), while it is not met. */
export function findingsOf(gates: readonly Pick<GateView, 'criteria'>[], id: string): { text: string; findings: number } | null {
  for (const g of gates) {
    const c = g.criteria.find((x) => x.id === id)
    if (!c) continue
    if (c.status === 'met' || c.status === 'waived') return null
    const n = c.evidence.filter((e) => e.kind === 'finding').length
    return n ? { text: c.text, findings: n } : null
  }
  return null
}

export interface WaitsOn { step: NextStep; owner: StepOwner | null }

/**
 * The next step, given to whoever it waits on (above); `owner`: who the stage's step "now" belongs to instead of trace
 * (waitsOnSteps), null when it stays trace's.
 */
export function waitsOn(next: NextStep, o: { changes: readonly Change[]; working: number; gates: readonly Pick<GateView, 'criteria'>[]; viewer: Pick<Viewer, 'admin' | 'part'>; at?: number }): WaitsOn {
  const same = { step: next, owner: null }
  if (next.kind !== 'working' || !next.ref || next.ref.kind === 'action' || next.ref.kind === 'stage') return same
  const at = o.at ?? Date.now() / 1000
  const stage = next.stage ? STAGE_NAMES[next.stage] : 'the stage'
  const mine = o.viewer.admin || o.viewer.part === 'contributor'
  const stuck = o.changes.filter((c) => c.state === 'open' && c.stuck)
  const first = stuck[0]?.stuck
  const alsoStuck = first ? ` Separately, the checks of ${named(stuck)} cannot start: ${first.why}. An admin fixes that.` : ''
  const f = o.working === 0 && next.ref.kind === 'criterion' ? findingsOf(o.gates, next.ref.id) : null
  if (f) {
    const them = f.findings === 1 ? 'it' : 'them'
    return {
      owner: mine ? 'you' : 'contributors',
      step: {
        ...next, kind: 'task', belongs_to: mine ? 'you' : 'contributors', yours: mine,
        summary: `${stage}: waive the ${plural(f.findings, 'finding')} on "${f.text.replace(/\.$/, '')}", or ask trace to fix ${them}.`,
        why: `trace is not working on it now: its check found ${f.findings === 1 ? 'one thing' : `${f.findings} things`}, and only a person can waive a finding or ask for a fix.${alsoStuck}`,
        recommendation: null, button: mine ? 'See the findings' : 'Read the stage',
        after: 'Once each finding is fixed or waived, the criterion is met.',
      },
    }
  }
  if (first) {
    const oldest = stuck.map((c) => c.stuck!.since).sort()[0]!
    const admin = o.viewer.admin
    return {
      owner: admin ? 'you' : 'admins',
      step: {
        ...next, kind: 'task', belongs_to: admin ? 'you' : 'admins', yours: admin,
        summary: `Checks cannot start: ${first.why}. ${first.fix}`,
        why: `${named(stuck)[0]!.toUpperCase()}${named(stuck).slice(1)} ${stuck.length === 1 ? 'has' : 'have'} waited ${waitedFor(oldest, at)} for ${stuck.length === 1 ? 'its' : 'their'} checks. Nothing checks ${stuck.length === 1 ? 'it' : 'them'} until the runner is fixed, so ${stage} waits.`,
        recommendation: null,
        button: admin ? 'Run the checks again' : 'Read the change',
        ref: admin ? { kind: 'action', id: 'changes.rerun_stuck' } : { kind: 'change', id: String(stuck[0]!.number) },
        after: 'Once the checks run and pass, the changes are ready to review. trace tries them again on its own every 30 minutes meanwhile.',
      },
    }
  }
  const checking = o.working === 0 ? o.changes.filter((c) => c.state === 'open' && (c.checks?.running ?? 0) > 0) : []
  if (checking.length) {
    return { owner: null, step: { ...next, summary: `Waiting for the checks of ${named(checking)} to finish: no job of trace's is working on ${stage} now.` } }
  }
  return same
}

/** The stage's steps when the next step went to someone else: trace's step "now" is shown as theirs ("You · now"). */
export function waitsOnSteps<S extends Pick<StageView, 'steps'>>(stages: readonly S[], owner: StepOwner | null): S[] {
  if (!owner) return [...stages]
  return stages.map((s) => (s.steps.some((x) => x.state === 'now' && x.owner === 'trace')
    ? { ...s, steps: s.steps.map((x) => (x.state === 'now' && x.owner === 'trace' ? { ...x, owner } : x)) }
    : s))
}
