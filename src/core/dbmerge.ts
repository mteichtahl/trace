/**
 * `tracectl db merge BASE OURS THEIRS`: a git merge driver for .trace/project.db, so two branches that both recorded runs
 * or changed settings merge like text would, instead of as a binary conflict.
 *
 * Onboarding wires it up: `.gitattributes` names the driver for the file, and each clone (the worker's included) runs
 * `git config merge.trace-db.driver "tracectl db merge %O %A %B"`. Git calls it with the common ancestor, our version
 * (the result is written back into it) and theirs.
 *
 *   runs, measurements, artifacts   union: their rows that ours lacks are added (keys are UUIDs, so nothing collides)
 *   registered tables                each area's own merge SQL (store.ensureProjectSchema), else a union
 *   settings                         three-way per key: a key only they changed takes theirs; one only we changed keeps
 *                                    ours; one both changed to different values is a CONFLICT — ours is kept, the key
 *                                    is listed, and the driver exits 1 so git reports the conflict.
 * GitHub's merge button can't run a custom driver; the update queue then reports the PR as conflicted and the worker
 * merges it locally, where the driver runs.
 */
import { existsSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { applyProjectSchema, open, projectTables, transaction } from './store.js'

interface Setting { value: string; updated: number; by: string | null }

function settings(db: DatabaseSync): Map<string, Setting> {
  return new Map(db.prepare('SELECT key, value, updated, by FROM settings').all()
    .map((r) => [String(r.key), { value: String(r.value), updated: Number(r.updated), by: r.by === null ? null : String(r.by) }]))
}

function opened(path: string): DatabaseSync {
  const db = open(path, { wal: false })
  // the same columns on all three sides (runs.agent added to older ones), so SELECT * lines up
  applyProjectSchema(db)
  return db
}

/** Merge THEIRS into OURS (in place). Returns the conflicting setting keys (empty when clean). */
export function merge(base: string, ours: string, theirs: string): string[] {
  const hasBase = existsSync(base) && statSync(base).size > 0
  const b = hasBase ? opened(base) : null
  const o = opened(ours)
  const t = opened(theirs)
  const conflicts: string[] = []
  try {
    const sb = b ? settings(b) : new Map<string, Setting>()
    const so = settings(o)
    const st = settings(t)
    o.prepare('ATTACH DATABASE ? AS theirs').run(theirs)
    transaction(o, () => {
      for (const key of [...new Set([...so.keys(), ...st.keys()])].sort()) {
        const vb = sb.get(key)?.value
        const vo = so.get(key)?.value
        const vt = st.get(key)?.value
        if (vo === vt || vt === vb) continue // the same on both sides, or only we changed it
        if (vo === vb) { // only they changed it
          const theirsRow = st.get(key)
          if (!theirsRow) o.prepare('DELETE FROM settings WHERE key=?').run(key)
          else o.prepare('INSERT OR REPLACE INTO settings (key, value, updated, by) VALUES (?,?,?,?)').run(key, theirsRow.value, theirsRow.updated, theirsRow.by)
          continue
        }
        conflicts.push(key)
      }
      o.exec('INSERT OR IGNORE INTO runs SELECT * FROM theirs.runs')
      o.exec('INSERT OR IGNORE INTO measurements SELECT * FROM theirs.measurements')
      o.exec('INSERT OR IGNORE INTO artifacts SELECT * FROM theirs.artifacts')
      // tables areas register (store.ensureProjectSchema): their own merge SQL, else a union
      for (const tb of projectTables()) o.exec(tb.merge ?? `INSERT OR IGNORE INTO ${tb.table} SELECT * FROM theirs.${tb.table}`)
    })
    o.exec('DETACH DATABASE theirs')
    o.exec('VACUUM')
  } finally {
    b?.close()
    o.close()
    t.close()
  }
  return conflicts
}

/** The driver: exit status 0 when clean, 1 on a settings conflict. */
export function mergeMain(paths: readonly string[]): number {
  const [base, ours, theirs] = paths
  if (paths.length !== 3 || !base || !ours || !theirs) {
    process.stderr.write('usage: tracectl db merge BASE OURS THEIRS\n')
    return 2
  }
  const conflicts = merge(base, ours, theirs)
  if (conflicts.length) {
    process.stderr.write(`trace: settings changed differently on both sides (ours kept): ${conflicts.join(', ')}\n`)
    return 1
  }
  return 0
}
