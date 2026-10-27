/**
 * The design record in the project database (.trace/project.db, committed with the repository beside the
 * requirements): what the agents propose for Define, Architect and Capture, so it changes with the design and git
 * history shows how it got there.
 *
 *   intent_statements   one line of the product intent: its topic (the Intent builder's ten), the words, where they
 *                       came from (the person's words, the brief, a document, the imported design), and for some kinds
 *                       more: an interface's type, connector, protocol, rate and direction; numeric limits; a topic
 *                       marked "don't care" or "unknown, decide by <stage>"; an open question with its owner; the
 *                       statements it conflicts with; whether it can become a testable requirement
 *   requirement_intent  each requirement's link to the intent line it is derived from (derived_from)
 *   arch_options        the architectures compared (option A, B …): summary, which one trace recommends and why, what
 *                       it gives up, the risks
 *   arch_criteria       the criteria trace proposes to score them on (cost, risk, availability …) with weights
 *   arch_scores         trace's proposed score of each option on each criterion, with a one-line reason
 *   arch_blocks         the blocks of each option: name, role, key parts (MPN), the requirements it serves, and where
 *                       it sits on the diagram (fractions of the frame, so options compare with the layout held still)
 *   arch_connections    what flows between two blocks of an option (a rail and its voltage, a bus, an RF path)
 *   pin_plan            each microcontroller or FPGA pin: its name, the function and peripheral instance the firmware
 *                       gives it, what that instance serves, the net it must be on, the role the part reserves for it
 *                       (boot, reset, debug), the alternate functions the part allows there, constraints
 *   sheet_requirements  which requirements each schematic sheet serves (and its block), or why it serves none
 *
 * Agents write proposals only: every row is `proposed` or `withdrawn`. What people decide about them (accepting or
 * editing intent, striking a requirement, choosing an architecture, agreeing the pin plan) is not here: it is in the
 * journey record (design_decisions, src/tools/design/decisions.ts), which only the API writes for a person, and is
 * merged over these rows wherever they are read (src/tools/design/record.ts). So an agent can never accept or choose
 * for a person, and a person's decision is live at once instead of waiting for a pull request.
 *
 * `tracectl db merge` merges every table by key, keeping the more recently updated row; nothing is deleted (a proposal
 * taken back is `withdrawn`), so a merge cannot resurrect or lose a row. New intent ids are random (INT-<6 hex>), so
 * two branches do not hand out the same one.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { ensureProjectSchema, openProject, transaction } from '../../core/store.js'

/** The Intent builder's topics, in its order (src/core/skills.ts intent-builder steps). */
export const INTENT_TOPICS = ['purpose', 'environment', 'power', 'interfaces', 'performance', 'physical', 'compliance', 'build', 'constraints', 'references'] as const
export type IntentTopic = (typeof INTENT_TOPICS)[number]
export const TOPIC_NAMES: Readonly<Record<IntentTopic, string>> = {
  purpose: 'Purpose', environment: 'Environment', power: 'Power', interfaces: 'Interfaces', performance: 'Performance', physical: 'Physical',
  compliance: 'Compliance', build: 'Build', constraints: 'Constraints', references: 'References',
}
export const INTENT_KINDS = ['statement', 'dont_care', 'unknown', 'question'] as const
export const SOURCE_KINDS = ['person', 'brief', 'document', 'design'] as const
export const PROPOSAL_STATUS = ['proposed', 'withdrawn'] as const
export const CONNECTION_KINDS = ['rail', 'bus', 'rf', 'signal', 'mechanical'] as const
export const PIN_KINDS = ['signal', 'analog', 'power', 'boot', 'reset', 'debug', 'clock', 'spare', 'nc'] as const
export const RESERVED_ROLES = ['boot', 'reset', 'debug'] as const
export const STAGES = ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup'] as const

export const SourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS).describe('person: their own words; brief: the written brief; document: a spec or datasheet; design: read from an imported design'),
  ref: z.string().max(300).optional().describe('the document path, datasheet sha256, file, or who said it'),
  quote: z.string().max(2000).optional().describe('the sentence or table row it came from, word for word'),
  page: z.number().int().positive().optional(),
}).strict()
export type Source = z.output<typeof SourceSchema>

export const InterfaceSchema = z.object({
  type: z.string().max(80).optional().describe('e.g. USB device, CAN, UART, antenna'),
  connector: z.string().max(120).optional().describe('e.g. USB-C receptacle, M12 4-pin'),
  protocol: z.string().max(120).optional().describe('e.g. USB 2.0 full speed, LoRaWAN 1.0.3'),
  rate: z.string().max(80).optional().describe('with its unit, e.g. 12 Mbit/s, 500 kbit/s'),
  direction: z.string().max(40).optional().describe('in, out or both'),
}).strict()
export type IntentInterface = z.output<typeof InterfaceSchema>

export const LimitSchema = z.object({
  name: z.string().min(1).max(80).describe('what is limited: board_width, board_height, supply_voltage, unit_cost …'),
  min: z.number().optional(), max: z.number().optional(),
  unit: z.string().min(1).max(20),
}).strict()
export type IntentLimit = z.output<typeof LimitSchema>

export interface IntentStatementRow {
  id: string; topic: IntentTopic; kind: (typeof INTENT_KINDS)[number]; text: string; source: Source | null
  interface: IntentInterface | null; limits: IntentLimit[]; decide_by: string | null; owner: string | null; conflicts: string[]
  testable: boolean | null; status: (typeof PROPOSAL_STATUS)[number]; created: number; updated: number; by: string | null
}
export interface RequirementIntentRow { requirement: string; intent: string; removed: boolean; updated: number; by: string | null }
export interface ArchOptionRow { id: string; name: string; summary: string; recommended: boolean; why: string | null; gives_up: string | null; risks: string[]; status: (typeof PROPOSAL_STATUS)[number]; created: number; updated: number; by: string | null }
export interface ArchCriterionRow { id: string; name: string; weight: number; description: string | null; status: (typeof PROPOSAL_STATUS)[number]; updated: number; by: string | null }
export interface ArchScoreRow { option: string; criterion: string; score: number; reason: string; updated: number; by: string | null }
export interface BlockPart { mpn: string; role?: string | undefined; key?: boolean | undefined }
export interface ArchBlockRow { option: string; id: string; name: string; role: string | null; parts: BlockPart[]; requirements: string[]; x: number | null; y: number | null; status: (typeof PROPOSAL_STATUS)[number]; updated: number; by: string | null }
export interface ArchConnectionRow { option: string; id: string; from: string; to: string; kind: (typeof CONNECTION_KINDS)[number]; label: string; status: (typeof PROPOSAL_STATUS)[number]; updated: number; by: string | null }
export interface PinRow {
  part: string; pin: string; name: string | null; function: string | null; peripheral: string | null; use: string | null; net: string | null
  kind: (typeof PIN_KINDS)[number]; reserved: (typeof RESERVED_ROLES)[number] | null; alternates: string[]; constraints: string | null; note: string | null
  status: (typeof PROPOSAL_STATUS)[number]; updated: number; by: string | null
}
export interface SheetRow { sheet: string; block: string | null; requirements: string[]; reason: string | null; updated: number; by: string | null }

/** Everything the design record holds, as rows (tables a database lacks read as empty). */
export interface DesignRows {
  intent: IntentStatementRow[]; links: RequirementIntentRow[]
  options: ArchOptionRow[]; criteria: ArchCriterionRow[]; scores: ArchScoreRow[]; blocks: ArchBlockRow[]; connections: ArchConnectionRow[]
  pins: PinRow[]; sheets: SheetRow[]
}

// ------------------------------------------------------------------ schema

/** Newer row wins, by its key. */
const newer = (table: string, keys: readonly string[], cols: readonly string[]): string =>
  `INSERT INTO ${table} (${[...keys, ...cols].join(', ')}) SELECT ${[...keys, ...cols].join(', ')} FROM theirs.${table} WHERE true
  ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(', ')} WHERE excluded.updated > ${table}.updated;`

const INTENT_COLS = ['topic', 'kind', 'text', 'source', 'detail', 'decide_by', 'owner', 'conflicts', 'testable', 'status', 'created', 'updated', 'by'] as const
ensureProjectSchema({ table: 'intent_statements', sql: `
CREATE TABLE IF NOT EXISTS intent_statements (
  id TEXT PRIMARY KEY,            -- INT-<6 hex>
  topic TEXT NOT NULL,            -- purpose | environment | power | interfaces | performance | physical | compliance | build | constraints | references
  kind TEXT NOT NULL DEFAULT 'statement',   -- statement | dont_care | unknown | question
  text TEXT NOT NULL,
  source TEXT,                    -- JSON { kind: person | brief | document | design, ref?, quote?, page? }
  detail TEXT,                    -- JSON { interface?: { type, connector, protocol, rate, direction }, limits?: [{ name, min?, max?, unit }] }
  decide_by TEXT,                 -- unknown: the stage it is decided by
  owner TEXT,                     -- question: who answers it
  conflicts TEXT,                 -- JSON list of statement ids it cannot hold together with
  testable INTEGER,               -- 0: cannot become a testable requirement as worded
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | withdrawn
  created REAL NOT NULL, updated REAL NOT NULL, by TEXT
);`, merge: newer('intent_statements', ['id'], INTENT_COLS) })

ensureProjectSchema({ table: 'requirement_intent', sql: `
CREATE TABLE IF NOT EXISTS requirement_intent (
  requirement TEXT NOT NULL,      -- a requirement id
  intent TEXT NOT NULL,           -- the intent statement it is derived from
  removed INTEGER NOT NULL DEFAULT 0,
  updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (requirement, intent)
);`, merge: newer('requirement_intent', ['requirement', 'intent'], ['removed', 'updated', 'by']) })

const OPTION_COLS = ['name', 'summary', 'recommended', 'why', 'gives_up', 'risks', 'status', 'created', 'updated', 'by'] as const
ensureProjectSchema({ table: 'arch_options', sql: `
CREATE TABLE IF NOT EXISTS arch_options (
  id TEXT PRIMARY KEY,            -- A, B, C …
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommended INTEGER NOT NULL DEFAULT 0,
  why TEXT, gives_up TEXT,
  risks TEXT,                     -- JSON list of lines
  status TEXT NOT NULL DEFAULT 'proposed',
  created REAL NOT NULL, updated REAL NOT NULL, by TEXT
);`, merge: newer('arch_options', ['id'], OPTION_COLS) })

ensureProjectSchema({ table: 'arch_criteria', sql: `
CREATE TABLE IF NOT EXISTS arch_criteria (
  id TEXT PRIMARY KEY,            -- cost, risk, availability, power, size, schedule …
  name TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  updated REAL NOT NULL, by TEXT
);`, merge: newer('arch_criteria', ['id'], ['name', 'weight', 'description', 'status', 'updated', 'by']) })

ensureProjectSchema({ table: 'arch_scores', sql: `
CREATE TABLE IF NOT EXISTS arch_scores (
  option TEXT NOT NULL, criterion TEXT NOT NULL,
  score REAL NOT NULL,            -- 1 (worst) to 5 (best)
  reason TEXT NOT NULL,
  updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (option, criterion)
);`, merge: newer('arch_scores', ['option', 'criterion'], ['score', 'reason', 'updated', 'by']) })

ensureProjectSchema({ table: 'arch_blocks', sql: `
CREATE TABLE IF NOT EXISTS arch_blocks (
  option TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT,
  parts TEXT NOT NULL,            -- JSON [{ mpn, role?, key? }]
  requirements TEXT NOT NULL,     -- JSON list of requirement ids it serves
  x REAL, y REAL,                 -- where on the diagram, 0..1 of the frame
  status TEXT NOT NULL DEFAULT 'proposed',
  updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (option, id)
);`, merge: newer('arch_blocks', ['option', 'id'], ['name', 'role', 'parts', 'requirements', 'x', 'y', 'status', 'updated', 'by']) })

ensureProjectSchema({ table: 'arch_connections', sql: `
CREATE TABLE IF NOT EXISTS arch_connections (
  option TEXT NOT NULL, id TEXT NOT NULL,
  from_block TEXT NOT NULL, to_block TEXT NOT NULL,
  kind TEXT NOT NULL,             -- rail | bus | rf | signal | mechanical
  label TEXT NOT NULL,            -- what flows: "3.3 V, 150 mA", "SPI 8 MHz"
  status TEXT NOT NULL DEFAULT 'proposed',
  updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (option, id)
);`, merge: newer('arch_connections', ['option', 'id'], ['from_block', 'to_block', 'kind', 'label', 'status', 'updated', 'by']) })

const PIN_COLS = ['name', 'function', 'peripheral', 'use', 'net', 'kind', 'reserved', 'alternates', 'constraints', 'note', 'status', 'updated', 'by'] as const
ensureProjectSchema({ table: 'pin_plan', sql: `
CREATE TABLE IF NOT EXISTS pin_plan (
  part TEXT NOT NULL,             -- the schematic reference of the microcontroller or FPGA: U1
  pin TEXT NOT NULL,              -- its pin number as the symbol has it: 30, A7
  name TEXT,                      -- the part's pin name: PA9
  function TEXT,                  -- what the firmware uses it as: USART1_TX, GPIO_OUT, ADC1_IN5
  peripheral TEXT,                -- the peripheral instance: USART1
  use TEXT,                       -- what that instance serves: "GPS", "debug console"
  net TEXT,                       -- the schematic net it must be on
  kind TEXT NOT NULL DEFAULT 'signal',      -- signal | analog | power | boot | reset | debug | clock | spare | nc
  reserved TEXT,                  -- the role the part gives the pin: boot | reset | debug
  alternates TEXT,                -- JSON list: the functions the part allows on this pin (its datasheet)
  constraints TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (part, pin)
);`, merge: newer('pin_plan', ['part', 'pin'], PIN_COLS) })

ensureProjectSchema({ table: 'sheet_requirements', sql: `
CREATE TABLE IF NOT EXISTS sheet_requirements (
  sheet TEXT PRIMARY KEY,         -- the schematic file, relative to the repository: hw/power.kicad_sch
  block TEXT,                     -- the block it implements
  requirements TEXT NOT NULL,     -- JSON list of requirement ids it serves
  reason TEXT,                    -- why it serves none (connectors only, mounting holes)
  updated REAL NOT NULL, by TEXT
);`, merge: newer('sheet_requirements', ['sheet'], ['block', 'requirements', 'reason', 'updated', 'by']) })

// ------------------------------------------------------------------ reading

const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const j = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try { return (JSON.parse(v) as T) ?? fallback } catch { return fallback }
}
const strs = (v: unknown): string[] => j<unknown[]>(v, []).filter((x): x is string => typeof x === 'string')
const all = (db: DatabaseSync, t: string, order: string): Record<string, unknown>[] => (hasTable(db, t) ? db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as Record<string, unknown>[] : [])
const status = (v: unknown): 'proposed' | 'withdrawn' => (v === 'withdrawn' ? 'withdrawn' : 'proposed')

/** The design record's rows, from any database holding its tables (the repository's, or the API's merged copy). */
export function readDesignRows(db: DatabaseSync): DesignRows {
  return {
    intent: all(db, 'intent_statements', 'created, rowid').map((r) => {
      const d = j<{ interface?: IntentInterface; limits?: IntentLimit[] }>(r.detail, {})
      return {
        id: String(r.id), topic: (INTENT_TOPICS as readonly string[]).includes(String(r.topic)) ? r.topic as IntentTopic : 'constraints',
        kind: (INTENT_KINDS as readonly string[]).includes(String(r.kind)) ? r.kind as IntentStatementRow['kind'] : 'statement', text: String(r.text),
        source: j<Source | null>(r.source, null), interface: d.interface ?? null, limits: Array.isArray(d.limits) ? d.limits : [],
        decide_by: s(r.decide_by), owner: s(r.owner), conflicts: strs(r.conflicts), testable: r.testable === null || r.testable === undefined ? null : Number(r.testable) !== 0,
        status: status(r.status), created: Number(r.created), updated: Number(r.updated), by: s(r.by),
      }
    }),
    links: all(db, 'requirement_intent', 'requirement, intent').map((r) => ({ requirement: String(r.requirement), intent: String(r.intent), removed: Number(r.removed) !== 0, updated: Number(r.updated), by: s(r.by) })),
    options: all(db, 'arch_options', 'id').map((r) => ({
      id: String(r.id), name: String(r.name), summary: String(r.summary), recommended: Number(r.recommended) !== 0, why: s(r.why), gives_up: s(r.gives_up),
      risks: strs(r.risks), status: status(r.status), created: Number(r.created), updated: Number(r.updated), by: s(r.by),
    })),
    criteria: all(db, 'arch_criteria', 'id').map((r) => ({ id: String(r.id), name: String(r.name), weight: Number(r.weight), description: s(r.description), status: status(r.status), updated: Number(r.updated), by: s(r.by) })),
    scores: all(db, 'arch_scores', 'option, criterion').map((r) => ({ option: String(r.option), criterion: String(r.criterion), score: Number(r.score), reason: String(r.reason), updated: Number(r.updated), by: s(r.by) })),
    blocks: all(db, 'arch_blocks', 'option, id').map((r) => ({
      option: String(r.option), id: String(r.id), name: String(r.name), role: s(r.role), parts: j<BlockPart[]>(r.parts, []), requirements: strs(r.requirements),
      x: n(r.x), y: n(r.y), status: status(r.status), updated: Number(r.updated), by: s(r.by),
    })),
    connections: all(db, 'arch_connections', 'option, id').map((r) => ({
      option: String(r.option), id: String(r.id), from: String(r.from_block), to: String(r.to_block),
      kind: (CONNECTION_KINDS as readonly string[]).includes(String(r.kind)) ? r.kind as ArchConnectionRow['kind'] : 'signal', label: String(r.label), status: status(r.status), updated: Number(r.updated), by: s(r.by),
    })),
    pins: all(db, 'pin_plan', 'part, pin').map((r) => ({
      part: String(r.part), pin: String(r.pin), name: s(r.name), function: s(r.function), peripheral: s(r.peripheral), use: s(r.use), net: s(r.net),
      kind: (PIN_KINDS as readonly string[]).includes(String(r.kind)) ? r.kind as PinRow['kind'] : 'signal',
      reserved: (RESERVED_ROLES as readonly string[]).includes(String(r.reserved)) ? r.reserved as PinRow['reserved'] : null,
      alternates: strs(r.alternates), constraints: s(r.constraints), note: s(r.note), status: status(r.status), updated: Number(r.updated), by: s(r.by),
    })),
    sheets: all(db, 'sheet_requirements', 'sheet').map((r) => ({ sheet: String(r.sheet), block: s(r.block), requirements: strs(r.requirements), reason: s(r.reason), updated: Number(r.updated), by: s(r.by) })),
  }
}

// ------------------------------------------------------------------ writing (agents' proposals)

const now = (): number => Date.now() / 1000
const who = (): string | null => {
  try {
    return process.env.TRACE_ACTOR || process.env.TRACE_AGENT_LABEL || process.env.GITHUB_ACTOR || userInfo().username
  } catch {
    return null
  }
}
const enc = (v: unknown): string => JSON.stringify(v ?? null)
const ID = /^[A-Za-z][\w.-]{0,63}$/
const checkId = (what: string, id: string): void => { if (!ID.test(id)) throw new ToolError(`${what} id ${JSON.stringify(id)}: letters, digits, '.', '_' and '-', starting with a letter`) }

/** One pin of the plan as an agent gives it: part and pin, the rest optional. */
export type PinInput = { part: string; pin: string } & { [K in 'name' | 'function' | 'peripheral' | 'use' | 'net' | 'constraints' | 'note']?: string | undefined } & {
  kind?: PinRow['kind'] | undefined; reserved?: PinRow['reserved'] | undefined; alternates?: string[] | undefined; status?: PinRow['status'] | undefined
}

export interface IntentInput {
  id?: string | undefined; topic: IntentTopic; kind?: IntentStatementRow['kind'] | undefined; text: string; source?: Source | undefined
  interface?: IntentInterface | undefined; limits?: IntentLimit[] | undefined; decide_by?: string | undefined; owner?: string | undefined
  conflicts?: string[] | undefined; testable?: boolean | undefined
}

/** The design record of the current project, for the agents' tools. Close it when done. */
export class DesignDb {
  readonly db: DatabaseSync

  constructor(root?: string) {
    this.db = openProject(root)
  }

  close(): void {
    this.db.close()
  }

  rows(): DesignRows {
    return readDesignRows(this.db)
  }

  private intentRow(id: string): IntentStatementRow | null {
    return this.rows().intent.find((x) => x.id === id) ?? null
  }

  private newIntentId(): string {
    for (let i = 0; i < 20; i++) {
      const id = `INT-${randomBytes(3).toString('hex')}`
      if (!this.db.prepare('SELECT 1 FROM intent_statements WHERE id=?').get(id)) return id
    }
    throw new ToolError('could not find a free intent statement id')
  }

  /** Propose intent statements (new ids unless given; an existing id is refused: use updateIntent). */
  addIntent(list: readonly IntentInput[]): IntentStatementRow[] {
    return transaction(this.db, () => list.map((x) => {
      const id = x.id ?? this.newIntentId()
      checkId('intent statement', id)
      if (this.db.prepare('SELECT 1 FROM intent_statements WHERE id=?').get(id)) throw new ToolError(`intent statement ${id} exists (use update)`)
      if (x.kind === 'unknown' && !x.decide_by) throw new ToolError(`${id}: an unknown topic names the stage it is decided by (decide_by)`)
      const t = now()
      this.db.prepare('INSERT INTO intent_statements (id, topic, kind, text, source, detail, decide_by, owner, conflicts, testable, status, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, x.topic, x.kind ?? 'statement', x.text, x.source ? enc(x.source) : null, enc({ ...(x.interface ? { interface: x.interface } : {}), ...(x.limits?.length ? { limits: x.limits } : {}) }),
          x.decide_by ?? null, x.owner ?? null, enc(x.conflicts ?? []), x.testable === undefined ? null : x.testable ? 1 : 0, 'proposed', t, t, who())
      return this.intentRow(id) as IntentStatementRow
    }))
  }

  /** Change a proposed statement (a person's accepted decision binds to the words it saw, so a change reopens it). */
  updateIntent(id: string, patch: Partial<Omit<IntentInput, 'id'>> & { status?: 'proposed' | 'withdrawn' | undefined }): IntentStatementRow {
    const cur = this.intentRow(id)
    if (!cur) throw new ToolError(`no intent statement ${id}`)
    const next = {
      topic: patch.topic ?? cur.topic, kind: patch.kind ?? cur.kind, text: patch.text ?? cur.text, source: patch.source ?? cur.source,
      interface: patch.interface ?? cur.interface, limits: patch.limits ?? cur.limits, decide_by: patch.decide_by ?? cur.decide_by, owner: patch.owner ?? cur.owner,
      conflicts: patch.conflicts ?? cur.conflicts, testable: patch.testable ?? cur.testable, status: patch.status ?? cur.status,
    }
    this.db.prepare('UPDATE intent_statements SET topic=?, kind=?, text=?, source=?, detail=?, decide_by=?, owner=?, conflicts=?, testable=?, status=?, updated=?, by=? WHERE id=?')
      .run(next.topic, next.kind, next.text, next.source ? enc(next.source) : null, enc({ ...(next.interface ? { interface: next.interface } : {}), ...(next.limits.length ? { limits: next.limits } : {}) }),
        next.decide_by, next.owner, enc(next.conflicts), next.testable === null ? null : next.testable ? 1 : 0, next.status, now(), who(), id)
    return this.intentRow(id) as IntentStatementRow
  }

  /** Link a requirement to the intent lines it is derived from (`replace`: drop its other links). */
  link(requirement: string, intents: readonly string[], replace = false): RequirementIntentRow[] {
    return transaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM requirements WHERE id=?').get(requirement)) throw new ToolError(`no requirement ${requirement}`)
      const missing = intents.filter((i) => !this.db.prepare('SELECT 1 FROM intent_statements WHERE id=?').get(i))
      if (missing.length) throw new ToolError(`no intent statement ${missing.join(', ')}`)
      const t = now()
      if (replace) this.db.prepare('UPDATE requirement_intent SET removed=1, updated=?, by=? WHERE requirement=? AND removed=0').run(t, who(), requirement)
      for (const i of intents) {
        this.db.prepare('INSERT INTO requirement_intent (requirement, intent, removed, updated, by) VALUES (?,?,0,?,?) ON CONFLICT(requirement, intent) DO UPDATE SET removed=0, updated=excluded.updated, by=excluded.by')
          .run(requirement, i, t, who())
      }
      return this.rows().links.filter((l) => l.requirement === requirement && !l.removed)
    })
  }

  unlink(requirement: string, intent: string): boolean {
    return Number(this.db.prepare('UPDATE requirement_intent SET removed=1, updated=?, by=? WHERE requirement=? AND intent=? AND removed=0').run(now(), who(), requirement, intent).changes) > 0
  }

  // ---------------------------------------------------------------- architecture

  setOption(o: { id: string; name: string; summary: string; recommended?: boolean | undefined; why?: string | undefined; gives_up?: string | undefined; risks?: string[] | undefined; status?: 'proposed' | 'withdrawn' | undefined }): ArchOptionRow {
    checkId('option', o.id)
    return transaction(this.db, () => {
      const t = now()
      const old = this.db.prepare('SELECT created FROM arch_options WHERE id=?').get(o.id)
      // one recommendation at a time
      if (o.recommended) this.db.prepare('UPDATE arch_options SET recommended=0, updated=?, by=? WHERE id<>? AND recommended=1').run(t, who(), o.id)
      this.db.prepare('INSERT OR REPLACE INTO arch_options (id, name, summary, recommended, why, gives_up, risks, status, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(o.id, o.name, o.summary, o.recommended ? 1 : 0, o.why ?? null, o.gives_up ?? null, enc(o.risks ?? []), o.status ?? 'proposed', old ? Number(old.created) : t, t, who())
      return this.rows().options.find((x) => x.id === o.id) as ArchOptionRow
    })
  }

  setCriteria(list: readonly { id: string; name: string; weight?: number | undefined; description?: string | undefined; status?: 'proposed' | 'withdrawn' | undefined }[]): ArchCriterionRow[] {
    return transaction(this.db, () => {
      for (const c of list) {
        checkId('criterion', c.id)
        this.db.prepare('INSERT OR REPLACE INTO arch_criteria (id, name, weight, description, status, updated, by) VALUES (?,?,?,?,?,?,?)').run(c.id, c.name, c.weight ?? 1, c.description ?? null, c.status ?? 'proposed', now(), who())
      }
      return this.rows().criteria
    })
  }

  setScores(list: readonly { option: string; criterion: string; score: number; reason: string }[]): ArchScoreRow[] {
    return transaction(this.db, () => {
      for (const x of list) {
        if (!this.db.prepare('SELECT 1 FROM arch_options WHERE id=?').get(x.option)) throw new ToolError(`no option ${x.option}`)
        if (!this.db.prepare('SELECT 1 FROM arch_criteria WHERE id=?').get(x.criterion)) throw new ToolError(`no criterion ${x.criterion}`)
        this.db.prepare('INSERT OR REPLACE INTO arch_scores (option, criterion, score, reason, updated, by) VALUES (?,?,?,?,?,?)').run(x.option, x.criterion, x.score, x.reason, now(), who())
      }
      return this.rows().scores
    })
  }

  /** The blocks of one option, replacing the ones it had (those left out are withdrawn). */
  setBlocks(option: string, blocks: readonly { id: string; name: string; role?: string | undefined; parts?: BlockPart[] | undefined; requirements?: string[] | undefined; x?: number | undefined; y?: number | undefined }[]): ArchBlockRow[] {
    return transaction(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM arch_options WHERE id=?').get(option)) throw new ToolError(`no option ${option}: set it first`)
      const reqs = new Set((this.db.prepare('SELECT id FROM requirements').all() as { id: string }[]).map((r) => String(r.id)))
      const t = now()
      const keep = new Set<string>()
      for (const b of blocks) {
        checkId('block', b.id)
        const unknown = (b.requirements ?? []).filter((r) => !reqs.has(r))
        if (unknown.length) throw new ToolError(`block ${b.id}: no such requirement ${unknown.join(', ')}`)
        keep.add(b.id)
        this.db.prepare('INSERT OR REPLACE INTO arch_blocks (option, id, name, role, parts, requirements, x, y, status, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(option, b.id, b.name, b.role ?? null, enc(b.parts ?? []), enc(b.requirements ?? []), b.x ?? null, b.y ?? null, 'proposed', t, who())
      }
      for (const old of this.rows().blocks.filter((x) => x.option === option && x.status === 'proposed' && !keep.has(x.id))) {
        this.db.prepare("UPDATE arch_blocks SET status='withdrawn', updated=?, by=? WHERE option=? AND id=?").run(t, who(), option, old.id)
      }
      return this.rows().blocks.filter((x) => x.option === option && x.status === 'proposed')
    })
  }

  /** The connections of one option, replacing the ones it had. */
  setConnections(option: string, list: readonly { id?: string | undefined; from: string; to: string; kind: ArchConnectionRow['kind']; label: string }[]): ArchConnectionRow[] {
    return transaction(this.db, () => {
      const blocks = new Set(this.rows().blocks.filter((b) => b.option === option && b.status === 'proposed').map((b) => b.id))
      const t = now()
      const keep = new Set<string>()
      for (const c of list) {
        for (const end of [c.from, c.to]) if (!blocks.has(end)) throw new ToolError(`option ${option} has no block ${end}`)
        const id = c.id ?? `${c.from}-${c.to}`
        keep.add(id)
        this.db.prepare('INSERT OR REPLACE INTO arch_connections (option, id, from_block, to_block, kind, label, status, updated, by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(option, id, c.from, c.to, c.kind, c.label, 'proposed', t, who())
      }
      for (const old of this.rows().connections.filter((x) => x.option === option && x.status === 'proposed' && !keep.has(x.id))) {
        this.db.prepare("UPDATE arch_connections SET status='withdrawn', updated=?, by=? WHERE option=? AND id=?").run(t, who(), option, old.id)
      }
      return this.rows().connections.filter((x) => x.option === option && x.status === 'proposed')
    })
  }

  // ---------------------------------------------------------------- pins and sheets

  setPins(list: readonly PinInput[]): PinRow[] {
    return transaction(this.db, () => {
      for (const p of list) {
        this.db.prepare('INSERT OR REPLACE INTO pin_plan (part, pin, name, function, peripheral, use, net, kind, reserved, alternates, constraints, note, status, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(p.part, p.pin, p.name ?? null, p.function ?? null, p.peripheral ?? null, p.use ?? null, p.net ?? null, p.kind ?? 'signal', p.reserved ?? null,
            enc(p.alternates ?? []), p.constraints ?? null, p.note ?? null, p.status ?? 'proposed', now(), who())
      }
      return this.rows().pins
    })
  }

  setSheet(x: { sheet: string; block?: string | undefined; requirements: string[]; reason?: string | undefined }): SheetRow {
    const reqs = new Set((this.db.prepare('SELECT id FROM requirements').all() as { id: string }[]).map((r) => String(r.id)))
    const unknown = x.requirements.filter((r) => !reqs.has(r))
    if (unknown.length) throw new ToolError(`no such requirement ${unknown.join(', ')}`)
    if (!x.requirements.length && (x.reason ?? '').trim().length < 10) throw new ToolError(`${x.sheet}: a sheet that serves no requirement says why (reason, a sentence)`)
    this.db.prepare('INSERT OR REPLACE INTO sheet_requirements (sheet, block, requirements, reason, updated, by) VALUES (?,?,?,?,?,?)')
      .run(x.sheet, x.block ?? null, enc(x.requirements), x.reason ?? null, now(), who())
    return this.rows().sheets.find((r) => r.sheet === x.sheet) as SheetRow
  }
}

export function withDesign<T>(fn: (d: DesignDb) => T): T {
  const d = new DesignDb()
  try {
    return fn(d)
  } finally {
    d.close()
  }
}
