/**
 * Whether a tool call through the API changed the project record.
 *
 * A tool the API forwards (src/agents/runtime/tool.ts) runs on a scratch clone of the default branch that is reset
 * before the next call and never committed. A tool that writes the record there (design.intent add, a requirement, an
 * architecture option …) would answer "added" and then lose it, so the person is told it was saved when it was not.
 * The runner takes a fingerprint of the record before and after the call and refuses the answer when it changed: a
 * change to the record goes through a task, whose agent commits it on a branch and opens a pull request.
 *
 * The fingerprint is of the rows, not the file's bytes: opening the database can apply the schema (new tables, a new
 * column), which changes the file without changing what the record says. The schema is applied before the first
 * fingerprint for the same reason. Tables that only hold a tool run's own output (its run, measurements, artifacts and
 * cache) are scratch here, as they always were: a simulation through the API still answers with its result.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openProject } from '../../core/store.js'

/** The tables a tool's own run writes: what a run through the API is for, so changing them is not a record change. */
export const SCRATCH_TABLES: ReadonlySet<string> = new Set(['runs', 'measurements', 'artifacts', 'cache'])

/** The project database in a clone. */
export const recordPath = (dir: string): string => join(dir, '.trace', 'project.db')

/** Apply the project schema to the clone's database, when it has one, so a later open by a tool changes no rows. */
export function prepareRecord(dir: string): void {
  if (!existsSync(recordPath(dir))) return
  openProject(dir).close()
}

/**
 * A fingerprint of every record row in the clone's project database, table by table, in no particular row order;
 * '' when the clone has no database. Two fingerprints differ exactly when a record table gained, lost or changed a row.
 */
export function recordFingerprint(dir: string): string {
  const path = recordPath(dir)
  if (!existsSync(path)) return ''
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => !SCRATCH_TABLES.has(t))
    const hash = createHash('sha256')
    for (const t of tables) {
      const rows = (db.prepare(`SELECT * FROM "${t.replaceAll('"', '""')}"`).all() as Record<string, unknown>[])
        .map((r) => JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v)))
        .sort()
      hash.update(`${t}\u0000${rows.length}\u0000`)
      for (const r of rows) hash.update(`${r}\u0000`)
    }
    return hash.digest('hex')
  } finally {
    db.close()
  }
}
