import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { cellText, describeDbDiff, describeRuns, diffDb, isSqlite, jsonText, localTime, openDb, readable, readOnly, readRows, rowFields, runsDigest, summarise, toCsv } from './sqlite'

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
    expect(parts.rows.find((r) => r.change === 'changed')!.fields).toEqual([{ column: 'qty', before: '2', after: '6', was: 2, now: 6 }])
    expect(parts.keyColumns).toEqual(['id'])
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

  it('says a trace record\'s tool runs by kind and their files by name, with the repeats (test-esp32 log #49)', () => {
    const schema = `CREATE TABLE runs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT, started REAL NOT NULL, finished REAL, status TEXT NOT NULL, summary TEXT);
      CREATE TABLE artifacts(run_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT, bytes BLOB NOT NULL, PRIMARY KEY (run_id, name));`
    const a = make(`${schema} INSERT INTO runs VALUES ('old','kicad.erc',NULL,1,2,'fail','ERC: 3 errors'); INSERT INTO artifacts VALUES ('old','erc-report.json',NULL,'v0');`)
    // three ERC runs, the first two with the same report; two netlists with the same nets.tsv
    const b = make(`${schema} INSERT INTO runs VALUES ('old','kicad.erc',NULL,1,2,'fail','ERC: 3 errors'),
        ('e1','kicad.erc',NULL,10,11,'fail','ERC: 1 error'),('e2','kicad.erc',NULL,20,21,'fail','ERC: 1 error'),('e3','kicad.erc',NULL,30,31,'pass','ERC: clean'),
        ('n1','kicad.netlist',NULL,12,13,'pass','54 nets'),('n2','kicad.netlist',NULL,22,23,'pass','54 nets');
      INSERT INTO artifacts VALUES ('old','erc-report.json',NULL,'v0'),('e1','erc-report.json',NULL,'v1'),('e2','erc-report.json',NULL,'v1'),('e3','erc-report.json',NULL,'v2'),
        ('n1','nets.tsv',NULL,'GND U1.1'),('n2','nets.tsv',NULL,'GND U1.1');`)
    const r = runsDigest(a, b)!
    expect(r.runs).toBe(5)
    expect(r.kinds).toEqual([
      { kind: 'kicad.erc', runs: 3, statuses: { fail: 2, pass: 1 }, last: { status: 'pass', summary: 'ERC: clean' } },
      { kind: 'kicad.netlist', runs: 2, statuses: { pass: 2 }, last: { status: 'pass', summary: '54 nets' } },
    ])
    expect(r.files).toBe(5)
    expect(r.names).toEqual([
      { name: 'erc-report.json', copies: 3, different: 2, kind: 'kicad.erc', status: 'pass' },
      { name: 'nets.tsv', copies: 2, different: 1, kind: 'kicad.netlist', status: 'pass' },
    ])
    expect(describeRuns(r)).toBe('Adds 5 tool runs (3 kicad.erc, 2 kicad.netlist) and 5 files they made, 2 of them the same file again.')
    // not a trace record, or one that adds no run: nothing to say
    expect(runsDigest(a, a)).toBeNull()
    expect(runsDigest(null, make('CREATE TABLE parts(id INTEGER PRIMARY KEY)'))).toBeNull()
  })

  // test-esp32 log R10 (#59, #19): an added intent statement read as words, not stored values
  it('reads an added row as words: times, JSON, flags, and no empty fields', () => {
    const db = make(`CREATE TABLE intent_statements (id TEXT PRIMARY KEY, topic TEXT, text TEXT, source TEXT, detail TEXT,
        decide_by TEXT, owner TEXT, conflicts TEXT, testable INTEGER, status TEXT, created REAL, updated REAL, by TEXT);
      INSERT INTO intent_statements VALUES ('I24', 'interfaces', 'Wi-Fi reset: hold the button',
        '{"kind":"person","ref":"marc@teichtahl.com","quote":"I24 Wi-Fi reset: hold it"}', '{}', NULL, '', '[]', 1, 'proposed',
        1794081403.409, 1794081403.409, 'the Verification specialist');`)
    const d = diffDb(null, db).find((t) => t.name === 'intent_statements')!
    const row = d.rows[0]!
    const when = localTime(1794081403409)
    expect(rowFields(d.columns, row.after!, d.keyColumns)).toEqual([
      { column: 'topic', text: 'interfaces' },
      { column: 'text', text: 'Wi-Fi reset: hold the button' },
      { column: 'source', text: 'person marc@teichtahl.com, quote: "I24 Wi-Fi reset: hold it"' },
      { column: 'testable', text: 'yes' },
      { column: 'status', text: 'proposed' },
      { column: 'created', text: when },
      { column: 'updated', text: when },
      { column: 'by', text: 'the Verification specialist' },
    ])
    expect(when).toMatch(/2026/)
  })

  it('reads stored values as a person would', () => {
    // times: by column name in seconds or milliseconds, or a number that clearly is one
    expect(readable('opened_at', 1794081403)).toBe(localTime(1794081403000))
    expect(readable('updated', 1794081403409)).toBe(localTime(1794081403409))
    expect(readable('t', 1794081403.5)).toBe(localTime(1794081403500))
    expect(readable('qty', 1794081403)).toBe('1794081403')
    expect(readable('created', 12)).toBe('12')
    // flags: 0 or 1 in a yes-or-no column only
    expect(readable('testable', 0)).toBe('no')
    expect(readable('is_dnp', 1)).toBe('yes')
    expect(readable('qty', 1)).toBe('1')
    expect(readable('testable', 2)).toBe('2')
    // JSON: compact words, nested objects in brackets, empty ones empty
    expect(readable('detail', '{}')).toBe('')
    expect(readable('conflicts', '[]')).toBe('')
    expect(readable('conflicts', '["I3","I7"]')).toBe('I3, I7')
    expect(readable('detail', '{"interface":{"type":"I2C","rate":400000},"limits":[{"name":"Vin","max":5.5,"unit":"V"}]}')).toBe('interface: (I2C, rate: 400000), limits: (Vin, max: 5.5, unit: V)')
    expect(readable('note', '{not json')).toBe('{not json')
    expect(jsonText({ kind: 'document', page: 4, ref: 'ds.pdf', extra: null })).toBe('document ds.pdf, page: 4')
    // empty
    expect(readable('owner', null)).toBe('')
    expect(readable('owner', '  ')).toBe('')
  })
})
