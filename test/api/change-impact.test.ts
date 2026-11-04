import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { type JourneyRecord, loadJourney, recordOpen, setCriterion, signGate, startJourney } from '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'
import { changeImpact } from '../../src/api/change-impact.js'

const signer = { hash: 'a'.repeat(16), label: 'admin@example.com' }
let db: DatabaseSync
const rec = (): JourneyRecord => loadJourney(db) as JourneyRecord
const pass = (gate: string): void => {
  for (const c of rec().criteria.filter((x) => x.gate === gate)) { setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}`, label: `run for ${c.id}` }], 'trace'); recordOpen(db, { criterion: c.id }, signer.hash) }
  signGate(db, gate, signer)
}

describe('change request impact', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-impact-'))
    mkdirSync(join(dir, '.git'))
    db = openProject(dir)
    startJourney(db, { template: 'board', by: signer.label, name: 'LED flasher' })
  })

  it('a requirement reopens from Define to the current stage, with the signed gates and their evidence', () => {
    for (const g of ['define', 'architect', 'capture', 'prove', 'layout']) pass(g)
    expect(rec().journey.currentStage).toBe('signoff')
    const i = changeImpact(rec(), 'requirement')
    expect(i?.stages).toEqual(['Define', 'Architect', 'Capture', 'Prove', 'Layout', 'Sign-off'])
    expect(i?.gates).toHaveLength(5)
    expect(i?.gates[0]).toMatch(/\(Define\)$/)
    expect(i?.stale).toContain('run for define.accepted')
    expect(i?.released).toBe(false)
  })

  it('a part starts at Capture; a change before its starting stage reopens nothing', () => {
    for (const g of ['define', 'architect', 'capture']) pass(g)
    expect(changeImpact(rec(), 'part')?.stages).toEqual(['Capture', 'Prove'])
    expect(changeImpact(rec(), 'firmware')?.stages).toEqual(['Prove'])
    db.prepare("UPDATE journey SET current_stage='architect' WHERE id='current'").run()
    expect(changeImpact(rec(), 'part')).toBeNull()
  })

  it('lineage narrows the stale evidence to the runs the change can touch, and keeps what it cannot rule out', () => {
    for (const g of ['define', 'architect', 'capture']) pass(g)
    const files = new Map<string, string[]>([
      ['run-capture.erc', ['hw/board.kicad_pro', 'hw/board.kicad_sch']],
      ['run-capture.datasheets', ['docs/datasheets/U1.pdf']],
    ])
    const all = changeImpact(rec(), 'part')!
    const narrow = changeImpact(rec(), 'part', files)!
    expect(narrow.stale).toContain('run for capture.erc')
    expect(narrow.stale).not.toContain('run for capture.datasheets')
    // a run whose inputs are not known (from before lineage) stays in
    expect(narrow.stale).toContain('run for capture.pins')
    expect(narrow.narrowed).toBe(1)
    expect(narrow.stale).toHaveLength(all.stale.length - 1)
    expect(all.narrowed).toBeUndefined()
    // firmware: the schematic's rule check is left out, the datasheet run is not
    const fw = changeImpact(rec(), 'firmware', files)
    expect(fw?.stages).toEqual(['Prove'])
    // a requirement change is not narrowed by files: the design record is not a file
    expect(changeImpact(rec(), 'requirement', files)?.narrowed).toBeUndefined()
  })

  it('nothing to trace until the kind of change is chosen', () => {
    expect(changeImpact(rec(), '')).toBeNull()
    expect(changeImpact(rec(), undefined)).toBeNull()
    expect(changeImpact(null, 'requirement')).toBeNull()
  })
})
