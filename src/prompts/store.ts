/**
 * Where prompt overrides are kept, and every change to them.
 *
 *   installation  one SQLite database through the central store's machinery (src/core/central.ts), beside the access
 *                 store: s3://<bucket>/prompts in AWS (TRACE_HOME's sibling), $TRACE_HOME/prompts locally,
 *                 $TRACE_PROMPTS_HOME to name another place. Written by the API runtime (admins, after the access
 *                 check) and by an admin's own `trace prompts --installation`; the workers and the repositories'
 *                 workflows only read it (their roles may not write prompts/*)
 *   project       the project's .trace/project.db, versioned in git with the repository. Through the API a change is
 *                 a commit on a trace/prompts-<slug>-<ts> branch, and .trace/** is a protected path, so its pull
 *                 request waits for a person, like settings.set. Jobs read it from the default branch only, never
 *                 from a pull request's tree
 *
 * Both have the same two tables:
 *
 *   prompts         one row per overridden id: its text (NULL after a reset: a tombstone, so a reset merges across
 *                   branches like any change), version, when and by whom
 *   prompt_history  every set, reset and revert, append only: a uid, the id, the version it made, the text, by (a
 *                   person's 16-character hash through the API, the login locally), when and why
 *
 * Merging .trace/project.db (`trace db merge`): prompts keeps, per id, the row changed last (`updated`); history is
 * the union of both sides (uids never collide). Two branches can each make, say, v3 of one id: their history keeps
 * both, and `uid` tells them apart.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { type Central, central } from '../core/central.js'
import { ensureProjectSchema, open, openProject, projectPath, traceHome, transaction } from '../core/store.js'
import { CATALOG, PROMPT_ID } from './catalog.js'
import type { Layers, Override, OverrideLayer } from './resolve.js'
import { overrideProblem } from './resolve.js'
import { TemplateError } from './template.js'

export const PROMPTS_PREFIX = 'prompts'

const PROMPTS_TABLE = `
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,            -- a prompt id of the catalog (src/prompts/catalog.ts)
  text TEXT,                      -- the override; NULL: reset to the layer below
  version INTEGER NOT NULL,       -- 1, 2, 3, … per id
  updated REAL NOT NULL,          -- seconds since the epoch
  by TEXT                         -- a person's hash (API) or a login (CLI)
);`
const HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS prompt_history (
  uid TEXT PRIMARY KEY,           -- unique, so two branches' histories merge as a union
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'reset', 'revert')),
  text TEXT,                      -- what it set (NULL for a reset)
  by TEXT,
  at REAL NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS prompt_history_id ON prompt_history(id, at);
`
const TABLES = `${PROMPTS_TABLE}\n${HISTORY_TABLE}`

// The project database's tables, with their merge rule (src/core/dbmerge.ts runs it with their copy attached as `theirs`).
ensureProjectSchema({
  table: 'prompts',
  sql: PROMPTS_TABLE,
  merge: `INSERT INTO prompts (id, text, version, updated, by) SELECT id, text, version, updated, by FROM theirs.prompts WHERE true
    ON CONFLICT(id) DO UPDATE SET text=excluded.text, version=excluded.version, updated=excluded.updated, by=excluded.by
    WHERE excluded.updated > prompts.updated`,
})
ensureProjectSchema({
  table: 'prompt_history',
  sql: HISTORY_TABLE,
})

export const ReasonSchema = z.string().trim().min(1, 'give a reason').max(500)
export const PromptIdSchema = z.string().regex(PROMPT_ID, 'a prompt id such as specialist.verify.workflow')

export interface HistoryEntry { uid: string; id: string; version: number; action: 'set' | 'reset' | 'revert'; text: string | null; by: string | null; at: number; reason: string | null }

export class PromptError extends Error {
  override name = 'PromptError'
}

const hasTables = (db: DatabaseSync): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='prompts'").get())

const overrideOf = (r: Record<string, unknown>): Override => ({
  id: String(r.id), text: r.text === null || r.text === undefined ? null : String(r.text), version: Number(r.version), updated: Number(r.updated),
  by: r.by === null || r.by === undefined ? null : String(r.by),
})
const historyOf = (r: Record<string, unknown>): HistoryEntry => ({
  uid: String(r.uid), id: String(r.id), version: Number(r.version), action: String(r.action) as HistoryEntry['action'],
  text: r.text === null || r.text === undefined ? null : String(r.text), by: r.by === null || r.by === undefined ? null : String(r.by),
  at: Number(r.at), reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
})

/** Every override row in a database (resets included, as text null). */
export function readOverrides(db: DatabaseSync): Map<string, Override> {
  if (!hasTables(db)) return new Map()
  return new Map(db.prepare('SELECT id, text, version, updated, by FROM prompts ORDER BY id').all().map((r) => [String(r.id), overrideOf(r)]))
}

/** One id's history, oldest first. */
export function readHistory(db: DatabaseSync, id: string): HistoryEntry[] {
  if (!hasTables(db)) return []
  return db.prepare('SELECT * FROM prompt_history WHERE id=? ORDER BY at, version').all(id).map(historyOf)
}

/** The checks every write passes: a known, editable id; a valid template within the size cap; a reason. */
export function checkSet(id: string, text: string): void {
  PromptIdSchema.parse(id)
  const e = CATALOG.get(id)
  if (!e) throw new PromptError(`no prompt ${id} in the catalog (trace prompts list)`)
  if (e.mode === 'locked') throw new PromptError(`${id} is locked: it can be read but not overridden`)
  const problem = overrideProblem(e, text)
  if (problem) throw new TemplateError(problem)
}

export interface Change { id: string; text: string | null; by: string | null; reason: string; action: 'set' | 'reset' | 'revert'; now?: number }

/** Write one change and its history row, in the caller's transaction. Returns the history entry. */
export function writeChange(db: DatabaseSync, c: Change): HistoryEntry {
  db.exec(TABLES)
  const at = c.now ?? Date.now() / 1000
  const prev = db.prepare('SELECT MAX(version) AS v FROM prompt_history WHERE id=?').get(c.id) as { v: number | null } | undefined
  const cur = db.prepare('SELECT version FROM prompts WHERE id=?').get(c.id) as { version: number } | undefined
  const version = Math.max(Number(prev?.v ?? 0), Number(cur?.version ?? 0)) + 1
  // `updated` strictly increases per id, so the merge's "changed last" is well defined even within one second
  const last = db.prepare('SELECT updated FROM prompts WHERE id=?').get(c.id) as { updated: number } | undefined
  const updated = Math.max(at, Number(last?.updated ?? 0) + 1e-6)
  db.prepare(`INSERT INTO prompts (id, text, version, updated, by) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET text=excluded.text, version=excluded.version, updated=excluded.updated, by=excluded.by`)
    .run(c.id, c.text, version, updated, c.by)
  const entry: HistoryEntry = { uid: randomUUID().replaceAll('-', '').slice(0, 16), id: c.id, version, action: c.action, text: c.text, by: c.by, at: updated, reason: c.reason }
  db.prepare('INSERT INTO prompt_history (uid, id, version, action, text, by, at, reason) VALUES (?,?,?,?,?,?,?,?)')
    .run(entry.uid, entry.id, entry.version, entry.action, entry.text, entry.by, entry.at, entry.reason)
  return entry
}

/** The history entry a revert names: a version number, or a uid (or its first 6+ characters). */
export function findVersion(history: readonly HistoryEntry[], which: string | number): HistoryEntry {
  const w = String(which).trim().replace(/^v/, '')
  const byVersion = /^\d+$/.test(w) ? history.filter((h) => h.version === Number(w)) : []
  // two branches may each have made the same version number: the later one, unless a uid says otherwise
  const hit = byVersion.at(-1) ?? (w.length >= 6 ? history.find((h) => h.uid.startsWith(w)) : undefined)
  if (!hit) throw new PromptError(`no version ${which} of ${history[0]?.id ?? 'this prompt'} (its history lists them)`)
  return hit
}

/** set / reset / revert on one database (either layer), checked. */
export interface Edit { op: 'set'; id: string; text: string; reason: string; by: string | null }
export interface Reset { op: 'reset'; id: string; reason: string; by: string | null }
export interface Revert { op: 'revert'; id: string; to: string | number; reason?: string | undefined; by: string | null }
export type PromptWrite = Edit | Reset | Revert

export function applyWrite(db: DatabaseSync, w: PromptWrite, now?: number): HistoryEntry {
  PromptIdSchema.parse(w.id)
  switch (w.op) {
    case 'set':
      checkSet(w.id, w.text)
      return writeChange(db, { id: w.id, text: w.text, by: w.by, reason: ReasonSchema.parse(w.reason), action: 'set', ...(now ? { now } : {}) })
    case 'reset': {
      if (!CATALOG.has(w.id) && !readOverrides(db).has(w.id)) throw new PromptError(`no prompt ${w.id} in the catalog or in this layer`)
      const cur = readOverrides(db).get(w.id)
      if (!cur || cur.text === null) throw new PromptError(`${w.id} has no override in this layer`)
      return writeChange(db, { id: w.id, text: null, by: w.by, reason: ReasonSchema.parse(w.reason), action: 'reset', ...(now ? { now } : {}) })
    }
    case 'revert': {
      const target = findVersion(readHistory(db, w.id), w.to)
      if (target.text !== null) checkSet(w.id, target.text)
      return writeChange(db, {
        id: w.id, text: target.text, by: w.by, reason: ReasonSchema.parse(w.reason ?? `revert to v${target.version} (${target.uid})`), action: 'revert', ...(now ? { now } : {}),
      })
    }
  }
}

// ------------------------------------------------------------------ the installation's store

/** Where the installation's overrides are: $TRACE_PROMPTS_HOME, else beside TRACE_HOME (s3://b/central → s3://b/prompts), else $TRACE_HOME/prompts. */
export function promptsHome(env: Record<string, string | undefined> = process.env): string {
  if (env.TRACE_PROMPTS_HOME) return env.TRACE_PROMPTS_HOME
  const home = env.TRACE_HOME || traceHome()
  const s3 = /^s3:\/\/([^/]+)(\/.*)?$/.exec(home)
  if (s3) {
    const parts = (s3[2] ?? '').split('/').filter(Boolean)
    parts.pop()
    return `s3://${s3[1]}/${[...parts, PROMPTS_PREFIX].join('/')}`
  }
  return join(home.replace(/^file:\/\//, ''), PROMPTS_PREFIX)
}

/** The installation's overrides (admins). Reads are a read-only copy; writes a transaction or a conditional put. */
export class InstallationPrompts {
  readonly store: Central

  constructor(o: { home?: string; store?: Central } = {}) {
    this.store = o.store ?? central(o.home ?? promptsHome())
  }

  get location(): string { return this.store.location }

  async overrides(): Promise<Map<string, Override>> {
    return this.store.query((db) => readOverrides(db))
  }

  async history(id: string): Promise<HistoryEntry[]> {
    return this.store.query((db) => readHistory(db, id))
  }

  /** Replayable (an S3 conflict re-runs it on a fresh copy): it reads all it needs from the database it is given. */
  async write(w: PromptWrite): Promise<HistoryEntry> {
    return this.store.update((db) => applyWrite(db, w))
  }
}

// ------------------------------------------------------------------ a project's database

/** A project database file's overrides (read only; none when the file or the tables are not there). */
export function projectOverrides(dbPath: string): Map<string, Override> {
  if (!existsSync(dbPath)) return new Map()
  const db = open(dbPath, { readonly: true })
  try {
    return readOverrides(db)
  } finally {
    db.close()
  }
}

export function projectHistory(dbPath: string, id: string): HistoryEntry[] {
  if (!existsSync(dbPath)) return []
  const db = open(dbPath, { readonly: true })
  try {
    return readHistory(db, id)
  } finally {
    db.close()
  }
}

/** Write one change to the project database at/above `root` (default: the one around the current directory). */
export function writeProject(w: PromptWrite, root?: string): HistoryEntry {
  const db = openProject(root)
  try {
    return transaction(db, () => applyWrite(db, w))
  } finally {
    db.close()
  }
}

export const localUser = (): string | null => {
  try {
    return userInfo().username
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ loading the layers for a job

/**
 * The layers a job runs with: the project's overrides from `projectDb` (the default branch's .trace/project.db) and
 * the installation's. A layer that cannot be read is left out and said so (`unavailable`): the job runs with the
 * layers below it, never with a guess.
 */
export async function loadLayers(o: { projectDb?: string | null; installation?: InstallationPrompts | null }): Promise<Layers> {
  const unavailable: { layer: OverrideLayer; reason: string }[] = []
  let project: Map<string, Override> | undefined
  let installation: Map<string, Override> | undefined
  if (o.projectDb) {
    try { project = projectOverrides(o.projectDb) } catch (e) { unavailable.push({ layer: 'project', reason: errText(e) }) }
  }
  if (o.installation) {
    try { installation = await o.installation.overrides() } catch (e) { unavailable.push({ layer: 'installation', reason: errText(e) }) }
  }
  return { ...(installation ? { installation } : {}), ...(project ? { project } : {}), ...(unavailable.length ? { unavailable } : {}) }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** The project database path of a checkout. */
export const projectDbOf = (dir: string): string => projectPath(dir)

// ------------------------------------------------------------------ diff

/** A line diff of two texts (`-` theirs only, `+` ours only, ` ` both), for `trace prompts diff`. */
export function diffLines(a: string, b: string): string {
  const x = a.split('\n')
  const y = b.split('\n')
  const n = x.length
  const m = y.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const row = lcs[i] as number[]
    row[j] = x[i] === y[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++ } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) { out.push(`- ${x[i]}`); i++ } else { out.push(`+ ${y[j]}`); j++ }
  }
  while (i < n) out.push(`- ${x[i++]}`)
  while (j < m) out.push(`+ ${y[j++]}`)
  return out.join('\n')
}
