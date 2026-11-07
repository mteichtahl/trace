/**
 * mergeRows: the project record merged row by row only when the two sides changed different rows (test-esp32 log
 * #191, #213). A row both changed differently is a conflict, never settled by a rule.
 */
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mergeRows } from '../../src/core/dbmerge.js'
import { openProject } from '../../src/core/store.js'

/** A base record with a run and two settings; ours and theirs start as copies of it. */
function three(): { base: string; ours: string; theirs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-rows-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  db.prepare("INSERT INTO runs (id, kind, subject, started, status, summary) VALUES ('run-base', 'kicad.erc', 'hw', 1, 'pass', 'ok')").run()
  db.prepare("INSERT INTO settings (key, value, updated, by) VALUES ('worker.model', '\"a\"', 1, 'p'), ('budget.target', '9', 1, 'p')").run()
  db.close()
  const base = join(dir, '.trace', 'project.db')
  const ours = join(dir, 'ours.db')
  const theirs = join(dir, 'theirs.db')
  copyFileSync(base, ours)
  copyFileSync(base, theirs)
  return { base, ours, theirs }
}

const exec = (path: string, sql: string): void => { const db = new DatabaseSync(path); db.exec(sql); db.close() }
const all = (path: string, sql: string): unknown[] => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all().map((r) => ({ ...r })) } finally { db.close() } }
const run = (id: string): string => `INSERT INTO runs (id, kind, subject, started, status, summary) VALUES ('${id}', 'render.showcase', 'hw', 2, 'pass', 'ok')`

describe('mergeRows', () => {
  it('each side added its own runs (the renders change after the docs change): both kept, nothing else touched', () => {
    const { base, ours, theirs } = three()
    exec(ours, run('run-renders'))
    exec(theirs, `${run('run-docs')}; INSERT INTO measurements (run_id, name, value) VALUES ('run-docs', 'pages', 3)`)
    expect(mergeRows(base, ours, theirs)).toEqual([])
    expect(all(ours, 'SELECT id FROM runs ORDER BY id')).toEqual([{ id: 'run-base' }, { id: 'run-docs' }, { id: 'run-renders' }])
    expect(all(ours, 'SELECT run_id, name, value FROM measurements')).toEqual([{ run_id: 'run-docs', name: 'pages', value: 3 }])
  })

  it('different rows changed and removed on each side: the base with both sides\' changes, exactly', () => {
    const { base, ours, theirs } = three()
    exec(ours, `UPDATE settings SET value='"b"', updated=2 WHERE key='worker.model'`)
    exec(theirs, `DELETE FROM settings WHERE key='budget.target'; DELETE FROM runs WHERE id='run-base'`)
    expect(mergeRows(base, ours, theirs)).toEqual([])
    expect(all(ours, 'SELECT key, value FROM settings ORDER BY key')).toEqual([{ key: 'worker.model', value: '"b"' }])
    // a row they removed stays removed (a union would bring it back)
    expect(all(ours, 'SELECT id FROM runs')).toEqual([])
  })

  it('the same row changed the same way on both sides is no conflict', () => {
    const { base, ours, theirs } = three()
    for (const p of [ours, theirs]) exec(p, `UPDATE settings SET value='10' WHERE key='budget.target'`)
    expect(mergeRows(base, ours, theirs)).toEqual([])
    expect(all(ours, "SELECT value FROM settings WHERE key='budget.target'")).toEqual([{ value: '10' }])
  })

  it('the same row changed differently, or removed on one side and changed on the other: a conflict, ours keeps its rows', () => {
    let s = three()
    exec(s.ours, `UPDATE settings SET value='10' WHERE key='budget.target'`)
    exec(s.theirs, `UPDATE settings SET value='12' WHERE key='budget.target'; ${run('run-docs')}`)
    expect(mergeRows(s.base, s.ours, s.theirs)).toEqual(['table settings'])
    expect(all(s.ours, "SELECT value FROM settings WHERE key='budget.target'")).toEqual([{ value: '10' }])
    expect(all(s.ours, "SELECT id FROM runs WHERE id='run-docs'")).toEqual([])
    s = three()
    exec(s.ours, "UPDATE runs SET summary='redone' WHERE id='run-base'")
    exec(s.theirs, "DELETE FROM runs WHERE id='run-base'")
    expect(mergeRows(s.base, s.ours, s.theirs)).toEqual(['table runs'])
  })

  it('a row ours added that their change would take with it (a cascade): a conflict, nothing changed', () => {
    const { base, ours, theirs } = three()
    exec(ours, "INSERT INTO measurements (run_id, name, value) VALUES ('run-base', 'margin', 1)")
    exec(theirs, "DELETE FROM runs WHERE id='run-base'")
    expect(mergeRows(base, ours, theirs)).toEqual(['table measurements'])
    expect(all(ours, 'SELECT id FROM runs')).toEqual([{ id: 'run-base' }])
  })

  it('a table only they have is made, with their rows; a table they removed is a conflict', () => {
    let s = three()
    exec(s.theirs, "CREATE TABLE extra (id TEXT PRIMARY KEY, v BLOB); INSERT INTO extra VALUES ('x', x'00ff')")
    expect(mergeRows(s.base, s.ours, s.theirs)).toEqual([])
    expect(all(s.ours, 'SELECT id, hex(v) AS v FROM extra')).toEqual([{ id: 'x', v: '00FF' }])
    s = three()
    exec(s.base, 'CREATE TABLE gone (id TEXT PRIMARY KEY)')
    exec(s.ours, 'CREATE TABLE gone (id TEXT PRIMARY KEY)')
    expect(mergeRows(s.base, s.ours, s.theirs)).toEqual(['table gone'])
  })

  it('no common ancestor: nothing is merged', () => {
    const { ours, theirs } = three()
    expect(mergeRows(join(tmpdir(), 'no-such-trace.db'), ours, theirs)).toEqual(['the common ancestor has no project database'])
  })
})
