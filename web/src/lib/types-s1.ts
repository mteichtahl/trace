/**
 * Shapes for the gate, the guided skills, New project and the project tabs (requirements, design, evidence, runs,
 * build, decisions, cost, settings). Where docs/web-build.md leaves a shape open, the choice made here is marked
 * "assumed" so the backend can match it or this file can follow the backend. Actions marked "needs building" in
 * lib/api.ts have no backend yet; the screens say so where they show their data.
 */
import type { CriterionStatus, EvidenceRef, Gate, Journey, Part, Question, Template, Wait } from './types'

// ------------------------------------------------------------------ gates (journey.get, assumed extras)

/** What journey.get may carry on a gate beyond the base shape (assumed). */
export interface GateMore extends Gate {
  /** trace's recommendation: "**trace recommends signing.** All 6 criteria are met; …" */
  recommendation?: { sign: boolean; summary: string; givesUp?: string; evidence?: EvidenceRef[] }
  /** what signing commits ("Next: Layout. Forecast 2 days of agent time, about US$11 of cloud use.") */
  forecast?: string
  /** at the order gate: the order's total and price changes since sign-off */
  spend?: { total: number; currency: string; changed?: string }
  /** the receipt, once signed or returned */
  record?: { notes?: string; acknowledged?: string[]; returned?: { by: string; at: string; reason: string } }
}

/** Journey extras the Decisions tab reads (assumed part of journey.get: "decisions log"). */
export interface DecisionEntry {
  id: string
  kind: 'gate' | 'change' | 'question' | 'waiver' | 'decision'
  title: string
  /** who decided ("Marc Teichtahl", "trace") */
  by: string
  at: string
  /** the choice, and whether it was trace's recommendation */
  choice?: string
  recommended?: boolean
  reason?: string
  state?: 'open' | 'approved' | 'rejected' | 'signed' | 'returned' | 'answered' | 'active' | 'closed'
  to?: string
}
export interface JourneyMore extends Journey {
  decisions?: DecisionEntry[]
}

// ------------------------------------------------------------------ guided skills (skill.get / skill.submit, needs building)

/** A finding drawn on a picture: numbered marker at (x, y) as fractions of the picture, linked to its list row. */
export interface PictureFinding {
  id: string
  severity: 'blocks' | 'fix' | 'waived'
  text: string
  /** where on the picture, 0..1 */
  at?: { x: number; y: number }
  /** where KiCad put it, in millimetres on its sheet or board (the API's; a picture maps it with its own scale) */
  x_mm?: number
  y_mm?: number
  where?: string
  source?: EvidenceRef
  /** the sheet or layer it is on */
  sheet?: string
}

/** A difference the person made from trace's draft, which needs a one-line reason. */
export interface DraftChange {
  id: string
  /** "C3 changed" */
  what: string
  from?: string
  to?: string
  /** trace's best guess, to confirm or rewrite */
  guess?: string
  reason?: string
  confirmed?: boolean
}

export interface SkillItem {
  id: string
  title: string
  detail?: string
  status: 'open' | 'done' | 'waived'
  evidence?: EvidenceRef
}

export interface IntentStatement {
  id: string
  topic: string
  text: string
  state: 'accepted' | 'draft' | 'needs_number' | 'vague' | 'conflict'
  flag?: string
}
export interface IntentDraft {
  /** the topic being worked on (index into the 10 topics) */
  topic: number
  answered: string[]
  statements: IntentStatement[]
  questions: { id: string; text: string; owner: string }[]
}

export interface BenchReadout {
  id: string
  label: string
  value: number | null
  unit: string
  min?: number
  max?: number
}

/** One quality-bar check as skill.get computes it from the record. */
export interface SkillCheckView {
  id: string
  status: CriterionStatus
  detail?: string
  /** the check cannot be computed yet: what the record has to hold first */
  unavailable?: string
}

export interface SkillView {
  skill: string
  name?: string
  steps?: { id: string; title: string }[]
  met?: number
  total?: number
  /** this person's draft, kept in the journey store (skill.draft), and when */
  draft?: Record<string, unknown> | null
  saved?: string | null
  /** Gate signing: the gate of the current stage */
  gate?: string
  /** trace's summary of where the person is ("You're on step 3. The Power sheet has two findings left…") */
  summary?: string
  /** a recommendation where there is a choice */
  recommendation?: { question?: string; recommended: string; options: { id: string; label: string; detail?: string }[]; why?: string; evidence?: EvidenceRef[]; givesUp?: string }
  /** the checker's verdict for each check id in the skill definition */
  checks?: SkillCheckView[]
  /** the person's step, as the record has it */
  step?: number
  items?: SkillItem[]
  picture?: { title: string; subtitle?: string; path?: string; url?: string }
  sheets?: { id: string; name: string; open: number; serves?: string[]; path?: string }[]
  findings?: PictureFinding[]
  changes?: DraftChange[]
  /** the last push trace checked */
  push?: { sha: string; at: string; fixed: number; new: number }
  intent?: IntentDraft
  /** Architecture choice: every option with its blocks and scores, the criteria, trace's recommendation */
  architecture?: Omit<ArchitectureRecord, 'option' | 'blocks' | 'connections'> & { options: ArchOption[]; current: string | null }
  /** decisions in the draft that Submit could not record (they name nothing, or lack their reason) */
  pending_errors?: string[]
  question?: Question & { quantity?: { unit: string }; context?: string; searched?: EvidenceRef[] }
  /** Waiver: what can be waived here */
  waivable?: { id: string; kind: 'requirement' | 'finding' | 'test'; title: string; evidence?: EvidenceRef; recommendation?: 'waive' | 'fix'; why?: string }[]
  /** Change request: the impact trace traced */
  impact?: { stages: string[]; gates: string[]; stale: string[]; cost?: string; time?: string; released?: boolean; recommendation?: SkillView['recommendation'] }
  /** checklist on a picture (bench setup, bring-up, inspection) */
  bench?: { powered: boolean; checklist: { id: string; text: string; by: 'person' | 'trace'; done: boolean; powered?: boolean }[]; readouts: BenchReadout[]; wires?: { id: string; from: string; to: string; net: string; power?: boolean; limit?: string; done?: boolean }[] }
}

// ------------------------------------------------------------------ requirements and traceability

export type Verdict = 'verified' | 'coverage_gap' | 'failing' | 'partial' | 'untested' | 'no_test' | 'waived'

/** One row of verify.coverage (src/tools/verify/matrix.ts ReqRow). */
export interface CoverageRow {
  id: string
  kind: string
  text: string
  acceptance: string | null
  status: string
  verdict: Verdict
  tests: { id: string; method: string; status: string; last_run: string | null }[]
  points?: { id: string; hits: number; goal: number; met: boolean }[]
  /** assumed extras where the project has them */
  source?: string | null
  priority?: 'must' | 'should'
}
export interface CoverageResult {
  summary: Record<string, number>
  requirements: CoverageRow[]
}

/** One requirement with its evidence status (requirements.trace). */
export interface TracedRequirement {
  id: string
  text: string
  kind: string
  acceptance: string | null
  source: string | null
  status: string
  evidence: 'verified' | 'failing' | 'untested' | 'waived'
  /** why, in words ("TST-001 failed on its last run.") */
  why: string
  tests: { id: string; title: string; method: string; status: string; last_run: string | null }[]
  waiver: string | null
}

/** One intent line (requirements.trace): agents propose it, a person accepts, edits or rejects it (Intent builder). */
export interface TraceIntent {
  id: string
  topic: string
  /** the words that stand: the person's own when they edited it */
  text: string
  /** accepted / edited: a person decided; proposed: an agent's, not yet decided */
  state?: 'accepted' | 'edited' | 'proposed'
  kind?: 'statement' | 'dont_care' | 'unknown'
  /** what the Intent builder flags: needs_number, vague, conflict, not_testable, interface_incomplete */
  flags?: string[]
  source?: { kind: 'person' | 'brief' | 'document' | 'design'; ref?: string; quote?: string; page?: number } | null
  decided?: { by: string; at: string; reason?: string }
  /** a person left it without a requirement, with this reason */
  uncovered?: string
  /** a requirement is derived from it */
  covered?: boolean
}

/** requirements.trace: the intent lines and each requirement's link to one, and each requirement's evidence. */
export interface TraceView {
  intent: TraceIntent[]
  links: { requirement: string; intent: string }[]
  /** said while no intent statement is recorded */
  intent_note?: string
  requirements?: (TracedRequirement & { derived_from?: string[] })[]
  summary?: { requirements: number; verified: number; failing: number; untested: number; waived: number; intent?: number; accepted?: number; uncovered?: number; unlinked?: number }
}

// ------------------------------------------------------------------ design (design.get)

export interface Block {
  id: string
  name: string
  role?: string
  /** the key part's number */
  part?: string
  parts?: { mpn: string; role?: string; key?: boolean }[]
  /** stock of the key part, where a parts check gave it (the record does not keep it per block) */
  stock?: 'in_stock' | 'low' | 'out'
  serves: string[]
  x: number
  y: number
}
export interface BlockConnection { from: string; to: string; label: string; kind?: string }
export interface ArchOption {
  id: string; name: string; summary: string; recommended: boolean; why: string | null; gives_up: string | null; risks: string[]
  /** weighted total of its scores */
  total: number
  blocks: Block[]
  connections: BlockConnection[]
}
export interface ArchitectureRecord {
  /** "Option B: STM32WL", the option drawn */
  option: string
  id?: string
  /** chosen by a person, or trace's proposal drawn until one is */
  state?: 'chosen' | 'proposed'
  blocks: Block[]
  connections: BlockConnection[]
  options?: ArchOption[]
  criteria?: { id: string; name: string; weight: number; description: string | null }[]
  fixed?: { by: string; at: string } | null
  scores?: { option: string; criterion: string; score: number; reason: string; by: 'trace' | 'person' }[]
  recommended?: string | null
  chosen?: { option: string; reason: string; deciding: string[]; by: string; at: string; against: boolean } | null
}
export interface PinView {
  part?: string
  pin: string
  name?: string | null
  net: string
  fn: string
  peripheral?: string
  use?: string
  alt?: string
  reserved?: string
  status: 'ok' | 'conflict' | 'spare' | 'waived'
  note?: string
  findings?: { id: string; severity: 'blocks' | 'fix' | 'waived'; text: string }[]
}
/** design.decide's decision (src/api/actions-design.ts). */
export type DesignDecisionInput =
  | { kind: 'intent'; statement: string; choice: 'accept' | 'edit' | 'reject'; text?: string; reason?: string }
  | { kind: 'uncovered'; statement: string; reason: string }
  | { kind: 'requirement'; requirement: string; choice: 'accept' | 'strike'; reason?: string }
  | { kind: 'criteria'; criteria: { id: string; name: string; weight: number; description?: string }[] }
  | { kind: 'architecture'; option: string; reason: string; deciding: string[] }
  | { kind: 'pins'; part: string }

export interface DesignView {
  architecture?: ArchitectureRecord
  /** one per schematic file; `path`: its drawing (runs/<id>/sheets/<file>.svg) when an export kept one */
  sheets: { id: string; name: string; path?: string; serves?: string[]; block?: string; serves_none?: string; findings: PictureFinding[] }[]
  pins?: PinView[]
  /** the pin plan's check against the schematic, and which parts' plans a person agreed */
  pin_plan?: {
    checked: { run: string; at: string | null } | null
    parts: { part: string; pins: number; agreed: { by: string; at: string; stale: boolean } | null }[]
    findings: { id: string; target: string; kind: string; severity: 'blocks' | 'fix' | 'waived'; text: string }[]
  }
  board?: { file?: string; path?: string; render?: string; layers?: string[]; findings: PictureFinding[]; size?: string }
  /** the export run the drawings come from */
  drawings?: { run: string; at: string | null }
  /** the latest rule checks the findings come from */
  checks?: { erc: { run: string; at: string | null; status: string; summary: string | null } | null; drc: { run: string; at: string | null; status: string; summary: string | null } | null }
  /** what the record does not hold yet, in words */
  notes?: string[]
}

// ------------------------------------------------------------------ runs (run, assumed extras; job.control, needs building)

export interface RunStep {
  id: string
  title: string
  state: 'done' | 'running' | 'queued' | 'failed' | 'skipped'
  detail?: string
  /** seconds */
  durationS?: number
  progress?: number
}
export interface RunRecordView {
  id: string
  kind: string
  subject: string | null
  started: number
  finished: number | null
  status: 'running' | 'pass' | 'fail' | 'error'
  summary: string | null
  args?: unknown
  result?: unknown
  git_sha?: string | null
  measurements?: { name: string; value: number | null; unit: string | null }[]
  artifacts?: { name: string; mime: string | null; size: number }[]
  // assumed extras
  title?: string
  where?: string
  jobId?: string
  typicalS?: number
  steps?: RunStep[]
  plots?: import('@/components/chat/cards').PlotData[]
  findings?: PictureFinding[]
  log?: { id: string; at: string; who: string; text: string; tools?: string[] }[]
  /** a table the evidence sheet shows (parts list check, coverage row) */
  table?: { columns: { id: string; label: string; mono?: boolean; align?: 'right' }[]; rows: Record<string, string | number>[]; note?: string }
  requirement?: string
}

// ------------------------------------------------------------------ build (build.get, needs building)

export interface OrderView {
  id: string
  release: string
  state: 'ready' | 'placed' | 'confirmed' | 'shipped' | 'delivered'
  cancelled?: boolean
  placedAt?: string | null
  placedBy?: string
  boards: number
  total: number
  currency: string
  budget?: number
  changed?: string
  cost: { label: string; amount: number }[]
  options: { option: string; value: string }[]
  parts: { ref: string; name: string; lcsc: string; stock: number; then: number; now: number }[]
  files: string[]
  checkedAt?: string
  number?: string
  paid?: number | null
  ship?: string | null
  /** waiting for the fab: `checkable: false` when nothing checks it on its own yet */
  wait?: (Wait & { checkable?: boolean }) | null
  meanwhile?: { title: string; state: 'done' | 'running' | 'todo' }[]
}
export interface BuildView {
  /** `files`: null when the record does not count them */
  releases: { id: string; revision: string; at: string; commit: string; branch?: string | null; files: number | null; by: string; frozen: boolean }[]
  orders: OrderView[]
  boards: { serial: string; order: string; state: 'received' | 'inspected' | 'brought_up' | 'failed'; note?: string }[]
  bench?: { configured: boolean; instruments: { name: string; kind: string; address: string; answered: boolean }[]; note?: string }
  notes?: string[]
}

// ------------------------------------------------------------------ cost and time (cost.get, needs building)

/** cost.get. Money is for admins only (`money: false`: every amount is null); what is not recorded is null, with notes. */
export interface CostView {
  money?: boolean
  currency: string
  /** cloud: null, cloud use is not recorded per project */
  spent: { cloud: number | null; orders: number | null }
  committed: number | null
  /** the build: quantity × unit cost; null without a unit cost */
  forecast: number | null
  budget?: number
  quantity?: number
  unit_cost?: number | null
  stages: { stage: string; id?: string; state: 'done' | 'current' | 'queued'; started?: string | null; finished?: string | null; cloud: number | null; days: number; forecastDays?: number | null }[]
  lines: { id: string; at: string; what: string; kind: 'agents' | 'gpu' | 'cpu' | 'order'; amount: number }[]
  notes?: string[]
}

// ------------------------------------------------------------------ new project (projects.create)

export type IconGlyph = 'chip' | 'antenna' | 'battery' | 'motor' | 'sensor' | 'board' | 'fpga' | 'plug'
export type IconColour = 'blue' | 'green' | 'amber' | 'violet' | 'pink' | 'teal' | 'indigo' | 'grey'
export interface ProjectIcon {
  glyph?: IconGlyph
  colour: IconColour
  /** an uploaded square image (data URL) in place of the glyph */
  image?: string
}

export interface NewProjectDraft {
  name: string
  description: string
  icon: ProjectIcon
  start: 'idea' | 'design'
  template: Template
  repository: { mode: 'new' | 'existing'; owner: string; name: string; branch: string }
  advanced: { ownToken: boolean; memoryDays: number; onboardingPr: boolean; applySettings: boolean }
  people: { who: string; name?: string; email: string; class: 'admin' | 'user' | 'guest' | 'new'; part: Part; notify: 'normal' | 'gates_spend' }[]
  build: { quantity: number; unitCost?: number; budget?: number; later: { certify: boolean; produce: boolean; sustain: boolean }; fab: string }
}
