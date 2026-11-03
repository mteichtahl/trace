/**
 * SQLite database files (.db, .sqlite): opened in the browser with sql.js (SQLite compiled to WebAssembly) on a copy of
 * the bytes, so nothing the viewer does can change the stored file. Reads the tables and views, their columns and row
 * counts, a page of rows, and compares two versions table by table and row by row. The functions take an open
 * database so they are tested in Node with the same library.
 */
import type { Database, SqlJsStatic, SqlValue } from 'sql.js'

export const DB_EXTS = new Set(['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'])

/** Every SQLite file starts with these 16 bytes. */
const MAGIC = 'SQLite format 3\u0000'

export function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false
  for (let i = 0; i < 16; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false
  return true
}

let sqlP: Promise<SqlJsStatic> | null = null

/** Load sql.js once (its own lazily loaded chunk and WebAssembly file). */
export function loadSql(): Promise<SqlJsStatic> {
  sqlP ??= Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm-browser.wasm?url')]).then(([m, w]) =>
    (m.default as unknown as (c: { locateFile: () => string }) => Promise<SqlJsStatic>)({ locateFile: () => w.default }),
  ).catch((e) => {
    sqlP = null
    throw e
  })
  return sqlP
}

/** Open bytes as a database, or explain plainly why not. */
export function openDb(SQL: SqlJsStatic, bytes: ArrayBuffer | Uint8Array): Database {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (u8.length === 0) return new SQL.Database()
  if (!isSqlite(u8)) throw new Error('This file is not a SQLite database, so its tables cannot be shown.')
  return new SQL.Database(u8)
}

export interface DbColumn { name: string; type: string; pk: number; notnull: boolean }
export interface DbTable { name: string; kind: 'table' | 'view'; sql: string; columns: DbColumn[]; rows: number; withoutRowid: boolean }
export interface DbSummary { tables: DbTable[]; indexes: { name: string; table: string; sql: string }[] }

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`

/** Run a query and get its rows as arrays. */
export function all(db: Database, sql: string, params: SqlValue[] = []): { columns: string[]; values: SqlValue[][] } {
  const st = db.prepare(sql)
  try {
    st.bind(params)
    const values: SqlValue[][] = []
    while (st.step()) values.push(st.get())
    return { columns: st.getColumnNames(), values }
  } finally {
    st.free()
  }
}

/** The database's tables and views (SQLite's own internal tables left out), with columns and row counts. */
export function summarise(db: Database): DbSummary {
  const objs = all(db, "SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type = 'view', type = 'index', name").values
  const tables: DbTable[] = []
  const indexes: DbSummary['indexes'] = []
  for (const [type, name, tbl, sql] of objs as string[][]) {
    if (type === 'index') {
      if (sql) indexes.push({ name: name!, table: tbl!, sql: sql! })
      continue
    }
    if (type !== 'table' && type !== 'view') continue
    const columns = all(db, `PRAGMA table_info(${ident(name!)})`).values.map((r) => ({ name: String(r[1]), type: String(r[2] ?? ''), notnull: r[3] === 1, pk: Number(r[5] ?? 0) }))
    let rows = 0
    try {
      rows = Number(all(db, `SELECT count(*) FROM ${ident(name!)}`).values[0]?.[0] ?? 0)
    } catch {
      rows = 0
    }
    tables.push({ name: name!, kind: type as 'table' | 'view', sql: sql!, columns, rows, withoutRowid: /without\s+rowid\s*;?\s*$/i.test(sql!) })
  }
  return { tables, indexes }
}

/** A cell as words: NULL shown as empty, bytes as their size and first bytes in hex. */
export function cellText(v: SqlValue): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Uint8Array) {
    const hex = [...v.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    return `[${v.length} bytes${v.length ? `: ${hex}${v.length > 8 ? ' …' : ''}` : ''}]`
  }
  return String(v)
}

/** Up to `limit` rows of a table or view, in its stored order (rowid, else primary key). */
export function readRows(db: Database, t: Pick<DbTable, 'name' | 'kind' | 'withoutRowid' | 'columns'>, limit = 5000, offset = 0) {
  const pk = t.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => ident(c.name))
  const order = t.kind === 'view' ? '' : t.withoutRowid ? (pk.length ? ` ORDER BY ${pk.join(', ')}` : '') : ' ORDER BY rowid'
  return all(db, `SELECT * FROM ${ident(t.name)}${order} LIMIT ? OFFSET ?`, [limit, offset])
}

/** Rows as CSV text (for Download as CSV). */
export function toCsv(columns: string[], values: SqlValue[][]): string {
  const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return [columns.map(q).join(','), ...values.map((r) => r.map((v) => q(cellText(v))).join(','))].join('\n')
}

/** Only reading statements may run in the query box (the database is a copy either way). */
export function readOnly(sql: string): boolean {
  const s = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().toLowerCase()
  return /^(select|with|pragma\s+(table_info|index_list|index_info|foreign_key_list)|explain)\b/.test(s) && !/;\s*\S/.test(s.replace(/;\s*$/, ''))
}

// comparing two versions

export type RowChange = 'added' | 'removed' | 'changed'
export interface RowDiff { key: string; change: RowChange; before?: SqlValue[]; after?: SqlValue[]; fields: { column: string; before: string; after: string }[] }
export interface TableDiff {
  name: string
  status: 'added' | 'removed' | 'changed' | 'same'
  schemaChanged: boolean
  beforeSql?: string
  afterSql?: string
  columns: string[]
  counts: { added: number; removed: number; changed: number; same: number }
  rows: RowDiff[]
  /** how rows were matched: by primary key, rowid, or whole row (no key) */
  matchedBy: 'key' | 'rowid' | 'row'
  /** more rows changed than are listed */
  truncated: boolean
}

const rowKey = (vals: SqlValue[]) => vals.map((v) => (v instanceof Uint8Array ? `b:${[...v].join(',')}` : `${typeof v}:${String(v)}`)).join('\u0001')

/** Key rows the same way in both versions: the primary key, else rowid, else the whole row. */
function keyedRows(db: Database, t: DbTable, by: TableDiff['matchedBy'], pkCols: string[]) {
  const keyExpr = by === 'key' ? pkCols.map(ident).join(', ') : by === 'rowid' ? 'rowid' : null
  const sql = keyExpr ? `SELECT ${keyExpr}, * FROM ${ident(t.name)}` : `SELECT * FROM ${ident(t.name)}`
  const r = all(db, sql)
  const n = keyExpr ? (by === 'key' ? pkCols.length : 1) : 0
  const cols = r.columns.slice(n)
  const map = new Map<string, SqlValue[]>()
  const dup = new Map<string, number>()
  for (const v of r.values) {
    const body = v.slice(n)
    let k = n ? rowKey(v.slice(0, n)) : rowKey(body)
    if (!n) {
      // identical rows without a key: count them apart
      const c = (dup.get(k) ?? 0) + 1
      dup.set(k, c)
      if (c > 1) k = `${k}#${c}`
    }
    map.set(k, body)
  }
  return { cols, map }
}

const keyLabel = (k: string) => k.split('\u0001').map((p) => p.replace(/^[a-z]+:/, '').replace(/#\d+$/, '')).join(', ')

export function diffTable(a: Database | null, b: Database | null, ta: DbTable | undefined, tb: DbTable | undefined, cap = 2000): TableDiff {
  const name = (tb ?? ta)!.name
  const pkA = (ta?.columns ?? []).filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name)
  const pkB = (tb?.columns ?? []).filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name)
  const samePk = pkA.join('|') === pkB.join('|')
  const view = (ta ?? tb)!.kind === 'view'
  const by: TableDiff['matchedBy'] = pkB.length && samePk && !view ? 'key' : !view && !(ta?.withoutRowid || tb?.withoutRowid) && pkA.length === 0 && pkB.length === 0 ? 'rowid' : 'row'
  const A = a && ta ? keyedRows(a, ta, by, pkA) : { cols: [] as string[], map: new Map<string, SqlValue[]>() }
  const B = b && tb ? keyedRows(b, tb, by, pkB) : { cols: [] as string[], map: new Map<string, SqlValue[]>() }
  const columns = B.cols.length ? B.cols : A.cols
  const counts = { added: 0, removed: 0, changed: 0, same: 0 }
  const rows: RowDiff[] = []
  const push = (r: RowDiff) => { if (rows.length < cap) rows.push(r) }
  for (const [k, after] of B.map) {
    const before = A.map.get(k)
    if (!before) {
      counts.added++
      push({ key: keyLabel(k), change: 'added', after, fields: [] })
      continue
    }
    const fields: RowDiff['fields'] = []
    const names = new Set([...A.cols, ...B.cols])
    for (const c of names) {
      const ia = A.cols.indexOf(c)
      const ib = B.cols.indexOf(c)
      const va = ia >= 0 ? cellText(before[ia]!) : ''
      const vb = ib >= 0 ? cellText(after[ib]!) : ''
      const rawA = ia >= 0 ? before[ia] : undefined
      const rawB = ib >= 0 ? after[ib] : undefined
      if (va !== vb || (rawA === null) !== (rawB === null)) fields.push({ column: c, before: rawA === null ? 'NULL' : va, after: rawB === null ? 'NULL' : vb })
    }
    if (fields.length) {
      counts.changed++
      push({ key: keyLabel(k), change: 'changed', before, after, fields })
    } else counts.same++
  }
  for (const [k, before] of A.map) {
    if (B.map.has(k)) continue
    counts.removed++
    push({ key: keyLabel(k), change: 'removed', before, fields: [] })
  }
  const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim()
  const schemaChanged = !!ta && !!tb && norm(ta.sql) !== norm(tb.sql)
  const status = !ta ? 'added' : !tb ? 'removed' : schemaChanged || counts.added || counts.removed || counts.changed ? 'changed' : 'same'
  return { name, status, schemaChanged, beforeSql: ta?.sql, afterSql: tb?.sql, columns, counts, rows, matchedBy: by, truncated: counts.added + counts.removed + counts.changed > rows.length }
}

/** Every table and view of both versions, compared. Changed ones first, then by name. */
export function diffDb(a: Database | null, b: Database | null): TableDiff[] {
  const sa = a ? summarise(a) : { tables: [] }
  const sb = b ? summarise(b) : { tables: [] }
  const names = [...new Set([...sa.tables.map((t) => t.name), ...sb.tables.map((t) => t.name)])]
  const rank = { added: 0, removed: 0, changed: 0, same: 1 }
  return names
    .map((n) => diffTable(a, b, sa.tables.find((t) => t.name === n), sb.tables.find((t) => t.name === n)))
    .sort((x, y) => rank[x.status] - rank[y.status] || x.name.localeCompare(y.name))
}

/** "2 tables changed, 1 added · 14 rows added, 3 removed, 5 changed" */
export function describeDbDiff(d: TableDiff[]): string {
  const t = { added: 0, removed: 0, changed: 0 }
  const r = { added: 0, removed: 0, changed: 0 }
  for (const x of d) {
    if (x.status !== 'same') t[x.status]++
    r.added += x.counts.added
    r.removed += x.counts.removed
    r.changed += x.counts.changed
  }
  const words = (o: typeof t, noun: string) => {
    const parts = (['changed', 'added', 'removed'] as const).filter((k) => o[k]).map((k) => `${o[k]} ${k}`)
    if (!parts.length) return ''
    const total = o.added + o.removed + o.changed
    return `${total === 1 ? noun : `${noun}s`}: ${parts.join(', ')}`
  }
  const out = [words(t, 'Table'), words(r, 'Row')].filter(Boolean)
  return out.length ? out.join(' · ') : 'No differences in the tables or their rows.'
}
