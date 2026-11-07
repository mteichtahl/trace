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
 *   any other table                  a union (created from their declaration when we lack it); different columns on
 *                                    the two sides is a CONFLICT, so a table this process did not load is never dropped
 *   settings                         three-way per key: a key only they changed takes theirs; one only we changed keeps
 *                                    ours; one both changed to different values is a CONFLICT — ours is kept, the key
 *                                    is listed, and the driver exits 1 so git reports the conflict.
 * GitHub's merge button can't run a custom driver; the update queue then reports the PR as conflicted and the worker
 * merges it locally, where the driver runs.
 */
import { existsSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { applyProjectSchema, open, projectTables, transaction } from './store.js'
// every area's tables and merge rules, whoever calls merge (the harness loads no area of its own)
import './project-tables.js'

interface Setting { value: string; updated: number; by: string | null }

function settings(db: DatabaseSync): Map<string, Setting> {
  return new Map(db.prepare('SELECT key, value, updated, by FROM settings').all()
    .map((r) => [String(r.key), { value: String(r.value), updated: Number(r.updated), by: r.by === null ? null : String(r.by) }]))
}

function opened(path: string): DatabaseSync {
  const db = open(path, { wal: false })
  // the same columns on all three sides (runs.agent and runs.job added to older ones), so SELECT * lines up
  applyProjectSchema(db)
  return db
}

/** Merge THEIRS into OURS (in place). Returns what conflicts: setting keys, and `table <name>` (empty when clean). */
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
      const done = new Set(['runs', 'measurements', 'artifacts', 'settings'])
      for (const tb of projectTables()) { o.exec(tb.merge ?? `INSERT OR IGNORE INTO ${tb.table} SELECT * FROM theirs.${tb.table}`); done.add(tb.table) }
      // a table no area registered here (this process did not load that area) is still merged, never dropped: a union
      // when both sides have it with the same columns; otherwise it is a conflict and the merge stops
      const tables = (db: string): string[] => (o.prepare(`SELECT name FROM ${db}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name)
      const cols = (db: string, t: string): string => (o.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(t, db) as { name: string }[]).map((r) => r.name).join(',')
      const mine = new Set(tables('main'))
      for (const t of tables('theirs')) {
        if (done.has(t)) continue
        if (!mine.has(t)) {
          // their table as they declared it (keys and constraints kept), then their rows
          const ddl = (o.prepare(`SELECT sql FROM theirs.sqlite_master WHERE type='table' AND name=?`).get(t) as { sql: string } | undefined)?.sql
          if (!ddl) { conflicts.push(`table ${t}`); continue }
          o.exec(ddl)
        }
        else if (cols('main', t) !== cols('theirs', t)) { conflicts.push(`table ${t}`); continue }
        o.exec(`INSERT OR IGNORE INTO "${t.replace(/"/g, '""')}" SELECT * FROM theirs."${t.replace(/"/g, '""')}"`)
      }
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
    process.stderr.write(`trace: changed differently on both sides (ours kept): ${conflicts.join(', ')}\n`)
    return 1
  }
  return 0
}

// ------------------------------------------------------------------ the strict, row-level merge

/** One row: its values in column order, the values that name it, and both as text to compare. */
interface Row { values: unknown[]; key: unknown[]; json: string }
/** One table as one side has it: its columns, the columns that name a row, and each row by its name. */
interface Side { cols: string[]; key: string[]; rows: Map<string, Row> }

// a SQL value as text: a bigint or a blob tagged as an object, which no SQL value is, so no two values read the same
const asJson = (v: readonly unknown[]): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? { n: x.toString() } : x instanceof Uint8Array ? { b: Buffer.from(x).toString('base64') } : x))
const quote = (n: string): string => `"${n.replaceAll('"', '""')}"`

/** A table's rows on one side, or null when it has no such table. Throws `table <name>` when a row has no single name. */
function sideOf(db: DatabaseSync, table: string): Side | null {
  const info = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as { name: string; pk: number }[]
  if (!info.length) return null
  const cols = info.map((c) => c.name)
  const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  // a table without a primary key: a row is named by all of it
  const key = pk.length ? pk : cols
  const at = key.map((k) => cols.indexOf(k))
  const stmt = db.prepare(`SELECT ${cols.map(quote).join(', ')} FROM ${quote(table)}`)
  stmt.setReadBigInts(true)
  const rows = new Map<string, Row>()
  for (const r of stmt.all() as Record<string, unknown>[]) {
    const values = cols.map((c) => r[c])
    const k = at.map((i) => values[i])
    const name = asJson(k)
    // the same row twice in a table without a key: which copy changed cannot be told
    if (rows.has(name)) throw new Error(`table ${table}`)
    rows.set(name, { values, key: k, json: asJson(values) })
  }
  return { cols, key, rows }
}

/** The rows one side changed from the base, by name: its row when added or changed, null (with the base's key) when removed. */
function changed(base: Side | null, side: Side): Map<string, { key: unknown[]; row: Row | null }> {
  const out = new Map<string, { key: unknown[]; row: Row | null }>()
  for (const [k, r] of side.rows) if (base?.rows.get(k)?.json !== r.json) out.set(k, { key: r.key, row: r })
  for (const [k, r] of base?.rows ?? []) if (!side.rows.has(k)) out.set(k, { key: r.key, row: null })
  return out
}

const tablesOf = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)

/**
 * Merge THEIRS into OURS (in place) row by row, only when the two sides changed different rows since BASE. Every row
 * (named by its table's primary key, or by all of it when there is none) that one side added, changed or removed is
 * taken from that side; a row both sides changed to different results is a conflict. Nothing is decided by a rule
 * (newer wins, a union): the result is the base with both sides' own changes, exactly.
 *
 * Returns what stands in the way (`table <name>` per table; empty when clean). On a conflict OURS keeps its rows (its
 * schema brought up to date, as every open does). Stricter than `merge`, which as a git merge driver settles overlaps
 * by each table's rule: this one is for merging with no person or agent looking (src/api/record-merge.ts).
 */
export function mergeRows(base: string, ours: string, theirs: string): string[] {
  if (!existsSync(base) || statSync(base).size === 0) return ['the common ancestor has no project database']
  const b = opened(base)
  const o = opened(ours)
  const t = opened(theirs)
  const conflicts: string[] = []
  try {
    const plan: { table: string; side: Side; take: { key: unknown[]; row: Row | null }[]; create: boolean }[] = []
    // what each table must hold afterwards, row name to row: ours with their changes
    const expected = new Map<string, Map<string, string>>()
    for (const table of [...new Set([...tablesOf(b), ...tablesOf(o), ...tablesOf(t)])].sort()) {
      let sides: [Side | null, Side | null, Side | null]
      try {
        sides = [sideOf(b, table), sideOf(o, table), sideOf(t, table)]
      } catch {
        conflicts.push(`table ${table}`)
        continue
      }
      const [sb, so, st] = sides
      const shapes = sides.filter((s): s is Side => s !== null).map((s) => `${s.cols.join(',')}|${s.key.join(',')}`)
      // different columns, or a table one side removed: not a row change, a person decides
      if (new Set(shapes).size > 1 || (sb && (!so || !st))) { conflicts.push(`table ${table}`); continue }
      if (!st) continue // only ours has it
      const mine = so ? changed(sb, so) : new Map<string, { key: unknown[]; row: Row | null }>()
      const yours = changed(sb, st)
      if ([...yours].some(([k, c]) => mine.has(k) && mine.get(k)?.row?.json !== c.row?.json)) { conflicts.push(`table ${table}`); continue }
      // their changes that ours does not already have
      const take = [...yours].filter(([k]) => !mine.has(k))
      const want = new Map([...(so?.rows ?? [])].map(([k, r]) => [k, r.json]))
      for (const [k, c] of take) { if (c.row) want.set(k, c.row.json); else want.delete(k) }
      expected.set(table, want)
      if (take.length || !so) plan.push({ table, side: st, take: take.map(([, c]) => c), create: !so })
    }
    if (conflicts.length) return conflicts
    o.prepare('ATTACH DATABASE ? AS theirs').run(theirs)
    transaction(o, () => {
      // rows go out and in in any order; the keys between tables are checked once, at the commit
      o.exec('PRAGMA defer_foreign_keys = ON')
      for (const p of plan) {
        if (p.create) {
          const ddl = (o.prepare("SELECT sql FROM theirs.sqlite_master WHERE type='table' AND name=?").get(p.table) as { sql: string } | undefined)?.sql
          if (!ddl) throw new Error(`table ${p.table}`)
          o.exec(ddl)
        }
        const where = p.side.key.map((k) => `${quote(k)} IS ?`).join(' AND ')
        // the key names one row (a table without one is named by all of it, and has no copies: sideOf)
        const del = o.prepare(`DELETE FROM main.${quote(p.table)} WHERE ${where}`)
        const ins = o.prepare(`INSERT INTO main.${quote(p.table)} (${p.side.cols.map(quote).join(', ')}) VALUES (${p.side.cols.map(() => '?').join(', ')})`)
        for (const c of p.take) {
          del.run(...(c.key as never[]))
          if (c.row) ins.run(...(c.row.values as never[]))
        }
      }
      // exactly ours with their changes, or nothing: a cascade (a run they removed taking rows ours added) is a conflict
      for (const [table, want] of expected) {
        const got = sideOf(o, table)
        if (!got || got.rows.size !== want.size || [...got.rows].some(([k, r]) => want.get(k) !== r.json)) throw new Error(`table ${table}`)
      }
    })
    o.exec('DETACH DATABASE theirs')
    o.exec('VACUUM')
    return []
  } catch (e) {
    if (e instanceof Error && /^table /.test(e.message)) return [e.message]
    return [`the merge failed (${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)})`]
  } finally {
    b.close()
    o.close()
    t.close()
  }
}
