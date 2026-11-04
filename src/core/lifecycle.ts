/**
 * A project's lifecycle: whether it is paused, and whether it is retired. Kept on the project's row in the central
 * registry (src/core/onboard.ts `projects`), so the API, the worker runtime and any harness step that can read
 * TRACE_HOME all see the same answer.
 *
 *   paused    the project stays as it is: nothing about it can be changed and no work starts (agents, tools that
 *             change things, the harness) until someone resumes it. Anyone with Contributor standing may pause or
 *             resume; people still read everything.
 *   retired   "deleted" as far as people can tell: it leaves every list and view, and anyone but an admin gets the
 *             same "no access" as for a project that does not exist. Nothing is removed (repository, record, chats,
 *             cloud resources stay), so an admin can restore it. Only admins retire and restore. A retired project
 *             does no work either; restoring it brings back whatever pause it had.
 *
 * Each change is also written to `project_lifecycle_log` here (the admin's history) and, by the API, to the project's
 * decisions log.
 */
import type { DatabaseSync } from 'node:sqlite'
import { ensureSchema, read, update } from './central.js'

export interface Mark { at: number; by: string; reason: string | null }

export interface Lifecycle {
  paused: Mark | null
  retired: Mark | null
}

export type LifecycleChange = 'paused' | 'resumed' | 'retired' | 'restored'

export const ACTIVE: Lifecycle = Object.freeze({ paused: null, retired: null })

/** Whether work and changes are held: paused, or retired. */
export const held = (l: Lifecycle): boolean => l.paused !== null || l.retired !== null

/** The registry's table as onboard.ts makes it, then the lifecycle columns and the log. Checks before it changes. */
export function migrateLifecycle(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS projects (repo TEXT PRIMARY KEY, added REAL NOT NULL, path TEXT)')
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('projects')").all().map((r) => String(r.name)))
  for (const [c, t] of [['paused_at', 'REAL'], ['paused_by', 'TEXT'], ['paused_reason', 'TEXT'], ['retired_at', 'REAL'], ['retired_by', 'TEXT'], ['retired_reason', 'TEXT']] as const) {
    if (!cols.has(c)) db.exec(`ALTER TABLE projects ADD COLUMN ${c} ${t}`)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS project_lifecycle_log (
    at REAL NOT NULL, repo TEXT NOT NULL,
    change TEXT NOT NULL CHECK (change IN ('paused', 'resumed', 'retired', 'restored')),
    by TEXT NOT NULL, reason TEXT)`)
  db.exec('CREATE INDEX IF NOT EXISTS project_lifecycle_log_repo ON project_lifecycle_log (repo, at)')
}
ensureSchema(migrateLifecycle)

const hasColumns = (db: DatabaseSync): boolean =>
  db.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name='retired_at'").get() !== undefined

const mark = (at: unknown, by: unknown, reason: unknown): Mark | null =>
  at === null || at === undefined ? null : { at: Number(at), by: String(by ?? 'someone'), reason: reason === null || reason === undefined ? null : String(reason) }

type Row = Record<string, unknown>
const fromRow = (r: Row | undefined): Lifecycle => r
  ? { paused: mark(r.paused_at, r.paused_by, r.paused_reason), retired: mark(r.retired_at, r.retired_by, r.retired_reason) }
  : ACTIVE

/** One project's lifecycle in an open central database (an unknown project, or an older store: active). */
export function lifecycleIn(db: DatabaseSync, repo: string): Lifecycle {
  if (!hasColumns(db)) return ACTIVE
  return fromRow(db.prepare('SELECT * FROM projects WHERE repo=?').get(repo.toLowerCase()) as Row | undefined)
}

/** Every project that is not active, by repo (lower case). */
export function heldIn(db: DatabaseSync): Map<string, Lifecycle> {
  if (!hasColumns(db)) return new Map()
  const rows = db.prepare('SELECT * FROM projects WHERE paused_at IS NOT NULL OR retired_at IS NOT NULL').all() as Row[]
  return new Map(rows.map((r) => [String(r.repo).toLowerCase(), fromRow(r)]))
}

// ------------------------------------------------------------------ reads, with a short cache

/** How long a read is trusted in this process: every API call asks, and a pause should land within seconds. */
const TTL_MS = 3000
let cache: { at: number; held: Map<string, Lifecycle> } | null = null

/** Forget the cached reads (tests, and after this process changes a lifecycle). */
export function forgetLifecycles(): void {
  cache = null
}

/** Every project that is paused or retired. */
export async function heldProjects(now: () => number = Date.now): Promise<Map<string, Lifecycle>> {
  if (cache && now() - cache.at < TTL_MS) return cache.held
  const db = await read()
  try {
    cache = { at: now(), held: heldIn(db) }
    return cache.held
  } finally {
    db.close()
  }
}

/** One project's lifecycle. */
export async function lifecycleOf(repo: string): Promise<Lifecycle> {
  return (await heldProjects()).get(repo.toLowerCase()) ?? ACTIVE
}

/** The projects that are retired, newest first. */
export async function retiredProjects(): Promise<{ repo: string; retired: Mark; paused: Mark | null }[]> {
  return [...(await heldProjects()).entries()]
    .flatMap(([repo, l]) => (l.retired ? [{ repo, retired: l.retired, paused: l.paused }] : []))
    .sort((a, b) => b.retired.at - a.retired.at || a.repo.localeCompare(b.repo))
}

/** A project's lifecycle changes, newest first. */
export async function lifecycleHistory(repo: string, limit = 50): Promise<{ at: number; change: LifecycleChange; by: string; reason: string | null }[]> {
  const db = await read()
  try {
    const known = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_lifecycle_log'").get()
    if (!known) return []
    return (db.prepare('SELECT at, change, by, reason FROM project_lifecycle_log WHERE repo=? ORDER BY at DESC LIMIT ?').all(repo.toLowerCase(), limit) as Row[])
      .map((r) => ({ at: Number(r.at), change: String(r.change) as LifecycleChange, by: String(r.by), reason: r.reason === null ? null : String(r.reason) }))
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ changes

export class LifecycleError extends Error {
  override name = 'LifecycleError'
}

/**
 * Pause, resume, retire or restore one project; answers its lifecycle after the change. Refuses a change that does
 * nothing (pausing a paused project), in words a person reads. A project assigned but not yet in the registry gets
 * its row here. Replayable (central.update may run it again on a fresh copy).
 */
export async function changeLifecycle(repo: string, change: LifecycleChange, by: string, reason: string | null = null, at: number = Date.now() / 1000): Promise<Lifecycle> {
  const slug = repo.toLowerCase()
  const why = reason?.trim() ? reason.trim().slice(0, 300) : null
  try {
    return await update((db) => {
      migrateLifecycle(db)
      const now = lifecycleIn(db, slug)
      const refuse = (s: string): never => { throw new LifecycleError(s) }
      if (change === 'paused' && now.paused) refuse(`It is already paused (by ${now.paused.by}).`)
      if (change === 'resumed' && !now.paused) refuse('It is not paused.')
      if (change === 'retired' && now.retired) refuse(`It is already retired (by ${now.retired.by}).`)
      if (change === 'restored' && !now.retired) refuse('It is not retired.')
      db.prepare('INSERT OR IGNORE INTO projects (repo, added, path) VALUES (?,?,NULL)').run(slug, at)
      const set = {
        paused: 'paused_at=?, paused_by=?, paused_reason=?',
        resumed: 'paused_at=NULL, paused_by=NULL, paused_reason=NULL',
        retired: 'retired_at=?, retired_by=?, retired_reason=?',
        restored: 'retired_at=NULL, retired_by=NULL, retired_reason=NULL',
      }[change]
      const args = change === 'paused' || change === 'retired' ? [at, by, why] : []
      db.prepare(`UPDATE projects SET ${set} WHERE repo=?`).run(...args, slug)
      db.prepare('INSERT INTO project_lifecycle_log (at, repo, change, by, reason) VALUES (?,?,?,?,?)').run(at, slug, change, by, why)
      return lifecycleIn(db, slug)
    })
  } finally {
    forgetLifecycles()
  }
}

/**
 * Why work on `repo` must wait, in words, or null when it may go on. For the worker runtime and the harness, which
 * read the central store only where TRACE_HOME is set: without it (a local run) or when the store cannot be read,
 * nothing is held here (the API, which every person's change passes through, still checks).
 */
export async function heldReason(repo: string, env: NodeJS.ProcessEnv = process.env, log?: (line: string) => void): Promise<string | null> {
  if (!env.TRACE_HOME) return null
  try {
    const l = await lifecycleOf(repo)
    if (l.retired) return `the project is retired (by ${l.retired.by})`
    if (l.paused) return `the project is paused (by ${l.paused.by}${l.paused.reason ? `: ${l.paused.reason}` : ''}): it starts when the project is resumed`
    return null
  } catch (e) {
    log?.(`the project's lifecycle could not be read (${e instanceof Error ? e.message : String(e)}): work goes on`)
    return null
  }
}
