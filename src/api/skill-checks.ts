/**
 * The guided skills' quality bars, checked from the record (docs/user-journey.md: "The bar is checked by a tool that
 * returns pass or fail with the reasons, never by the model's opinion"). One function per check of the nineteen
 * skills (src/core/skills.ts), over what the record holds: the journey (gates, criteria, waivers, questions, orders,
 * decisions), the repository's project database (requirements, tests, runs and their reports, settings) and the
 * person's own draft of the skill.
 *
 * A check is `met`, `not_met` or `waived` (the gate criterion it rests on is waived). Where nothing in the record says
 * what a check needs, it is `not_met` with `unavailable`: what has to be recorded first. The app shows that instead of
 * guessing, and Submit waits, as it does for any check not met. Pure: tested on its own.
 */
import type { JourneyRecord, OrderRow, QuestionRow, Viewer } from '../core/journey.js'
import { signBlockers } from '../core/journey.js'
import { type SkillCheckDef, skillDef } from '../core/skills.js'
import type { Finding, TraceRequirement } from './record-read.js'

export type CheckStatus = 'met' | 'not_met' | 'waived'
export interface CheckResult { id: string; status: CheckStatus; detail?: string; unavailable?: string }

/** Everything a check may read. Absent pieces were not in the record. */
export interface CheckInput {
  r: JourneyRecord | null
  viewer: Viewer
  /** every requirement, struck ones included, with its evidence (record-read.ts) */
  requirements: (TraceRequirement & { status: string })[]
  /** the struck ones (rejected or obsolete), which requirementEvidence leaves out */
  struck: { id: string; tags: string[] }[]
  erc: { findings: Finding[]; errors: number } | null
  drc: { findings: Finding[]; errors: number } | null
  /** the latest kicad.bom run's result, kicad.board's, pcb.placement_check's status */
  bom: Record<string, unknown> | null
  board: Record<string, unknown> | null
  placement: { status: string; summary: string | null } | null
  /** settings: hil.instruments */
  instruments: { name: string; kind: string; limits?: { max_voltage_v?: number; max_current_a?: number } }[]
  /** the orders recorded (journey.orders) */
  orders: OrderRow[]
  /** a test item's method and status, for the hardware checks */
  tests: { id: string; method: string; status: string }[]
  /** the person's draft of this skill (its own shape per skill), or null */
  draft: Record<string, unknown> | null
  /** the gate Gate signing is about; the question Question answer is about */
  gate: string | null
  question: QuestionRow | null
}

const met = (id: string, detail?: string): CheckResult => ({ id, status: 'met', ...(detail ? { detail } : {}) })
const notMet = (id: string, detail: string): CheckResult => ({ id, status: 'not_met', detail })
const unavailable = (id: string, needs: string): CheckResult => ({ id, status: 'not_met', unavailable: needs })
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const VAGUE = /^(not needed|n\/?a|none|no need|unnecessary|not required|later|tbd|it depends|you decide|whatever|-+)\.?$/i
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const ids = (xs: { id: string }[], n = 5): string => `${xs.slice(0, n).map((x) => x.id).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`

/** A gate criterion of the journey, as a check: met, waived (an open waiver on it), or not met with its words. */
function criterion(input: CheckInput, id: string, criterionId: string): CheckResult {
  const c = input.r?.criteria.find((x) => x.id === criterionId)
  if (!c) return unavailable(id, `the journey has no criterion ${criterionId} (this project's template does not use it, or it has not started)`)
  if (c.status === 'met') return met(id, c.evidenceLabel ? `From ${c.evidenceLabel}.` : undefined)
  const w = input.r?.waivers.find((x) => x.targetKind === 'criterion' && x.target === c.id && x.closedAt === null)
  if (w) return { id, status: 'waived', detail: `Waived: ${w.reason}` }
  return notMet(id, `${c.text.replace(/\.$/, '')}: not met yet.`)
}

/** A rule check's findings: clean, or every blocking finding waived. */
function ruleCheck(id: string, name: string, c: { findings: Finding[]; errors: number } | null, run: string): CheckResult {
  if (!c) return notMet(id, `No ${name} is recorded yet: run ${run}.`)
  const open = c.findings.filter((f) => f.severity === 'blocks')
  if (open.length) return notMet(id, `${plural(open.length, 'error')} left: fix or waive each.`)
  const waived = c.findings.filter((f) => f.severity === 'waived' && f.waiver).length
  return waived ? { id, status: 'met', detail: `Clean, with ${plural(waived, 'finding')} waived.` } : met(id, 'Clean.')
}

/** The shared rule: a choice against trace's recommendation carries a reason (the draft's `choice`). */
function reasons(input: CheckInput): CheckResult {
  const choice = input.draft?.choice as { option?: string; recommended?: boolean; reason?: string } | undefined
  const against = input.draft?.reasonAgainst
  if (typeof against === 'string' && !against.trim() && input.draft?.against === true) return notMet('reasons', 'Say in a line why you chose against the recommendation.')
  if (choice && choice.recommended === false && str(choice.reason).length < 3) return notMet('reasons', 'Say in a line why you chose against the recommendation.')
  return met('reasons')
}

type Checker = (input: CheckInput) => CheckResult

const NO_INTENT = 'the intent statements in the record (the Intent builder does not store them yet)'
const NO_ARCH = 'an architecture record (options, criteria, scores and the block each requirement maps to); Architecture choice does not store one yet'
const NO_PINS = 'a pin plan in the record (each pin with its net and function); Pin plan review does not store one yet'
const NO_BOARDS = 'the boards received (each with its serial, photos and faults); Incoming inspection does not store them yet'

/** Every check of every skill, by `<skill>/<check>`; the shared `reasons` check is the same for all. */
export const CHECKS: Readonly<Record<string, Checker>> = {
  // ---- Design import
  'design-import/confirmed': (i) => {
    const open = i.requirements.filter((q) => q.status === 'proposed')
    if (!i.requirements.length && !i.struck.length) return notMet('confirmed', 'No requirements are recorded yet.')
    return open.length ? notMet('confirmed', `${plural(open.length, 'requirement')} still proposed: ${ids(open)}.`) : met('confirmed')
  },
  'design-import/entry': () => unavailable('entry', 'the import assessment (each gate\'s criteria run against the imported design) in the record'),
  'design-import/earlier': (i) => {
    if (!i.r) return notMet('earlier', 'The project has no journey yet.')
    const cur = i.r.stages.find((s) => s.id === i.r?.journey.currentStage)?.ord ?? 0
    const before = i.r.gates.filter((g) => (i.r?.stages.find((s) => s.id === g.stage)?.ord ?? 0) < cur)
    const unsigned = before.filter((g) => !i.r?.signatures.some((s) => s.gate === g.id && s.supersededAt === null))
    return unsigned.length ? notMet('earlier', `${plural(unsigned.length, 'earlier gate')} not signed: ${unsigned.map((g) => g.name).join(', ')}.`) : met('earlier')
  },

  // ---- Intent builder: the record keeps no intent yet
  'intent-builder/answered': () => unavailable('answered', NO_INTENT),
  'intent-builder/quantities': () => unavailable('quantities', NO_INTENT),
  'intent-builder/vague': () => unavailable('vague', NO_INTENT),
  'intent-builder/interfaces': () => unavailable('interfaces', NO_INTENT),
  'intent-builder/conflicts': () => unavailable('conflicts', NO_INTENT),
  'intent-builder/testable': () => unavailable('testable', NO_INTENT),
  'intent-builder/owners': () => unavailable('owners', NO_INTENT),

  // ---- Requirements review
  'requirements-review/criterion': (i) => {
    if (!i.requirements.length) return notMet('criterion', 'No requirements are recorded yet.')
    // decided: accepted (or struck, not listed here), or an open question names it
    const asked = (id: string): boolean => Boolean(i.r?.questions.some((q) => q.answeredAt === null && q.text.includes(id)))
    const undecided = i.requirements.filter((q) => q.status !== 'accepted' && !asked(q.id))
    if (undecided.length) return notMet('criterion', `${plural(undecided.length, 'requirement')} neither accepted nor under an open question: ${ids(undecided)}.`)
    const vague = i.requirements.filter((q) => q.status === 'accepted' && !/\d/.test(q.acceptance ?? ''))
    return vague.length ? notMet('criterion', `${plural(vague.length, 'accepted requirement')} without a criterion with a number: ${ids(vague)}.`) : met('criterion')
  },
  'requirements-review/conflicts': (i) => {
    const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const seen = new Map<string, string>()
    const dups: string[] = []
    for (const q of i.requirements) { const k = norm(q.text); const o = seen.get(k); if (o) dups.push(`${o} and ${q.id}`); else seen.set(k, q.id) }
    if (dups.length) return notMet('conflicts', `Duplicates: ${dups.slice(0, 5).join('; ')}.`)
    return unavailable('conflicts', 'a conflict check between requirements (duplicates are checked and there are none; no tool checks that two requirements can both hold)')
  },
  'requirements-review/sources': (i) => {
    const none = i.requirements.filter((q) => !q.source)
    return !i.requirements.length ? notMet('sources', 'No requirements are recorded yet.') : none.length ? notMet('sources', `${plural(none.length, 'requirement')} without a source: ${ids(none)}.`) : met('sources')
  },
  'requirements-review/covered': () => unavailable('covered', NO_INTENT),
  'requirements-review/struck': () => unavailable('struck', 'a reason stored with each struck requirement (the requirements table has no place for it yet)'),

  // ---- Architecture choice
  'architecture-choice/two': () => unavailable('two', NO_ARCH),
  'architecture-choice/fixed': () => unavailable('fixed', NO_ARCH),
  'architecture-choice/scored': () => unavailable('scored', NO_ARCH),
  'architecture-choice/mapped': (i) => criterion(i, 'mapped', 'architect.mapped'),
  'architecture-choice/stock': (i) => criterion(i, 'stock', 'architect.stock'),

  // ---- Schematic finish
  'schematic-finish/notes': () => unavailable('notes', 'trace\'s draft notes on the sheets in the record; the drafting agent does not store them yet'),
  'schematic-finish/changes': () => unavailable('changes', 'the difference between trace\'s draft and the pushed schematic, with a reason per change; no tool records it yet'),
  'schematic-finish/erc': (i) => ruleCheck('erc', 'electrical rule check', i.erc, 'kicad.erc on the latest push'),
  'schematic-finish/datasheet': (i) => criterion(i, 'datasheet', 'capture.datasheets'),
  'schematic-finish/mpn': (i) => {
    if (!i.bom) return notMet('mpn', 'No parts list check is recorded yet: run kicad.bom with jlc.')
    const missing = Number(i.bom.missing_part_number ?? 0)
    const lcsc = i.bom.lines_without_lcsc
    if (missing) return notMet('mpn', `${plural(missing, 'part')} without a part number.`)
    if (lcsc === undefined) return notMet('mpn', 'The last parts list check did not look at LCSC codes: run kicad.bom with jlc.')
    return Number(lcsc) ? notMet('mpn', `${plural(Number(lcsc), 'line')} without an LCSC code.`) : met('mpn')
  },
  'schematic-finish/serves': () => unavailable('serves', 'which requirements each sheet serves, in the record; the architecture record does not exist yet'),

  // ---- Pin plan review
  'pin-plan-review/functions': () => unavailable('functions', NO_PINS),
  'pin-plan-review/instances': (i) => (i.r?.criteria.some((c) => c.id === 'capture.alternates') ? criterion(i, 'instances', 'capture.alternates') : unavailable('instances', NO_PINS)),
  'pin-plan-review/boot': () => unavailable('boot', NO_PINS),
  'pin-plan-review/match': () => unavailable('match', NO_PINS),

  // ---- Waiver: the draft's own fields
  'waiver/what': (i) => (str(i.draft?.what) && (i.draft?.what !== 'other' || str(i.draft?.custom)) ? met('what') : notMet('what', 'Name what is waived.')),
  'waiver/reason': (i) => { const r = str(i.draft?.reason); return r.length >= 10 && !VAGUE.test(r) ? met('reason') : notMet('reason', 'Give the reason it cannot or need not be met now; "not needed" alone is not enough.') },
  'waiver/risk': (i) => (str(i.draft?.risk).length >= 5 && str(i.draft?.severity) ? met('risk') : notMet('risk', 'Say what goes wrong if the reason is mistaken, and how bad it would be.')),
  'waiver/safety': (i) => {
    const caught = str(i.draft?.caught)
    if (i.draft?.severity !== 'safety') return caught ? met('safety') : notMet('safety', 'Say where it is caught instead, or that it is accepted for good.')
    return caught && caught !== 'nowhere' && str(i.draft?.where).length >= 3 ? met('safety') : notMet('safety', 'A safety waiver must say where it is verified instead.')
  },
  'waiver/scope': (i) => (i.draft?.scope === 'revision' || (i.draft?.scope === 'condition' && str(i.draft?.condition).length >= 3) ? met('scope') : notMet('scope', 'Set the scope: this revision only, or until a named condition changes.')),

  // ---- Change request
  'change-request/reason': (i) => (str(i.draft?.what) && str(i.draft?.change).length >= 8 && str(i.draft?.why).length >= 8 ? met('reason') : notMet('reason', 'Say what changes and why.')),
  'change-request/impact': (i) => (i.draft?.acknowledged === true ? met('impact') : notMet('impact', 'Read the impact and acknowledge it.')),
  'change-request/released': (i) => {
    const rev = i.r?.journey.revision
    const released = Boolean(i.r?.decisions.some((d) => d.kind === 'journey.snapshot' && (d.detail as { revision?: string } | null)?.revision === rev))
    if (!i.draft?.revision) return notMet('released', 'Choose this revision or the next.')
    return released && i.draft.revision === 'this' ? notMet('released', `Revision ${rev} is released; the change goes into the next revision.`) : met('released')
  },

  // ---- Board setup
  'board-setup/outline': (i) => {
    const o = i.board?.outline as { width_mm?: number; height_mm?: number } | null | undefined
    if (!i.board) return notMet('outline', 'No board check is recorded yet: run kicad.board.')
    if (!o?.width_mm) return notMet('outline', 'The board has no closed outline on Edge.Cuts.')
    return unavailable('outline', `the size limits from the intent (the outline is ${o.width_mm} × ${o.height_mm} mm; the record keeps no limit to compare it with)`)
  },
  'board-setup/stackup': (i) => (!i.board ? notMet('stackup', 'No board check is recorded yet: run kicad.board.') : i.board.stackup_known ? met('stackup', 'The stackup is complete; impedance widths are not checked against targets yet.') : notMet('stackup', 'The board file has no complete stackup.')),
  'board-setup/fixed': () => unavailable('fixed', 'the fixed parts with their mechanical reasons, in the record; Board setup does not store them yet'),
  'board-setup/rules': () => unavailable('rules', 'the fab\'s capabilities in the record, to compare the board\'s design rules with'),

  // ---- Placement adjust
  'placement-adjust/moves': () => unavailable('moves', 'the parts moved since trace placed them, with a reason each; no tool records the moves yet'),
  'placement-adjust/check': (i) => (!i.placement ? notMet('check', 'No placement check is recorded yet: run pcb.placement_check.') : i.placement.status === 'pass' ? met('check') : notMet('check', i.placement.summary ?? 'The last placement check did not pass.')),
  'placement-adjust/fixed': () => unavailable('fixed', 'the fixed parts and where they must stay, in the record'),
  'placement-adjust/locked': () => unavailable('locked', 'which parts the router must not move, read from the board; no tool reports locks yet'),

  // ---- Gate signing: what still stops this person signing the gate (signBlockers)
  'gate-signing/met': (i) => gateCheck(i, 'met', /not met or waived/),
  'gate-signing/opened': (i) => gateCheck(i, 'opened', /Open the evidence|Open \d+ waiver/),
  'gate-signing/acknowledged': (i) => gateCheck(i, 'acknowledged', /Acknowledge/),
  'gate-signing/admin': (i) => (i.viewer.admin ? met('admin') : notMet('admin', 'Only an admin can sign a gate.')),

  // ---- Release review
  'release-review/areas': () => unavailable('areas', 'the release report\'s five areas with who acknowledged each, in the record'),
  'release-review/untested': (i) => {
    const untested = i.requirements.filter((q) => q.evidence === 'untested')
    const failing = i.requirements.filter((q) => q.evidence === 'failing')
    if (!i.requirements.length) return notMet('untested', 'No requirements are recorded.')
    if (untested.length) return notMet('untested', `${plural(untested.length, 'requirement')} untested: ${ids(untested)}.`)
    return failing.length ? notMet('untested', `${plural(failing.length, 'requirement')} failing and not waived: ${ids(failing)}.`) : met('untested')
  },
  'release-review/single': () => unavailable('single', 'each part\'s sources and lifecycle from a parts check, with their acknowledgement, in the record'),
  'release-review/cost': (i) => {
    const b = i.r?.journey.build
    return b && b.unit_cost !== null ? met('cost', `${b.quantity} boards at ${b.currency} ${b.unit_cost} each.`) : notMet('cost', 'Set the expected unit cost in the project\'s build plan.')
  },

  // ---- Order submit
  'order-submit/stock': (i) => criterion(i, 'stock', 'fabricate.order.stock'),
  'order-submit/options': () => unavailable('options', 'the order sheet\'s options (from the release package), to compare what was entered with'),
  'order-submit/matching': () => unavailable('matching', 'the fab\'s matched parts list for the order; trace does not read it from the fab'),
  'order-submit/recorded': (i) => {
    const rev = i.r?.journey.revision
    const o = i.orders.find((x) => x.revision === rev && x.state !== 'cancelled')
    if (!o) return notMet('recorded', 'Record the order number, what was paid and the ship date.')
    const missing = [o.paid === null ? 'what was paid' : '', o.shipDate ? '' : 'the ship date'].filter(Boolean)
    return missing.length ? notMet('recorded', `Order ${o.number} has no ${missing.join(' or ')}.`) : met('recorded', `Order ${o.number}.`)
  },

  // ---- Incoming inspection
  'incoming-inspection/count': () => unavailable('count', NO_BOARDS),
  'incoming-inspection/faults': () => unavailable('faults', NO_BOARDS),
  'incoming-inspection/hand': () => unavailable('hand', NO_BOARDS),

  // ---- Bench setup
  'bench-setup/limits': (i) => {
    const psus = i.instruments.filter((x) => x.kind === 'psu')
    if (!psus.length) return notMet('limits', 'No power supply is set up in hil.instruments.')
    const open = psus.filter((p) => !(p.limits?.max_voltage_v && p.limits?.max_current_a))
    return open.length ? notMet('limits', `${open.map((p) => p.name).join(', ')} without both a voltage and a current limit.`) : met('limits')
  },
  'bench-setup/idn': () => unavailable('idn', 'each instrument\'s answer to its identity query, recorded on this bench (hil runs do not store it yet)'),
  'bench-setup/wired': () => unavailable('wired', 'the bench wiring (each connection with its net), in the record'),
  'bench-setup/hardware': () => unavailable('hardware', 'which machine the bench tools run on; the API cannot see the bench machine'),

  // ---- Bring-up run
  'bring-up-run/limits': () => unavailable('limits', 'each bring-up step\'s readings against its limits, in the record'),
  'bring-up-run/shorts': () => unavailable('shorts', 'the unpowered checks (resistance to ground per rail), in the record'),
  'bring-up-run/results': (i) => {
    const hw = i.tests.filter((t) => t.method === 'hil')
    if (!hw.length) return notMet('results', 'No hardware test is planned.')
    const open = hw.filter((t) => t.status === 'planned' || t.status === 'blocked')
    return open.length ? notMet('results', `${plural(open.length, 'hardware test')} without a result: ${ids(open)}.`) : met('results')
  },
  'bring-up-run/issues': () => unavailable('issues', 'each failure linked to its issue, in the record'),

  // ---- Certification run
  'certification-run/recorded': () => unavailable('recorded', 'the lab, the standard and the setups, in the record'),
  'certification-run/every': (i) => criterion(i, 'every', 'certify.lab'),
  'certification-run/report': () => unavailable('report', 'the lab\'s report stored with the record'),

  // ---- Production release
  'production-release/findings': (i) => criterion(i, 'findings', 'produce.reviews'),
  'production-release/golden': (i) => criterion(i, 'golden', 'produce.golden'),
  'production-release/stored': () => unavailable('stored', 'the production package (files, procedure, image and quote) stored together in the record'),

  // ---- Question answer: the draft against the question
  'question-answer/resolves': (i) => {
    if (!i.question) return notMet('resolves', 'There is no open question to answer.')
    const opt = str(i.draft?.option)
    const text = str(i.draft?.answer)
    return (opt && opt !== 'other') || (text.length >= 3 && !VAGUE.test(text)) ? met('resolves') : notMet('resolves', 'Choose an option or write an answer that unblocks the agent.')
  },
  'question-answer/units': (i) => {
    const opt = str(i.draft?.option)
    const text = `${str(i.draft?.value)} ${str(i.draft?.answer)}`
    const wantsNumber = /\b(how (many|much|long|fast|far)|what (is|are) the .*(range|current|voltage|value|size|rate))\b/i.test(i.question?.text ?? '')
    return (opt && opt !== 'other') || !wantsNumber || /\d/.test(text) ? met('units') : notMet('units', 'The question asks for a quantity: give a number and a unit.')
  },
  'question-answer/source': (i) => {
    const opt = str(i.draft?.option)
    const text = str(i.draft?.answer)
    return (opt && opt !== 'other') || !/\d/.test(text) || str(i.draft?.source).length >= 3 ? met('source') : notMet('source', 'Say where the number comes from.')
  },
  'question-answer/requirement': (i) => (str(i.draft?.lasts) ? met('requirement') : notMet('requirement', 'Say whether the answer is a one-off, a rule, or a requirement change.')),
}

function gateCheck(i: CheckInput, id: string, about: RegExp): CheckResult {
  if (!i.r) return notMet(id, 'The project has no journey yet.')
  if (!i.gate) return notMet(id, 'There is no gate to sign in the current stage.')
  const ack = Array.isArray(i.draft?.acknowledged) ? (i.draft.acknowledged as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const blockers = signBlockers(i.r, i.gate, { ...i.viewer, admin: true }, ack).filter((b) => about.test(b))
  return blockers.length ? notMet(id, blockers.join(' ')) : met(id)
}

/** A skill's checks, in its bar's order. Unknown skills answer null. */
export function checkSkill(skill: string, input: CheckInput): CheckResult[] | null {
  const def = skillDef(skill)
  if (!def) return null
  return def.checks.map((c: SkillCheckDef) => (c.id === 'reasons' ? reasons(input) : (CHECKS[`${skill}/${c.id}`] ?? (() => unavailable(c.id, 'a checker for this check')))(input)))
}
