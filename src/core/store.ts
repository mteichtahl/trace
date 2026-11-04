/**
 * Where trace keeps data: SQLite, always. No .json or .yaml data files.
 *
 *   project  <repo>/.trace/project.db    one per project, committed with the repository: its settings (config.ts)
 *                                          and its run record — every simulation, check, build, capture and
 *                                          measurement, with artifacts (netlists, logs, waveforms, reports) as blobs.
 *                                          Rows have UUID keys, so two branches' records merge cleanly
 *                                          (`tracectl db merge`, wired up by onboarding as a git merge driver). It uses a
 *                                          rollback journal (not WAL), so the committed file is always whole.
 *   central  <TRACE_HOME>/central.db      one for everything all projects share: the datasheet library and the parts
 *                                          database (central.ts). TRACE_HOME is a directory or s3://bucket/prefix.
 *   cache    ~/.cache/tracekit/cache.db   disposable, per machine: parsed boards, field-solver results.
 *
 * Built on Node's own `node:sqlite` (no native module to compile). Lists and mappings are stored as JSON text inside
 * a column: an encoding, not a file.
 */
import { normalisedHash } from './normalise.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Row = Record<string, SQLInputValue>

const BUSY_MS = 30_000

export interface OpenOptions {
  readonly readonly?: boolean
  /** WAL for local shared databases; false (rollback journal) for a database committed to git. */
  readonly wal?: boolean
}

export function open(path: string, opts: OpenOptions = {}): DatabaseSync {
  if (!opts.readonly) mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { readOnly: opts.readonly ?? false, timeout: BUSY_MS, enableForeignKeyConstraints: true })
  if (!opts.readonly) setJournalMode(db, opts.wal === false ? 'delete' : 'wal')
  return db
}

/**
 * Switch the journal mode, waiting out other connections. Changing the mode needs an exclusive lock, and SQLite
 * answers "database is locked" at once instead of calling the busy handler, so several processes opening the same
 * new database could fail here. The mode is persistent: when it is already set, nothing is locked at all.
 */
export function setJournalMode(db: Pick<DatabaseSync, 'prepare' | 'exec'>, mode: 'wal' | 'delete'): void {
  const current = (): string => String((db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined)?.journal_mode ?? '').toLowerCase()
  const deadline = Date.now() + BUSY_MS
  for (let wait = 5; ; wait = Math.min(wait * 2, 200)) {
    try {
      if (current() === mode) return
      db.exec(`PRAGMA journal_mode=${mode.toUpperCase()}`)
      return
    } catch (e) {
      if (!/database is locked|SQLITE_BUSY/i.test(String((e as Error).message)) || Date.now() > deadline) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
    }
  }
}

/** BEGIN IMMEDIATE … COMMIT: writers queue rather than fail half way. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const enc = (v: unknown): string => JSON.stringify(v ?? null)
export const dec = <T = Json>(s: unknown): T => (s === null || s === undefined ? (null as T) : (JSON.parse(String(s)) as T))

// ------------------------------------------------------------------ locations

export const PROJECT_DB = join('.trace', 'project.db')

/** The nearest directory at or above `start` holding .trace/project.db or .git. */
export function findRoot(start: string = process.cwd()): string | null {
  let d = resolve(start)
  for (;;) {
    if (existsSync(join(d, PROJECT_DB)) || existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d || d === parse(d).root) return null
    d = up
  }
}

/** <root's repository>/.trace/project.db when `root` is given; else $TRACE_PROJECT_DB, else the repository around the
 * current directory, else a per-user database for work outside any repository. */
export function projectPath(root?: string): string {
  if (root === undefined && process.env.TRACE_PROJECT_DB) return process.env.TRACE_PROJECT_DB
  const r = findRoot(root)
  if (r === null) return join(homedir(), '.local', 'share', 'tracekit', 'scratch-project.db')
  return join(r, PROJECT_DB)
}

/** Where the central database lives: $TRACE_HOME (a directory or s3://bucket/prefix), default ~/.trace. */
export function traceHome(): string {
  return process.env.TRACE_HOME || join(homedir(), '.trace')
}

export function cachePath(): string {
  if (process.env.TRACE_CACHE_DB) return process.env.TRACE_CACHE_DB
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tracekit', 'cache.db')
}

/** A temporary directory for programs that need files on disk (ngspice, iverilog, kicad-cli). Its contents are
 * working copies: what matters goes into the project database before it is removed. */
export function scratchDir(prefix = 'trace-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ------------------------------------------------------------------ the project schema

export const PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,           -- dotted path: prs.merge_method, hil.instruments, ...
  value TEXT NOT NULL,            -- JSON text
  updated REAL NOT NULL,
  by TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,            -- a UUID, so records from two branches merge without collisions
  kind TEXT NOT NULL,             -- sim.spice, kicad.drc, firmware.build, hil.scope_capture, ...
  subject TEXT,                   -- what it ran on: a project, a netlist, a target, an instrument
  started REAL NOT NULL, finished REAL,
  status TEXT NOT NULL DEFAULT 'running',   -- running | pass | fail | error
  summary TEXT,                   -- one line for people
  args TEXT,                      -- JSON text: the inputs
  result TEXT,                    -- JSON text: the compact result returned to the caller
  git_sha TEXT,
  agent TEXT,                     -- the agent whose session made it (TRACE_AGENT: verify, impl, …, worker), NULL for a person's own run
  job TEXT                        -- the job whose session made it (TRACE_JOB_ID, else gh-<GITHUB_RUN_ID>), NULL outside a job
);
CREATE INDEX IF NOT EXISTS runs_kind ON runs(kind, started);
CREATE TABLE IF NOT EXISTS measurements (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, value REAL, unit TEXT, detail TEXT,
  PRIMARY KEY (run_id, name)
);
CREATE TABLE IF NOT EXISTS artifacts (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,             -- netlist.cir, ngspice.log, capture.vcd, drc-report, build.log, waveform.csv
  mime TEXT, bytes BLOB NOT NULL,
  PRIMARY KEY (run_id, name)
);
`

/**
 * Tables an area adds to the project database (CREATE … IF NOT EXISTS), applied after PROJECT_SCHEMA wherever the
 * project database is opened. `merge` is the SQL `tracectl db merge` runs for the table, with their database attached
 * as `theirs` (e.g. an upsert keeping the newer row); without it a registered table is merged as a union
 * (INSERT OR IGNORE: on a key both sides have, ours is kept).
 */
export interface ProjectTable { readonly table: string; readonly sql: string; readonly merge?: string }

const PROJECT_TABLES = new Map<string, ProjectTable>()

export function ensureProjectSchema(t: ProjectTable): void {
  PROJECT_TABLES.set(t.table, t)
}

/** The registered tables, in registration order. */
export function projectTables(): ProjectTable[] {
  return [...PROJECT_TABLES.values()]
}

/**
 * Lineage (docs/ontology.md "Input/output, versions and staleness"): what each run was made from, and a hash of each
 * output over a normalised form, so freshness can be worked out on read (src/ontology/lineage.ts). Rows are written
 * once, with the run, and merge as a union: a run's inputs never change after it.
 *
 *   run_inputs       one row per input: a file of the repository (its path and the hash of its normalised content when
 *                    the run read it), or an output of another run (that run's id, the output's name and its hash)
 *   artifact_hashes  each output's hash, over the normalised form its kind defines (src/core/normalise.ts), so a
 *                    report regenerated with only a new timestamp has the same hash
 */
ensureProjectSchema({ table: 'run_inputs', sql: `
CREATE TABLE IF NOT EXISTS run_inputs (
  run_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'artifact')),
  ref TEXT NOT NULL,              -- file: its path in the repository; artifact: the run that made it
  name TEXT,                      -- artifact: the output's name
  sha256 TEXT,                    -- the normalised content's hash when the run read it (NULL: the file was missing)
  PRIMARY KEY (run_id, ord)
);
CREATE INDEX IF NOT EXISTS run_inputs_ref ON run_inputs(ref);` })

ensureProjectSchema({ table: 'artifact_hashes', sql: `
CREATE TABLE IF NOT EXISTS artifact_hashes (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,           -- over the normalised form (src/core/normalise.ts)
  PRIMARY KEY (run_id, name)
);` })

export interface RunInput { kind: 'file' | 'artifact'; ref: string; name?: string | null; sha256: string | null }

/**
 * The project schema, every registered table, and the columns added since a database was made: `runs.agent` (which
 * agent made a run) then `runs.job` (which job's session made it); databases from before them get the columns, NULL on
 * their old rows, always last and in that order so `SELECT *` merges line up.
 */
export function applyProjectSchema(db: DatabaseSync): void {
  db.exec(PROJECT_SCHEMA)
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('runs')").all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('agent')) db.exec('ALTER TABLE runs ADD COLUMN agent TEXT')
  if (!cols.has('job')) db.exec('ALTER TABLE runs ADD COLUMN job TEXT')
  for (const t of PROJECT_TABLES.values()) db.exec(t.sql)
}

/** Which agent is making runs in this process: TRACE_AGENT (a job's MCP server has it: src/agents/runtime/job.ts
 * journeyAgentEnv), or none (a person's own CLI). */
export const runAgent = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const a = env.TRACE_AGENT?.trim().toLowerCase()
  return a && /^[a-z][a-z0-9-]{0,31}$/.test(a) ? a : null
}

/** Which job is making runs in this process: TRACE_JOB_ID (a job's MCP server has it), else the GitHub Actions run
 * (`gh-<GITHUB_RUN_ID>`), else none (a person's own CLI). */
export const runJob = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const j = env.TRACE_JOB_ID?.trim()
  if (j) return j.slice(0, 200)
  const g = env.GITHUB_RUN_ID?.trim()
  return g ? `gh-${g.slice(0, 40)}` : null
}

export function openProject(root?: string): DatabaseSync {
  const db = open(projectPath(root), { wal: false })
  applyProjectSchema(db)
  return db
}

export type RunStatus = 'running' | 'pass' | 'fail' | 'error'

export interface RunSummary {
  id: string
  kind: string
  subject: string | null
  started: number
  finished: number | null
  status: RunStatus
  summary: string | null
  /** the agent whose session made it (null: a person's own run, or a run from before agents were recorded) */
  agent: string | null
  /** the job whose session made it (null: outside a job, or a run from before jobs were recorded) */
  job: string | null
}

/** One run of a job's session, as the run page lists its steps. `args` and `result` only for some (Work.session). */
export interface SessionStep { id: string; kind: string; summary: string | null; status: RunStatus; started: number; finished: number | null; args?: Json; result?: Json }
/** The runs of one job's session (Work.session). */
export interface RunSession { job: string; agent: string | null; steps: SessionStep[] }
/** At most this many steps of a session are answered. */
export const SESSION_STEPS = 200
/** At most this many steps other than the run itself and the failed ones carry their args and result. */
export const SESSION_DETAILED = 20
/** A step's args and result are cut to this many characters of JSON. */
export const SESSION_JSON_MAX = 4 * 1024

/** A value as a step carries it: itself when its JSON is at most `max` characters, else that JSON cut, ending in `…`. */
export function trimJson(v: Json, max = SESSION_JSON_MAX): Json {
  if (v === null) return null
  const t = JSON.stringify(v)
  return t.length <= max ? v : `${t.slice(0, max - 1)}…`
}

export interface Measurement {
  name: string
  value: number | null
  unit: string | null
}

export interface RunRecord extends RunSummary {
  args: Json
  result: Json
  git_sha: string | null
  measurements: Measurement[]
  artifacts: { name: string; mime: string | null; size: number }[]
}

const now = (): number => Date.now() / 1000

/**
 * The project's run record.
 *
 *   const w = new Work()
 *   const id = w.start('sim.spice', { subject: 'rc-lowpass', args })
 *   w.artifact(id, 'netlist.cir', netlist)
 *   w.measure(id, 'f3db', 1591.5, 'Hz')
 *   w.finish(id, 'pass', 'f-3dB = 1.59 kHz', result)
 */
export class Work {
  readonly db: DatabaseSync

  constructor(path?: string) {
    this.db = open(path ?? projectPath(), { wal: false })
    applyProjectSchema(this.db)
  }

  /** `agent`: who makes it (default runAgent(): the agent of the job this process serves, if any); `job`: in which job
   * (default runJob()). */
  start(kind: string, opts: { subject?: string; args?: unknown; gitSha?: string; agent?: string | null; job?: string | null } = {}): string {
    const id = randomUUID().replaceAll('-', '').slice(0, 16)
    this.db.prepare('INSERT INTO runs (id, kind, subject, started, args, git_sha, agent, job) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, kind, opts.subject ?? null, now(), enc(opts.args), opts.gitSha ?? null, opts.agent === undefined ? runAgent() : opts.agent, opts.job === undefined ? runJob() : opts.job)
    return id
  }

  finish(id: string, status: Exclude<RunStatus, 'running'>, summary = '', result?: unknown): void {
    this.db.prepare('UPDATE runs SET finished=?, status=?, summary=?, result=? WHERE id=?').run(now(), status, summary, enc(result), id)
  }

  measure(id: string, name: string, value: number | null, unit = '', detail?: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO measurements VALUES (?,?,?,?,?)')
      .run(id, name, value, unit, detail === undefined ? null : enc(detail))
  }

  artifact(id: string, name: string, data: string | Uint8Array, mime?: string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const p = packArtifact(mime ?? (typeof data === 'string' ? 'text/plain' : 'application/octet-stream'), bytes)
    this.db.prepare('INSERT OR REPLACE INTO artifacts VALUES (?,?,?,?)').run(id, name, p.mime, p.bytes)
    this.db.prepare('INSERT OR REPLACE INTO artifact_hashes (run_id, name, sha256) VALUES (?,?,?)').run(id, name, normalisedHash(name, bytes))
  }

  /** Record what a run was made from (lineage): once, in order. */
  inputs(id: string, inputs: readonly RunInput[]): void {
    const add = this.db.prepare('INSERT OR IGNORE INTO run_inputs (run_id, ord, kind, ref, name, sha256) VALUES (?,?,?,?,?,?)')
    inputs.forEach((x, i) => add.run(id, i, x.kind, x.ref, x.name ?? null, x.sha256))
  }

  getArtifact(id: string, name: string): Uint8Array | null {
    const row = this.db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(id, name)
    return row ? unpackArtifact(row.mime as string | null, row.bytes as Uint8Array).bytes : null
  }

  /** The newest runs: of a kind (a prefix), and of one agent's sessions (`agent`), when given. */
  runs(kind?: string, limit = 20, agent?: string): RunSummary[] {
    const where = [...(kind ? ['kind LIKE ?'] : []), ...(agent ? ['agent = ?'] : [])]
    const sql = `SELECT id, kind, subject, started, finished, status, summary, agent, job FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started DESC LIMIT ?`
    const args = [...(kind ? [`${kind}%`] : []), ...(agent ? [agent] : []), limit]
    return this.db.prepare(sql).all(...args) as unknown as RunSummary[]
  }

  run(id: string): RunRecord | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id)
    if (!r) return null
    const measurements = this.db.prepare('SELECT name, value, unit FROM measurements WHERE run_id=? ORDER BY name').all(id) as unknown as Measurement[]
    const artifacts = (this.db.prepare('SELECT name, mime, length(bytes) AS size FROM artifacts WHERE run_id=? ORDER BY name').all(id) as unknown as RunRecord['artifacts'])
      .map((a) => ({ ...a, mime: artifactMime(a.mime) }))
    return { ...(r as unknown as RunRecord), args: dec(r.args), result: dec(r.result), measurements, artifacts }
  }

  /**
   * The session run `id` belongs to: every run of the same job, oldest first, at most SESSION_STEPS (the ones nearest
   * `id` when there are more). `args` and `result` (each cut to SESSION_JSON_MAX characters of JSON) only for `id`
   * itself, a failed or errored step, and the SESSION_DETAILED others nearest it. Null when there is no such run or it
   * has no job.
   */
  session(id: string): RunSession | null {
    const me = this.db.prepare('SELECT job, agent, started FROM runs WHERE id=?').get(id) as { job: string | null; agent: string | null; started: number } | undefined
    if (!me?.job) return null
    type Row = { id: string; kind: string; summary: string | null; status: RunStatus; started: number; finished: number | null; args: string | null; result: string | null }
    const cols = 'id, kind, summary, status, started, finished, args, result'
    // the runs around this one: up to half before and the rest after, then topped up from the other side
    const half = Math.floor(SESSION_STEPS / 2)
    const before = this.db.prepare(`SELECT ${cols} FROM runs WHERE job=? AND (started < ? OR (started = ? AND id < ?)) ORDER BY started DESC, id DESC LIMIT ?`).all(me.job, me.started, me.started, id, SESSION_STEPS) as unknown as Row[]
    const after = this.db.prepare(`SELECT ${cols} FROM runs WHERE job=? AND (started > ? OR (started = ? AND id >= ?)) ORDER BY started, id LIMIT ?`).all(me.job, me.started, me.started, id, SESSION_STEPS) as unknown as Row[]
    const nb = Math.min(before.length, Math.max(half, SESSION_STEPS - after.length))
    const rows = [...before.slice(0, nb).reverse(), ...after.slice(0, SESSION_STEPS - nb)]
    const at = rows.findIndex((r) => r.id === id)
    // the others nearest this run (by position), apart from the failed ones that carry theirs anyway
    const near = new Set(rows.map((r, i) => ({ r, d: Math.abs(i - at) }))
      .filter(({ r }) => r.id !== id && r.status !== 'fail' && r.status !== 'error')
      .sort((a, b) => a.d - b.d).slice(0, SESSION_DETAILED).map(({ r }) => r.id))
    const steps = rows.map((r): SessionStep => {
      const s: SessionStep = { id: r.id, kind: r.kind, summary: r.summary, status: r.status, started: r.started, finished: r.finished }
      if (r.id === id || r.status === 'fail' || r.status === 'error' || near.has(r.id)) { s.args = trimJson(dec(r.args)); s.result = trimJson(dec(r.result)) }
      return s
    })
    return { job: me.job, agent: me.agent, steps }
  }

  close(): void {
    this.db.close()
  }
}

// ------------------------------------------------------------------ cache

const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cache (
  ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, blob BLOB,
  stored REAL NOT NULL, expires REAL,
  PRIMARY KEY (ns, key)
);`

/** const cache = new Cache(); cache.put('pcb', sha, parsed); cache.get<Board>('pcb', sha) */
export class Cache {
  readonly db: DatabaseSync

  constructor(path: string = cachePath()) {
    this.db = open(path)
    this.db.exec(CACHE_SCHEMA)
  }

  get<T = Json>(ns: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value, expires FROM cache WHERE ns=? AND key=?').get(ns, key)
    if (!row || (row.expires !== null && (row.expires as number) < now())) return undefined
    return dec<T>(row.value)
  }

  getBlob(ns: string, key: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT blob, expires FROM cache WHERE ns=? AND key=?').get(ns, key)
    if (!row || row.blob === null || (row.expires !== null && (row.expires as number) < now())) return undefined
    return row.blob as Uint8Array
  }

  put(ns: string, key: string, value: unknown, opts: { ttlSeconds?: number; blob?: Uint8Array } = {}): void {
    const t = now()
    this.db.prepare('INSERT OR REPLACE INTO cache (ns, key, value, blob, stored, expires) VALUES (?,?,?,?,?,?)')
      .run(ns, key, enc(value), opts.blob ?? null, t, opts.ttlSeconds ? t + opts.ttlSeconds : null)
  }

  clear(ns?: string): number {
    const r = ns ? this.db.prepare('DELETE FROM cache WHERE ns=?').run(ns) : this.db.prepare('DELETE FROM cache').run()
    return Number(r.changes)
  }

  close(): void {
    this.db.close()
  }
}

export function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ packed artifacts

/**
 * A large artifact is kept gzipped in .trace/project.db, which lives in git under GitHub's 100 MB file limit: SPICE
 * waveforms (tran.raw, several MB of text each) filled testyyyu's database to 72 MB in one Prove stage, and gzip keeps
 * about a fifth of them. The mime carries the marker, so a reader knows to unpack (unpackArtifact); a file already
 * compressed (images, archives, PDFs), or one gzip does not shrink by a fifth, is kept as it is.
 */
export const PACK_OVER = 256 * 1024
const PACKED = '; trace-encoding=gzip'
const COMPRESSED = /^(image\/(png|jpe?g|gif|webp)|application\/(gzip|zip|x-7z-compressed|zstd|pdf)|video\/|audio\/)/

export function packArtifact(mime: string, bytes: Uint8Array): { mime: string; bytes: Uint8Array } {
  if (bytes.length <= PACK_OVER || mime.endsWith(PACKED) || COMPRESSED.test(mime)) return { mime, bytes }
  const z = gzipSync(bytes, { level: 6 })
  return z.length <= bytes.length * 0.8 ? { mime: `${mime}${PACKED}`, bytes: new Uint8Array(z) } : { mime, bytes }
}

/** An artifact row's own mime and bytes: unpacked when packArtifact packed it, else as stored. */
export function unpackArtifact(mime: string | null, bytes: Uint8Array): { mime: string | null; bytes: Uint8Array } {
  if (!mime?.endsWith(PACKED)) return { mime, bytes }
  return { mime: mime.slice(0, -PACKED.length), bytes: new Uint8Array(gunzipSync(bytes)) }
}

/** An artifact's mime as its readers see it (without the packing marker). */
export const artifactMime = (mime: string | null): string | null => (mime?.endsWith(PACKED) ? mime.slice(0, -PACKED.length) : mime)

/** Pack every large artifact already in a database (tracectl db pack). Returns how many and the bytes before/after. */
export function packArtifacts(db: DatabaseSync): { packed: number; before: number; after: number } {
  const rows = db.prepare('SELECT run_id, name, mime, bytes FROM artifacts WHERE length(bytes) > ?').all(PACK_OVER) as { run_id: string; name: string; mime: string | null; bytes: Uint8Array }[]
  const put = db.prepare('UPDATE artifacts SET mime=?, bytes=? WHERE run_id=? AND name=?')
  let packed = 0, before = 0, after = 0
  for (const r of rows) {
    const p = packArtifact(r.mime ?? 'application/octet-stream', r.bytes)
    if (p.bytes === r.bytes) continue
    put.run(p.mime, p.bytes, r.run_id, r.name)
    packed++; before += r.bytes.length; after += p.bytes.length
  }
  return { packed, before, after }
}
