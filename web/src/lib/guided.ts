/**
 * The guided flow's reading of a journey (docs/guided-flow.md): the current stage, its steps with their owners, which
 * step is now, "Step 3 of 5 in Capture", and the words for who does each step. The API gives a stage's steps and the
 * next step's place; an older API gives neither, so the steps are worked out here from the gate's criteria (a met
 * criterion is done, the first unmet one is now, the next is next, then the gate's signature) and the screens still
 * show where the project is.
 */
import type { ChangeDetail, ChangeSummary, ChangeVerdict, Gate, Journey, NextStep, Stage, StageStep } from './types'

/** The stage the project is in (current or reopened), with its place among the visible stages. */
export function currentStage(j: Pick<Journey, 'stages'>): { stage: Stage; index: number; total: number } | null {
  const visible = j.stages.filter((s) => !(s.optional && s.state === 'skipped'))
  const index = visible.findIndex((s) => s.state === 'current' || s.state === 'reopened')
  return index < 0 ? null : { stage: visible[index]!, index, total: visible.length }
}

/** The gate that closes a stage. */
export const gateOf = (gates: Gate[], stage: Stage): Gate | undefined => gates.find((g) => g.after === stage.id)

/**
 * A stage's steps: the API's when it gives them; otherwise from its gate's criteria and the gate itself. `admin`
 * decides whether "Sign the gate" is the reader's own step.
 */
export function stageSteps(stage: Stage, gate: Gate | undefined, o: { admin?: boolean } = {}): StageStep[] {
  if (stage.steps) return stage.steps
  const done = stage.state === 'done' || stage.state === 'skipped'
  const steps: StageStep[] = (gate?.criteria ?? []).map((c) => ({
    id: c.id, text: c.text, owner: 'contributors', ref: { kind: 'criterion', id: c.id },
    state: done || c.status === 'met' ? 'done' : c.status === 'waived' ? 'waived' : 'later',
  }))
  if (gate) steps.push({ id: `sign-${gate.id}`, text: `Sign ${gate.name}`, owner: o.admin ? 'you' : 'admins', ref: { kind: 'gate', id: gate.id }, state: gate.state === 'signed' || done ? 'done' : 'later' })
  if (done || stage.state === 'queued') return steps
  // the first step not done is now, the one after it next
  const open = steps.filter((s) => s.state === 'later')
  if (open[0]) open[0].state = 'now'
  if (open[1]) open[1].state = 'next'
  return steps
}

/** Where the now-step sits: { index (from 1), total }; null when nothing is left. */
export function stepPlace(steps: StageStep[]): { index: number; total: number } | null {
  if (!steps.length) return null
  let i = steps.findIndex((s) => s.state === 'now')
  if (i < 0) i = steps.findIndex((s) => s.state !== 'done' && s.state !== 'waived')
  return i < 0 ? null : { index: i + 1, total: steps.length }
}

/** The next step's place in its stage: the API's, else worked out from the current stage's steps. */
export function nextPlace(j: Pick<Journey, 'stages' | 'gates' | 'next'>, o: { admin?: boolean } = {}): { index: number; total: number; stage: string } | null {
  const c = currentStage(j)
  if (!c) return null
  const p = j.next.step ?? stepPlace(stageSteps(c.stage, gateOf(j.gates, c.stage), o))
  return p ? { ...p, stage: c.stage.name } : null
}

/** "Step 3 of 5 in Capture" */
export const stepWords = (p: { index: number; total: number; stage?: string } | null): string =>
  p ? `Step ${p.index} of ${p.total}${p.stage ? ` in ${p.stage}` : ''}` : ''

/** Who does a step, in words: You, trace, Priya, An admin, A contributor. */
export function ownerWord(s: Pick<StageStep, 'owner' | 'who'>): string {
  switch (s.owner) {
    case 'you': return 'You'
    case 'trace': return 'trace'
    case 'admins': return 'An admin'
    case 'contributors': return 'A contributor'
    default: return s.who ?? 'A person'
  }
}

/** The small label beside a step: "trace · done", "You · now", "trace · after you", "An admin". */
export function stepLabel(steps: StageStep[], i: number): string {
  const s = steps[i]!
  const who = ownerWord(s)
  switch (s.state) {
    case 'done': return `${who} · done`
    case 'waived': return `${who} · waived`
    case 'now': return `${who} · now`
    case 'next': {
      const now = steps.find((x) => x.state === 'now')
      return now?.owner === 'you' ? `${who} · after you` : now ? `${who} · after ${ownerWord(now).replace(/^An? /, 'the ').replace(/^You$/, 'you')}` : `${who} · next`
    }
    default: return who
  }
}

/** "4 of 6 criteria met" and the meter's fraction. */
export function gateMeter(gate: Gate | undefined, stage: Stage): { met: number; total: number; frac: number } {
  const total = gate?.criteria.length || stage.criteria.total
  const met = gate?.criteria.length ? gate.criteria.filter((c) => c.status === 'met' || c.status === 'waived').length : stage.criteria.met
  return { met, total, frac: total ? met / total : 0 }
}

// ------------------------------------------------------------------ changes

/** A change's pill: its words and tone. "For you" is a change ready to review. */
export const VERDICT_WORDS: Record<ChangeVerdict, { pill: string; tone: 'primary' | 'neutral' | 'bad' | 'warning' }> = {
  ready: { pill: 'For you', tone: 'primary' },
  checking: { pill: 'In progress', tone: 'neutral' },
  failing: { pill: 'Needs a fix', tone: 'bad' },
  conflict: { pill: 'Out of date', tone: 'warning' },
  blocked: { pill: 'Waiting', tone: 'neutral' },
}

/** The checks in a few words: "7 checks passed", "Checks running, 4 of 7 done", "1 check failing: ERC". */
export function checksWords(c: ChangeSummary['checks']): string {
  if (c === null) return 'Checks not readable'
  if (!c?.total) return 'No checks yet'
  const counted = c.total - c.skipped
  if (c.failed) return `${c.failed} ${c.failed === 1 ? 'check' : 'checks'} failing${c.failing.length ? `: ${c.failing.slice(0, 2).join(', ')}${c.failing.length > 2 ? ', …' : ''}` : ''}`
  if (c.running) return `Checks running, ${c.passed} of ${counted} done`
  return `${c.passed === counted ? (c.passed === 1 ? '1 check' : `${c.passed} checks`) : `${c.passed} of ${counted} checks`} passed`
}

/** One line under a change's title: what it waits for, in plain words. */
export function changeLine(c: ChangeSummary): string {
  if (c.checks_denied) return 'trace may not read its checks: an admin gives trace\'s GitHub token "Checks: Read-only".'
  switch (c.verdict) {
    case 'ready': return `Ready to review. ${checksWords(c.checks)}.`
    case 'checking': return `${checksWords(c.checks)}. Ready to review when the last one finishes.`
    case 'failing': return `${checksWords(c.checks)}. trace is fixing it.`
    case 'conflict': return 'The design moved on since this was made. trace will bring it up to date.'
    default: return 'Waiting on GitHub before it can be accepted.'
  }
}

/** trace's recommendation as the box says it: "trace recommends accepting." */
export function recommendationWords(r: ChangeDetail['recommendation']): string {
  switch (r.verdict) {
    case 'accept': return 'trace recommends accepting.'
    case 'ask': return 'trace recommends asking for changes.'
    case 'wait': return 'trace recommends waiting for the checks.'
    default: return 'trace has no recommendation yet.'
  }
}

/** What the decision bar can do for this person on this change, and why not. */
export type DecisionMode = 'read-only' | 'closed' | 'blocked' | 'ready'
export function decisionMode(c: Pick<ChangeDetail, 'state' | 'may_accept'>, part: 'contributor' | 'reviewer' | undefined): DecisionMode {
  if (c.state !== 'open') return 'closed'
  if (part === 'reviewer') return 'read-only'
  return c.may_accept ? 'ready' : 'blocked'
}

/** A next step about a change: its number. */
export function changeOf(n: Pick<NextStep, 'ref' | 'action'>): number | null {
  if (n.ref?.kind === 'change' && Number(n.ref.id) > 0) return Number(n.ref.id)
  const m = /\/changes\/(\d+)/.exec(n.action?.to ?? '')
  return m ? Number(m[1]) : null
}
