/**
 * The journey record: where a project is between its written intent and an accepted board. It lives in the central
 * bucket beside the project's chats (src/core/journey-store.ts: projects/<slug>/journey/journey.db, written with
 * conditional puts), because it changes with every click (evidence opened, a question answered) and must be live for
 * everyone at once. When a release is cut, the record is copied into the repository's .trace/project.db, whose journey
 * tables are registered here with their merge rules, so the released revision carries the record that approved it.
 *
 * A project starts from a TEMPLATE (docs/user-journey.md "Templates") that keeps only the stages it needs:
 *
 *   board      Define, Architect, Capture, Prove, Layout, Sign-off, Release, Fabricate, Bring up
 *   fpga       the same without Capture and Layout (Prove covers synthesis and timing; Release is a bitstream)
 *   firmware   Define, Architect, Prove, Release, Bring up
 *   mixed      all nine, with logic (FPGA) and firmware items in Prove and the firmware track's criteria added
 * and, chosen per project, the stages after acceptance: Certify, Produce, Sustain.
 *
 * Every stage ends at a GATE a person passes (Fabricate has two: order approval, then boards received; Release and
 * Sustain have none: Release is a product of the approval before it, and is passed with it). A gate's CRITERIA are
 * marked met or not met by trace's checker tools, each with its evidence (runs, reports, records); a criterion can be
 * waived instead. Gates are hard: one admin signs, and only when every criterion is met or waived, the signer has
 * opened the evidence for every criterion and every waiver taken in the stage, and has acknowledged each waiver.
 *
 *   journey          one row: template, revision (A, B …), the current stage, the later stages chosen, the project's
 *                    name, description, icon and build plan (quantity, unit cost, budget, fab)
 *   stages           one row per stage of the template: order, when it started and finished, and why it was reopened
 *   gates            one row per gate: its stage, order and name; when and why it was last returned
 *   gate_criteria    one row per criterion: its words, who moves it (a person or trace), its status and evidence
 *   criterion_opens  who opened which criterion's or waiver's evidence (the person's 16-character hash) and when
 *   gate_signatures  each signature: who, when, the criteria with their evidence and the waivers acknowledged, notes
 *   questions        an agent's question (or an agent that is stuck): what it blocks, its options with the recommended
 *                    one first and why, the sources it read, and the answer with who gave it and when
 *   waivers          reason, risk, severity, where it is caught instead, scope; who acknowledged it at the gate
 *   decisions        the log: every start, signature, return, answer and waiver, in plain words
 *   orders           each order placed with the fab: its number, boards, what was paid, the ship date, its state
 *   stuck_dismissals a person's dismissal of a stuck agent's report (stuck.dismiss): the stuck item's id, the reason
 *                    in one line, who and when. A dismissed item leaves Home and the inbox; the agent reads the
 *                    dismissal and its reason with journey.status
 *   skill_drafts     (the store only, never copied into the repository) each person's unsubmitted guided-skill draft
 *
 * People are named by the memory hash of their email (or sub) where the record only needs to match them (opens,
 * who a question is for); where a person reads who did something (a signature, an answer) the record also keeps the
 * same label settings use (`by`: their email). The computations here are pure: stage states, criteria counts, the one
 * next step and whether a gate may be signed are worked out from the rows on every read, never stored.
 *
 * What agents contribute is not in this record: they cannot write it (src/infra/project.ts PeopleRecordsReadOnly). They
 * keep their own facts beside it (src/core/agent-facts.ts: their questions, their checks of the criteria trace owns,
 * and when they are stuck), and every view here takes those facts as input (mergeAgentFacts, below): an agent's
 * question is a question, its newer check of a trace-owned criterion sets that criterion's status, and a stuck agent is
 * a stuck item. A person's answer to an agent's question is written here, under the agent's question id. Person-owned
 * criteria never move from an agent's fact.
 *
 * All person-facing words follow the design's plain language: no unexplained acronyms, the point first.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ensureProjectSchema, projectTables, transaction } from './store.js'

// ------------------------------------------------------------------ templates

export const TEMPLATES = ['board', 'fpga', 'firmware', 'mixed'] as const
export type Template = (typeof TEMPLATES)[number]
export const LATER_STAGES = ['certify', 'produce', 'sustain'] as const
export type LaterStage = (typeof LATER_STAGES)[number]
export const STAGE_IDS = ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup', ...LATER_STAGES] as const
export type StageId = (typeof STAGE_IDS)[number]

export const TEMPLATE_NAMES: Readonly<Record<Template, string>> = { board: 'Board', fpga: 'FPGA', firmware: 'Firmware', mixed: 'Mixed' }

export const STAGE_NAMES: Readonly<Record<StageId, string>> = {
  define: 'Define', architect: 'Architect', capture: 'Capture', prove: 'Prove', layout: 'Layout', signoff: 'Sign-off',
  release: 'Release', fabricate: 'Fabricate', bringup: 'Bring up', certify: 'Certify', produce: 'Produce', sustain: 'Sustain',
}

const STAGES_OF: Readonly<Record<Template, readonly StageId[]>> = {
  board: ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup'],
  fpga: ['define', 'architect', 'prove', 'signoff', 'release', 'fabricate', 'bringup'],
  firmware: ['define', 'architect', 'prove', 'release', 'bringup'],
  mixed: ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup'],
}

/** Who moves a criterion: a person (through a guided skill) or trace (a checker tool). */
export type Owner = 'person' | 'trace'

interface CriterionDef { key: string; text: string; owner: Owner; evidence: string; in?: readonly Template[] }
interface GateDef { id: string; stage: StageId; name: string; criteria: readonly CriterionDef[] }

const ALL = TEMPLATES
const HARDWARE: readonly Template[] = ['board', 'fpga', 'mixed']
const BOARDS: readonly Template[] = ['board', 'mixed']
const FIRMWARE: readonly Template[] = ['firmware', 'mixed']
const LOGIC: readonly Template[] = ['fpga', 'mixed']

/** Every gate trace knows, in journey order, with each criterion and the templates it applies to (all, when unsaid). */
const GATES: readonly GateDef[] = [
  { id: 'define', stage: 'define', name: 'requirements baseline', criteria: [
    { key: 'accepted', text: 'Every requirement is accepted or struck.', owner: 'person', evidence: 'the requirements list' },
    { key: 'measurable', text: 'Every requirement has a criterion that can be measured, with a number and a unit.', owner: 'person', evidence: 'the requirements list' },
    { key: 'firmware', text: 'The firmware requirements are accepted with the rest.', owner: 'person', evidence: 'the firmware requirements', in: FIRMWARE },
  ] },
  { id: 'architect', stage: 'architect', name: 'architecture review', criteria: [
    { key: 'blocks', text: 'The blocks and key parts are approved.', owner: 'person', evidence: 'the block diagram and key parts list' },
    { key: 'mapped', text: 'Every requirement maps to at least one block.', owner: 'trace', evidence: 'the requirement to block map' },
    { key: 'stock', text: 'Every key part is in stock for the build quantity, or its exception is signed.', owner: 'trace', evidence: 'the stock check', in: HARDWARE },
    { key: 'peripherals', text: 'Every interface has a peripheral on the microcontroller, and no peripheral is claimed twice.', owner: 'trace', evidence: 'the peripheral budget', in: FIRMWARE },
  ] },
  { id: 'capture', stage: 'capture', name: 'schematic review', criteria: [
    { key: 'erc', text: 'The electrical rule check is clean, or each finding is waived with a reason.', owner: 'trace', evidence: 'the electrical rule check report' },
    { key: 'datasheets', text: 'No conflict with a part\'s datasheet is left open.', owner: 'trace', evidence: 'the datasheet limit check' },
    { key: 'stock', text: 'Every part is in stock for the build quantity, or its exception is signed.', owner: 'trace', evidence: 'the parts list stock check' },
    { key: 'pins', text: 'The pin plan matches the schematic.', owner: 'person', evidence: 'the pin plan' },
    { key: 'alternates', text: 'No two functions claim the same pin\'s alternate function.', owner: 'trace', evidence: 'the pin plan check', in: ['mixed'] },
  ] },
  { id: 'prove', stage: 'prove', name: 'design proven', criteria: [
    { key: 'verified', text: 'Every requirement that can be checked before layout is verified or waived.', owner: 'trace', evidence: 'the coverage matrix' },
    { key: 'failing', text: 'No test item is failing.', owner: 'trace', evidence: 'the test plan results' },
    { key: 'logic', text: 'The logic builds for the chip and meets its timing.', owner: 'trace', evidence: 'the synthesis and timing report', in: LOGIC },
    { key: 'firmware', text: 'The firmware builds cleanly and its unit tests pass.', owner: 'trace', evidence: 'the firmware build and test run', in: FIRMWARE },
    { key: 'size', text: 'The firmware fits in the chip\'s flash and memory.', owner: 'trace', evidence: 'the firmware size report', in: FIRMWARE },
  ] },
  { id: 'layout', stage: 'layout', name: 'layout review', criteria: [
    { key: 'routed', text: 'Every connection is routed.', owner: 'trace', evidence: 'the routing report' },
    { key: 'drc', text: 'The design rule check is clean, or each finding is waived.', owner: 'trace', evidence: 'the design rule check report' },
    { key: 'lengths', text: 'Matched-length groups are within tolerance.', owner: 'trace', evidence: 'the length-match report' },
    { key: 'fit', text: 'The board fits its enclosure, or each clash is waived.', owner: 'trace', evidence: 'the fit check' },
    { key: 'renders', text: 'The board renders are approved.', owner: 'person', evidence: 'the board renders' },
    { key: 'pins', text: 'The pin plan still matches after any pin swaps.', owner: 'trace', evidence: 'the pin plan check', in: ['mixed'] },
  ] },
  { id: 'signoff', stage: 'signoff', name: 'release approval', criteria: [
    { key: 'coverage', text: 'Every requirement is verified or waived.', owner: 'trace', evidence: 'the coverage matrix' },
    { key: 'emc', text: 'The radio interference prechecks are run and within the target.', owner: 'trace', evidence: 'the interference precheck', in: BOARDS },
    { key: 'bom', text: 'The parts list is checked for cost and stock at the build quantity.', owner: 'trace', evidence: 'the parts list check' },
    { key: 'report', text: 'The release report is reviewed: coverage, interference estimates, parts list and open waivers.', owner: 'person', evidence: 'the release report' },
  ] },
  { id: 'fabricate.order', stage: 'fabricate', name: 'order approval', criteria: [
    { key: 'package', text: 'The release package is built and stored.', owner: 'trace', evidence: 'the release package' },
    { key: 'stock', text: 'Stock and prices are checked again today, and every line is available.', owner: 'trace', evidence: 'today\'s stock check' },
    { key: 'sheet', text: 'The order sheet matches the release.', owner: 'person', evidence: 'the order sheet' },
  ] },
  { id: 'fabricate.received', stage: 'fabricate', name: 'boards received', criteria: [
    { key: 'inspected', text: 'The boards are received and inspected.', owner: 'person', evidence: 'the inspection record' },
    { key: 'bench', text: 'The bring-up plan, test scripts and bench are ready.', owner: 'person', evidence: 'the bring-up plan and bench setup' },
    { key: 'firmware', text: 'The bring-up firmware is built and tagged with the hardware revision.', owner: 'trace', evidence: 'the firmware release build', in: ['mixed'] },
  ] },
  { id: 'bringup', stage: 'bringup', name: 'revision accepted', criteria: [
    { key: 'package', text: 'The release package is built and stored.', owner: 'trace', evidence: 'the release package', in: ['firmware'] },
    { key: 'verified', text: 'Every requirement is verified on hardware, or carried to the next revision as an issue.', owner: 'trace', evidence: 'the coverage matrix with bench results' },
    { key: 'firmware', text: 'The firmware requirements are verified on hardware.', owner: 'trace', evidence: 'the bench results', in: FIRMWARE },
  ] },
  { id: 'certify', stage: 'certify', name: 'certification', criteria: [
    { key: 'lab', text: 'Every compliance requirement passed at the lab, or a change request is raised.', owner: 'person', evidence: 'the lab results' },
  ] },
  { id: 'produce', stage: 'produce', name: 'production release', criteria: [
    { key: 'reviews', text: 'The manufacture and test reviews are closed or waived.', owner: 'person', evidence: 'the manufacture and test review' },
    { key: 'golden', text: 'The test procedure ran on the golden board and every step passed.', owner: 'trace', evidence: 'the golden board run' },
    { key: 'quote', text: 'The volume quote is recorded.', owner: 'person', evidence: 'the volume quote' },
  ] },
]

export interface TemplateCriterion { id: string; text: string; owner: Owner; evidence: string }
export interface TemplateGate { id: string; stage: StageId; name: string; criteria: TemplateCriterion[] }
export interface TemplateStage { id: StageId; name: string; optional: boolean; gates: TemplateGate[] }

/** The stages, gates and criteria a template (with its later stages) gives a project, in journey order. */
export function templateStages(template: Template, later: readonly LaterStage[] = []): TemplateStage[] {
  const ids = [...STAGES_OF[template], ...LATER_STAGES.filter((s) => later.includes(s))]
  return ids.map((id) => ({
    id, name: STAGE_NAMES[id], optional: (LATER_STAGES as readonly string[]).includes(id),
    gates: GATES.filter((g) => g.stage === id).map((g) => ({
      id: g.id, stage: g.stage, name: g.name,
      criteria: g.criteria.filter((c) => (c.in ?? ALL).includes(template)).map((c) => ({ id: `${g.id}.${c.key}`, text: c.text, owner: c.owner, evidence: c.evidence })),
    })),
  }))
}

// ------------------------------------------------------------------ the tables

const newer = (table: string, key: string, cols: readonly string[]): string =>
  `INSERT INTO ${table} (${key}, ${cols.join(', ')}) SELECT ${key}, ${cols.join(', ')} FROM theirs.${table} WHERE true
  ON CONFLICT(${key}) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(', ')} WHERE excluded.updated > ${table}.updated;`

const JOURNEY_COLS = ['template', 'revision', 'current_stage', 'later', 'start', 'name', 'description', 'icon', 'build', 'created', 'updated', 'by'] as const
const STAGE_COLS = ['ord', 'revision', 'started', 'finished', 'reopened_at', 'reopened_reason', 'reopened_by', 'updated'] as const
const GATE_COLS = ['stage', 'ord', 'name', 'returned_at', 'returned_by', 'return_reason', 'updated'] as const
const CRITERION_COLS = ['gate', 'ord', 'text', 'owner', 'evidence_label', 'status', 'evidence', 'checked_at', 'checked_by', 'updated'] as const
const QUESTION_COLS = ['kind', 'asked_by', 'asked_of', 'stage', 'text', 'blocks', 'options', 'sources', 'job_id', 'asked_at', 'answer', 'option_id', 'answer_reason', 'answered_by', 'answered_by_hash', 'answered_at', 'updated'] as const
const WAIVER_COLS = ['stage', 'gate', 'target_kind', 'target', 'reason', 'risk', 'severity', 'caught_where', 'scope', 'by', 'at', 'acknowledged_by', 'acknowledged_at', 'closed_at', 'updated'] as const

ensureProjectSchema({ table: 'journey', sql: `
CREATE TABLE IF NOT EXISTS journey (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  template TEXT NOT NULL,         -- board | fpga | firmware | mixed
  revision TEXT NOT NULL,         -- A, B, …
  current_stage TEXT NOT NULL,
  later TEXT NOT NULL,            -- JSON list: certify, produce, sustain
  start TEXT NOT NULL,            -- idea | import
  name TEXT, description TEXT, icon TEXT,
  build TEXT,                     -- JSON: { quantity, unit_cost, budget, fab, currency }
  created REAL NOT NULL, updated REAL NOT NULL, by TEXT
);`, merge: newer('journey', 'id', JOURNEY_COLS) })

ensureProjectSchema({ table: 'stages', sql: `
CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,            -- define, architect, …
  ord INTEGER NOT NULL,
  revision TEXT NOT NULL,
  started REAL, finished REAL,
  reopened_at REAL, reopened_reason TEXT, reopened_by TEXT,
  updated REAL NOT NULL
);`, merge: newer('stages', 'id', STAGE_COLS) })

ensureProjectSchema({ table: 'gates', sql: `
CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,            -- define, fabricate.order, …
  stage TEXT NOT NULL,
  ord INTEGER NOT NULL,
  name TEXT NOT NULL,
  returned_at REAL, returned_by TEXT, return_reason TEXT,
  updated REAL NOT NULL
);`, merge: newer('gates', 'id', GATE_COLS) })

ensureProjectSchema({ table: 'gate_criteria', sql: `
CREATE TABLE IF NOT EXISTS gate_criteria (
  id TEXT PRIMARY KEY,            -- capture.erc, …
  gate TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  owner TEXT NOT NULL,            -- person | trace
  evidence_label TEXT,            -- what opening the evidence shows, in words
  status TEXT NOT NULL DEFAULT 'not_met' CHECK (status IN ('met', 'not_met')),
  evidence TEXT,                  -- JSON list: [{ kind: run | record | report | file, ref, label }]
  checked_at REAL, checked_by TEXT,
  updated REAL NOT NULL
);`, merge: newer('gate_criteria', 'id', CRITERION_COLS) })

ensureProjectSchema({ table: 'criterion_opens', sql: `
CREATE TABLE IF NOT EXISTS criterion_opens (
  item TEXT NOT NULL,             -- a criterion id, or waiver:<id>
  who TEXT NOT NULL,              -- the person's 16-character hash
  at REAL NOT NULL,
  PRIMARY KEY (item, who)
);` })

ensureProjectSchema({ table: 'gate_signatures', sql: `
CREATE TABLE IF NOT EXISTS gate_signatures (
  id TEXT PRIMARY KEY,
  gate TEXT NOT NULL,
  revision TEXT NOT NULL,
  by TEXT NOT NULL,               -- email (or sub), for people to read
  by_hash TEXT NOT NULL,
  at REAL NOT NULL,
  criteria TEXT NOT NULL,         -- JSON: each criterion with its status and evidence when signed
  waivers TEXT NOT NULL,          -- JSON: the waiver ids acknowledged
  notes TEXT,
  superseded_at REAL              -- set when the stage was reopened after it
);
CREATE INDEX IF NOT EXISTS gate_signatures_gate ON gate_signatures(gate, at);` })

ensureProjectSchema({ table: 'questions', sql: `
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'stuck')),
  asked_by TEXT NOT NULL,         -- the agent
  asked_of TEXT,                  -- a person's hash, or NULL: the project's contributors
  stage TEXT,
  text TEXT NOT NULL,
  blocks TEXT,                    -- what it blocks, in words (empty: it blocks nothing)
  options TEXT NOT NULL,          -- JSON list, recommended first: [{ id, label, recommended, why, gives_up? }]
  sources TEXT NOT NULL,          -- JSON list: [{ kind, ref, label }] what the agent already read
  job_id TEXT,
  asked_at REAL NOT NULL,
  answer TEXT, option_id TEXT, answer_reason TEXT, answered_by TEXT, answered_by_hash TEXT, answered_at REAL,
  updated REAL NOT NULL
);`, merge: newer('questions', 'id', QUESTION_COLS) })

ensureProjectSchema({ table: 'waivers', sql: `
CREATE TABLE IF NOT EXISTS waivers (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  gate TEXT,
  target_kind TEXT NOT NULL,      -- criterion | requirement | finding | test
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('cosmetic', 'degraded', 'failure', 'safety')),
  caught_where TEXT,               -- a later stage, a bench test, or NULL: accepted for good
  scope TEXT NOT NULL,
  by TEXT NOT NULL, at REAL NOT NULL,
  acknowledged_by TEXT, acknowledged_at REAL,
  closed_at REAL,
  updated REAL NOT NULL
);`, merge: newer('waivers', 'id', WAIVER_COLS) })

ensureProjectSchema({ table: 'decisions', sql: `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  at REAL NOT NULL,
  kind TEXT NOT NULL,             -- journey.started | gate.signed | gate.returned | stage.reopened | question.answered | waiver.added
  stage TEXT,
  ref TEXT,                       -- the gate, question or waiver
  summary TEXT NOT NULL,          -- one sentence, plain words
  by TEXT,
  detail TEXT                     -- JSON
);
CREATE INDEX IF NOT EXISTS decisions_at ON decisions(at);` })

const ORDER_COLS = ['revision', 'fab', 'number', 'boards', 'paid', 'currency', 'ship_date', 'state', 'placed_by', 'placed_at', 'shipped_at', 'delivered_at', 'note', 'updated'] as const

ensureProjectSchema({ table: 'orders', sql: `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,         -- the revision the boards are of
  fab TEXT NOT NULL,              -- JLCPCB, …
  number TEXT NOT NULL,           -- the fab's own order number
  boards INTEGER NOT NULL,
  paid REAL,                      -- what was paid, in currency
  currency TEXT NOT NULL,
  ship_date TEXT,                 -- the date the fab expects to ship (YYYY-MM-DD)
  state TEXT NOT NULL CHECK (state IN ('placed', 'shipped', 'delivered', 'cancelled')),
  placed_by TEXT NOT NULL, placed_at REAL NOT NULL,
  shipped_at REAL, delivered_at REAL,
  note TEXT,
  updated REAL NOT NULL
);`, merge: newer('orders', 'id', ORDER_COLS) })

ensureProjectSchema({ table: 'stuck_dismissals', sql: `
CREATE TABLE IF NOT EXISTS stuck_dismissals (
  stuck_id TEXT PRIMARY KEY,      -- the stuck item: an agent's stuck fact, or a stuck row of questions
  job_id TEXT,                    -- the job that was stuck, for the agent to find it
  reason TEXT NOT NULL,           -- one line, the person's words
  by TEXT NOT NULL,               -- email (or sub), for people to read
  by_hash TEXT NOT NULL,
  at REAL NOT NULL
);` })

/** The journey's tables, in the order they are created and copied. */
export const JOURNEY_TABLES = ['journey', 'stages', 'gates', 'gate_criteria', 'criterion_opens', 'gate_signatures', 'questions', 'waivers', 'decisions', 'orders', 'stuck_dismissals'] as const

/**
 * Tables only the journey store keeps: each person's unsubmitted guided-skill drafts. They are never copied into the
 * repository with a release (copyJourneyTables copies JOURNEY_TABLES only), because a draft is one person's work in
 * progress, not part of the record that approved a revision.
 */
const STORE_ONLY_SQL = `
CREATE TABLE IF NOT EXISTS skill_drafts (
  who TEXT NOT NULL,              -- the person's 16-character hash
  skill TEXT NOT NULL,            -- the guided skill's id (schematic-finish, waiver, …)
  step INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,             -- JSON: the skill's own draft
  saved REAL NOT NULL,
  PRIMARY KEY (who, skill)
);`

/** Create the journey's tables (and only those) in `db`; `store`: also the store-only ones (the journey store's own). */
export function applyJourneySchema(db: DatabaseSync, o: { store?: boolean } = {}): void {
  for (const t of projectTables()) if ((JOURNEY_TABLES as readonly string[]).includes(t.table)) db.exec(t.sql)
  if (o.store) db.exec(STORE_ONLY_SQL)
}

const tableIn = (db: DatabaseSync, schema: string, t: string): boolean =>
  Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(t))

/**
 * Replace the journey tables of `target` with those of the database at `sourcePath` (a release snapshot into the
 * project database, or an older repository's record into the store). Tables the source lacks are emptied. Returns
 * whether the source had a journey at all.
 */
export function copyJourneyTables(target: DatabaseSync, sourcePath: string): boolean {
  applyJourneySchema(target)
  target.prepare('ATTACH DATABASE ? AS src').run(sourcePath)
  try {
    const had = tableIn(target, 'src', 'journey') && Boolean(target.prepare("SELECT 1 FROM src.journey WHERE id='current'").get())
    transaction(target, () => {
      for (const t of JOURNEY_TABLES) {
        target.exec(`DELETE FROM main.${t}`)
        if (tableIn(target, 'src', t)) {
          const cols = (target.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name)
          const theirs = new Set((target.prepare(`SELECT name FROM src.pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name))
          const both = cols.filter((c) => theirs.has(c)).join(', ')
          target.exec(`INSERT INTO main.${t} (${both}) SELECT ${both} FROM src.${t}`)
        }
      }
    })
    return had
  } finally {
    target.exec('DETACH DATABASE src')
  }
}

// ------------------------------------------------------------------ rows

export class JourneyError extends Error {
  override name = 'JourneyError'
}

const now = (): number => Date.now() / 1000
const newId = (): string => randomUUID().replaceAll('-', '').slice(0, 16)
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try { return JSON.parse(v) as T } catch { return fallback }
}

export interface Evidence { kind: string; ref: string; label?: string | undefined }
export const EvidenceSchema = z.object({ kind: z.string().min(1).max(40), ref: z.string().min(1).max(300), label: z.string().max(300).optional() })

export const BuildSchema = z.object({
  quantity: z.number().int().min(1).max(1_000_000).default(10),
  unit_cost: z.number().min(0).nullable().default(null),
  budget: z.number().min(0).nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  fab: z.string().min(1).max(60).default('JLCPCB'),
})
export type Build = z.output<typeof BuildSchema>

export interface OptionRow { id: string; label: string; recommended: boolean; why: string; gives_up?: string | undefined }
export const OptionSchema = z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(300), recommended: z.boolean().default(false), why: z.string().max(2000).default(''), gives_up: z.string().max(1000).optional() })

export interface JourneyRow {
  template: Template; revision: string; currentStage: StageId; later: LaterStage[]; start: 'idea' | 'import'
  name: string | null; description: string | null; icon: string | null; build: Build; created: number; updated: number; by: string | null
}
export interface StageRow { id: StageId; ord: number; revision: string; started: number | null; finished: number | null; reopenedAt: number | null; reopenedReason: string | null; reopenedBy: string | null }
export interface GateRow { id: string; stage: StageId; ord: number; name: string; returnedAt: number | null; returnedBy: string | null; returnReason: string | null }
export interface CriterionRow { id: string; gate: string; ord: number; text: string; owner: Owner; evidenceLabel: string | null; status: 'met' | 'not_met'; evidence: Evidence[]; checkedAt: number | null; checkedBy: string | null }
export interface SignatureRow { id: string; gate: string; revision: string; by: string; byHash: string; at: number; criteria: unknown; waivers: string[]; notes: string | null; supersededAt: number | null }
export interface QuestionRow {
  id: string; kind: 'question' | 'stuck'; askedBy: string; askedOf: string | null; stage: StageId | null; text: string; blocks: string | null
  options: OptionRow[]; sources: Evidence[]; jobId: string | null; askedAt: number
  answer: string | null; optionId: string | null; answerReason: string | null; answeredBy: string | null; answeredByHash: string | null; answeredAt: number | null
  /** an agent's fact (src/core/agent-facts.ts), merged in: who it is for by Cognito sub, or by part, and a stuck agent's recommendation */
  askedOfSub?: string | null | undefined
  askedPart?: AskedPart | null | undefined
  recommendation?: string | null | undefined
  from?: 'agent' | undefined
}
/** Who an agent's question is for when it names no one: the project's contributors (admins too), or its admins. */
export type AskedPart = 'contributors' | 'admins'
export const SEVERITIES = ['cosmetic', 'degraded', 'failure', 'safety'] as const
export type Severity = (typeof SEVERITIES)[number]
export const WAIVER_TARGETS = ['criterion', 'requirement', 'finding', 'test'] as const
export interface WaiverRow {
  id: string; stage: StageId; gate: string | null; targetKind: (typeof WAIVER_TARGETS)[number]; target: string; reason: string; risk: string; severity: Severity
  caughtWhere: string | null; scope: string; by: string; at: number; acknowledgedBy: string | null; acknowledgedAt: number | null; closedAt: number | null
}
export interface DecisionRow { id: string; at: number; kind: string; stage: string | null; ref: string | null; summary: string; by: string | null; detail: unknown }
/** A person's dismissal of a stuck agent's report. */
export interface DismissalRow { stuckId: string; jobId: string | null; reason: string; by: string; byHash: string; at: number }

/** Everything the journey record holds, as rows. */
export interface JourneyRecord {
  journey: JourneyRow; stages: StageRow[]; gates: GateRow[]; criteria: CriterionRow[]
  opens: { item: string; who: string; at: number }[]; signatures: SignatureRow[]; questions: QuestionRow[]; waivers: WaiverRow[]; decisions: DecisionRow[]
  /** dismissed stuck reports (absent in a record written before they existed: none) */
  dismissals?: DismissalRow[] | undefined
}

const tableExists = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

const hasJourney = (db: DatabaseSync): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journey'").get()) && Boolean(db.prepare("SELECT 1 FROM journey WHERE id='current'").get())

/** The journey record, or null when the project has none yet. */
export function loadJourney(db: DatabaseSync): JourneyRecord | null {
  if (!hasJourney(db)) return null
  const j = db.prepare("SELECT * FROM journey WHERE id='current'").get() as Record<string, unknown>
  const journey: JourneyRow = {
    template: j.template as Template, revision: String(j.revision), currentStage: j.current_stage as StageId, later: json<LaterStage[]>(j.later, []),
    start: j.start === 'import' ? 'import' : 'idea', name: str(j.name), description: str(j.description), icon: str(j.icon),
    build: BuildSchema.parse(json<unknown>(j.build, {})), created: Number(j.created), updated: Number(j.updated), by: str(j.by),
  }
  const rows = (sql: string): Record<string, unknown>[] => db.prepare(sql).all() as Record<string, unknown>[]
  return {
    journey,
    stages: rows('SELECT * FROM stages ORDER BY ord').map((r) => ({
      id: r.id as StageId, ord: Number(r.ord), revision: String(r.revision), started: num(r.started), finished: num(r.finished),
      reopenedAt: num(r.reopened_at), reopenedReason: str(r.reopened_reason), reopenedBy: str(r.reopened_by),
    })),
    gates: rows('SELECT * FROM gates ORDER BY ord').map((r) => ({
      id: String(r.id), stage: r.stage as StageId, ord: Number(r.ord), name: String(r.name), returnedAt: num(r.returned_at), returnedBy: str(r.returned_by), returnReason: str(r.return_reason),
    })),
    criteria: rows('SELECT * FROM gate_criteria ORDER BY gate, ord').map((r) => ({
      id: String(r.id), gate: String(r.gate), ord: Number(r.ord), text: String(r.text), owner: r.owner === 'person' ? 'person' : 'trace', evidenceLabel: str(r.evidence_label),
      status: r.status === 'met' ? 'met' : 'not_met', evidence: json<Evidence[]>(r.evidence, []), checkedAt: num(r.checked_at), checkedBy: str(r.checked_by),
    })),
    opens: rows('SELECT * FROM criterion_opens').map((r) => ({ item: String(r.item), who: String(r.who), at: Number(r.at) })),
    signatures: rows('SELECT * FROM gate_signatures ORDER BY at').map((r) => ({
      id: String(r.id), gate: String(r.gate), revision: String(r.revision), by: String(r.by), byHash: String(r.by_hash), at: Number(r.at),
      criteria: json<unknown>(r.criteria, []), waivers: json<string[]>(r.waivers, []), notes: str(r.notes), supersededAt: num(r.superseded_at),
    })),
    questions: rows('SELECT * FROM questions ORDER BY asked_at').map((r) => ({
      id: String(r.id), kind: r.kind === 'stuck' ? 'stuck' : 'question', askedBy: String(r.asked_by), askedOf: str(r.asked_of), stage: str(r.stage) as StageId | null,
      text: String(r.text), blocks: str(r.blocks), options: json<OptionRow[]>(r.options, []), sources: json<Evidence[]>(r.sources, []), jobId: str(r.job_id), askedAt: Number(r.asked_at),
      answer: str(r.answer), optionId: str(r.option_id), answerReason: str(r.answer_reason), answeredBy: str(r.answered_by), answeredByHash: str(r.answered_by_hash), answeredAt: num(r.answered_at),
    })),
    waivers: rows('SELECT * FROM waivers ORDER BY at').map((r) => ({
      id: String(r.id), stage: r.stage as StageId, gate: str(r.gate), targetKind: r.target_kind as WaiverRow['targetKind'], target: String(r.target), reason: String(r.reason),
      risk: String(r.risk), severity: r.severity as Severity, caughtWhere: str(r.caught_where), scope: String(r.scope), by: String(r.by), at: Number(r.at),
      acknowledgedBy: str(r.acknowledged_by), acknowledgedAt: num(r.acknowledged_at), closedAt: num(r.closed_at),
    })),
    decisions: rows('SELECT * FROM decisions ORDER BY at DESC, rowid DESC').map((r) => ({
      id: String(r.id), at: Number(r.at), kind: String(r.kind), stage: str(r.stage), ref: str(r.ref), summary: String(r.summary), by: str(r.by), detail: json<unknown>(r.detail, null),
    })),
    dismissals: (tableExists(db, 'stuck_dismissals') ? rows('SELECT * FROM stuck_dismissals ORDER BY at') : []).map((r) => ({
      stuckId: String(r.stuck_id), jobId: str(r.job_id), reason: String(r.reason), by: String(r.by), byHash: String(r.by_hash), at: Number(r.at),
    })),
  }
}

// ------------------------------------------------------------------ the computed view (pure)

/** Who is looking: what the next step and the inbox are worked out for (`sub`: their Cognito sub, which an agent's
 * question may be asked of). */
export interface Viewer {
  /** the person's 16-character hash (of their Cognito sub): what new marks are written under */
  hash: string
  label: string; admin: boolean; part: 'contributor' | 'reviewer' | null
  sub?: string | undefined
  /** other hashes the person's earlier marks may carry (the email's, from before identity was keyed on the sub) */
  also?: readonly string[] | undefined
}

/** Is `who` (a recorded hash) this viewer? */
export const isViewer = (v: Pick<Viewer, 'hash' | 'also'>, who: string | null): boolean => who !== null && (who === v.hash || (v.also?.includes(who) ?? false))

export type StageState = 'done' | 'current' | 'queued' | 'reopened'
export type CriterionState = 'met' | 'not_met' | 'waived'
export type GateState = 'signed' | 'ready' | 'open' | 'queued'

export interface CriterionView {
  id: string; text: string; owner: Owner; status: CriterionState; evidence: Evidence[]; evidence_label: string | null
  waiver: string | null; opened_by_you: boolean; checked_at: string | null
}
export interface GateView {
  id: string; stage: StageId; name: string; title: string; state: GateState; met: number; total: number
  criteria: CriterionView[]; waivers: string[]
  signature: { by: string; at: string; notes: string | null } | null
  returned: { by: string | null; at: string; reason: string | null } | null
  may_sign: boolean; missing: string[]
}
export interface StageView {
  id: StageId; name: string; optional: boolean; state: StageState; met: number; total: number; progress: string
  started: string | null; finished: string | null; reopened: { at: string; reason: string | null } | null; gates: string[]
}
export type NextKind = 'task' | 'gate' | 'working' | 'waiting_person' | 'waiting_outside' | 'failed' | 'answer' | 'done'
export interface NextStep {
  kind: NextKind
  /** whose move it is: you, the admins, the contributors, a named person (by label), trace, or someone outside */
  belongs_to: 'you' | 'admins' | 'contributors' | 'person' | 'trace' | 'outside'
  yours: boolean
  summary: string
  why: string
  recommendation: string | null
  button: string
  stage: StageId | null
  ref: { kind: 'gate' | 'criterion' | 'question' | 'stage'; id: string } | null
}
export interface QuestionView {
  id: string; kind: 'question' | 'stuck'; asked_by: string; for_you: boolean; for: 'you' | 'person' | 'contributors' | 'admins'; stage: StageId | null
  text: string; blocks: string | null; options: OptionRow[]; recommended: OptionRow | null; sources: Evidence[]; job_id: string | null; asked_at: string
  answered: { answer: string; option_id: string | null; reason: string | null; by: string | null; at: string } | null
  /** a stuck agent's recommendation, in its words (agent facts) */
  recommendation?: string | undefined
}
export interface WaiverView {
  id: string; stage: StageId; gate: string | null; target: { kind: string; id: string }; reason: string; risk: string; severity: Severity
  caught_where: string | null; scope: string; by: string; at: string; acknowledged: { by: string | null; at: string } | null; closed: boolean; opened_by_you: boolean
}
export interface JourneyView {
  template: Template; template_name: string; revision: string; current_stage: StageId; later: LaterStage[]; start: 'idea' | 'import'
  name: string | null; description: string | null; icon: string | null; build: Build
  stages: StageView[]; gates: GateView[]; next: NextStep; questions: QuestionView[]; waivers: WaiverView[]
  decisions: { id: string; at: string; kind: string; stage: string | null; ref: string | null; summary: string; by: string | null }[]
  firmware_track: boolean
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())
const isoN = (t: number): string => new Date(t * 1000).toISOString()

/** A gate's title for people: "the schematic review gate". */
export const gateTitle = (g: { name: string }): string => `the ${g.name} gate`

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** How long ago, in words: "2 days ago", "3 hours ago", "just now". */
export function ago(t: number, at: number = now()): string {
  const s = Math.max(0, at - t)
  if (s < 90) return 'just now'
  if (s < 90 * 60) return `${plural(Math.round(s / 60), 'minute')} ago`
  if (s < 36 * 3600) return `${plural(Math.round(s / 3600), 'hour')} ago`
  return `${plural(Math.round(s / 86400), 'day')} ago`
}

/** Open waivers (not closed), by the criterion they waive. */
function waiverFor(r: JourneyRecord): Map<string, WaiverRow> {
  const m = new Map<string, WaiverRow>()
  for (const w of r.waivers) if (w.targetKind === 'criterion' && w.closedAt === null) m.set(w.target, w)
  return m
}

const liveSignature = (r: JourneyRecord, gate: string): SignatureRow | null =>
  [...r.signatures].reverse().find((s) => s.gate === gate && s.supersededAt === null && s.revision === r.journey.revision) ?? null

/** The waivers a gate's signer must open and acknowledge: every open waiver taken in that gate's stage. */
const stageWaivers = (r: JourneyRecord, stage: StageId): WaiverRow[] => r.waivers.filter((w) => w.stage === stage && w.closedAt === null)

/**
 * What still stops `viewer` signing gate `id`, in plain words (empty: they may sign). Pass the waiver ids they are
 * acknowledging with the signature; waivers acknowledged before count too.
 */
export function signBlockers(r: JourneyRecord, id: string, viewer: Viewer, acknowledging: readonly string[] = []): string[] {
  const gate = r.gates.find((g) => g.id === id)
  if (!gate) return [`There is no gate called ${id} in this project.`]
  const out: string[] = []
  if (!viewer.admin) out.push('Only an admin can sign a gate.')
  if (gate.stage !== r.journey.currentStage) out.push(`${gateTitle(gate)[0]?.toUpperCase()}${gateTitle(gate).slice(1)} is not in the current stage (${STAGE_NAMES[r.journey.currentStage]}).`)
  if (liveSignature(r, id)) out.push('This gate is already signed.')
  const earlier = r.gates.filter((g) => g.stage === gate.stage && g.ord < gate.ord && !liveSignature(r, g.id))
  for (const g of earlier) out.push(`Sign ${gateTitle(g)} first.`)
  const waived = waiverFor(r)
  const opened = new Set(r.opens.filter((o) => isViewer(viewer, o.who)).map((o) => o.item))
  const criteria = r.criteria.filter((c) => c.gate === id)
  const notMet = criteria.filter((c) => c.status !== 'met' && !waived.has(c.id))
  if (notMet.length) out.push(`${plural(notMet.length, 'criterion is', 'criteria are')} not met or waived: ${notMet.map((c) => c.text.replace(/\.$/, '').toLowerCase()).join('; ')}.`)
  const unopened = criteria.filter((c) => !opened.has(c.id))
  if (unopened.length) out.push(`Open the evidence for ${plural(unopened.length, 'more criterion', 'more criteria')}.`)
  const ws = stageWaivers(r, gate.stage)
  const unopenedW = ws.filter((w) => !opened.has(`waiver:${w.id}`))
  if (unopenedW.length) out.push(`Open ${plural(unopenedW.length, 'waiver')} taken in this stage.`)
  const unack = ws.filter((w) => w.acknowledgedAt === null && !acknowledging.includes(w.id))
  if (unack.length) out.push(`Acknowledge ${plural(unack.length, 'waiver')} taken in this stage.`)
  return out
}

function criterionViews(r: JourneyRecord, gate: string, viewer: Viewer): CriterionView[] {
  const waived = waiverFor(r)
  const opened = new Set(r.opens.filter((o) => isViewer(viewer, o.who)).map((o) => o.item))
  return r.criteria.filter((c) => c.gate === gate).map((c) => {
    const w = waived.get(c.id)
    return {
      id: c.id, text: c.text, owner: c.owner, status: c.status === 'met' ? 'met' : w ? 'waived' : 'not_met', evidence: c.evidence,
      evidence_label: c.evidenceLabel, waiver: w?.id ?? null, opened_by_you: opened.has(c.id), checked_at: iso(c.checkedAt),
    }
  })
}

const isMet = (c: CriterionView): boolean => c.status === 'met' || c.status === 'waived'

/** One gate as people see it (`facts`: the agents' facts, merged in first). */
export function gateView(r0: JourneyRecord, id: string, viewer: Viewer, facts?: AgentFacts | null): GateView {
  const r = facts ? mergeAgentFacts(r0, facts) : r0
  const g = r.gates.find((x) => x.id === id)
  if (!g) throw new JourneyError(`There is no gate called ${id} in this project.`)
  const criteria = criterionViews(r, id, viewer)
  const sig = liveSignature(r, id)
  const curOrd = r.stages.find((s) => s.id === r.journey.currentStage)?.ord ?? 0
  const stageOrd = r.stages.find((s) => s.id === g.stage)?.ord ?? 0
  const met = criteria.filter(isMet).length
  const state: GateState = sig ? 'signed' : stageOrd > curOrd ? 'queued' : met === criteria.length ? 'ready' : 'open'
  const missing = sig ? [] : signBlockers(r, id, viewer)
  return {
    id, stage: g.stage, name: g.name, title: gateTitle(g), state, met, total: criteria.length, criteria,
    waivers: stageWaivers(r, g.stage).map((w) => w.id),
    signature: sig ? { by: sig.by, at: isoN(sig.at), notes: sig.notes } : null,
    returned: g.returnedAt !== null && !sig ? { by: g.returnedBy, at: isoN(g.returnedAt), reason: g.returnReason } : null,
    may_sign: !sig && missing.length === 0, missing,
  }
}

/**
 * Whether a question is for this viewer: asked of them (by sub, or by hash: their sub's, or their email's on questions asked before), of the admins and they are one, or of no
 * one and they are a contributor (or an admin).
 */
const questionFor = (q: QuestionRow, v: Viewer): boolean => {
  if (q.askedOfSub) return q.askedOfSub === v.sub
  if (q.askedOf) return isViewer(v, q.askedOf)
  if (q.askedPart === 'admins') return v.admin
  return v.admin || v.part === 'contributor'
}
/** Whether a question (an agent's included) is for this viewer to answer. */
export const questionIsFor = (q: QuestionRow, v: Viewer): boolean => questionFor(q, v)
const questionForWhom = (q: QuestionRow, v: Viewer): QuestionView['for'] =>
  q.askedOfSub || q.askedOf ? (questionFor(q, v) ? 'you' : 'person') : q.askedPart === 'admins' ? 'admins' : 'contributors'

function questionView(q: QuestionRow, v: Viewer): QuestionView {
  return {
    id: q.id, kind: q.kind, asked_by: q.askedBy, for_you: questionFor(q, v), for: questionForWhom(q, v),
    stage: q.stage, text: q.text, blocks: q.blocks, options: q.options, recommended: q.options.find((o) => o.recommended) ?? null,
    sources: q.sources, job_id: q.jobId, asked_at: isoN(q.askedAt),
    answered: q.answeredAt !== null ? { answer: q.answer ?? '', option_id: q.optionId, reason: q.answerReason, by: q.answeredBy, at: isoN(q.answeredAt) } : null,
    ...(q.recommendation ? { recommendation: q.recommendation } : {}),
  }
}

/** Open questions and stuck agents that block work, oldest first. */
export const blockingQuestions = (r: JourneyRecord): QuestionRow[] =>
  r.questions.filter((q) => q.answeredAt === null && (q.kind === 'stuck' || Boolean(q.blocks?.trim())))

/** The single next step (docs/ui-design.md "The next step card"), for this viewer. */
export function nextStep(r: JourneyRecord, viewer: Viewer, at: number = now()): NextStep {
  const stageId = r.journey.currentStage
  const stage = r.stages.find((s) => s.id === stageId)
  const stageName = STAGE_NAMES[stageId]
  const gates = r.gates.filter((g) => g.stage === stageId)
  const open = gates.find((g) => !liveSignature(r, g.id))
  const last = r.stages.at(-1)
  // The journey is complete: every gate signed (or a gate-less last stage, Sustain, reached).
  if (!open && (stage?.id === last?.id)) {
    if (stageId === 'sustain') return { kind: 'working', belongs_to: 'trace', yours: false, summary: 'trace re-checks every part\'s stock and lifecycle each week.', why: 'Sustain runs on its own schedule until the product is retired.', recommendation: null, button: 'See the parts watch', stage: stageId, ref: null }
    return { kind: 'done', belongs_to: 'trace', yours: false, summary: `Revision ${r.journey.revision} is accepted.`, why: 'Every gate is signed.', recommendation: null, button: 'Read the record', stage: stageId, ref: null }
  }
  const blocking = blockingQuestions(r)
  // Something failed: the current stage was reopened and nothing of it is met again yet.
  if (stage && stage.reopenedAt !== null && open && !blocking.length && r.criteria.filter((c) => c.gate === open.id).every((c) => c.status !== 'met')) {
    const mine = viewer.admin || viewer.part === 'contributor'
    return {
      kind: 'failed', belongs_to: mine ? 'you' : 'contributors', yours: mine, summary: `${stageName} was reopened: ${(stage.reopenedReason ?? 'something failed').replace(/\.$/, '')}.`,
      why: 'A failure reopens the earliest stage it touches, and work starts again from there.', recommendation: null, button: 'See what failed', stage: stageId, ref: { kind: 'stage', id: stageId },
    }
  }
  // A question blocks work.
  const q = blocking[0]
  if (q) {
    const rec = q.options.find((o) => o.recommended)
    const forYou = questionFor(q, viewer)
    const verb = q.kind === 'stuck' ? `${q.askedBy} is stuck` : `${q.askedBy} asks`
    if (forYou) {
      return {
        kind: 'answer', belongs_to: 'you', yours: true, summary: `${verb}: ${q.text}`, why: q.blocks ? `It blocks ${q.blocks.replace(/\.$/, '')}.` : 'The agent cannot go on without it.',
        recommendation: rec ? `trace recommends ${rec.label}${rec.why ? `: ${rec.why}` : ''}` : q.recommendation ? `${q.askedBy} recommends: ${q.recommendation}` : null,
        button: rec ? `Use ${rec.label}` : 'Answer', stage: q.stage, ref: { kind: 'question', id: q.id },
      }
    }
    return {
      kind: 'waiting_person', belongs_to: q.askedOf || q.askedOfSub ? 'person' : q.askedPart === 'admins' ? 'admins' : 'contributors', yours: false,
      summary: `Waiting for ${q.askedOf || q.askedOfSub ? 'a person on the project' : q.askedPart === 'admins' ? 'an admin' : 'a contributor'} to answer: ${q.text} Asked ${ago(q.askedAt, at)}.`,
      why: q.blocks ? `It blocks ${q.blocks.replace(/\.$/, '')}.` : 'The agent cannot go on without it.', recommendation: null,
      button: viewer.admin ? 'Answer it for them' : 'Read the question', stage: q.stage, ref: { kind: 'question', id: q.id },
    }
  }
  if (!open) {
    return { kind: 'working', belongs_to: 'trace', yours: false, summary: `trace is preparing ${stageName}.`, why: 'The stage has no gate of its own.', recommendation: null, button: 'Watch', stage: stageId, ref: { kind: 'stage', id: stageId } }
  }
  const g = gateView(r, open.id, viewer)
  if (g.state === 'ready') {
    const waivers = g.waivers.length ? `, ${plural(g.waivers.length, 'waiver')} taken` : ''
    const all = g.criteria.every((c) => c.status === 'met') ? `All ${g.total} criteria met` : `All ${g.total} criteria met or waived`
    if (viewer.admin) {
      return {
        kind: 'gate', belongs_to: 'you', yours: true, summary: `${cap(g.title)} is ready. ${all}${waivers}. trace recommends signing.`,
        why: `Work on the next stage starts only when ${g.title} is signed.`, recommendation: 'trace recommends signing.', button: 'Review and sign', stage: stageId, ref: { kind: 'gate', id: g.id },
      }
    }
    return {
      kind: 'gate', belongs_to: 'admins', yours: false, summary: `${cap(g.title)} is waiting for an admin to sign. ${all}${waivers}.`,
      why: 'Only an admin can sign a gate.', recommendation: null, button: 'Read the evidence', stage: stageId, ref: { kind: 'gate', id: g.id },
    }
  }
  // Waiting on someone outside: the order is signed and the boards are on their way.
  if (open.id === 'fabricate.received' && g.criteria.every((c) => c.status !== 'met')) {
    const fab = r.journey.build.fab
    return {
      kind: 'waiting_outside', belongs_to: 'outside', yours: false, summary: `Waiting for ${fab} to make and ship the boards.`,
      why: 'The order is signed; bring-up starts the day the boards arrive.', recommendation: null, button: 'Check now', stage: stageId, ref: { kind: 'gate', id: g.id },
    }
  }
  const unmet = g.criteria.filter((c) => c.status === 'not_met')
  const first = unmet.find((c) => c.owner === 'person') ?? unmet[0]
  const progress = `${g.met} of ${g.total} criteria met`
  if (first?.owner === 'person') {
    const mine = viewer.admin || viewer.part === 'contributor'
    return {
      kind: 'task', belongs_to: mine ? 'you' : 'contributors', yours: mine, summary: `${stageName}: ${first.text}`,
      why: `${cap(g.title)} needs it (${progress}).`, recommendation: null, button: mine ? 'Continue' : 'Read the stage', stage: stageId, ref: { kind: 'criterion', id: first.id },
    }
  }
  return {
    kind: 'working', belongs_to: 'trace', yours: false, summary: `trace is working on ${stageName}: ${(first?.text ?? '').replace(/\.$/, '').toLowerCase()}.`,
    why: `${cap(g.title)} needs it (${progress}).`, recommendation: null, button: 'Watch', stage: stageId, ref: first ? { kind: 'criterion', id: first.id } : null,
  }
}

const cap = (s: string): string => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`

/** The whole journey as people see it, for this viewer (`facts`: the agents' facts, merged in first). */
export function journeyView(r0: JourneyRecord, viewer: Viewer, at: number = now(), facts?: AgentFacts | null): JourneyView {
  const r = withoutDismissed(facts ? mergeAgentFacts(r0, facts) : r0)
  const curOrd = r.stages.find((s) => s.id === r.journey.currentStage)?.ord ?? 0
  const gates = r.gates.map((g) => gateView(r, g.id, viewer))
  const stages: StageView[] = r.stages.map((s) => {
    const own = gates.filter((g) => g.stage === s.id)
    const met = own.reduce((n, g) => n + g.met, 0)
    const total = own.reduce((n, g) => n + g.total, 0)
    const state: StageState = s.ord < curOrd ? 'done' : s.ord > curOrd ? 'queued' : s.reopenedAt !== null ? 'reopened' : 'current'
    const progress = state === 'done' ? 'Done' : state === 'queued'
      ? `Queued: starts when ${gateTitle(r.gates.filter((g) => r.stages.find((x) => x.id === g.stage)!.ord < s.ord).at(-1) ?? { name: 'previous' })} is signed`
      : total ? `${STAGE_NAMES[s.id]} · ${met} of ${total} criteria met` : STAGE_NAMES[s.id]
    return {
      id: s.id, name: STAGE_NAMES[s.id], optional: (LATER_STAGES as readonly string[]).includes(s.id), state, met, total, progress,
      started: iso(s.started), finished: iso(s.finished), reopened: s.reopenedAt !== null ? { at: isoN(s.reopenedAt), reason: s.reopenedReason } : null,
      gates: own.map((g) => g.id),
    }
  })
  const opened = new Set(r.opens.filter((o) => isViewer(viewer, o.who)).map((o) => o.item))
  return {
    template: r.journey.template, template_name: TEMPLATE_NAMES[r.journey.template], revision: r.journey.revision, current_stage: r.journey.currentStage,
    later: r.journey.later, start: r.journey.start, name: r.journey.name, description: r.journey.description, icon: r.journey.icon, build: r.journey.build,
    stages, gates, next: nextStep(r, viewer, at),
    questions: r.questions.map((q) => questionView(q, viewer)),
    waivers: r.waivers.map((w) => ({
      id: w.id, stage: w.stage, gate: w.gate, target: { kind: w.targetKind, id: w.target }, reason: w.reason, risk: w.risk, severity: w.severity,
      caught_where: w.caughtWhere, scope: w.scope, by: w.by, at: isoN(w.at), acknowledged: w.acknowledgedAt !== null ? { by: w.acknowledgedBy, at: isoN(w.acknowledgedAt) } : null,
      closed: w.closedAt !== null, opened_by_you: opened.has(`waiver:${w.id}`),
    })),
    decisions: r.decisions.slice(0, 200).map((d) => ({ id: d.id, at: isoN(d.at), kind: d.kind, stage: d.stage, ref: d.ref, summary: d.summary, by: d.by })),
    firmware_track: r.journey.template === 'firmware' || r.journey.template === 'mixed',
  }
}

// ------------------------------------------------------------------ writes

/** Add one entry to the decisions log (plain words); returns its id. */
export function decide(db: DatabaseSync, d: { kind: string; stage: string | null; ref: string | null; summary: string; by: string | null; detail?: unknown }): string {
  const id = newId()
  db.prepare('INSERT INTO decisions (id, at, kind, stage, ref, summary, by, detail) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, now(), d.kind, d.stage, d.ref, d.summary, d.by, d.detail === undefined ? null : JSON.stringify(d.detail))
  return id
}

export interface StartOptions {
  template: Template
  later?: readonly LaterStage[] | undefined
  start?: 'idea' | 'import' | undefined
  name?: string | null | undefined
  description?: string | null | undefined
  icon?: string | null | undefined
  build?: z.input<typeof BuildSchema> | undefined
  by: string
  revision?: string | undefined
}

/** Write a project's first journey state from its template. Refuses when the project already has a journey. */
export function startJourney(db: DatabaseSync, o: StartOptions): JourneyRecord {
  if (hasJourney(db)) throw new JourneyError('This project already has a journey; its template cannot change.')
  const stages = templateStages(o.template, o.later ?? [])
  const first = stages[0]
  if (!first) throw new JourneyError('The template has no stages.')
  const t = now()
  const revision = o.revision ?? 'A'
  transaction(db, () => {
    db.prepare(`INSERT INTO journey (id, template, revision, current_stage, later, start, name, description, icon, build, created, updated, by)
      VALUES ('current',?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.template, revision, first.id, JSON.stringify(o.later ?? []), o.start ?? 'idea',
      o.name ?? null, o.description ?? null, o.icon ?? null, JSON.stringify(BuildSchema.parse(o.build ?? {})), t, t, o.by)
    let gateOrd = 0
    stages.forEach((s, i) => {
      db.prepare('INSERT OR REPLACE INTO stages (id, ord, revision, started, finished, updated) VALUES (?,?,?,?,NULL,?)').run(s.id, i, revision, i === 0 ? t : null, t)
      for (const g of s.gates) {
        db.prepare('INSERT OR REPLACE INTO gates (id, stage, ord, name, updated) VALUES (?,?,?,?,?)').run(g.id, s.id, gateOrd++, g.name, t)
        g.criteria.forEach((c, k) => {
          db.prepare("INSERT OR REPLACE INTO gate_criteria (id, gate, ord, text, owner, evidence_label, status, evidence, updated) VALUES (?,?,?,?,?,?,'not_met','[]',?)")
            .run(c.id, g.id, k, c.text, c.owner, c.evidence, t)
        })
      }
    })
    decide(db, { kind: 'journey.started', stage: first.id, ref: null, by: o.by, summary: `The project started from the ${TEMPLATE_NAMES[o.template]} template, at ${STAGE_NAMES[first.id]}.`, detail: { template: o.template, later: o.later ?? [] } })
  })
  return loadJourney(db) as JourneyRecord
}

const need = (db: DatabaseSync): JourneyRecord => {
  const r = loadJourney(db)
  if (!r) throw new JourneyError('This project has no journey yet. An admin starts one by choosing a template.')
  return r
}

/** Record that a person opened a criterion's (or a waiver's) evidence: the Sign button needs it. */
export function recordOpen(db: DatabaseSync, item: { criterion: string } | { waiver: string }, who: string): { item: string; at: string } {
  const r = need(db)
  let key: string
  if ('criterion' in item) {
    if (!r.criteria.some((c) => c.id === item.criterion)) throw new JourneyError(`There is no criterion called ${item.criterion} in this project.`)
    key = item.criterion
  } else {
    if (!r.waivers.some((w) => w.id === item.waiver)) throw new JourneyError(`There is no waiver ${item.waiver} in this project.`)
    key = `waiver:${item.waiver}`
  }
  const t = now()
  db.prepare('INSERT INTO criterion_opens (item, who, at) VALUES (?,?,?) ON CONFLICT(item, who) DO UPDATE SET at=excluded.at').run(key, who, t)
  return { item: key, at: isoN(t) }
}

/** Mark a criterion met or not met, with its evidence (trace's checker tools). */
export function setCriterion(db: DatabaseSync, id: string, status: 'met' | 'not_met', evidence: readonly Evidence[], by: string): void {
  const n = db.prepare('UPDATE gate_criteria SET status=?, evidence=?, checked_at=?, checked_by=?, updated=? WHERE id=?')
    .run(status, JSON.stringify(evidence), now(), by, now(), id).changes
  if (!Number(n)) throw new JourneyError(`There is no criterion called ${id} in this project.`)
}

export interface Signer { hash: string; label: string; also?: readonly string[] | undefined }

/** Sign a gate (the caller has checked the signer is an admin). Moves the project on when it closes the stage. */
export function signGate(db: DatabaseSync, id: string, signer: Signer, o: { acknowledged?: readonly string[] | undefined; notes?: string | null | undefined; facts?: AgentFacts | null | undefined } = {}): { gate: GateView; advanced_to: StageId | null; released: boolean; summary: string } {
  // the agents' checks of the criteria trace owns count; the signing rules are the same
  const r = withFacts(need(db), o.facts)
  const viewer: Viewer = { hash: signer.hash, label: signer.label, also: signer.also, admin: true, part: 'contributor' }
  const blockers = signBlockers(r, id, viewer, o.acknowledged ?? [])
  if (blockers.length) throw new JourneyError(`The gate cannot be signed yet. ${blockers.join(' ')}`)
  const gate = r.gates.find((g) => g.id === id) as GateRow
  const t = now()
  let advanced: StageId | null = null
  transaction(db, () => {
    const ws = stageWaivers(r, gate.stage)
    for (const w of ws) if (w.acknowledgedAt === null) db.prepare('UPDATE waivers SET acknowledged_by=?, acknowledged_at=?, updated=? WHERE id=?').run(signer.label, t, t, w.id)
    const criteria = criterionViews(r, id, viewer).map((c) => ({ id: c.id, text: c.text, status: c.status, evidence: c.evidence, waiver: c.waiver }))
    db.prepare('INSERT INTO gate_signatures (id, gate, revision, by, by_hash, at, criteria, waivers, notes) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId(), id, r.journey.revision, signer.label, signer.hash, t, JSON.stringify(criteria), JSON.stringify(ws.map((w) => w.id)), o.notes ?? null)
    db.prepare('UPDATE gates SET returned_at=NULL, returned_by=NULL, return_reason=NULL, updated=? WHERE id=?').run(t, id)
    const closesStage = r.gates.filter((g) => g.stage === gate.stage).every((g) => g.id === id || liveSignature(r, g.id))
    if (closesStage) advanced = advance(db, r, gate.stage, t)
    decide(db, {
      kind: 'gate.signed', stage: gate.stage, ref: id, by: signer.label,
      summary: `${cap(gateTitle(gate))} was signed${ws.length ? ` with ${plural(ws.length, 'waiver')} acknowledged` : ''}.${advanced ? ` ${STAGE_NAMES[advanced]} starts now.` : ''}`,
      detail: { notes: o.notes ?? null },
    })
  })
  const after = withFacts(need(db), o.facts)
  // the Release stage has no gate of its own: it is passed by the signature before it, and that is when a release is cut
  const ord = (st: StageId | null): number => r.stages.find((x) => x.id === st)?.ord ?? -1
  const released = advanced !== null && r.stages.some((x) => x.id === 'release') && ord(gate.stage) < ord('release') && ord('release') < ord(advanced)
  return { gate: gateView(after, id, viewer), advanced_to: advanced, released, summary: `Gate signed.${advanced ? ` ${STAGE_NAMES[advanced]} started.` : ''}` }
}

/** Close `from` and open the next stage; a stage with no gate (Release) is passed with it. Returns the new stage. */
function advance(db: DatabaseSync, r: JourneyRecord, from: StageId, t: number): StageId | null {
  const order = r.stages
  let i = order.findIndex((s) => s.id === from)
  db.prepare('UPDATE stages SET finished=?, reopened_at=NULL, reopened_reason=NULL, reopened_by=NULL, updated=? WHERE id=?').run(t, t, from)
  for (;;) {
    const next = order[++i]
    if (!next) return null
    db.prepare('UPDATE stages SET started=COALESCE(started, ?), finished=NULL, updated=? WHERE id=?').run(t, t, next.id)
    db.prepare('UPDATE journey SET current_stage=?, updated=? WHERE id=\'current\'').run(next.id, t)
    const hasGate = r.gates.some((g) => g.stage === next.id)
    if (hasGate || i === order.length - 1) return next.id
    // a stage without a gate (Release) is a product of the approval before it: passed at once
    db.prepare('UPDATE stages SET finished=?, updated=? WHERE id=?').run(t, t, next.id)
  }
}

/**
 * Return a gate with what has to change (any contributor or admin). With `reopen`, an earlier stage the problem
 * belongs to is reopened: the project goes back there, and the signatures of the gates from there on stop counting.
 */
export function returnGate(db: DatabaseSync, id: string, by: Signer, o: { reason: string; reopen?: StageId | undefined }): { gate: GateView; reopened: StageId | null } {
  const r = need(db)
  const gate = r.gates.find((g) => g.id === id)
  if (!gate) throw new JourneyError(`There is no gate called ${id} in this project.`)
  if (gate.stage !== r.journey.currentStage) throw new JourneyError(`Only a gate of the current stage (${STAGE_NAMES[r.journey.currentStage]}) can be returned.`)
  if (liveSignature(r, id)) throw new JourneyError('This gate is already signed.')
  const reason = o.reason.trim()
  if (reason.length < 5) throw new JourneyError('Say what has to change before the gate can be signed.')
  const t = now()
  let reopened: StageId | null = null
  transaction(db, () => {
    db.prepare('UPDATE gates SET returned_at=?, returned_by=?, return_reason=?, updated=? WHERE id=?').run(t, by.label, reason, t, id)
    decide(db, { kind: 'gate.returned', stage: gate.stage, ref: id, by: by.label, summary: `${cap(gateTitle(gate))} was returned: ${reason}` })
    if (o.reopen && o.reopen !== gate.stage) {
      const target = r.stages.find((s) => s.id === o.reopen)
      const cur = r.stages.find((s) => s.id === gate.stage) as StageRow
      if (!target) throw new JourneyError(`This project has no ${o.reopen} stage.`)
      if (target.ord > cur.ord) throw new JourneyError('Only an earlier stage can be reopened.')
      reopenStage(db, r, target.id, reason, by.label, t)
      reopened = target.id
    } else if (o.reopen === gate.stage) {
      db.prepare('UPDATE stages SET reopened_at=?, reopened_reason=?, reopened_by=?, updated=? WHERE id=?').run(t, reason, by.label, t, gate.stage)
    }
  })
  return { gate: gateView(need(db), id, { hash: by.hash, label: by.label, also: by.also, admin: false, part: 'contributor' }), reopened }
}

function reopenStage(db: DatabaseSync, r: JourneyRecord, stage: StageId, reason: string, by: string, t: number): void {
  const target = r.stages.find((s) => s.id === stage) as StageRow
  const later = r.stages.filter((s) => s.ord >= target.ord).map((s) => s.id)
  const gates = r.gates.filter((g) => later.includes(g.stage)).map((g) => g.id)
  for (const g of gates) db.prepare('UPDATE gate_signatures SET superseded_at=? WHERE gate=? AND superseded_at IS NULL').run(t, g)
  for (const s of later) db.prepare('UPDATE stages SET finished=NULL, updated=? WHERE id=?').run(t, s)
  db.prepare('UPDATE stages SET reopened_at=?, reopened_reason=?, reopened_by=?, started=COALESCE(started, ?), updated=? WHERE id=?').run(t, reason, by, t, t, stage)
  db.prepare('UPDATE journey SET current_stage=?, updated=? WHERE id=\'current\'').run(stage, t)
  decide(db, { kind: 'stage.reopened', stage, ref: stage, by, summary: `${STAGE_NAMES[stage]} was reopened: ${reason}` })
}

const VAGUE = /^(it depends|you decide|not needed|n\/?a|none|no|ok|yes|whatever)\.?$/i

/**
 * Answer an agent's question: the recommended option, another option with a reason, or an answer in words with a reason.
 * With `facts`, a question an agent keeps in its own facts (src/core/agent-facts.ts) is answered here under its id: the
 * question is copied into this record with the answer, so the record keeps what was asked and the agent reads the answer.
 */
export function answerQuestion(db: DatabaseSync, id: string, by: Signer, a: { option?: string | undefined; answer?: string | undefined; reason?: string | undefined }, o: { facts?: AgentFacts | null | undefined } = {}): QuestionView {
  const r0 = need(db)
  if (!r0.questions.some((x) => x.id === id) && o.facts) {
    const fact = withFacts(r0, o.facts).questions.find((x) => x.id === id)
    if (fact) {
      db.prepare(`INSERT INTO questions (id, kind, asked_by, asked_of, stage, text, blocks, options, sources, job_id, asked_at, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, fact.kind, fact.askedBy, null, fact.stage, fact.text, fact.blocks, JSON.stringify(fact.options), JSON.stringify(fact.sources), fact.jobId, fact.askedAt, now())
    }
  }
  const r = need(db)
  const q = r.questions.find((x) => x.id === id)
  if (!q) throw new JourneyError(`There is no question ${id} in this project.`)
  if (q.answeredAt !== null) throw new JourneyError('This question is already answered.')
  const opt = a.option ? q.options.find((o) => o.id === a.option) : undefined
  if (a.option && !opt) throw new JourneyError(`The question has no option ${a.option}.`)
  const text = (a.answer ?? opt?.label ?? '').trim()
  if (!text) throw new JourneyError('Choose an option or write an answer.')
  if (!opt && VAGUE.test(text)) throw new JourneyError('That answer does not unblock the agent. Say what to do, with a number and unit for a quantity.')
  const recommended = q.options.find((o) => o.recommended)
  const differs = !opt || (recommended !== undefined && opt.id !== recommended.id)
  const reason = a.reason?.trim() ?? ''
  if (differs && recommended && reason.length < 3) throw new JourneyError(`trace recommended "${recommended.label}". Say in a line why you chose otherwise.`)
  const t = now()
  transaction(db, () => {
    db.prepare('UPDATE questions SET answer=?, option_id=?, answer_reason=?, answered_by=?, answered_by_hash=?, answered_at=?, updated=? WHERE id=?')
      .run(text, opt?.id ?? null, reason || null, by.label, by.hash, t, t, id)
    decide(db, {
      kind: 'question.answered', stage: q.stage, ref: id, by: by.label,
      summary: `${q.askedBy} asked: ${q.text} Answered: ${text}${differs && recommended ? ` (not the recommended ${recommended.label}, because ${reason})` : ''}.`,
    })
  })
  const after = withFacts(need(db), o.facts).questions.find((x) => x.id === id) as QuestionRow
  return questionView(after, { hash: by.hash, label: by.label, also: by.also, admin: false, part: 'contributor' })
}

export interface WaiverInput {
  target: { kind: (typeof WAIVER_TARGETS)[number]; id: string }
  reason: string
  risk: string
  severity: Severity
  /** where it is caught instead (a later stage, a bench test), or null: accepted for good */
  caught_where: string | null
  scope: string
}

/** Take a waiver (the Waiver skill's quality bar is checked here). */
export function addWaiver(db: DatabaseSync, w: WaiverInput, by: Signer, o: { facts?: AgentFacts | null | undefined } = {}): WaiverView {
  const r = withFacts(need(db), o.facts)
  const reason = w.reason.trim()
  if (reason.length < 10 || VAGUE.test(reason)) throw new JourneyError('Give the reason it cannot or need not be met now; "not needed" alone is not enough.')
  if (w.risk.trim().length < 5) throw new JourneyError('Say what goes wrong if the reason is mistaken.')
  if (w.severity === 'safety' && !w.caught_where?.trim()) throw new JourneyError('A waiver rated safety must say where it is checked instead; it cannot be accepted for good.')
  if (!w.scope.trim()) throw new JourneyError('Say the scope: this revision only, or until a named condition changes.')
  let gate: string | null = null
  let stage = r.journey.currentStage
  if (w.target.kind === 'criterion') {
    const c = r.criteria.find((x) => x.id === w.target.id)
    if (!c) throw new JourneyError(`There is no criterion called ${w.target.id} in this project.`)
    if (c.status === 'met') throw new JourneyError('That criterion is already met; there is nothing to waive.')
    gate = c.gate
    stage = (r.gates.find((g) => g.id === c.gate) as GateRow).stage
    if (r.waivers.some((x) => x.targetKind === 'criterion' && x.target === c.id && x.closedAt === null)) throw new JourneyError('That criterion is already waived.')
  }
  const id = newId()
  const t = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO waivers (id, stage, gate, target_kind, target, reason, risk, severity, caught_where, scope, by, at, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, stage, gate, w.target.kind, w.target.id, reason, w.risk.trim(), w.severity, w.caught_where?.trim() || null, w.scope.trim(), by.label, t, t)
    decide(db, { kind: 'waiver.added', stage, ref: id, by: by.label, summary: `A waiver was taken on ${w.target.kind} ${w.target.id} (rated ${w.severity}): ${reason}` })
  })
  const v = journeyView(need(db), { hash: by.hash, label: by.label, also: by.also, admin: false, part: 'contributor' })
  return v.waivers.find((x) => x.id === id) as WaiverView
}

/** An agent asks a person (or the project's contributors) a question, or says it is stuck. */
export function askQuestion(db: DatabaseSync, q: {
  askedBy: string; askedOf?: string | null | undefined; kind?: 'question' | 'stuck' | undefined; text: string; blocks?: string | null | undefined
  options?: readonly z.input<typeof OptionSchema>[] | undefined; sources?: readonly Evidence[] | undefined; jobId?: string | null | undefined; stage?: StageId | undefined
}): string {
  const r = need(db)
  const options = (q.options ?? []).map((o) => OptionSchema.parse(o))
  // the recommended option always comes first
  options.sort((a, b) => Number(b.recommended) - Number(a.recommended))
  const id = newId()
  const t = now()
  db.prepare(`INSERT INTO questions (id, kind, asked_by, asked_of, stage, text, blocks, options, sources, job_id, asked_at, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, q.kind ?? 'question', q.askedBy, q.askedOf ?? null, q.stage ?? r.journey.currentStage, q.text, q.blocks ?? null, JSON.stringify(options), JSON.stringify(q.sources ?? []), q.jobId ?? null, t, t)
  return id
}


// ------------------------------------------------------------------ orders

export const ORDER_STATES = ['placed', 'shipped', 'delivered', 'cancelled'] as const
export interface OrderRow {
  id: string; revision: string; fab: string; number: string; boards: number; paid: number | null; currency: string; shipDate: string | null
  state: (typeof ORDER_STATES)[number]; placedBy: string; placedAt: number; shippedAt: number | null; deliveredAt: number | null; note: string | null
}

/** Every order recorded, newest first (none for a project whose record predates orders). */
export function loadOrders(db: DatabaseSync): OrderRow[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get()) return []
  return (db.prepare('SELECT * FROM orders ORDER BY placed_at DESC').all() as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), revision: String(r.revision), fab: String(r.fab), number: String(r.number), boards: Number(r.boards), paid: num(r.paid),
    currency: String(r.currency), shipDate: str(r.ship_date), state: r.state as OrderRow['state'], placedBy: String(r.placed_by), placedAt: Number(r.placed_at),
    shippedAt: num(r.shipped_at), deliveredAt: num(r.delivered_at), note: str(r.note),
  }))
}

export interface OrderInput { number: string; paid: number | null; ship_date: string | null; boards?: number | undefined; note?: string | null | undefined }

/**
 * Record an order placed with the fab (Order submit's last step). The same fab order number again updates that order
 * (a corrected cost or ship date) rather than adding a second one. Logged in the decisions.
 */
export function recordOrder(db: DatabaseSync, o: OrderInput, by: Signer): { order: OrderRow; created: boolean } {
  const r = need(db)
  const number = o.number.trim()
  if (!number) throw new JourneyError('Give the order number the fab gave you.')
  if (o.paid !== null && !(o.paid >= 0)) throw new JourneyError('The amount paid cannot be negative.')
  if (o.ship_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.ship_date)) throw new JourneyError('Give the ship date as a date (2026-11-04).')
  const b = r.journey.build
  const t = now()
  const existing = loadOrders(db).find((x) => x.number === number && x.fab === b.fab)
  const id = existing?.id ?? newId()
  transaction(db, () => {
    if (existing) {
      db.prepare('UPDATE orders SET paid=?, ship_date=?, boards=?, note=COALESCE(?, note), updated=? WHERE id=?')
        .run(o.paid, o.ship_date, o.boards ?? existing.boards, o.note ?? null, t, id)
    } else {
      db.prepare(`INSERT INTO orders (id, revision, fab, number, boards, paid, currency, ship_date, state, placed_by, placed_at, note, updated)
        VALUES (?,?,?,?,?,?,?,?,'placed',?,?,?,?)`).run(id, r.journey.revision, b.fab, number, o.boards ?? b.quantity, o.paid, b.currency, o.ship_date, by.label, t, o.note ?? null, t)
    }
    const paid = o.paid === null ? 'cost not given' : `${b.currency} ${o.paid.toFixed(2)} paid`
    decide(db, {
      kind: existing ? 'order.updated' : 'order.placed', stage: 'fabricate', ref: id, by: by.label,
      summary: `${existing ? 'Order updated' : 'Order placed'} with ${b.fab}: number ${number}, ${plural(o.boards ?? existing?.boards ?? b.quantity, 'board')}, ${paid}${o.ship_date ? `, shipping ${o.ship_date}` : ''}.`,
      detail: { number, paid: o.paid, ship_date: o.ship_date },
    })
  })
  return { order: loadOrders(db).find((x) => x.id === id) as OrderRow, created: !existing }
}

// ------------------------------------------------------------------ guided-skill drafts (the store only)

export interface SkillDraft { skill: string; step: number; data: unknown; saved: string }

/** This person's draft of one skill, or null. */
export function getDraft(db: DatabaseSync, who: string, skill: string): SkillDraft | null {
  const r = db.prepare('SELECT step, data, saved FROM skill_drafts WHERE who=? AND skill=?').get(who, skill) as Record<string, unknown> | undefined
  return r ? { skill, step: Number(r.step), data: json<unknown>(r.data, null), saved: isoN(Number(r.saved)) } : null
}

/** Keep (or with data null, discard) this person's draft of one skill. At most 256 KB. */
export function putDraft(db: DatabaseSync, who: string, skill: string, d: { step: number; data: unknown } | null): boolean {
  if (d === null) return Number(db.prepare('DELETE FROM skill_drafts WHERE who=? AND skill=?').run(who, skill).changes) > 0
  const text = JSON.stringify(d.data ?? null)
  if (text.length > 256 * 1024) throw new JourneyError('The draft is larger than 256 KB; it was not saved.')
  db.prepare('INSERT INTO skill_drafts (who, skill, step, data, saved) VALUES (?,?,?,?,?) ON CONFLICT(who, skill) DO UPDATE SET step=excluded.step, data=excluded.data, saved=excluded.saved')
    .run(who, skill, d.step, text, now())
  return true
}

// ------------------------------------------------------------------ the inbox

export const INBOX_KINDS = ['gate', 'question', 'spend', 'stuck'] as const
export interface InboxItem {
  id: string; kind: (typeof INBOX_KINDS)[number]; repo: string; project: string; stage: StageId; summary: string
  since: string; waited: string; blocking: boolean; action: string; ref: { kind: 'gate' | 'question'; id: string }
  recommended?: { id: string; label: string } | undefined
}

/**
 * The four kinds that earn a notification on one project, for one viewer (docs/ui-design.md "Notifications"): gates
 * and spend go to admins; questions and stuck agents to the person asked, or the contributors when no one was.
 */
export function inboxItems(repo: string, r0: JourneyRecord, viewer: Viewer, at: number = now(), facts?: AgentFacts | null): InboxItem[] {
  const r = withoutDismissed(facts ? mergeAgentFacts(r0, facts) : r0)
  const out: InboxItem[] = []
  const project = r.journey.name ?? repo
  const stage = r.journey.currentStage
  const lead = `${project}: `
  if (viewer.admin) {
    for (const g of r.gates.filter((x) => x.stage === stage)) {
      const v = gateView(r, g.id, viewer)
      if (v.state !== 'ready') continue
      const since = Math.max(...r.criteria.filter((c) => c.gate === g.id).map((c) => c.checkedAt ?? 0), r.stages.find((s) => s.id === stage)?.started ?? 0)
      if (g.id === 'fabricate.order') {
        const b = r.journey.build
        const cost = b.unit_cost !== null ? ` about ${b.currency === 'USD' ? 'US$' : `${b.currency} `}${Math.round(b.unit_cost * b.quantity)}` : ''
        out.push({ id: `spend:${g.id}`, kind: 'spend', repo, project, stage, summary: `${lead}the order for ${plural(b.quantity, 'board')} is ready${cost ? `:${cost}` : ''}. Money is spent when you sign.`, since: isoN(since), waited: ago(since, at), blocking: true, action: 'Review order', ref: { kind: 'gate', id: g.id } })
        continue
      }
      out.push({ id: `gate:${g.id}`, kind: 'gate', repo, project, stage, summary: `${lead}${v.title} is ready. All ${v.total} criteria met or waived; trace recommends signing.`, since: isoN(since), waited: ago(since, at), blocking: true, action: 'Review and sign', ref: { kind: 'gate', id: g.id } })
    }
  }
  for (const q of r.questions) {
    if (q.answeredAt !== null || !questionFor(q, viewer)) continue
    if (q.kind === 'question' && !q.blocks?.trim()) continue
    const rec = q.options.find((o) => o.recommended)
    out.push({
      id: `question:${q.id}`, kind: q.kind === 'stuck' ? 'stuck' : 'question', repo, project, stage: q.stage ?? stage,
      summary: `${lead}${q.kind === 'stuck' ? `${q.askedBy} is stuck: ` : `${q.askedBy} asks: `}${q.text}${rec ? ` It recommends ${rec.label}.` : q.recommendation ? ` It recommends: ${q.recommendation.replace(/\.$/, '')}.` : ''}`,
      since: isoN(q.askedAt), waited: ago(q.askedAt, at), blocking: q.kind === 'stuck' || Boolean(q.blocks?.trim()), action: q.kind === 'stuck' ? 'See options' : 'Answer',
      ref: { kind: 'question', id: q.id }, ...(rec ? { recommended: { id: rec.id, label: rec.label } } : {}),
    })
  }
  return out
}

/** Most blocking first, then the oldest. */
export const sortInbox = (items: InboxItem[]): InboxItem[] =>
  [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.since.localeCompare(b.since))

// ------------------------------------------------------------------ the agents' facts (src/core/agent-facts.ts)

/** An agent's question for a person, the project's contributors or its admins (its own facts, never this record). */
export interface AgentQuestion {
  id: string; askedBy: string; askedOfSub: string | null; askedPart: AskedPart; stage: StageId | null; text: string; blocks: string | null
  options: OptionRow[]; sources: Evidence[]; jobId: string | null; askedAt: number
}
/** An agent's check of a criterion trace owns: the newest one for a criterion supersedes the ones before it. */
export interface CriterionCheck {
  id: string; criterion: string; status: 'met' | 'not_met'; evidence: Evidence[]; checkedAt: number; by: string; jobId: string | null; revision: string | null
}
/** An agent that is stuck: why, what it recommends, and its options when it has any. */
export interface StuckFact {
  id: string; jobId: string | null; agent: string; why: string; recommendation: string; options: OptionRow[]; sources: Evidence[]
  stage: StageId | null; at: number; resolvedAt: number | null
}
/** What the agents contributed to one project (the newest check per criterion only). */
export interface AgentFacts { questions: AgentQuestion[]; checks: CriterionCheck[]; stuck: StuckFact[] }
export const NO_AGENT_FACTS: AgentFacts = { questions: [], checks: [], stuck: [] }

const withFacts = (r: JourneyRecord, f: AgentFacts | null | undefined): JourneyRecord => (f ? mergeAgentFacts(r, f) : r)

/** The record without the stuck items a person dismissed (stuck.dismiss): what Home, the inbox and journey.get show. */
export function withoutDismissed(r: JourneyRecord): JourneyRecord {
  if (!r.dismissals?.length) return r
  const gone = new Set(r.dismissals.map((d) => d.stuckId))
  return { ...r, questions: r.questions.filter((q) => q.kind !== 'stuck' || !gone.has(q.id)) }
}

/**
 * A person dismisses a stuck agent's report, with a reason in one line: it leaves every view (withoutDismissed), the
 * decisions log keeps it, and the agent reads the dismissal and its reason (journey.status). The agent's own fact is
 * not changed (people never write the agents' facts); a newer stuck report of the same job is a new item.
 */
export function dismissStuck(db: DatabaseSync, id: string, by: Signer, reason: string, o: { facts?: AgentFacts | null | undefined } = {}): { id: string; job_id: string | null; reason: string; by: string; at: string } {
  const r = withFacts(need(db), o.facts)
  const dismissed = new Set((r.dismissals ?? []).map((d) => d.stuckId))
  // the stuck item's own id, or its job's (the newest of that job's not yet dismissed)
  const stuck = r.questions.filter((x) => x.kind === 'stuck')
  const q = stuck.find((x) => x.id === id) ?? stuck.filter((x) => x.jobId === id && !dismissed.has(x.id)).at(-1)
  if (!q) throw new JourneyError(`There is no stuck report of ${id} in this project.`)
  if (dismissed.has(q.id)) throw new JourneyError('This stuck report is already dismissed.')
  if (q.answeredAt !== null) throw new JourneyError('This stuck report is already answered.')
  const why = reason.trim()
  if (why.length < 3 || VAGUE.test(why)) throw new JourneyError('Say in a line why it can be dismissed, so the agent knows what to do instead.')
  if (/[\r\n]/.test(why)) throw new JourneyError('Keep the reason to one line.')
  const t = now()
  transaction(db, () => {
    db.prepare('INSERT INTO stuck_dismissals (stuck_id, job_id, reason, by, by_hash, at) VALUES (?,?,?,?,?,?)').run(q.id, q.jobId, why, by.label, by.hash, t)
    decide(db, { kind: 'stuck.dismissed', stage: q.stage, ref: q.id, by: by.label, summary: `${cap(q.askedBy)} was stuck: ${q.text} Dismissed: ${why}` })
  })
  return { id: q.id, job_id: q.jobId, reason: why, by: by.label, at: isoN(t) }
}

/**
 * The record with the agents' facts merged in, the rules every view follows:
 *
 *   questions   each agent question is a question (from: 'agent'), for the person whose sub it names, else for its
 *               part. A person's answer is the record's row under the same id: its answer is kept, the agent's
 *               routing and words stand
 *   checks      for a criterion trace owns, the agent's check sets status, evidence, when and by whom when it is newer
 *               than the record's own, was made on this revision, and is not older than the reopening of the
 *               criterion's stage. A person-owned criterion is never moved by an agent's fact
 *   stuck       an agent that is stuck and not resolved (or that a person answered) is a 'stuck' item for the
 *               contributors, its recommendation with it
 */
export function mergeAgentFacts(r: JourneyRecord, f: AgentFacts): JourneyRecord {
  const own = new Map(r.questions.map((q) => [q.id, q]))
  const answer = (id: string): Partial<QuestionRow> => {
    const p = own.get(id)
    return p ? { answer: p.answer, optionId: p.optionId, answerReason: p.answerReason, answeredBy: p.answeredBy, answeredByHash: p.answeredByHash, answeredAt: p.answeredAt } : {}
  }
  const unanswered = { answer: null, optionId: null, answerReason: null, answeredBy: null, answeredByHash: null, answeredAt: null }
  const asked: QuestionRow[] = f.questions.map((q) => ({
    id: q.id, kind: 'question', askedBy: q.askedBy, askedOf: null, askedOfSub: q.askedOfSub, askedPart: q.askedPart, stage: q.stage, text: q.text, blocks: q.blocks,
    options: q.options, sources: q.sources, jobId: q.jobId, askedAt: q.askedAt, from: 'agent', ...unanswered, ...answer(q.id),
  }))
  const stuck: QuestionRow[] = f.stuck.filter((s) => s.resolvedAt === null || own.get(s.id)?.answeredAt != null).map((s) => ({
    id: s.id, kind: 'stuck', askedBy: s.agent, askedOf: null, askedOfSub: null, askedPart: 'contributors', stage: s.stage, text: s.why,
    blocks: s.jobId ? `the job ${s.jobId}` : null, options: s.options, sources: s.sources, jobId: s.jobId, askedAt: s.at, recommendation: s.recommendation,
    from: 'agent', ...unanswered, ...answer(s.id),
  }))
  const theirs = new Set([...asked, ...stuck].map((q) => q.id))
  const questions = [...r.questions.filter((q) => !theirs.has(q.id)), ...asked, ...stuck].sort((a, b) => a.askedAt - b.askedAt)

  const newest = new Map<string, CriterionCheck>()
  for (const c of f.checks) {
    const was = newest.get(c.criterion)
    if (!was || c.checkedAt >= was.checkedAt) newest.set(c.criterion, c)
  }
  const criteria = r.criteria.map((c) => {
    const k = newest.get(c.id)
    if (!k || c.owner !== 'trace') return c
    if (k.revision !== null && k.revision !== r.journey.revision) return c
    const stage = r.stages.find((s) => s.id === r.gates.find((g) => g.id === c.gate)?.stage)
    if (stage?.reopenedAt != null && k.checkedAt < stage.reopenedAt) return c
    if (c.checkedAt !== null && c.checkedAt > k.checkedAt) return c
    return { ...c, status: k.status, evidence: k.evidence, checkedAt: k.checkedAt, checkedBy: k.by }
  })
  return { ...r, questions, criteria }
}
