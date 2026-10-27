/**
 * Inactive memories: which long-term records of one project people have marked "not to be considered". An overlay
 * beside the project's AgentCore memory, never a change to the memory itself: records are not deleted or rewritten,
 * and reactivating one simply removes its mark.
 *
 *   where   <TRACE_HOME's parent>/projects/<owner>/<repo>/memory-state   (s3://<bucket>/projects/<slug>/memory-state
 *           in AWS, beside the project's other data; locally $TRACE_HOME/projects/<slug>/memory-state)
 *           TRACE_MEMORY_STATE_HOME names another place (tests); it is the store's root, holding central.db
 *   how     one SQLite database through src/core/central.ts: local writes in a transaction, S3 writes as a
 *           conditional put (If-Match / If-None-Match) re-run on a conflict
 *   tables  inactive_records  one row per inactive record: the record id, the namespace it was verified under, why,
 *                             who (the person's 16-character hash, never their email) and when
 *           memory_state_log  every deactivation and reactivation, append only
 *
 * Who writes it: the API runtime (memory.deactivate / memory.reactivate, after the access check and after the
 * record is verified to be this project's), and a person's own `tracectl memory` on a local installation. A project's
 * worker only reads it: its role may read projects/<slug>/*, and is denied writes under memory-state (an agent has
 * Bash and the role's credentials, and must not be able to bring a record back).
 *
 * Why an overlay and not AgentCore record metadata: see README "Inactive memories".
 */
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { z } from 'zod'
import { type Central, central } from '../../core/central.js'
import { PROJECTS_PREFIX, projectSlug } from '../../core/project.js'
import { traceHome } from '../../core/store.js'

export const MEMORY_STATE = 'memory-state'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inactive_records (
  record_id TEXT PRIMARY KEY,      -- the AgentCore memory record id
  namespace TEXT NOT NULL,         -- the namespace the record was found under when it was marked
  reason TEXT NOT NULL,
  by_hash TEXT NOT NULL,           -- sha256 of the person's email (or sub), 16 hex characters
  at REAL NOT NULL                 -- seconds since the epoch
);
CREATE TABLE IF NOT EXISTS memory_state_log (
  at REAL NOT NULL,
  by_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('deactivate', 'reactivate')),
  record_id TEXT NOT NULL,
  namespace TEXT,
  reason TEXT
);
`

/** A record id as AgentCore writes them (mem-…), or any id of that character set. */
export const RecordIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'a memory record id')
export const ReasonSchema = z.string().trim().min(1, 'give a reason').max(500)

export interface InactiveMark {
  recordId: string
  namespace: string
  reason: string
  /** the hash of who marked it */
  by: string
  /** when, seconds since the epoch */
  at: number
}

export interface LogEntry { at: number; by: string; action: 'deactivate' | 'reactivate'; recordId: string; namespace: string | null; reason: string | null }

/** What the memory client needs: the marks of one project (every one; there are few). */
export interface InactiveSource {
  inactive(): Promise<ReadonlyMap<string, InactiveMark>>
}

/** Where a project's memory state lives (see the module comment). */
export function memoryStateHome(repository: string, env: Record<string, string | undefined> = process.env): string {
  const slug = projectSlug(repository)
  if (env.TRACE_MEMORY_STATE_HOME) return join(env.TRACE_MEMORY_STATE_HOME, slug)
  const home = env.TRACE_HOME || traceHome()
  const s3 = /^s3:\/\/([^/]+)(\/.*)?$/.exec(home)
  if (s3) {
    // s3://bucket/central → s3://bucket/projects/<slug>/memory-state (the bucket's layout: src/infra/stack.ts)
    const parts = (s3[2] ?? '').split('/').filter(Boolean)
    parts.pop()
    return `s3://${s3[1]}/${[...parts, PROJECTS_PREFIX, slug, MEMORY_STATE].join('/')}`
  }
  return join(home.replace(/^file:\/\//, ''), PROJECTS_PREFIX, slug, MEMORY_STATE)
}

const hasTable = (db: DatabaseSync): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inactive_records'").get())

const markOf = (r: Record<string, unknown>): InactiveMark => ({
  recordId: String(r.record_id), namespace: String(r.namespace), reason: String(r.reason), by: String(r.by_hash), at: Number(r.at),
})

/** One project's memory state. */
export class MemoryState implements InactiveSource {
  readonly repository: string
  readonly store: Central
  private readonly now: () => number

  /** `store`: a Central to use instead of the one at `home` (default memoryStateHome) — tests hand in one on a fake S3. */
  constructor(repository: string, o: { home?: string; store?: Central; now?: () => number } = {}) {
    this.repository = projectSlug(repository)
    this.store = o.store ?? central(o.home ?? memoryStateHome(repository))
    this.now = o.now ?? (() => Date.now() / 1000)
  }

  /** Every inactive record of the project, by id. */
  async inactive(): Promise<Map<string, InactiveMark>> {
    return this.store.query((db) => {
      if (!hasTable(db)) return new Map()
      return new Map(db.prepare('SELECT * FROM inactive_records').all().map((r) => { const m = markOf(r as Record<string, unknown>); return [m.recordId, m] as const }))
    })
  }

  async get(recordId: string): Promise<InactiveMark | null> {
    return (await this.inactive()).get(RecordIdSchema.parse(recordId)) ?? null
  }

  /** Mark a record inactive (the caller has verified it is this project's). Marking it again keeps the first mark. */
  async deactivate(m: { recordId: string; namespace: string; reason: string; by: string }): Promise<{ mark: InactiveMark; changed: boolean }> {
    const id = RecordIdSchema.parse(m.recordId)
    const reason = ReasonSchema.parse(m.reason)
    return this.store.update((db) => {
      db.exec(SCHEMA)
      const had = db.prepare('SELECT * FROM inactive_records WHERE record_id=?').get(id)
      if (had) return { mark: markOf(had as Record<string, unknown>), changed: false }
      const at = this.now()
      db.prepare('INSERT INTO inactive_records (record_id, namespace, reason, by_hash, at) VALUES (?,?,?,?,?)').run(id, m.namespace, reason, m.by, at)
      db.prepare('INSERT INTO memory_state_log VALUES (?,?,?,?,?,?)').run(at, m.by, 'deactivate', id, m.namespace, reason)
      return { mark: { recordId: id, namespace: m.namespace, reason, by: m.by, at }, changed: true }
    })
  }

  /** Remove a record's mark: it is considered again. Returns the mark that was removed, or null when it had none. */
  async reactivate(recordId: string, by: string): Promise<InactiveMark | null> {
    const id = RecordIdSchema.parse(recordId)
    return this.store.update((db) => {
      db.exec(SCHEMA)
      const had = db.prepare('SELECT * FROM inactive_records WHERE record_id=?').get(id)
      if (!had) return null
      const mark = markOf(had as Record<string, unknown>)
      db.prepare('DELETE FROM inactive_records WHERE record_id=?').run(id)
      db.prepare('INSERT INTO memory_state_log VALUES (?,?,?,?,?,?)').run(this.now(), by, 'reactivate', id, mark.namespace, null)
      return mark
    })
  }

  /** The audit log, newest first. */
  async log(limit = 100): Promise<LogEntry[]> {
    return this.store.query((db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_state_log'").get()) return []
      return db.prepare('SELECT * FROM memory_state_log ORDER BY at DESC, rowid DESC LIMIT ?').all(Math.max(1, Math.min(limit, 1000))).map((r) => ({
        at: Number(r.at), by: String(r.by_hash), action: r.action === 'reactivate' ? 'reactivate' as const : 'deactivate' as const,
        recordId: String(r.record_id), namespace: r.namespace === null ? null : String(r.namespace), reason: r.reason === null ? null : String(r.reason),
      }))
    })
  }
}

/** The memory state of `repository` where this process keeps it (TRACE_HOME, or TRACE_MEMORY_STATE_HOME). */
export const memoryState = (repository: string): MemoryState => new MemoryState(repository)
