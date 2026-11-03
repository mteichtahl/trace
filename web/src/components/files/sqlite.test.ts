import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { cellText, describeDbDiff, diffDb, isSqlite, openDb, readOnly, readRows, summarise, toCsv } from './sqlite'

const require = createRequire(import.meta.url)
let SQL: SqlJsStatic

beforeAll(async () => {
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm')
  SQL = await initSqlJs({ locateFile: () => wasm })
})

const make = (sql: string) => {
  const db = new SQL.Database()
  db.run(sql)
  return openDb(SQL, db.export())
}

describe('sqlite files', () => {
  it('knows a SQLite file by its first bytes and refuses anything else', () => {
    const bytes = new SQL.Database().export()
    expect(isSqlite(make('CREATE TABLE t(a)').export())).toBe(true)
    expect(bytes.length === 0 || isSqlite(bytes)).toBe(true)
    expect(() => openDb(SQL, new TextEncoder().encode('hello, not a database'))).toThrow(/not a SQLite database/)
  })

  it('lists tables and views with columns and row counts', () => {
    const db = make(`CREATE TABLE parts(id INTEGER PRIMARY KEY, mpn TEXT NOT NULL, qty INT);
      INSERT INTO parts(mpn, qty) VALUES ('R1', 4), ('C1', 2);
      CREATE VIEW many AS SELECT * FROM parts WHERE qty > 3;
      CREATE INDEX parts_mpn ON parts(mpn);`)
    const s = summarise(db)
    expect(s.tables.map((t) => [t.name, t.kind, t.rows])).toEqual([['parts', 'table', 2], ['many', 'view', 1]])
    expect(s.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'mpn', 'qty'])
    expect(s.tables[0]!.columns[0]!.pk).toBe(1)
    expect(s.indexes[0]!.name).toBe('parts_mpn')
    expect(readRows(db, s.tables[0]!).values).toEqual([[1, 'R1', 4], [2, 'C1', 2]])
  })

  it('shows cells as words and writes CSV', () => {
    expect(cellText(null)).toBe('')
    expect(cellText(new Uint8Array([1, 255]))).toBe('[2 bytes: 01 ff]')
    expect(toCsv(['a', 'b'], [['x,y', 1], [null, 'q"']])).toBe('a,b\n"x,y",1\n,"q"""')
  })

  it('lets only reading statements run in the query box', () => {
    expect(readOnly('SELECT * FROM parts')).toBe(true)
    expect(readOnly('  with x as (select 1) select * from x;')).toBe(true)
    expect(readOnly('DELETE FROM parts')).toBe(false)
    expect(readOnly('SELECT 1; DROP TABLE parts')).toBe(false)
  })

  it('compares two versions row by row by primary key', () => {
    const a = make(`CREATE TABLE parts(id INTEGER PRIMARY KEY, mpn TEXT, qty INT);
      INSERT INTO parts VALUES (1,'R1',4),(2,'C1',2),(3,'U1',1);
      CREATE TABLE old(x); CREATE TABLE same(x); INSERT INTO same VALUES (1);`)
    const b = make(`CREATE TABLE parts(id INTEGER PRIMARY KEY, mpn TEXT, qty INT);
      INSERT INTO parts VALUES (1,'R1',4),(2,'C1',6),(4,'D1',1);
      CREATE TABLE fresh(y); INSERT INTO fresh VALUES ('a'); CREATE TABLE same(x); INSERT INTO same VALUES (1);`)
    const d = diffDb(a, b)
    const parts = d.find((t) => t.name === 'parts')!
    expect(parts.matchedBy).toBe('key')
    expect(parts.counts).toEqual({ added: 1, removed: 1, changed: 1, same: 1 })
    expect(parts.rows.find((r) => r.change === 'changed')!.fields).toEqual([{ column: 'qty', before: '2', after: '6' }])
    expect(d.find((t) => t.name === 'fresh')!.status).toBe('added')
    expect(d.find((t) => t.name === 'old')!.status).toBe('removed')
    expect(d.at(-1)!.name).toBe('same')
    expect(d.at(-1)!.status).toBe('same')
    expect(describeDbDiff(d)).toBe('Tables: 1 changed, 1 added, 1 removed · Rows: 1 changed, 2 added, 1 removed')
  })

  it('compares a table without a key by its rows', () => {
    const a = make(`CREATE TABLE log(t TEXT) WITHOUT ROWID;`.replace(' WITHOUT ROWID', '') + `INSERT INTO log VALUES ('a'),('b');`)
    const b = make(`CREATE TABLE log(t TEXT); INSERT INTO log VALUES ('a'),('c');`)
    const d = diffDb(a, b)[0]!
    expect(d.matchedBy).toBe('rowid')
    expect(d.counts.changed).toBe(1)
  })
})
