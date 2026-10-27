/**
 * The cost ledger: what each project's cloud use cost, kept in the central bucket beside its journey, never in the
 * repository (money is for admins only, and a repository's record is readable by everyone on the project).
 *
 *   estimates  projects/<slug>/journey-agent/cost.db  one row per agent run (each model's tokens, priced from the one
 *                                                  price table, src/core/prices.ts) and per finished AWS Batch job
 *                                                  (its running time x the pool's price), each with the date and the
 *                                                  source (override, fetched, built-in) of the price that priced it.
 *                                                  Written by the worker (and
 *                                                  the in-Actions fallback) that ran it, with conditional puts like the
 *                                                  agents' facts, never deleted (the same rules as the facts beside
 *                                                  it: src/infra/project.ts AgentFactsConditional).
 *                                                  Every amount here is an estimate, and says so
 *   actuals    installation/cost/actuals.db         what AWS billed per project per day and service, from Cost
 *                                                  Explorer grouped by the trace:project cost allocation tag, written
 *                                                  once a day by the `<prefix>-cost-explorer` Lambda
 *                                                  (src/infra/lambda/cost-explorer.ts), which also keeps its own status:
 *                                                  whether the tag is active for cost allocation, when it read last and
 *                                                  reads next. No worker can reach installation/*, but for the one
 *   prices     installation/cost/prices.json        the price table fetched from the AWS price list by the same
 *                                                  Lambda once a day (src/core/prices-store.ts), which the workers
 *                                                  read to price their rows
 *
 * Why the bucket and not the run record (.trace/project.db): the run record travels with the repository and its pull
 * requests (reviewers read it), a run's row is written in a clone that may never be pushed, and two branches would
 * each carry part of the spend. Why two databases: estimates are written by many workers as they finish; actuals by
 * one Lambda for every project at once, out of the workers' reach so an agent cannot change what AWS billed.
 *
 * Actuals lag: Cost Explorer's figures for a day settle about 24 hours later, so the latest days are re-read each day.
 * Only resources carrying the project tag are counted per project (its worker runtime, memory, knowledge base, CI
 * runner, secret); Bedrock model use and the shared Batch instances are not tagged per project, so for those the
 * estimates are the per-project figure. cost.get says both on screen.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type Backend } from './central.js'
import { projectsBackend, projectsFromEnv } from './agent-facts.js'
import { BucketDb } from './journey-store.js'
import { type PriceSource, type PriceTable, type Tokens, jobCost, modelCost, poolPricedBy, pricesFromEnv } from './prices.js'
import { pricesFor } from './prices-store.js'
import { transaction } from './store.js'

/** The ledger is beside the agents' facts: like them it is written by the project's agents (conditional puts, never
 * deleted: src/infra/project.ts AgentFactsConditional covers the folder) and read by the API. */
export const COST_FOLDER = 'journey-agent'
export const COST_DB = 'cost.db'
/** The actuals' folder under installation/. */
export const ACTUALS_FOLDER = 'cost'
/** Under the central bucket: installation/cost/actuals.db */
export const ACTUALS_PREFIX = 'installation'
export const ACTUALS_KEY = 'cost/actuals.db'

export const USAGE_KINDS = ['agents', 'gpu', 'cpu'] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

const USAGE_SQL = `
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  at REAL NOT NULL,                -- when the run or job finished
  kind TEXT NOT NULL CHECK (kind IN ('agents', 'gpu', 'cpu')),
  job_id TEXT,                     -- the agent's job, or the Batch job's trace id
  agent TEXT,                      -- the specialist or worker (agents), the job kind (gpu, cpu)
  model TEXT,                      -- the model id as called (agents)
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  seconds REAL,                    -- running time (gpu, cpu)
  vcpus INTEGER,                   -- what a CPU job asked for
  amount REAL,                     -- USD, an estimate; NULL: not priced (no table entry, no SDK figure)
  basis TEXT NOT NULL,             -- table | sdk | none
  prices_as_of TEXT,               -- the date of the price that priced it
  prices_source TEXT,              -- where that price came from: override | fetched | built-in (NULL: before sources)
  sdk_cost REAL,                   -- the Agent SDK's own figure (agents), kept for comparison
  region TEXT
);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);`

const ACTUALS_SQL = `
CREATE TABLE IF NOT EXISTS actuals (
  repo TEXT NOT NULL,              -- owner/repo, or '' for the installation's cost no project tag covers
  day TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  service TEXT NOT NULL,
  amount REAL NOT NULL,            -- USD, unblended
  estimated INTEGER NOT NULL,      -- Cost Explorer marks recent days as estimated until they settle
  read_at REAL NOT NULL,
  PRIMARY KEY (repo, day, service)
);
CREATE TABLE IF NOT EXISTS status (
  id TEXT PRIMARY KEY CHECK (id = 'cost-explorer'),
  checked_at REAL NOT NULL,
  next_at REAL,
  ok INTEGER NOT NULL,
  tag TEXT NOT NULL,               -- active | inactive | not_found | unknown
  message TEXT
);`

export const applyUsageSchema = (db: DatabaseSync): void => {
  db.exec(USAGE_SQL)
  // a ledger written before rows kept their price's source
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('usage')").all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('prices_source')) db.exec('ALTER TABLE usage ADD COLUMN prices_source TEXT')
}
export const applyActualsSchema = (db: DatabaseSync): void => { db.exec(ACTUALS_SQL) }

/** One project's estimates, in `store` (the central bucket at its `projects` prefix). */
export class CostLedger extends BucketDb {
  constructor(store: Backend, repo: string, o: { scratch?: string } = {}) {
    super(store, repo, { folder: COST_FOLDER, file: COST_DB, schema: applyUsageSchema }, o)
  }
}

/** The installation's actuals, in `store` (the central bucket at its `installation` prefix). */
export class ActualsStore extends BucketDb {
  constructor(store: Backend, o: { scratch?: string } = {}) {
    super(store, '', { folder: COST_FOLDER, file: 'actuals.db', schema: applyActualsSchema, key: ACTUALS_KEY }, o)
  }
}

// ------------------------------------------------------------------ writing (the worker, best effort)

export interface ModelUse { model: string; tokens: Tokens; sdkCost: number | null }

export interface UsageRow {
  id: string; at: number; kind: UsageKind; jobId: string | null; agent: string | null; model: string | null
  tokens: Tokens | null; seconds: number | null; vcpus: number | null; amount: number | null; basis: 'table' | 'sdk' | 'none'
  pricesAsOf: string | null; pricesSource: PriceSource | null; sdkCost: number | null; region: string | null
}

const newId = (): string => randomUUID().replaceAll('-', '').slice(0, 16)

/** The rows one agent run makes: one per model it used, priced from the table. Pure. */
export function modelRows(t: PriceTable, uses: readonly ModelUse[], o: { at: number; jobId: string | null; agent: string | null; region: string | null }): UsageRow[] {
  return uses.map((u) => {
    const c = modelCost(t, u.model, u.tokens, { region: o.region, sdkCost: u.sdkCost })
    return {
      id: newId(), at: o.at, kind: 'agents', jobId: o.jobId, agent: o.agent, model: u.model, tokens: u.tokens, seconds: null, vcpus: null,
      amount: c.amount, basis: c.basis, pricesAsOf: c.by?.asOf ?? null, pricesSource: c.by?.source ?? null, sdkCost: u.sdkCost, region: o.region,
    }
  })
}

/** The row one finished Batch job makes. Pure. */
export function jobRow(t: PriceTable, j: { pool: 'gpu' | 'cpu'; seconds: number; vcpus: number; at: number; jobId: string; kind: string; region: string | null }): UsageRow {
  const by = poolPricedBy(t, j.pool)
  return {
    id: newId(), at: j.at, kind: j.pool, jobId: j.jobId, agent: j.kind, model: null, tokens: null, seconds: j.seconds, vcpus: j.pool === 'cpu' ? j.vcpus : null,
    amount: jobCost(t, j.pool, j.seconds, j.vcpus), basis: 'table', pricesAsOf: by.asOf, pricesSource: by.source, sdkCost: null, region: j.region,
  }
}

export function insertUsage(db: DatabaseSync, rows: readonly UsageRow[]): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO usage (id, at, kind, job_id, agent, model, input, output, cache_read, cache_write, seconds, vcpus, amount, basis, prices_as_of, prices_source, sdk_cost, region)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  transaction(db, () => {
    for (const r of rows) {
      ins.run(r.id, r.at, r.kind, r.jobId, r.agent, r.model, r.tokens?.input ?? null, r.tokens?.output ?? null, r.tokens?.cacheRead ?? null, r.tokens?.cacheWrite ?? null,
        r.seconds, r.vcpus, r.amount, r.basis, r.pricesAsOf, r.pricesSource, r.sdkCost, r.region)
    }
  })
}

/** The project's ledger from a session's environment (TRACE_PROJECT_HOME / TRACE_HOME and the project), or null. */
export function ledgerFromEnv(env: Record<string, string | undefined> = process.env): CostLedger | null {
  const where = projectsFromEnv(env)
  return where ? new CostLedger(projectsBackend(where.projects), where.repository) : null
}

/**
 * Add rows to the project's ledger. Never throws: cost is recorded on a best-effort basis and a failure to record it
 * never fails the run (it is logged, and the row is lost; cost.get counts what is there).
 */
export async function recordUsage(rows: readonly UsageRow[], o: { ledger?: CostLedger | null; log?: (l: string) => void } = {}): Promise<boolean> {
  if (!rows.length) return true
  const ledger = o.ledger === undefined ? ledgerFromEnv() : o.ledger
  if (!ledger) return false
  try {
    await ledger.update((db) => { insertUsage(db, rows); return { result: null } })
    return true
  } catch (e) {
    o.log?.(`cost: not recorded (${e instanceof Error ? e.message : String(e)})`)
    return false
  }
}

/**
 * Record one agent run's model use (the Agent SDK's result message: modelUsage, total_cost_usd), priced with the table
 * in use (src/core/prices-store.ts pricesFor: the overrides, the fetched price list, the built-in table); `prices`
 * gives it instead.
 */
export async function recordModelUse(uses: readonly ModelUse[], o: { jobId: string | null; agent: string | null; env?: Record<string, string | undefined>; ledger?: CostLedger | null; log?: (l: string) => void; now?: number; prices?: PriceTable }): Promise<boolean> {
  const env = o.env ?? process.env
  // the price read never fails the run: without it, the overrides over the built-in table
  const table = o.prices ?? (await pricesFor(env).catch(() => null))?.table ?? pricesFromEnv(env)
  const rows = modelRows(table, uses.filter((u) => u.tokens.input + u.tokens.output + u.tokens.cacheRead + u.tokens.cacheWrite > 0 || (u.sdkCost ?? 0) > 0),
    { at: (o.now ?? Date.now()) / 1000, jobId: o.jobId, agent: o.agent, region: env.AWS_REGION ?? null })
  return recordUsage(rows, { ...(o.ledger !== undefined ? { ledger: o.ledger } : { ledger: ledgerFromEnv(env) }), ...(o.log ? { log: o.log } : {}) })
}

// ------------------------------------------------------------------ reading (the API)

export function loadUsage(db: DatabaseSync, since = 0): UsageRow[] {
  return (db.prepare('SELECT * FROM usage WHERE at >= ? ORDER BY at').all(since) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), at: Number(r.at), kind: r.kind as UsageKind, jobId: r.job_id === null ? null : String(r.job_id), agent: r.agent === null ? null : String(r.agent),
    model: r.model === null ? null : String(r.model),
    tokens: r.input === null ? null : { input: Number(r.input), output: Number(r.output ?? 0), cacheRead: Number(r.cache_read ?? 0), cacheWrite: Number(r.cache_write ?? 0) },
    seconds: r.seconds === null ? null : Number(r.seconds), vcpus: r.vcpus === null ? null : Number(r.vcpus), amount: r.amount === null ? null : Number(r.amount),
    basis: (r.basis as UsageRow['basis']) ?? 'none', pricesAsOf: r.prices_as_of === null ? null : String(r.prices_as_of),
    pricesSource: r.prices_source === null || r.prices_source === undefined ? null : (String(r.prices_source) as PriceSource), sdkCost: r.sdk_cost === null ? null : Number(r.sdk_cost),
    region: r.region === null ? null : String(r.region),
  }))
}

export interface ActualRow { repo: string; day: string; service: string; amount: number; estimated: boolean }
export interface ExplorerStatus { checkedAt: number; nextAt: number | null; ok: boolean; tag: 'active' | 'inactive' | 'not_found' | 'unknown'; message: string | null }

export function loadActuals(db: DatabaseSync, o: { repo?: string; since?: string } = {}): ActualRow[] {
  const where: string[] = []
  const args: string[] = []
  if (o.repo !== undefined) { where.push('repo = ?'); args.push(o.repo.toLowerCase()) }
  if (o.since) { where.push('day >= ?'); args.push(o.since) }
  return (db.prepare(`SELECT repo, day, service, amount, estimated FROM actuals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY day, repo, service`).all(...args) as Record<string, unknown>[])
    .map((r) => ({ repo: String(r.repo), day: String(r.day), service: String(r.service), amount: Number(r.amount), estimated: Boolean(r.estimated) }))
}

export function loadExplorerStatus(db: DatabaseSync): ExplorerStatus | null {
  const r = db.prepare("SELECT * FROM status WHERE id='cost-explorer'").get() as Record<string, unknown> | undefined
  if (!r) return null
  return { checkedAt: Number(r.checked_at), nextAt: r.next_at === null ? null : Number(r.next_at), ok: Boolean(r.ok), tag: r.tag as ExplorerStatus['tag'], message: r.message === null ? null : String(r.message) }
}

/** Replace the actuals of the days read (Cost Explorer revises recent days), and the status. */
export function writeActuals(db: DatabaseSync, rows: readonly ActualRow[], days: readonly string[], status: ExplorerStatus, at: number): void {
  transaction(db, () => {
    const del = db.prepare('DELETE FROM actuals WHERE day = ?')
    for (const d of days) del.run(d)
    const ins = db.prepare('INSERT OR REPLACE INTO actuals (repo, day, service, amount, estimated, read_at) VALUES (?,?,?,?,?,?)')
    for (const r of rows) ins.run(r.repo.toLowerCase(), r.day, r.service, r.amount, r.estimated ? 1 : 0, at)
    db.prepare("INSERT OR REPLACE INTO status (id, checked_at, next_at, ok, tag, message) VALUES ('cost-explorer', ?, ?, ?, ?, ?)")
      .run(status.checkedAt, status.nextAt, status.ok ? 1 : 0, status.tag, status.message)
  })
}

const cents = (n: number): number => Math.round(n * 100) / 100

/** Which source priced how many rows: override, fetched, built-in; 'sdk' for the Agent SDK's figure; 'unknown' for
 * rows written before rows kept their source. */
export type PricedBySource = Partial<Record<PriceSource | 'sdk' | 'unknown', number>>

/** A project's estimated spend by kind, how much of it is unpriced, and which sources priced it. Pure. */
export function estimateTotals(rows: readonly UsageRow[]): { byKind: Record<UsageKind, number>; total: number; unpriced: number; oldestTable: string | null; bySource: PricedBySource } {
  const byKind: Record<UsageKind, number> = { agents: 0, gpu: 0, cpu: 0 }
  const bySource: PricedBySource = {}
  let unpriced = 0
  let oldest: string | null = null
  for (const r of rows) {
    if (r.amount === null) { unpriced++; continue }
    byKind[r.kind] += r.amount
    const s = r.basis === 'sdk' ? 'sdk' : (r.pricesSource ?? 'unknown')
    bySource[s] = (bySource[s] ?? 0) + 1
    if (r.pricesAsOf && (!oldest || r.pricesAsOf < oldest)) oldest = r.pricesAsOf
  }
  for (const k of USAGE_KINDS) byKind[k] = cents(byKind[k])
  return { byKind, total: cents(byKind.agents + byKind.gpu + byKind.cpu), unpriced, oldestTable: oldest, bySource }
}

/** Actual spend by service, and in all. Pure. */
export function actualTotals(rows: readonly ActualRow[]): { byService: Record<string, number>; total: number; estimatedDays: number; lastDay: string | null } {
  const byService: Record<string, number> = {}
  const est = new Set<string>()
  let last: string | null = null
  for (const r of rows) {
    byService[r.service] = (byService[r.service] ?? 0) + r.amount
    if (r.estimated) est.add(r.day)
    if (!last || r.day > last) last = r.day
  }
  for (const k of Object.keys(byService)) byService[k] = cents(byService[k] ?? 0)
  return { byService, total: cents(Object.values(byService).reduce((a, b) => a + b, 0)), estimatedDays: est.size, lastDay: last }
}

/** A usage row as one line of the Spend table, in plain words. */
export function usageLine(r: UsageRow): { id: string; at: string; what: string; kind: UsageKind; amount: number; estimate: true; basis: UsageRow['basis'] } {
  const tok = r.tokens ? r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite : 0
  const what = r.kind === 'agents'
    ? `${r.agent ?? 'An agent'}${r.jobId ? ` (job ${r.jobId.slice(-8)})` : ''}: ${tok.toLocaleString('en-US')} tokens of ${r.model ?? 'a model'}${r.basis === 'sdk' ? ', priced by the Agent SDK (the price table has no entry for this model)' : r.basis === 'none' ? ', not priced' : ''}`
    : `${r.kind === 'gpu' ? 'Graphics card' : 'CPU'} job ${r.agent ?? ''}: ${Math.round((r.seconds ?? 0) / 60)} min${r.kind === 'cpu' ? ` on ${r.vcpus ?? 1} vCPUs` : ''}`
  return { id: r.id, at: new Date(r.at * 1000).toISOString(), what, kind: r.kind, amount: r.amount ?? 0, estimate: true, basis: r.basis }
}
