/**
 * Evidence gone out of date (docs/ontology-plan.md P4.3): a met criterion trace owns that cites a run that no longer
 * stands reads as not met, with why, and a gate cannot be signed on it; a person's criterion stays theirs.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { applyJourneySchema, gateView, journeyView, setCriterion, signGate, staleCriteria, startJourney, withStaleEvidence } from '../../src/core/journey.js'
import { ADMIN, rec, signThrough, tempDb } from '../ontology/fixture.js'

const VIEWER = { hash: ADMIN.hash, label: ADMIN.label, admin: true, part: 'contributor' as const }
let db: DatabaseSync
const stale = (id: string): string | null => (id === 'run-old' ? 'hw/board.kicad_sch changed since kicad.erc ran' : null)

beforeEach(() => {
  db = tempDb('journey.db')
  applyJourneySchema(db, { store: true })
  startJourney(db, { template: 'board', by: ADMIN.label })
  signThrough(db, 'define')
  signThrough(db, 'architect')
  setCriterion(db, 'capture.erc', 'met', [{ kind: 'run', ref: 'run-old' }], 'trace')
  setCriterion(db, 'capture.datasheets', 'met', [{ kind: 'run', ref: 'run-fresh' }], 'trace')
})

describe('evidence that has gone out of date', () => {
  it('makes a criterion trace owns read as not met, with why; current evidence and people\'s criteria are untouched', () => {
    const r = withStaleEvidence(rec(db), stale)
    const by = Object.fromEntries(gateView(r, 'capture', VIEWER).criteria.map((c) => [c.id, c]))
    expect(by['capture.erc']).toMatchObject({ status: 'not_met', stale: 'Its evidence is out of date: hw/board.kicad_sch changed since kicad.erc ran. trace checks it again.' })
    expect(by['capture.datasheets']).toMatchObject({ status: 'met' })
    expect(by['capture.datasheets']?.stale).toBeUndefined()
    expect(staleCriteria(r)).toEqual([{ criterion: 'capture.erc', gate: 'capture', text: expect.any(String), why: expect.stringMatching(/out of date/) }])
    // the record itself is not changed
    expect(rec(db).criteria.find((c) => c.id === 'capture.erc')?.status).toBe('met')
    expect(withStaleEvidence(rec(db), () => null)).toEqual(rec(db))
    // a person's criterion stays theirs
    setCriterion(db, 'capture.pins', 'met', [{ kind: 'run', ref: 'run-old' }], ADMIN.label)
    expect(withStaleEvidence(rec(db), stale).criteria.find((c) => c.id === 'capture.pins')?.status).toBe('met')
  })

  it('keeps the gate from being signed until the criterion is checked again on current evidence', () => {
    for (const c of rec(db).criteria.filter((x) => x.gate === 'capture' && x.status !== 'met')) setCriterion(db, c.id, 'met', [{ kind: 'run', ref: 'run-fresh' }], c.owner === 'trace' ? 'trace' : ADMIN.label)
    expect(journeyView(withStaleEvidence(rec(db), stale), VIEWER).stages.find((s) => s.id === 'capture')).toBeTruthy()
    expect(() => signGate(db, 'capture', ADMIN, { staleRun: stale })).toThrow(/cannot be signed/)
    setCriterion(db, 'capture.erc', 'met', [{ kind: 'run', ref: 'run-new' }], 'trace')
    for (const c of rec(db).criteria.filter((x) => x.gate === 'capture')) db.prepare('INSERT OR IGNORE INTO criterion_opens (item, who, at) VALUES (?,?,?)').run(c.id, ADMIN.hash, Date.now() / 1000)
    expect(signGate(db, 'capture', ADMIN, { staleRun: stale }).gate.state).toBe('signed')
  })
})
