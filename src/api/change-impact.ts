/**
 * The impact a change request shows before a person acknowledges it (Change request, step 2 "See the impact"): the
 * stages that reopen, the gates to re-sign, the evidence that goes stale. Without it the step's acknowledgement stays
 * disabled (web/src/components/skills/form-skills.tsx), so a change request could never be submitted.
 *
 * It is the most the change can reopen, read from the journey record: on approval the project returns to the earliest
 * stage the change touches (core/skills.ts Change request), and every stage from there to the current one is done
 * again. Where the change starts follows what it changes:
 *
 *   requirement  Define (the changed requirement goes through Requirements review)
 *   block        Architect
 *   part         Capture
 *   firmware     Prove
 *
 * Only stages this project's template has count, from the earliest one up to and including the current stage. The
 * gates to re-sign are those signed among them; the stale evidence is what their met criteria cite. The agents that
 * raise the request can narrow it (a requirement about the outline leaves the schematic alone), and say so at the gate.
 * Cost and time are left out: nothing in the record estimates them yet.
 */
import { STAGE_NAMES, type JourneyRecord, type StageId } from '../core/journey.js'

export type ChangeKind = 'requirement' | 'block' | 'part' | 'firmware'

const STARTS: Readonly<Record<ChangeKind, StageId>> = { requirement: 'define', block: 'architect', part: 'capture', firmware: 'prove' }

export interface ChangeImpact { stages: string[]; gates: string[]; stale: string[]; released: boolean }

/** The impact of a change of `what` on the project as its record stands, or null when there is nothing to trace yet. */
export function changeImpact(r: JourneyRecord | null, what: unknown): ChangeImpact | null {
  if (!r || typeof what !== 'string' || !(what in STARTS)) return null
  const order = r.stages.map((s) => s.id)
  const current = order.indexOf(r.journey.currentStage)
  // the template may lack the starting stage (a firmware project has no Capture): the next one it has
  const ideal = STAGE_ORDER.indexOf(STARTS[what as ChangeKind])
  const first = order.findIndex((id) => STAGE_ORDER.indexOf(id) >= ideal)
  if (first < 0 || current < 0 || first > current) return null
  const reopened = order.slice(first, current + 1)
  const gates = r.gates.filter((g) => reopened.includes(g.stage))
  const signed = gates.filter((g) => r.signatures.some((s) => s.gate === g.id && s.supersededAt === null))
  const stale = r.criteria
    .filter((c) => c.status === 'met' && signed.some((g) => g.id === c.gate))
    .flatMap((c) => c.evidence.map((e) => e.label ?? `${e.kind} ${e.ref}`))
  const released = r.decisions.some((d) => d.kind === 'journey.snapshot' && (d.detail as { revision?: string } | null)?.revision === r.journey.revision)
  return {
    stages: reopened.map((id) => STAGE_NAMES[id]),
    gates: signed.map((g) => `${g.name} (${STAGE_NAMES[g.stage]})`),
    stale: [...new Set(stale)].slice(0, 40),
    released,
  }
}

const STAGE_ORDER: readonly StageId[] = ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup']
