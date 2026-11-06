/**
 * Which records a change touched (src/docs/stale.ts), as the Documentation agent's start and its docs_stale read them:
 * a check run again with the same outcome is not a changed record (test-esp32 run 2 ran the same ERC in five jobs and
 * each marked the board sections again), and a change that feeds only sections due at a later stage is due nothing now.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { dueSections, sourcesOfDatabases } from '../../src/docs/stale.js'
import { openProject } from '../../src/core/store.js'

const root = mkdtempSync(join(tmpdir(), 'trace-stale-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
/** A project database with these runs (kind, subject, status, summary), in order. */
function withRuns(runs: [string, string, string, string][]): DatabaseSync {
  const dir = join(root, `p${n++}`)
  mkdirSync(join(dir, '.git'), { recursive: true })
  const db = openProject(dir)
  runs.forEach(([kind, subject, status, summary], i) => db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary) VALUES (?, ?, ?, ?, ?, ?)').run(`r${n}-${i}`, kind, subject, i + 1, status, summary))
  return db
}
const ERC: [string, string, string, string] = ['kicad.erc', 'hw/board.kicad_pro', 'pass', 'ERC: 0 errors, 0 warnings']
const TST = (id: string): [string, string, string, string] => ['verify.run', 'TST-002', 'pass', `TST-002 pass: inspection: J2 footprint PinSocket_1x04 (kicad_components ${id}); J2.1 GND`]

describe('a changed record, from two project databases', () => {
  it('a check run again with the same outcome marks nothing, though its summary cites new run ids', () => {
    const before = withRuns([ERC, TST('1067e7bb2b234fc0')])
    const after = withRuns([ERC, TST('1067e7bb2b234fc0'), ERC, TST('533b5e9b4d9f4872')])
    expect([...sourcesOfDatabases(before, after)]).toEqual([])
  })

  it('a check whose outcome changed, or a new check, marks its sections as before', () => {
    const before = withRuns([ERC])
    expect([...sourcesOfDatabases(before, withRuns([ERC, ['kicad.erc', 'hw/board.kicad_pro', 'pass', 'ERC: 0 errors, 2 warnings']]))]).toEqual(['board'])
    expect([...sourcesOfDatabases(before, withRuns([ERC, ['kicad.erc', 'hw/board.kicad_pro', 'fail', 'ERC: 1 errors, 0 warnings']]))]).toEqual(['board'])
    expect([...sourcesOfDatabases(before, withRuns([ERC, ['thermal.junction', 'optA', 'pass', 'pass: every part within the derated limit']]))]).toEqual(['thermal'])
    expect([...sourcesOfDatabases(null, withRuns([ERC]))]).toContain('board')
  })

  it('only the latest outcome of a check counts: a failure fixed within the change is the pass it ends with', () => {
    const before = withRuns([ERC])
    expect([...sourcesOfDatabases(before, withRuns([ERC, ['kicad.erc', 'hw/board.kicad_pro', 'fail', 'ERC: 1 errors'], ERC]))]).toEqual([])
  })
})

describe('the sections due now', () => {
  it('a thermal result at Architect feeds only sections due at Prove: nothing is due', () => {
    expect(dueSections(new Set(['thermal', 'power']), 'architect')).toEqual([])
    expect(dueSections(new Set(['thermal', 'power']), 'prove').map((d) => d.kind)).toEqual(['hld', 'lld'])
  })

  it('the case at Capture feeds nothing due; at Layout the mechanical sections', () => {
    expect(dueSections(new Set(['enclosure']), 'capture')).toEqual([])
    const due = dueSections(new Set(['enclosure']), 'layout')
    expect(due.find((d) => d.kind === 'lld')?.sections.map((s) => s.id)).toEqual(['mechanical'])
  })

  it('the schematic at Capture feeds the low level design\'s modules and power tree', () => {
    expect(dueSections(new Set(['schematic']), 'capture').find((d) => d.kind === 'lld')?.sections.map((s) => s.id)).toEqual(['modules', 'power-tree', 'interfaces'])
  })
})
