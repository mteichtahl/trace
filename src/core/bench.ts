/**
 * Bring-up readings and instrument identities: what the bench measured, against which board and step.
 *
 *   where  the run record (.trace/project.db), table `bringup_readings`, beside the run and measurement the hil tool
 *          wrote (run_id): readings are physical-world records taken by tools, like every other measurement, so they
 *          travel with the repository and its releases and merge as a union (UUID keys). Also, best effort, a live
 *          copy in the central bucket, projects/<slug>/journey-agent/bench.db (with each instrument's identity), written
 *          with a conditional put like the agents' facts: the bench machine's run record reaches the API only when it
 *          is pushed, while the bucket copy lets the Bring-up run screen show a reading as it is taken (its write is
 *          an S3 event that src/web/journey-events.ts turns into a live update). A bench machine that cannot reach
 *          the bucket still records every reading in its run record
 *   why not the journey record  the journey is people's entries (decisions, orders, boards received); a reading is a
 *          tool's measurement, so it is recorded where measurements are, and no person types it
 *
 *   one reading  board serial, bring-up step (BRINGUP_STEPS), instrument, quantity (what was measured, in words: "3V3
 *                rail at TP4"), value and unit, the limits (min, max), pass or fail, when, who or what took it (the
 *                agent, or a person at the bench), and the run
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { projectsBackend, projectsFromEnv } from './agent-facts.js'
import { BucketDb } from './journey-store.js'
import { ensureProjectSchema, transaction } from './store.js'

export const BRINGUP_STEPS = ['inspect', 'unpowered', 'rails', 'clocks', 'firmware', 'tests'] as const
export type BringupStep = (typeof BRINGUP_STEPS)[number]
/** Steps that need the board powered. */
export const POWERED_STEPS: readonly BringupStep[] = ['rails', 'clocks', 'firmware', 'tests']

const READINGS_SQL = `
CREATE TABLE IF NOT EXISTS bringup_readings (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL,            -- the board's serial (boards.serial in the journey)
  step TEXT NOT NULL,             -- inspect | unpowered | rails | clocks | firmware | tests
  instrument TEXT,                -- a hil.instruments name
  quantity TEXT NOT NULL,         -- what was measured, in words
  value REAL,                     -- NULL: no reading (an overload, no answer)
  unit TEXT,
  min REAL, max REAL,             -- the limits it is checked against (either may be absent)
  pass INTEGER NOT NULL,          -- within its limits (a missing value fails)
  at REAL NOT NULL,
  by TEXT NOT NULL,               -- the agent or person who took it
  run_id TEXT                     -- the hil run it came from
);
CREATE INDEX IF NOT EXISTS bringup_readings_board ON bringup_readings(board, at);`

ensureProjectSchema({ table: 'bringup_readings', sql: READINGS_SQL })

const IDS_SQL = `
CREATE TABLE IF NOT EXISTS instrument_ids (
  instrument TEXT PRIMARY KEY,
  manufacturer TEXT, model TEXT, serial TEXT, firmware TEXT,
  ok INTEGER NOT NULL,
  at REAL NOT NULL,
  run_id TEXT
);`

export const BENCH_DB = 'bench.db'
export const BENCH_FOLDER = 'journey-agent'

/** The live copy's tables. */
export const applyBenchSchema = (db: DatabaseSync): void => { db.exec(READINGS_SQL); db.exec(IDS_SQL) }

export class BenchStore extends BucketDb {
  constructor(store: import('./central.js').Backend, repo: string, o: { scratch?: string } = {}) {
    super(store, repo, { folder: BENCH_FOLDER, file: BENCH_DB, schema: applyBenchSchema }, o)
  }
}

export interface Reading {
  id: string; board: string; step: BringupStep; instrument: string | null; quantity: string; value: number | null; unit: string | null
  min: number | null; max: number | null; pass: boolean; at: number; by: string; runId: string | null
}
export interface InstrumentId { instrument: string; manufacturer: string | null; model: string | null; serial: string | null; firmware: string | null; ok: boolean; at: number; runId: string | null }

/** Whether a value is within its limits. A missing value never passes. Pure. */
export const withinLimits = (value: number | null, min: number | null, max: number | null): boolean =>
  value !== null && Number.isFinite(value) && (min === null || value >= min) && (max === null || value <= max)

export function newReading(r: Omit<Reading, 'id' | 'pass' | 'at'> & { at?: number }): Reading {
  return { ...r, id: randomUUID().replaceAll('-', '').slice(0, 16), pass: withinLimits(r.value, r.min, r.max), at: r.at ?? Date.now() / 1000 }
}

export function insertReadings(db: DatabaseSync, rows: readonly Reading[]): void {
  db.exec(READINGS_SQL)
  const ins = db.prepare('INSERT OR IGNORE INTO bringup_readings (id, board, step, instrument, quantity, value, unit, min, max, pass, at, by, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const r of rows) ins.run(r.id, r.board, r.step, r.instrument, r.quantity, r.value, r.unit, r.min, r.max, r.pass ? 1 : 0, r.at, r.by, r.runId)
}

export function insertIds(db: DatabaseSync, rows: readonly InstrumentId[]): void {
  db.exec(IDS_SQL)
  const ins = db.prepare('INSERT OR REPLACE INTO instrument_ids (instrument, manufacturer, model, serial, firmware, ok, at, run_id) VALUES (?,?,?,?,?,?,?,?)')
  for (const r of rows) ins.run(r.instrument, r.manufacturer, r.model, r.serial, r.firmware, r.ok ? 1 : 0, r.at, r.runId)
}

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export function loadReadings(db: DatabaseSync, board?: string): Reading[] {
  if (!has(db, 'bringup_readings')) return []
  const rows = (board
    ? db.prepare('SELECT * FROM bringup_readings WHERE board=? ORDER BY at, rowid').all(board)
    : db.prepare('SELECT * FROM bringup_readings ORDER BY at, rowid').all()) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: String(r.id), board: String(r.board), step: String(r.step) as BringupStep, instrument: s(r.instrument), quantity: String(r.quantity), value: n(r.value), unit: s(r.unit),
    min: n(r.min), max: n(r.max), pass: Boolean(r.pass), at: Number(r.at), by: String(r.by), runId: s(r.run_id),
  }))
}

export function loadIds(db: DatabaseSync): InstrumentId[] {
  if (!has(db, 'instrument_ids')) return []
  return (db.prepare('SELECT * FROM instrument_ids ORDER BY instrument').all() as Record<string, unknown>[]).map((r) => ({
    instrument: String(r.instrument), manufacturer: s(r.manufacturer), model: s(r.model), serial: s(r.serial), firmware: s(r.firmware), ok: Boolean(r.ok), at: Number(r.at), runId: s(r.run_id),
  }))
}

/** The identities the run record holds: each instrument's newest hil.idn run. */
export function idsFromRuns(db: DatabaseSync): InstrumentId[] {
  if (!has(db, 'runs')) return []
  const out = new Map<string, InstrumentId>()
  for (const r of db.prepare("SELECT id, subject, status, result, started FROM runs WHERE kind='hil.idn' ORDER BY started").all() as Record<string, unknown>[]) {
    const subject = s(r.subject)
    if (!subject) continue
    let res: Record<string, unknown> = {}
    try { const v: unknown = JSON.parse(String(r.result ?? 'null')); if (v && typeof v === 'object') res = v as Record<string, unknown> } catch { /* none */ }
    out.set(subject, { instrument: subject, manufacturer: s(res.manufacturer), model: s(res.model), serial: s(res.serial), firmware: s(res.firmware), ok: r.status === 'pass', at: Number(r.started), runId: String(r.id) })
  }
  return [...out.values()]
}

/** Two sources of the same rows (the repository's and the live copy), by id, newest per instrument. Pure. */
export function unionReadings(a: readonly Reading[], b: readonly Reading[]): Reading[] {
  const m = new Map<string, Reading>()
  for (const r of [...a, ...b]) m.set(r.id, r)
  return [...m.values()].sort((x, y) => x.at - y.at)
}
export function unionIds(a: readonly InstrumentId[], b: readonly InstrumentId[]): InstrumentId[] {
  const m = new Map<string, InstrumentId>()
  for (const r of [...a, ...b]) { const o = m.get(r.instrument); if (!o || r.at >= o.at) m.set(r.instrument, r) }
  return [...m.values()].sort((x, y) => x.instrument.localeCompare(y.instrument))
}

/** Copy readings and identities into the live copy, when this session can reach the project's store. Never throws. */
export async function mirrorBench(o: { readings?: readonly Reading[]; ids?: readonly InstrumentId[]; env?: Record<string, string | undefined> }): Promise<boolean> {
  const where = projectsFromEnv(o.env ?? process.env)
  if (!where || (!o.readings?.length && !o.ids?.length)) return false
  try {
    await new BenchStore(projectsBackend(where.projects), where.repository).update((db) => {
      transaction(db, () => { insertReadings(db, o.readings ?? []); insertIds(db, o.ids ?? []) })
      return { result: null }
    })
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ what the bring-up skill checks (pure)

/** The newest reading of each step and quantity: a reading taken again replaces the one before it. */
export function latestByQuantity(rows: readonly Reading[]): Reading[] {
  const m = new Map<string, Reading>()
  for (const r of rows) m.set(`${r.step}\n${r.quantity}`, r)
  return [...m.values()]
}

/** Per step of one board: whether it has readings, whether its newest readings all pass, and its first and last time. */
export function stepStates(rows: readonly Reading[]): { step: BringupStep; readings: number; passed: boolean; first: number; lastPass: number | null; failing: string[] }[] {
  const latest = latestByQuantity(rows)
  return BRINGUP_STEPS.filter((st) => rows.some((r) => r.step === st)).map((st) => {
    const all = rows.filter((r) => r.step === st)
    const now = latest.filter((r) => r.step === st)
    const failing = now.filter((r) => !r.pass).map((r) => r.quantity)
    return { step: st, readings: all.length, passed: failing.length === 0, first: Math.min(...all.map((r) => r.at)), lastPass: failing.length ? null : Math.max(...now.map((r) => r.at)), failing }
  })
}

/**
 * "Each step passed its limits before the next": every step a board has readings for passed (its newest readings in
 * limits), and no step began before the step before it had passed. Null: nothing to say (no readings).
 */
export function stepOrderProblems(rows: readonly Reading[]): string[] | null {
  if (!rows.length) return null
  const st = stepStates(rows)
  const out: string[] = []
  for (const [i, s] of st.entries()) {
    if (!s.passed) out.push(`${s.step}: ${s.failing.join(', ')} out of limits`)
    const prev = st[i - 1]
    if (!prev) continue
    // the earlier step as it stood when this one began: every quantity it measured by then in limits
    const before = latestByQuantity(rows.filter((r) => r.step === prev.step && r.at < s.first))
    const quantities = new Set(rows.filter((r) => r.step === prev.step).map((r) => r.quantity))
    if (before.length < quantities.size || before.some((r) => !r.pass)) out.push(`${s.step} began before ${prev.step} had passed`)
  }
  return out
}
