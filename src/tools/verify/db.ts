/**
 * The verification record in the project database: requirements, the test plan that verifies them, each test run's
 * verdict with its evidence, and coverage (planned coverage points, and the hits simulators reported).
 *
 *   requirements      id, text, kind (functional | electrical | timing | emc), acceptance criterion, source document
 *                     and page, status (proposed | accepted | rejected | obsolete), tags
 *   test_items        id, title, the requirement ids it verifies, method (sim | formal | spice | hil | inspection |
 *                     drc), how it runs (a tool call: tool + args; or a command argv run in the repository root),
 *                     expected measurement limits, status (planned | pass | fail | error | blocked | waived), last run
 *   test_results      one row per verify.run of a test item: verdict, evidence (the run ids of the tool runs it made)
 *   coverage_points   a named coverage goal tied to requirements: the kind of point, the name (or /regex/) it matches
 *                     among the hits simulators report, and how many hits make it covered
 *   coverage_hits     functional coverage hits a run reported: verilator user points (cover property), sby/smtbmc
 *                     cover statements, and TRACE_COVER lines in any simulator's output
 *
 * Line, toggle and branch coverage are not rows: they stay in each run's coverage.dat artifact, and verify.coverage
 * merges those files, so the database committed with the repository does not grow by a row per toggled bit.
 *
 * `tracectl db merge` merges requirements, test_items and coverage_points by id, keeping the more recently updated row,
 * and takes the union of test_results and coverage_hits (keyed by run id). New requirement ids are random
 * (REQ-<6 hex>), so two branches do not hand out the same one; ids written before that (REQ-001, a project's own
 * numbering) are kept. Two different requirements that still share an id (different text and created time: each
 * branch added its own) are both kept: theirs is renamed <id>-<6 hex>, their test items and coverage points are
 * pointed at the new id, and the rename is recorded in verify_merge_notes.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { dec, enc, ensureProjectSchema, openProject, transaction, type Json } from '../../core/store.js'

const REQ_COLS = ['text', 'kind', 'acceptance', 'source', 'page', 'status', 'tags', 'created', 'updated', 'by'] as const
const TEST_COLS = ['title', 'requirements', 'method', 'tool', 'args', 'command', 'expect', 'status', 'last_run', 'note', 'created', 'updated', 'by'] as const
const POINT_COLS = ['requirements', 'kind', 'match', 'goal', 'description', 'created', 'updated', 'by'] as const

/** The requirement renames of this merge (theirs' id → its new id), filled by the requirements merge below. */
const RENAMES = `CREATE TEMP TABLE IF NOT EXISTS trace_req_renames (old TEXT PRIMARY KEY, new TEXT NOT NULL);`

const upsert = (table: string, cols: readonly string[]): string =>
  `ON CONFLICT(id) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(', ')} WHERE excluded.updated > ${table}.updated`

/** Requirements: newer row wins, except that a different requirement under the same id (text and created both
 * differ) is renamed instead of overwriting ours. */
const REQ_MERGE = `${RENAMES}
DELETE FROM temp.trace_req_renames;
INSERT INTO temp.trace_req_renames (old, new)
  SELECT t.id, t.id || '-' || lower(hex(randomblob(3))) FROM theirs.requirements t JOIN main.requirements o ON o.id = t.id
  WHERE t.created <> o.created AND t.text <> o.text;
INSERT INTO requirements (id, ${REQ_COLS.join(', ')})
  SELECT COALESCE(r.new, t.id), ${REQ_COLS.map((c) => `t.${c}`).join(', ')} FROM theirs.requirements t
  LEFT JOIN temp.trace_req_renames r ON r.old = t.id WHERE true
  ${upsert('requirements', REQ_COLS)};
INSERT OR IGNORE INTO verify_merge_notes (id, at, kind, old_id, new_id, note)
  SELECT 'rename:' || r.new, unixepoch('subsec'), 'requirement_renamed', r.old, r.new,
    'both branches added a different requirement ' || r.old || ' (different text and created time): ours kept the id, theirs became ' || r.new
  FROM temp.trace_req_renames r;`

/** A JSON list of requirement ids with theirs' renamed ids replaced (unchanged when none is renamed). */
const renamedRefs = (col: string): string => `CASE WHEN EXISTS (SELECT 1 FROM json_each(t.${col}) j JOIN temp.trace_req_renames r ON r.old = j.value)
    THEN (SELECT json_group_array(COALESCE(r.new, j.value)) FROM json_each(t.${col}) j LEFT JOIN temp.trace_req_renames r ON r.old = j.value)
    ELSE t.${col} END`

/** Test items and coverage points: newer row wins; their requirement ids follow theirs' renames. */
const refMerge = (table: string, cols: readonly string[]): string => `${RENAMES}
INSERT INTO ${table} (id, ${cols.join(', ')})
  SELECT t.id, ${cols.map((c) => (c === 'requirements' ? renamedRefs(c) : `t.${c}`)).join(', ')} FROM theirs.${table} t WHERE true
  ${upsert(table, cols)};`

ensureProjectSchema({
  table: 'requirements',
  sql: `
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,            -- REQ-001, or the project's own numbering
  text TEXT NOT NULL,
  kind TEXT NOT NULL,             -- functional | electrical | timing | emc
  acceptance TEXT,                -- the acceptance criterion
  source TEXT, page INTEGER,      -- the document (and page) it comes from
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted | rejected | obsolete
  tags TEXT,                      -- JSON list
  created REAL NOT NULL, updated REAL NOT NULL, by TEXT
);`,
  merge: REQ_MERGE,
})

ensureProjectSchema({
  table: 'verify_merge_notes',
  sql: `
CREATE TABLE IF NOT EXISTS verify_merge_notes (
  id TEXT PRIMARY KEY,            -- rename:<new id>
  at REAL NOT NULL,
  kind TEXT NOT NULL,             -- requirement_renamed
  old_id TEXT, new_id TEXT,
  note TEXT NOT NULL
);`,
})

ensureProjectSchema({
  table: 'test_items',
  sql: `
CREATE TABLE IF NOT EXISTS test_items (
  id TEXT PRIMARY KEY,            -- TST-001
  title TEXT NOT NULL,
  requirements TEXT NOT NULL,     -- JSON list of requirement ids
  method TEXT NOT NULL,           -- sim | formal | spice | hil | inspection | drc
  tool TEXT,                      -- the tool verify.run calls (verify.cocotb, sim.spice, kicad.drc, ...)
  args TEXT,                      -- JSON: its arguments
  command TEXT,                   -- or JSON argv, run in the repository root (exit 0 passes)
  expect TEXT,                    -- JSON list: [{measurement, min?, max?, equals?}] the run must meet
  status TEXT NOT NULL DEFAULT 'planned',   -- planned | pass | fail | error | blocked | waived
  last_run TEXT,                  -- the verify.run run that set status
  note TEXT,
  created REAL NOT NULL, updated REAL NOT NULL, by TEXT
);`,
  merge: refMerge('test_items', TEST_COLS),
})

ensureProjectSchema({
  table: 'test_results',
  sql: `
CREATE TABLE IF NOT EXISTS test_results (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,   -- the verify.run run
  test_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- pass | fail | error | blocked
  evidence TEXT,                  -- JSON list of run ids (the tool runs this verdict rests on)
  reason TEXT,
  at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS test_results_test ON test_results(test_id, at);`,
})

ensureProjectSchema({
  table: 'coverage_points',
  sql: `
CREATE TABLE IF NOT EXISTS coverage_points (
  id TEXT PRIMARY KEY,            -- COV-001
  requirements TEXT NOT NULL,     -- JSON list of requirement ids
  kind TEXT NOT NULL,             -- functional | cover (a formal cover statement)
  match TEXT NOT NULL,            -- a hit name, or /regex/
  goal INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created REAL NOT NULL, updated REAL NOT NULL, by TEXT
);`,
  merge: refMerge('coverage_points', POINT_COLS),
})

ensureProjectSchema({
  table: 'coverage_hits',
  sql: `
CREATE TABLE IF NOT EXISTS coverage_hits (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- functional (verilator user points, TRACE_COVER lines) | cover (formal)
  name TEXT NOT NULL,
  hits INTEGER NOT NULL,
  location TEXT,                  -- file:line when the tool knows it
  PRIMARY KEY (run_id, kind, name)
);`,
})

// ------------------------------------------------------------------ types

export const REQ_KINDS = ['functional', 'electrical', 'timing', 'emc'] as const
export const REQ_STATUS = ['proposed', 'accepted', 'rejected', 'obsolete'] as const
export const METHODS = ['sim', 'formal', 'spice', 'hil', 'inspection', 'drc'] as const
export const TEST_STATUS = ['planned', 'pass', 'fail', 'error', 'blocked', 'waived'] as const
export const POINT_KINDS = ['functional', 'cover'] as const

export const ExpectSchema = z.object({
  measurement: z.string().min(1).describe('a measurement name on the run (as trace.run lists them)'),
  min: z.number().optional(),
  max: z.number().optional(),
  equals: z.number().optional(),
  tolerance: z.number().nonnegative().optional().describe('with equals: allowed absolute difference'),
}).strict()
export type Expect = z.output<typeof ExpectSchema>

export interface Requirement {
  id: string
  text: string
  kind: (typeof REQ_KINDS)[number]
  acceptance: string | null
  source: string | null
  page: number | null
  status: (typeof REQ_STATUS)[number]
  tags: string[]
  created: number
  updated: number
  by: string | null
}

export interface TestItem {
  id: string
  title: string
  requirements: string[]
  method: (typeof METHODS)[number]
  tool: string | null
  args: Record<string, Json> | null
  command: string[] | null
  expect: Expect[]
  status: (typeof TEST_STATUS)[number]
  last_run: string | null
  note: string | null
  created: number
  updated: number
  by: string | null
}

export interface TestResult {
  run_id: string
  test_id: string
  status: 'pass' | 'fail' | 'error' | 'blocked'
  evidence: string[]
  reason: string | null
  at: number
}

export interface CoveragePoint {
  id: string
  requirements: string[]
  kind: (typeof POINT_KINDS)[number]
  match: string
  goal: number
  description: string | null
  created: number
  updated: number
  by: string | null
}

export interface Hit { run_id: string; kind: string; name: string; hits: number; location: string | null }

const now = (): number => Date.now() / 1000
const who = (): string | null => {
  try {
    return process.env.TRACE_ACTOR || process.env.GITHUB_ACTOR || userInfo().username
  } catch {
    return null
  }
}
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

function toReq(r: Record<string, unknown>): Requirement {
  return {
    id: String(r.id), text: String(r.text), kind: String(r.kind) as Requirement['kind'], acceptance: s(r.acceptance), source: s(r.source),
    page: r.page === null || r.page === undefined ? null : Number(r.page), status: String(r.status) as Requirement['status'],
    tags: dec<string[]>(r.tags) ?? [], created: Number(r.created), updated: Number(r.updated), by: s(r.by),
  }
}

function toTest(r: Record<string, unknown>): TestItem {
  return {
    id: String(r.id), title: String(r.title), requirements: dec<string[]>(r.requirements) ?? [], method: String(r.method) as TestItem['method'],
    tool: s(r.tool), args: dec<Record<string, Json> | null>(r.args), command: dec<string[] | null>(r.command), expect: dec<Expect[]>(r.expect) ?? [],
    status: String(r.status) as TestItem['status'], last_run: s(r.last_run), note: s(r.note), created: Number(r.created), updated: Number(r.updated), by: s(r.by),
  }
}

function toPoint(r: Record<string, unknown>): CoveragePoint {
  return {
    id: String(r.id), requirements: dec<string[]>(r.requirements) ?? [], kind: String(r.kind) as CoveragePoint['kind'], match: String(r.match),
    goal: Number(r.goal), description: s(r.description), created: Number(r.created), updated: Number(r.updated), by: s(r.by),
  }
}

/** A new requirement id, REQ-<6 hex>: random, so ids added on two branches do not collide; checked against the
 * table. */
export function newRequirementId(db: DatabaseSync, random: () => string = () => randomBytes(3).toString('hex')): string {
  for (let i = 0; i < 20; i++) {
    const id = `REQ-${random()}`
    if (!db.prepare('SELECT 1 FROM requirements WHERE id=?').get(id)) return id
  }
  throw new ToolError('could not find a free requirement id')
}

/** The next free id with this prefix: TST-001, TST-002, … (gaps are not reused). */
function nextId(db: DatabaseSync, table: string, prefix: string): string {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ?`).all(`${prefix}-%`)
  let n = 0
  for (const r of rows) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(r.id))
    if (m) n = Math.max(n, Number(m[1]))
  }
  return `${prefix}-${String(n + 1).padStart(3, '0')}`
}

const ID = /^[A-Za-z][\w.-]{0,63}$/

/** The verification record of the current project. Close it when done. */
export class VerifyDb {
  readonly db: DatabaseSync

  constructor(root?: string) {
    this.db = openProject(root)
  }

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- requirements

  addRequirement(r: { id?: string | undefined; text: string; kind: Requirement['kind']; acceptance?: string | undefined; source?: string | undefined; page?: number | undefined; status?: Requirement['status'] | undefined; tags?: string[] | undefined }): Requirement {
    return transaction(this.db, () => {
      const id = r.id ?? newRequirementId(this.db)
      if (!ID.test(id)) throw new ToolError(`requirement id ${JSON.stringify(id)}: letters, digits, '.', '_' and '-', starting with a letter`)
      if (this.db.prepare('SELECT 1 FROM requirements WHERE id=?').get(id)) throw new ToolError(`requirement ${id} exists (use update)`)
      const t = now()
      this.db.prepare('INSERT INTO requirements (id, text, kind, acceptance, source, page, status, tags, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, r.text, r.kind, r.acceptance ?? null, r.source ?? null, r.page ?? null, r.status ?? 'proposed', enc(r.tags ?? []), t, t, who())
      return this.requirement(id) as Requirement
    })
  }

  /** What merges recorded (requirements renamed because both branches added a different one under one id). */
  mergeNotes(): { id: string; at: number; kind: string; old_id: string | null; new_id: string | null; note: string }[] {
    return (this.db.prepare('SELECT * FROM verify_merge_notes ORDER BY at, id').all() as Record<string, unknown>[])
      .map((r) => ({ id: String(r.id), at: Number(r.at), kind: String(r.kind), old_id: s(r.old_id), new_id: s(r.new_id), note: String(r.note) }))
  }

  requirement(id: string): Requirement | null {
    const r = this.db.prepare('SELECT * FROM requirements WHERE id=?').get(id)
    return r ? toReq(r) : null
  }

  requirements(filter: { kind?: string | undefined; status?: string | undefined } = {}): Requirement[] {
    return (this.db.prepare('SELECT * FROM requirements ORDER BY id').all() as Record<string, unknown>[]).map(toReq)
      .filter((r) => (!filter.kind || r.kind === filter.kind) && (!filter.status || r.status === filter.status))
  }

  updateRequirement(id: string, patch: Partial<Pick<Requirement, 'text' | 'kind' | 'acceptance' | 'source' | 'page' | 'status' | 'tags'>>): Requirement {
    const cur = this.requirement(id)
    if (!cur) throw new ToolError(`no requirement ${id}`)
    const n = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Requirement
    this.db.prepare('UPDATE requirements SET text=?, kind=?, acceptance=?, source=?, page=?, status=?, tags=?, updated=?, by=? WHERE id=?')
      .run(n.text, n.kind, n.acceptance, n.source, n.page, n.status, enc(n.tags), now(), who(), id)
    return this.requirement(id) as Requirement
  }

  // ---------------------------------------------------------------- test items

  addTest(t: { id?: string | undefined; title: string; requirements: string[]; method: TestItem['method']; tool?: string | undefined; args?: Record<string, Json> | undefined; command?: string[] | undefined; expect?: Expect[] | undefined; note?: string | undefined; status?: TestItem['status'] | undefined }): TestItem {
    return transaction(this.db, () => {
      const id = t.id ?? nextId(this.db, 'test_items', 'TST')
      if (!ID.test(id)) throw new ToolError(`test id ${JSON.stringify(id)}: letters, digits, '.', '_' and '-', starting with a letter`)
      if (this.db.prepare('SELECT 1 FROM test_items WHERE id=?').get(id)) throw new ToolError(`test item ${id} exists (use update)`)
      this.checkRequirements(t.requirements)
      const ts = now()
      this.db.prepare('INSERT INTO test_items (id, title, requirements, method, tool, args, command, expect, status, last_run, note, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, t.title, enc(t.requirements), t.method, t.tool ?? null, t.args === undefined ? null : enc(t.args), t.command === undefined ? null : enc(t.command),
          enc(t.expect ?? []), t.status ?? 'planned', null, t.note ?? null, ts, ts, who())
      return this.test(id) as TestItem
    })
  }

  test(id: string): TestItem | null {
    const r = this.db.prepare('SELECT * FROM test_items WHERE id=?').get(id)
    return r ? toTest(r) : null
  }

  tests(filter: { requirement?: string | undefined; method?: string | undefined; status?: string | undefined } = {}): TestItem[] {
    return (this.db.prepare('SELECT * FROM test_items ORDER BY id').all() as Record<string, unknown>[]).map(toTest)
      .filter((t) => (!filter.requirement || t.requirements.includes(filter.requirement)) && (!filter.method || t.method === filter.method) && (!filter.status || t.status === filter.status))
  }

  updateTest(id: string, patch: Partial<Pick<TestItem, 'title' | 'requirements' | 'method' | 'tool' | 'args' | 'command' | 'expect' | 'status' | 'note' | 'last_run'>>): TestItem {
    const cur = this.test(id)
    if (!cur) throw new ToolError(`no test item ${id}`)
    if (patch.requirements) this.checkRequirements(patch.requirements)
    const n = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as TestItem
    this.db.prepare('UPDATE test_items SET title=?, requirements=?, method=?, tool=?, args=?, command=?, expect=?, status=?, last_run=?, note=?, updated=?, by=? WHERE id=?')
      .run(n.title, enc(n.requirements), n.method, n.tool, n.args === null ? null : enc(n.args), n.command === null ? null : enc(n.command), enc(n.expect),
        n.status, n.last_run, n.note, now(), who(), id)
    return this.test(id) as TestItem
  }

  deleteTest(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM test_items WHERE id=?').run(id).changes) > 0
  }

  private checkRequirements(ids: readonly string[]): void {
    const missing = ids.filter((r) => !this.db.prepare('SELECT 1 FROM requirements WHERE id=?').get(r))
    if (missing.length) throw new ToolError(`no such requirement: ${missing.join(', ')}`)
  }

  // ---------------------------------------------------------------- results

  addResult(r: Omit<TestResult, 'at'>): void {
    this.db.prepare('INSERT OR REPLACE INTO test_results (run_id, test_id, status, evidence, reason, at) VALUES (?,?,?,?,?,?)')
      .run(r.run_id, r.test_id, r.status, enc(r.evidence), r.reason, now())
  }

  results(testId: string, limit = 10): TestResult[] {
    return (this.db.prepare('SELECT * FROM test_results WHERE test_id=? ORDER BY at DESC LIMIT ?').all(testId, limit) as Record<string, unknown>[])
      .map((r) => ({ run_id: String(r.run_id), test_id: String(r.test_id), status: String(r.status) as TestResult['status'], evidence: dec<string[]>(r.evidence) ?? [], reason: s(r.reason), at: Number(r.at) }))
  }

  latestResult(testId: string): TestResult | null {
    return this.results(testId, 1)[0] ?? null
  }

  // ---------------------------------------------------------------- coverage

  definePoint(p: { id?: string | undefined; requirements: string[]; kind: CoveragePoint['kind']; match: string; goal?: number | undefined; description?: string | undefined }): CoveragePoint {
    return transaction(this.db, () => {
      const id = p.id ?? nextId(this.db, 'coverage_points', 'COV')
      if (!ID.test(id)) throw new ToolError(`coverage point id ${JSON.stringify(id)}: letters, digits, '.', '_' and '-'`)
      this.checkRequirements(p.requirements)
      if (p.match.startsWith('/')) {
        try {
          matcher(p.match)
        } catch {
          throw new ToolError(`coverage point ${id}: ${p.match} is not a valid /regex/`)
        }
      }
      const t = now()
      const old = this.db.prepare('SELECT created FROM coverage_points WHERE id=?').get(id)
      this.db.prepare('INSERT OR REPLACE INTO coverage_points (id, requirements, kind, match, goal, description, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, enc(p.requirements), p.kind, p.match, p.goal ?? 1, p.description ?? null, old ? Number(old.created) : t, t, who())
      return toPoint(this.db.prepare('SELECT * FROM coverage_points WHERE id=?').get(id) as Record<string, unknown>)
    })
  }

  points(): CoveragePoint[] {
    return (this.db.prepare('SELECT * FROM coverage_points ORDER BY id').all() as Record<string, unknown>[]).map(toPoint)
  }

  deletePoint(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM coverage_points WHERE id=?').run(id).changes) > 0
  }

  addHits(runId: string, kind: string, hits: ReadonlyMap<string, { hits: number; location?: string | null }>): void {
    const st = this.db.prepare('INSERT OR REPLACE INTO coverage_hits (run_id, kind, name, hits, location) VALUES (?,?,?,?,?)')
    transaction(this.db, () => {
      for (const [name, h] of hits) st.run(runId, kind, name, h.hits, h.location ?? null)
    })
  }

  hits(runIds: readonly string[]): Hit[] {
    if (!runIds.length) return []
    const q = this.db.prepare(`SELECT * FROM coverage_hits WHERE run_id IN (${runIds.map(() => '?').join(',')})`)
    return (q.all(...runIds) as Record<string, unknown>[]).map((r) => ({ run_id: String(r.run_id), kind: String(r.kind), name: String(r.name), hits: Number(r.hits), location: s(r.location) }))
  }

  hasHits(runId: string): boolean {
    return this.db.prepare('SELECT 1 FROM coverage_hits WHERE run_id=? LIMIT 1').get(runId) !== undefined
  }
}

/** A coverage point's match: a plain name matches exactly (or as the last dotted part of a hierarchical name), and
 * /regex/flags is a regular expression. */
export function matcher(match: string): (name: string) => boolean {
  const m = /^\/(.*)\/([a-z]*)$/.exec(match)
  if (m) {
    const re = new RegExp(m[1] as string, m[2])
    return (n) => re.test(n)
  }
  return (n) => n === match || n.endsWith(`.${match}`)
}

export function withVerify<T>(fn: (v: VerifyDb) => T): T {
  const v = new VerifyDb()
  try {
    return fn(v)
  } finally {
    v.close()
  }
}
