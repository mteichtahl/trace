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
  agent TEXT                      -- the agent whose session made it (TRACE_AGENT: verify, impl, …, worker), NULL for a person's own run
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
 * The project schema, every registered table, and the columns added since a database was made: `runs.agent` (which
 * agent made a run; databases from before it get the column, NULL on their old rows, always last so `SELECT *`
 * merges line up).
 */
export function applyProjectSchema(db: DatabaseSync): void {
  db.exec(PROJECT_SCHEMA)
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('runs')").all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('agent')) db.exec('ALTER TABLE runs ADD COLUMN agent TEXT')
  for (const t of PROJECT_TABLES.values()) db.exec(t.sql)
}

/** Which agent is making runs in this process: TRACE_AGENT (a job's MCP server has it: src/agents/runtime/job.ts
 * journeyAgentEnv), or none (a person's own CLI). */
export const runAgent = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const a = env.TRACE_AGENT?.trim().toLowerCase()
  return a && /^[a-z][a-z0-9-]{0,31}$/.test(a) ? a : null
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

  /** `agent`: who makes it (default runAgent(): the agent of the job this process serves, if any). */
  start(kind: string, opts: { subject?: string; args?: unknown; gitSha?: string; agent?: string | null } = {}): string {
    const id = randomUUID().replaceAll('-', '').slice(0, 16)
    this.db.prepare('INSERT INTO runs (id, kind, subject, started, args, git_sha, agent) VALUES (?,?,?,?,?,?,?)')
      .run(id, kind, opts.subject ?? null, now(), enc(opts.args), opts.gitSha ?? null, opts.agent === undefined ? runAgent() : opts.agent)
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
  }

  getArtifact(id: string, name: string): Uint8Array | null {
    const row = this.db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(id, name)
    return row ? unpackArtifact(row.mime as string | null, row.bytes as Uint8Array).bytes : null
  }

  /** The newest runs: of a kind (a prefix), and of one agent's sessions (`agent`), when given. */
  runs(kind?: string, limit = 20, agent?: string): RunSummary[] {
    const where = [...(kind ? ['kind LIKE ?'] : []), ...(agent ? ['agent = ?'] : [])]
    const sql = `SELECT id, kind, subject, started, finished, status, summary, agent FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started DESC LIMIT ?`
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
