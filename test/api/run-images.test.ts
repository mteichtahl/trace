/**
 * The pictures runs made, for the screens that show them (record-read.ts runImages): a render kept in the store has a
 * type that says where ("image/png; trace-stored=<sha>:<bytes>") and is a picture all the same (test-esp32-run3 S21:
 * the release review's board read "no drawing of it is recorded yet" over three renders).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runImages } from '../../src/api/record-read.js'
import { openProject } from '../../src/core/store.js'

const dir = mkdtempSync(join(tmpdir(), 'trace-run-images-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('runImages', () => {
  it('finds stored renders, inline pictures and SVGs, and nothing else', () => {
    // the project's database file is what makes `dir` a project: without it openProject used the per-user scratch database
    mkdirSync(join(dir, '.trace'), { recursive: true })
    writeFileSync(join(dir, '.trace', 'project.db'), '')
    const db = openProject(dir)
    db.prepare("INSERT INTO runs (id, kind, started, status) VALUES ('r1', 'render.board', 2, 'pass'), ('x1', 'kicad.export', 1, 'pass'), ('d1', 'docs.check', 3, 'pass')").run()
    const add = db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)')
    add.run('r1', 'top.png', 'image/png; trace-stored=06e0e39a:1646405', new Uint8Array())
    add.run('r1', 'notes.txt', 'text/plain', new Uint8Array())
    add.run('x1', 'board.svg', 'image/svg+xml; trace-encoding=gzip', new Uint8Array())
    add.run('x1', 'old.png', 'image/png', new Uint8Array())
    add.run('d1', 'page.png', 'image/png', new Uint8Array())
    const got = runImages(db, ['render.board', 'kicad.export']).map((i) => [i.run, i.name, i.mime])
    db.close()
    expect(got).toEqual([['r1', 'top.png', 'image/png'], ['x1', 'board.svg', 'image/svg+xml'], ['x1', 'old.png', 'image/png']])
  })
})
