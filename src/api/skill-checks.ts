/**
 * The guided skills' quality bars, checked from the record (docs/user-journey.md: "The bar is checked by a tool that
 * returns pass or fail with the reasons, never by the model's opinion"). One function per check of the twenty
 * skills (src/core/skills.ts), over what the record holds: the journey (gates, criteria, waivers, questions, orders,
 * decisions), the repository's project database (requirements, tests, runs and their reports, settings) and the
 * person's own draft of the skill.
 *
 * A check is `met`, `not_met` or `waived` (the gate criterion it rests on is waived). Where nothing in the record says
 * what a check needs, it is `not_met` with `unavailable`: what has to be recorded first. The app shows that instead of
 * guessing, and Submit waits, as it does for any check not met. Pure: tested on its own.
 *
 * The design record (src/tools/design: the intent, the architecture, the pin plan, which requirements each sheet
 * serves, with people's decisions over the agents' proposals) makes the Intent builder, Requirements review's
 * coverage and struck reasons, Architecture choice, Pin plan review, Schematic finish's "every sheet names its
 * requirements" and Board setup's size limits computable. A skill's own pending decision (the choice in the person's
 * draft, the statements Submit accepts) is laid over the record first (`pending`), so the bar shows what Submit would
 * record.
 */
import type { InstrumentId, Reading } from '../core/bench.js'
import { stepOrderProblems } from '../core/bench.js'
import { type BoardRow, inspectionProblems } from '../core/boards.js'
import type { JourneyRecord, OrderRow, QuestionRow, Viewer } from '../core/journey.js'
import { signBlockers } from '../core/journey.js'
import { type SkillCheckDef, skillDef } from '../core/skills.js'
import { type DesignDecision, standing } from '../tools/design/decisions.js'
import { type DesignRows, TOPIC_NAMES, INTENT_TOPICS } from '../tools/design/db.js'
import { type PinFinding, architectureView, intentView, linksView, pinCheck } from '../tools/design/record.js'
import type { Finding, TraceRequirement } from './record-read.js'
import { staleSentence } from '../tools/mech/stale.js'

export type CheckStatus = 'met' | 'not_met' | 'waived'
export interface CheckResult { id: string; status: CheckStatus; detail?: string; unavailable?: string }

/** Everything a check may read. Absent pieces were not in the record. */
export interface CheckInput {
  r: JourneyRecord | null
  viewer: Viewer
  /** every requirement, struck ones included, with its evidence (record-read.ts) */
  requirements: (TraceRequirement & { status: string })[]
  /** the struck ones (rejected or obsolete, or struck by a person), which requirementEvidence leaves out, each with the
   * reason a person gave (null: none) */
  struck: { id: string; reason: string | null }[]
  /** the design record and people's decisions over it (null: the record could not be read) */
  design?: { rows: DesignRows; decisions: DesignDecision[] } | null
  /** the newest schematic netlist in the record (net → "<ref>.<pin>"), for the pin plan check */
  nets?: ReadonlyMap<string, readonly string[]> | null
  /** the default branch's schematic files (Schematic finish), null when not read */
  sheetFiles?: string[] | null
  erc: { findings: Finding[]; errors: number } | null
  drc: { findings: Finding[]; errors: number } | null
  /** the latest kicad.bom run's result, kicad.board's, pcb.placement_check's status */
  bom: Record<string, unknown> | null
  board: Record<string, unknown> | null
  placement: { status: string; summary: string | null } | null
  /** the latest mech.build run (Case design): its status, summary and result (process, fit, rules, warnings) */
  caseBuild?: { id: string; status: string; summary: string | null; result: Record<string, unknown> | null } | null
  /** why that build no longer stands for the default branch (src/tools/mech/stale.ts staleReasons; empty: current;
   * absent: not compared) */
  caseStale?: string[] | null
  /** settings: hil.instruments */
  instruments: { name: string; kind: string; limits?: { max_voltage_v?: number; max_current_a?: number } }[]
  /** the orders recorded (journey.orders) */
  orders: OrderRow[]
  /** a test item's method and status, for the hardware checks */
  tests: { id: string; method: string; status: string }[]
  /** the boards by serial with their inspection checks (journey: boards, board_checks) */
  boards?: BoardRow[]
  /** the parts the fab does not place (the latest kicad.fab run's hand_placed), null when no run says */
  handPlaced?: string[] | null
  /** each instrument's newest identity answer (hil.idn), from the run record and the bench's live copy */
  ids?: InstrumentId[]
  /** the bring-up readings (bringup_readings), from the run record and the bench's live copy */
  readings?: Reading[]
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
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
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

const NO_PLAN = 'No pin plan is recorded yet: the firmware track proposes it with design.pins.'

/** A check over the intent statements (with the person's pending decisions over them). */
function withIntent(i: CheckInput, id: string, fn: (v: ReturnType<typeof intentView>) => CheckResult): CheckResult {
  if (!i.design) return notMet(id, 'The design record could not be read.')
  const v = intentView(i.design.rows, i.design.decisions)
  if (!v.some((s) => s.state !== 'rejected')) return notMet(id, 'No intent statements are recorded yet: answer the topics and trace drafts them.')
  return fn(v)
}

/** Statements carrying one flag, as a check. */
function flagged(i: CheckInput, id: string, flag: Parameters<ReturnType<typeof intentView>[number]['flags']['includes']>[0], words: string, note?: string): CheckResult {
  return withIntent(i, id, (v) => {
    const open = v.filter((s) => s.state !== 'rejected' && s.flags.includes(flag))
    return open.length ? notMet(id, `${plural(open.length, 'statement')} ${words}: ${ids(open)}.`) : met(id, note)
  })
}

/** A check over the architecture record. */
function withArch(i: CheckInput, id: string, fn: (a: ReturnType<typeof architectureView> & { fixedAt: number | null; chosenAt: number | null; onlyOne: string | null }) => CheckResult): CheckResult {
  if (!i.design) return notMet(id, 'The design record could not be read.')
  const a = architectureView(i.design.rows, i.design.decisions)
  const f = standing(i.design.decisions, 'architecture.criteria').get('architecture')
  const c = standing(i.design.decisions, 'architecture.choice').get('architecture')
  return fn({ ...a, fixedAt: f?.at ?? null, chosenAt: c?.at ?? null, onlyOne: typeof c?.detail.only_one === 'string' ? c.detail.only_one : null })
}

/** The pin plan's findings of some kinds, as a check: each finding open, or waived (a journey waiver on its id). */
function pinBar(i: CheckInput, id: string, kinds: readonly PinFinding['kind'][]): CheckResult {
  if (!i.design) return notMet(id, 'The design record could not be read.')
  const pins = i.design.rows.pins.filter((p) => p.status !== 'withdrawn')
  if (!pins.length) return notMet(id, NO_PLAN)
  const waived = new Set((i.r?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => w.target))
  const mine = pinCheck(pins, kinds.some((k) => k === 'mismatch' || k === 'not_on_schematic' || k === 'missing_pin') ? i.nets ?? null : null).filter((f) => kinds.includes(f.kind))
  const open = mine.filter((f) => !waived.has(f.id))
  if (open.length) return notMet(id, `${open.slice(0, 3).map((f) => f.text).join(' ')}${open.length > 3 ? ` And ${open.length - 3} more.` : ''}`)
  return mine.length ? { id, status: 'waived', detail: `${plural(mine.length, 'finding')} waived.` } : met(id)
}

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

  // ---- Intent builder: the statements in the record, with the person's draft decisions laid over them
  'intent-builder/answered': (i) => withIntent(i, 'answered', (v) => {
    const live = v.filter((s) => s.state !== 'rejected' && s.kind !== 'question')
    const open = INTENT_TOPICS.filter((t) => !live.some((s) => s.topic === t))
    const undated = live.filter((s) => s.kind === 'unknown' && !s.decide_by)
    if (open.length) return notMet('answered', `${plural(open.length, 'topic')} not answered or marked: ${open.map((t) => TOPIC_NAMES[t]).join(', ')}.`)
    return undated.length ? notMet('answered', `${plural(undated.length, 'unknown')} without the stage it is decided by: ${ids(undated)}.`) : met('answered')
  }),
  'intent-builder/quantities': (i) => flagged(i, 'quantities', 'needs_number', 'without a number and unit'),
  'intent-builder/vague': (i) => flagged(i, 'vague', 'vague', 'with a vague word and no number'),
  'intent-builder/interfaces': (i) => withIntent(i, 'interfaces', (v) => {
    const live = v.filter((s) => s.state !== 'rejected' && s.topic === 'interfaces' && s.kind !== 'question')
    if (!live.length) return notMet('interfaces', 'No interface is stated, nor is the topic marked "don\'t care".')
    const open = live.filter((s) => s.flags.includes('interface_incomplete'))
    return open.length ? notMet('interfaces', `${plural(open.length, 'interface')} without all of type, connector, protocol, rate and direction: ${ids(open)}.`) : met('interfaces')
  }),
  'intent-builder/conflicts': (i) => flagged(i, 'conflicts', 'conflict', 'in conflict with another, neither given way'),
  'intent-builder/testable': (i) => flagged(i, 'testable', 'not_testable', 'that cannot become a testable requirement as worded', 'As the agents judged each statement.'),
  'intent-builder/owners': (i) => withIntent(i, 'owners', (v) => {
    const open = v.filter((s) => s.state !== 'rejected' && s.flags.includes('no_owner'))
    return open.length ? notMet('owners', `${plural(open.length, 'open question')} without an owner: ${ids(open)}.`) : met('owners')
  }),

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
    // requirements derived from intent lines still in conflict with each other conflict too
    if (i.design) {
      const v = intentView(i.design.rows, i.design.decisions)
      const live = new Set(i.requirements.map((q) => q.id))
      const links = linksView(i.design.rows).filter((l) => live.has(l.requirement))
      const clash = v.filter((x) => x.flags.includes('conflict') && links.some((l) => l.intent === x.id))
      if (clash.length) return notMet('conflicts', `Requirements derive from intent lines still in conflict: ${clash.map((x) => `${x.id} (${links.filter((l) => l.intent === x.id).map((l) => l.requirement).join(', ')})`).slice(0, 4).join('; ')}. Resolve it in the intent first.`)
    }
    return unavailable('conflicts', 'a check that two requirements can both hold (duplicates, and conflicts between the intent lines they come from, are checked and there are none; no tool checks the requirements\' own numbers against each other)')
  },
  'requirements-review/sources': (i) => {
    const none = i.requirements.filter((q) => !q.source)
    return !i.requirements.length ? notMet('sources', 'No requirements are recorded yet.') : none.length ? notMet('sources', `${plural(none.length, 'requirement')} without a source: ${ids(none)}.`) : met('sources')
  },
  'requirements-review/covered': (i) => withIntent(i, 'covered', (v) => {
    const live = new Set(i.requirements.map((q) => q.id))
    const links = linksView(i.design!.rows).filter((l) => live.has(l.requirement))
    const open = v.filter((s) => s.state !== 'rejected' && s.kind === 'statement' && s.uncovered === null && !links.some((l) => l.intent === s.id))
    return open.length ? notMet('covered', `${plural(open.length, 'intent statement')} no requirement covers, and not left out with a reason: ${ids(open)}.`) : met('covered')
  }),
  'requirements-review/struck': (i) => {
    const bare = i.struck.filter((q) => !q.reason?.trim())
    if (!i.struck.length) return met('struck', 'No requirement is struck.')
    return bare.length ? notMet('struck', `${plural(bare.length, 'struck requirement')} without a reason: ${ids(bare)}. Strike each again here with the reason.`) : met('struck')
  },

  // ---- Architecture choice
  'architecture-choice/two': (i) => withArch(i, 'two', (a) => {
    if (a.options.length >= 2) return met('two', `${a.options.length} options compared.`)
    if (!a.options.length) return notMet('two', 'No architecture is proposed yet: the agents propose options with design.architecture.')
    return a.chosen?.option && a.onlyOne ? met('two', `Only one option: ${a.onlyOne}`) : notMet('two', 'Only one option is proposed: compare a second, or say why only one is possible.')
  }),
  'architecture-choice/fixed': (i) => withArch(i, 'fixed', (a) => {
    if (!a.fixed) return notMet('fixed', 'Fix the criteria and their weights first, before reading any score.')
    if (a.chosen && a.fixedAt !== null && a.chosenAt !== null && a.fixedAt > a.chosenAt) return notMet('fixed', 'The criteria were changed after the choice: choose again on the fixed criteria.')
    return met('fixed', `Fixed by ${a.fixed.by}.`)
  }),
  'architecture-choice/scored': (i) => withArch(i, 'scored', (a) => {
    if (!a.criteria.length) return notMet('scored', 'There are no criteria to score on.')
    const missing: string[] = []
    for (const o of a.options) for (const c of a.criteria) { const sc = a.scores.find((x) => x.option === o.id && x.criterion === c.id); if (!sc || str(sc.reason).length < 3) missing.push(`${o.id} on ${c.name}`) }
    if (missing.length) return notMet('scored', `${plural(missing.length, 'score')} missing or without a reason: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`)
    if (!a.chosen) return notMet('scored', 'Choose an option and name the criteria that decided it.')
    return a.chosen.deciding.length ? met('scored') : notMet('scored', 'Name the criteria that decided the choice.')
  }),
  'architecture-choice/mapped': (i) => {
    const c = criterion(i, 'mapped', 'architect.mapped')
    if (c.status === 'waived') return c
    return withArch(i, 'mapped', (a) => {
      const o = a.options.find((x) => x.id === a.current)
      if (!o) return notMet('mapped', 'No architecture is proposed yet.')
      const served = new Set(o.blocks.flatMap((b) => b.serves))
      const open = i.requirements.filter((q) => !served.has(q.id))
      if (!i.requirements.length) return notMet('mapped', 'No requirements are recorded yet.')
      return open.length ? notMet('mapped', `${plural(open.length, 'requirement')} served by no block of option ${o.id}: ${ids(open)}.`) : met('mapped', `Every requirement maps to a block of option ${o.id}.`)
    })
  },
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
  'schematic-finish/serves': (i) => {
    if (!i.design) return notMet('serves', 'The design record could not be read.')
    if (!i.sheetFiles) return unavailable('serves', 'the list of schematic files on the default branch, which could not be read')
    if (!i.sheetFiles.length) return notMet('serves', 'There is no schematic on the default branch yet.')
    const named = new Map(i.design.rows.sheets.map((x) => [x.sheet, x]))
    const live = new Set(i.requirements.map((q) => q.id))
    const open = i.sheetFiles.filter((f) => { const x = named.get(f); return !x || (!x.requirements.some((r) => live.has(r)) && !str(x.reason)) })
    return open.length ? notMet('serves', `${plural(open.length, 'sheet')} without the requirements it serves: ${open.slice(0, 5).join(', ')}${open.length > 5 ? ` and ${open.length - 5} more` : ''}.`) : met('serves')
  },

  // ---- Pin plan review
  'pin-plan-review/functions': (i) => pinBar(i, 'functions', ['no_net', 'no_function', 'unsupported', 'unknown_alternates']),
  'pin-plan-review/instances': (i) => pinBar(i, 'instances', ['claimed_twice', 'function_twice']),
  'pin-plan-review/boot': (i) => pinBar(i, 'boot', ['reserved']),
  'pin-plan-review/match': (i) => {
    if (!i.nets) return i.design?.rows.pins.some((p) => p.status !== 'withdrawn') ? notMet('match', 'The pin plan has not been checked against the schematic yet: run design.pins check.') : notMet('match', NO_PLAN)
    return pinBar(i, 'match', ['mismatch', 'not_on_schematic', 'missing_pin'])
  },

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
    if (!i.design) return unavailable('outline', `the size limits from the intent (the outline is ${o.width_mm} × ${o.height_mm} mm), which could not be read`)
    const v = intentView(i.design.rows, i.design.decisions).filter((s) => s.state !== 'rejected' && s.topic === 'physical')
    const limits = v.flatMap((s) => s.limits)
    const w = limits.find((l) => /^board_?(width|length|x)$/i.test(l.name) && l.unit === 'mm')
    const h = limits.find((l) => /^board_?(height|depth|y)$/i.test(l.name) && l.unit === 'mm')
    if (!w && !h) return v.some((s) => s.kind === 'dont_care') ? met('outline', `Closed, ${o.width_mm} × ${o.height_mm} mm; the intent sets no size limit.`) : notMet('outline', `The outline is ${o.width_mm} × ${o.height_mm} mm, but the intent gives no board size limit (Physical: board_width, board_height in mm) to check it against.`)
    const over = [w && w.max !== undefined && Number(o.width_mm) > w.max ? `${o.width_mm} mm wide (at most ${w.max})` : '', h && h.max !== undefined && Number(o.height_mm) > h.max ? `${o.height_mm} mm high (at most ${h.max})` : ''].filter(Boolean)
    return over.length ? notMet('outline', `The board is ${over.join(' and ')}.`) : met('outline', `${o.width_mm} × ${o.height_mm} mm, within the intent's limits.`)
  },
  'board-setup/stackup': (i) => (!i.board ? notMet('stackup', 'No board check is recorded yet: run kicad.board.') : i.board.stackup_known ? met('stackup', 'The stackup is complete; impedance widths are not checked against targets yet.') : notMet('stackup', 'The board file has no complete stackup.')),
  'board-setup/fixed': () => unavailable('fixed', 'the fixed parts with their mechanical reasons, in the record; Board setup does not store them yet'),
  'board-setup/rules': () => unavailable('rules', 'the fab\'s capabilities in the record, to compare the board\'s design rules with'),

  // ---- Placement adjust
  'placement-adjust/moves': () => unavailable('moves', 'the parts moved since trace placed them, with a reason each; no tool records the moves yet'),
  'placement-adjust/check': (i) => (!i.placement ? notMet('check', 'No placement check is recorded yet: run pcb.placement_check.') : i.placement.status === 'pass' ? met('check') : notMet('check', i.placement.summary ?? 'The last placement check did not pass.')),
  'placement-adjust/fixed': () => unavailable('fixed', 'the fixed parts and where they must stay, in the record'),
  'placement-adjust/locked': () => unavailable('locked', 'which parts the router must not move, read from the board; no tool reports locks yet'),

  // ---- Case design: the latest mech.build run (src/tools/mech), and the layout gate's fit criterion for waivers
  'case-design/process': (i) => {
    const b = i.caseBuild
    if (!b?.result) return notMet('process', 'No case build is recorded yet: run mech.build (mech.init first if the project has no case).')
    const p = b.result.process as { service?: string; process?: string; material?: string } | undefined
    const rules = list(b.result.rules) as { rule?: string; ok?: boolean | null; detail?: string }[]
    const bad = rules.filter((x) => (x.rule === 'process' || x.rule === 'size' || x.rule === 'min_size') && x.ok === false)
    const what = p ? `${p.process ?? '?'} ${p.material ?? '?'} at ${p.service ?? '?'}` : 'the process'
    return bad.length ? notMet('process', `${what}: ${bad.map((x) => x.detail ?? x.rule).join('; ')}.`) : met('process', `${what}, within its build size.`)
  },
  'case-design/clearances': (i) => {
    const b = i.caseBuild
    if (!b?.result) return notMet('clearances', 'No case build is recorded yet: run mech.build.')
    const missing = list(b.result.warnings).filter((w): w is string => typeof w === 'string' && /^clearance\.\S+ .*without a reason/.test(w))
    return missing.length ? notMet('clearances', `${plural(missing.length, 'clearance')} changed without a reason: ${missing.map((w) => w.split(' ')[0]).join(', ')}.`) : met('clearances')
  },
  'case-design/fit': (i) => {
    const b = i.caseBuild
    if (!b?.result) return notMet('fit', 'No case build is recorded yet: run mech.build.')
    // a build of other files is no evidence for these (mech.fit's stale check)
    if (i.caseStale?.length) return notMet('fit', staleSentence(i.caseStale))
    if (b.result.fit_status === 'pass') return met('fit', `Build ${b.id.slice(0, 8)}: no clash, every gap at its clearance.`)
    const waived = criterion(i, 'fit', 'layout.fit')
    if (waived.status === 'waived') return waived
    const problems = list(b.result.problems).filter((x): x is string => typeof x === 'string')
    return notMet('fit', problems.length ? `${problems.slice(0, 4).join('; ')}${problems.length > 4 ? ` and ${problems.length - 4} more` : ''}.` : String(b.result.fit_summary ?? b.summary ?? 'The fit check does not pass.'))
  },
  'case-design/rules': (i) => {
    const b = i.caseBuild
    if (!b?.result) return notMet('rules', 'No case build is recorded yet: run mech.build.')
    const failing = (list(b.result.rules) as { ok?: boolean | null; detail?: string; rule?: string }[]).filter((x) => x.ok === false)
    const unchecked = (list(b.result.rules) as { ok?: boolean | null }[]).filter((x) => x.ok === null).length
    return failing.length ? notMet('rules', `${failing.map((x) => x.detail ?? x.rule).join('; ')}.`) : met('rules', unchecked ? `Within the rules; ${plural(unchecked, 'rule')} not checked (a handed-in file's walls are not measured).` : undefined)
  },

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

  // ---- Incoming inspection: the boards recorded (board.record, board.check)
  'incoming-inspection/count': (i) => { const p = inspection(i).count; return p ? notMet('count', p) : met('count', `${plural(boardsOf(i).length, 'board')} recorded, each with a serial and a photo.`) },
  'incoming-inspection/faults': (i) => { const p = inspection(i).faults; return p ? notMet('faults', p) : met('faults') },
  'incoming-inspection/hand': (i) => {
    if (i.handPlaced === null || i.handPlaced === undefined) return unavailable('hand', 'the parts the fab does not place: run kicad.fab so its result lists them')
    if (!i.handPlaced.length) return boardsOf(i).length ? met('hand', 'The fab places every part.') : notMet('hand', 'No boards are recorded yet.')
    const p = inspection(i).hand
    return p ? notMet('hand', p) : met('hand')
  },

  // ---- Bench setup
  'bench-setup/limits': (i) => {
    const psus = i.instruments.filter((x) => x.kind === 'psu')
    if (!psus.length) return notMet('limits', 'No power supply is set up in hil.instruments.')
    const open = psus.filter((p) => !(p.limits?.max_voltage_v && p.limits?.max_current_a))
    return open.length ? notMet('limits', `${open.map((p) => p.name).join(', ')} without both a voltage and a current limit.`) : met('limits')
  },
  'bench-setup/idn': (i) => {
    if (!i.instruments.length) return notMet('idn', 'No instruments are set up in hil.instruments.')
    const ids = new Map((i.ids ?? []).map((x) => [x.instrument, x]))
    const silent = i.instruments.filter((x) => !ids.get(x.name)?.ok)
    return silent.length ? notMet('idn', `${silent.map((x) => x.name).join(', ')} ${silent.length === 1 ? 'has' : 'have'} not answered its identity query: run hil.idn on the bench.`) : met('idn', i.instruments.map((x) => `${x.name}: ${[ids.get(x.name)?.manufacturer, ids.get(x.name)?.model].filter(Boolean).join(' ')}`).join('; '))
  },
  'bench-setup/wired': () => unavailable('wired', 'the bench wiring (each connection with its net), in the record'),
  'bench-setup/hardware': () => unavailable('hardware', 'which machine the bench tools run on; the API cannot see the bench machine'),

  // ---- Bring-up run
  'bring-up-run/limits': (i) => {
    const rs = i.readings ?? []
    if (!rs.length) return notMet('limits', 'No bring-up readings are recorded yet: the bring-up run takes them with the hil tools against each step\'s limits.')
    const problems = [...new Set(rs.map((r) => r.board))].flatMap((b) => (stepOrderProblems(rs.filter((r) => r.board === b)) ?? []).map((p) => `${b} ${p}`))
    return problems.length ? notMet('limits', `${problems.slice(0, 4).join('; ')}.`) : met('limits')
  },
  'bring-up-run/shorts': (i) => {
    const rs = i.readings ?? []
    const boards = [...new Set(rs.map((r) => r.board))]
    if (!boards.length) return notMet('shorts', 'No bring-up readings are recorded yet.')
    const bad: string[] = []
    for (const b of boards) {
      const mine = rs.filter((r) => r.board === b)
      const powered = mine.filter((r) => r.step !== 'inspect' && r.step !== 'unpowered')
      if (!powered.length) continue
      const firstPowered = Math.min(...powered.map((r) => r.at))
      const unpowered = mine.filter((r) => r.step === 'unpowered' && r.at < firstPowered)
      if (!unpowered.length) bad.push(`${b} was powered with no unpowered check before it`)
      else if (unpowered.some((r) => !r.pass && !unpowered.some((x) => x.quantity === r.quantity && x.at > r.at && x.pass))) bad.push(`${b} was powered with an unpowered check out of limits`)
      if (powered.some((r) => r.step === 'rails' && r.unit === 'A' && r.max === null)) bad.push(`${b} had a rail's current read without a limit`)
    }
    if (!boards.some((b) => rs.some((r) => r.board === b && r.step !== 'inspect' && r.step !== 'unpowered'))) return rs.some((r) => r.step === 'unpowered') ? met('shorts', 'Unpowered checks recorded; nothing powered yet.') : notMet('shorts', 'No unpowered check is recorded yet.')
    return bad.length ? notMet('shorts', `${bad.join('; ')}.`) : met('shorts')
  },
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

const boardsOf = (i: CheckInput): BoardRow[] => (i.boards ?? []).filter((b) => !i.r || b.revision === i.r.journey.revision)
const inspection = (i: CheckInput) => inspectionProblems(i.boards ?? [], i.orders, i.r?.journey.revision ?? 'A', i.handPlaced ?? [])

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
