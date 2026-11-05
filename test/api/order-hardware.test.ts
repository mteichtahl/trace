/**
 * The order sheet's panel and mounting hardware: read from the run that made it (kicad.fab, else kicad.bom), kept apart
 * from the parts, and nothing when no run made one.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hardwareOf } from '../../src/api/actions-build.js'
import { BuildSchema } from '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'

const dir = mkdtempSync(join(tmpdir(), 'trace-hw-'))
mkdirSync(join(dir, '.git'))
const db = openProject(dir)
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const insert = (id: string, kind: string, result: unknown, at: number) =>
  db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)').run(id, kind, 'hw', at, 'pass', '', JSON.stringify(result))

const HW = {
  total_items: 3, case_built: true, case_stale: true, notes: ['The case was built for an earlier version of the board.'],
  lines: [
    { qty: 1, item: 'Case lid', kind: 'panel', size: '60 × 40 × 3 mm', length_mm: null, for: ['lid'], mpn: null, lcsc: null, source: 'case', note: null },
    { qty: 2, item: 'M2.5 pan head screw, 6 mm', kind: 'mounting', size: 'M2.5', length_mm: 6, for: ['H1', 'H2'], mpn: null, lcsc: null, source: 'case', note: 'thread-forming' },
  ],
}

describe('the order\'s hardware list', () => {
  it('is off unless the build plan asks for it', () => {
    expect(BuildSchema.parse({}).hardware).toBe(false)
    expect(BuildSchema.parse({ hardware: true }).hardware).toBe(true)
  })

  it('is nothing when no run made one', () => {
    insert('fab-1', 'kicad.fab', { files: [] }, 1)
    expect(hardwareOf({ files: [] }, db)).toBeNull()
  })

  it('comes from the newest kicad.bom run that made one when the fab run did not', () => {
    insert('bom-1', 'kicad.bom', { total_parts: 7, hardware: HW }, 2)
    const h = hardwareOf({ files: [] }, db)
    expect(h).toMatchObject({ run: 'bom-1', case_stale: true })
    expect(h?.lines.map((l) => [l.qty, l.item, l.kind, l.for.join(' ')])).toEqual([[1, 'Case lid', 'panel', 'lid'], [2, 'M2.5 pan head screw, 6 mm', 'mounting', 'H1 H2']])
  })

  it('prefers the fab run\'s own list', () => {
    insert('fab-2', 'kicad.fab', { files: [], hardware: { ...HW, case_stale: false, lines: HW.lines.slice(1) } }, 3)
    const h = hardwareOf({ files: [], hardware: { ...HW, case_stale: false, lines: HW.lines.slice(1) } }, db)
    expect(h).toMatchObject({ run: 'fab-2', case_stale: false })
    expect(h?.lines).toHaveLength(1)
  })
})
