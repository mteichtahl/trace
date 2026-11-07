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
/** A changed field: its text before and after, and the stored values (for `readable`). */
export interface FieldChange { column: string; before: string; after: string; was?: SqlValue; now?: SqlValue }
export interface RowDiff { key: string; change: RowChange; before?: SqlValue[]; after?: SqlValue[]; fields: FieldChange[] }
export interface TableDiff {
  name: string
  status: 'added' | 'removed' | 'changed' | 'same'
  schemaChanged: boolean
  beforeSql?: string
  afterSql?: string
  columns: string[]
  /** the primary key's columns, when rows are matched by key */
  keyColumns: string[]
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
  // a table only one version has is keyed by its own key
  const samePk = !ta || !tb || pkA.join('|') === pkB.join('|')
  const view = (ta ?? tb)!.kind === 'view'
  const pk = tb ? pkB : pkA
  const by: TableDiff['matchedBy'] = pk.length && samePk && !view ? 'key' : !view && !(ta?.withoutRowid || tb?.withoutRowid) && pkA.length === 0 && pkB.length === 0 ? 'rowid' : 'row'
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
      if (va !== vb || (rawA === null) !== (rawB === null)) fields.push({ column: c, before: rawA === null ? 'NULL' : va, after: rawB === null ? 'NULL' : vb, was: rawA ?? null, now: rawB ?? null })
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
  return { name, status, schemaChanged, beforeSql: ta?.sql, afterSql: tb?.sql, columns, keyColumns: by === 'key' ? pk : [], counts, rows, matchedBy: by, truncated: counts.added + counts.removed + counts.changed > rows.length }
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

// a row's values as a person reads them (test-esp32 log #59, #19, R10)

/** Columns that hold a time: created, updated, opened_at, decided_on, ts and the like. */
const TIME_COLUMN = /^(created|updated|modified|deleted|decided|accepted|started|finished|ended|opened|closed|merged|signed|ts|time|timestamp|when)$|_(at|on|ts|time)$/i
/** Columns that hold a yes or no: is_x, has_x, testable, enabled, removed and the like. */
const FLAG_COLUMN = /^(is|has|can|should|was|allow|use|needs)_|able$|^(enabled|disabled|done|active|required|removed|deleted|ok|passed|checked|locked|hidden|optional|accepted|archived|pinned|resolved|stale|dnp|flag)$|_(flag|ok)$/i

/** A number as Unix time in milliseconds, when it is one (seconds or milliseconds, years 2000 to 2100). */
function asTime(column: string, v: SqlValue): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{9,13}(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  const named = TIME_COLUMN.test(column)
  const seconds = n >= 946_684_800 && n < 4_102_444_800
  const millis = n >= 946_684_800_000 && n < 4_102_444_800_000
  // a column not named for a time: only a number that clearly is one (fractional seconds, or milliseconds since 2014)
  if (named) return seconds ? n * 1000 : millis ? n : null
  if (typeof v !== 'number') return null
  if (seconds && !Number.isInteger(n)) return n * 1000
  if (Number.isInteger(n) && n >= 1_388_534_400_000 && n < 2_524_608_000_000) return n
  return null
}

/** A time as the person's local date and time, to the second. */
export const localTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

const IDENTITY = ['kind', 'type', 'name', 'ref', 'id']

/** Parsed JSON as compact words: an object's kind and ref first, then key: value; empty parts left out. */
export function jsonText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? `(${jsonText(x)})` : jsonText(x))).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonText(x)] as const).filter(([, t]) => t)
    const head = IDENTITY.flatMap((k) => entries.filter(([e]) => e === k).map(([, t]) => t))
    const rest = entries.filter(([k]) => !IDENTITY.includes(k)).map(([k, t]) => {
      const inner = (v as Record<string, unknown>)[k]
      const shown = inner && typeof inner === 'object' && !Array.isArray(inner) ? `(${t})` : typeof inner === 'string' && /\s/.test(t) ? `"${t}"` : t
      return `${k}: ${shown}`
    })
    return [head.join(' '), ...rest].filter(Boolean).join(', ')
  }
  return String(v)
}

/**
 * A stored value as a person reads it: times as local date and time, JSON as compact words, a 0 or 1 in a yes-or-no
 * column as yes or no. Empty (NULL, "", {} or []) is "".
 */
export function readable(column: string, v: SqlValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Uint8Array) return cellText(v)
  const t = asTime(column, v)
  if (t !== null) return localTime(t)
  if (typeof v === 'number' && (v === 0 || v === 1) && FLAG_COLUMN.test(column)) return v ? 'yes' : 'no'
  const s = String(v).trim()
  if (/^[[{]/.test(s)) {
    try {
      return jsonText(JSON.parse(s))
    } catch {
      return s
    }
  }
  if (s === 'null') return ''
  return s
}

/** An added or removed row as its filled-in fields, read as words; empty ones and the key already shown left out. */
export function rowFields(columns: string[], values: SqlValue[], skip: string[] = []): { column: string; text: string }[] {
  return values
    .map((v, i) => ({ column: columns[i] ?? `Column ${i + 1}`, text: readable(columns[i] ?? '', v) }))
    .filter((f) => f.text && !skip.includes(f.column))
}

// a trace project record's tool runs: said by kind and file, not row by row

/** One kind of tool run a version adds: how many, their results, and the newest one's. */
export interface RunKind { kind: string; runs: number; statuses: Record<string, number>; last: { status: string; summary: string } }
/** One file name the added runs made: how many copies, how many different contents, and the newest copy's run. */
export interface RunFile { name: string; copies: number; different: number; kind: string; status: string }
export interface RunsDigest { runs: number; kinds: RunKind[]; files: number; names: RunFile[] }

const hasCols = (db: Database, table: string, cols: readonly string[]): boolean => {
  const t = summarise(db).tables.find((x) => x.name === table && x.kind === 'table')
  return !!t && cols.every((c) => t.columns.some((x) => x.name === c))
}

/** FNV-1a over the bytes, with their length: copies with the same contents get the same word. */
const contentKey = (v: SqlValue): string => {
  const b = v instanceof Uint8Array ? v : new TextEncoder().encode(v === null ? '' : String(v))
  let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0
  return `${b.length}:${h}`
}

/**
 * The tool runs (runs) and the files they made (artifacts) that `b` adds against `a`, when both are a trace project
 * record: by kind, each with its newest run's result, and by file name, with how many copies are the same file again
 * (test-esp32 log #49: a change's record added 46 artifact rows from about 20 runs, erc-report.json 11 times). Null
 * when `b` is not a trace record or adds no run.
 */
export function runsDigest(a: Database | null, b: Database | null): RunsDigest | null {
  if (!b || !hasCols(b, 'runs', ['id', 'kind', 'status', 'started'])) return null
  const before = new Set(a && hasCols(a, 'runs', ['id']) ? all(a, 'SELECT id FROM runs').values.map((v) => String(v[0])) : [])
  const summary = hasCols(b, 'runs', ['summary']) ? 'summary' : "''"
  const runs = all(b, `SELECT id, kind, status, started, ${summary} FROM runs ORDER BY started`).values
    .filter((v) => !before.has(String(v[0])))
    .map((v) => ({ id: String(v[0]), kind: String(v[1]), status: String(v[2]), started: Number(v[3]), summary: v[4] === null ? '' : String(v[4]) }))
  const byKind = new Map<string, RunKind>()
  for (const r of runs) {
    const k = byKind.get(r.kind) ?? { kind: r.kind, runs: 0, statuses: {}, last: { status: r.status, summary: r.summary } }
    k.runs++
    k.statuses[r.status] = (k.statuses[r.status] ?? 0) + 1
    k.last = { status: r.status, summary: r.summary }
    byKind.set(r.kind, k)
  }
  const names: RunFile[] = []
  let files = 0
  if (hasCols(b, 'artifacts', ['run_id', 'name', 'bytes'])) {
    const had = new Set(a && hasCols(a, 'artifacts', ['run_id', 'name']) ? all(a, 'SELECT run_id, name FROM artifacts').values.map((v) => `${String(v[0])}\u0001${String(v[1])}`) : [])
    const when = new Map(all(b, 'SELECT id, kind, status, started FROM runs').values.map((v) => [String(v[0]), { kind: String(v[1]), status: String(v[2]), started: Number(v[3]) }]))
    const byName = new Map<string, { copies: number; contents: Set<string>; newest: { kind: string; status: string; started: number } | null }>()
    for (const v of all(b, 'SELECT run_id, name, bytes FROM artifacts').values) {
      if (had.has(`${String(v[0])}\u0001${String(v[1])}`)) continue
      files++
      const name = String(v[1])
      const g = byName.get(name) ?? { copies: 0, contents: new Set<string>(), newest: null }
      g.copies++
      g.contents.add(contentKey(v[2] ?? null))
      const r = when.get(String(v[0]))
      if (r && (!g.newest || r.started >= g.newest.started)) g.newest = r
      byName.set(name, g)
    }
    for (const [name, g] of byName) names.push({ name, copies: g.copies, different: g.contents.size, kind: g.newest?.kind ?? '', status: g.newest?.status ?? '' })
    names.sort((x, y) => y.copies - x.copies || x.name.localeCompare(y.name))
  }
  if (!runs.length && !files) return null
  return { runs: runs.length, kinds: [...byKind.values()].sort((x, y) => y.runs - x.runs || x.kind.localeCompare(y.kind)), files, names }
}

const RESULT_WORD: Record<string, string> = { pass: 'passed', fail: 'failed', error: 'could not run', running: 'still running' }
/** "passed", "failed": a run's status in words. */
export const resultWord = (s: string): string => RESULT_WORD[s] ?? s

/** "Adds 19 tool runs (8 kicad.erc, 5 kicad.bom and 2 more kinds) and 30 files they made, 14 of them the same file again." */
export function describeRuns(d: RunsDigest): string {
  const kinds = d.kinds.slice(0, 2).map((k) => `${k.runs} ${k.kind}`)
  const more = d.kinds.length - kinds.length
  const repeats = d.names.reduce((n, f) => n + f.copies - f.different, 0)
  const runs = d.runs ? `${d.runs.toLocaleString()} tool ${d.runs === 1 ? 'run' : 'runs'} (${kinds.join(', ')}${more ? ` and ${more} more ${more === 1 ? 'kind' : 'kinds'}` : ''})` : ''
  const files = d.files ? `${d.files.toLocaleString()} ${d.files === 1 ? 'file' : 'files'} ${d.runs ? 'they made' : 'from earlier runs'}${repeats ? `, ${repeats} of them the same file again` : ''}` : ''
  return `Adds ${[runs, files].filter(Boolean).join(' and ')}.`
}
