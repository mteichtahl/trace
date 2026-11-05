/**
 * The gates count the accepted design only (src/api/evidence-freshness.ts acceptedRecord, src/core/journey.ts
 * withStaleEvidence), from the test-esp32 run:
 *   #51  "ERC is clean, or each finding is waived" was met on "0 errors" while the report had 82 warnings to fix or waive
 *   #43, #57  criteria were met by a run made on a change that was not accepted yet
 *   #32  the evidence did not say what was checked
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { acceptedRecord, ruleCheck } from '../../src/api/evidence-freshness.js'
import { baselineEvidence } from '../../src/api/actions-skills.js'
import { type JourneyRecord, addWaiver, gateView, loadJourney, setCriterion, startJourney, withStaleEvidence } from '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'

const VIEWER = { hash: 'a'.repeat(16), label: 'admin@example.com', admin: true, part: 'contributor' as const }
const warning = (type: string, ref: string, y: number) => ({ type, severity: 'warning', description: `Symbol ${ref} has an issue`, items: [{ description: `Symbol ${ref}`, pos: { x: 10, y } }] })
/** An ERC report with no error and three warnings (two library symbol issues, a footprint link issue). */
const ERC = JSON.stringify({
  kicad_version: '9.0.0', coordinate_units: 'mm',
  sheets: [{ path: '/', violations: [warning('lib_symbol_issues', 'U1', 1), warning('lib_symbol_issues', 'U2', 2), warning('footprint_link_issues', 'J1', 3)] }],
})
const CLEAN = JSON.stringify({ kicad_version: '9.0.0', coordinate_units: 'mm', sheets: [{ path: '/', violations: [] }] })

let db: DatabaseSync
const rec = (): JourneyRecord => loadJourney(db) as JourneyRecord
const ercRun = (id: string, report: string, t: number): void => {
  db.prepare("INSERT INTO runs (id, kind, subject, started, status, summary) VALUES (?, 'kicad.erc', 'hw/board.kicad_pro', ?, 'pass', 'ERC: 0 errors')").run(id, t)
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run(id, 'erc-report.json', 'application/json', new TextEncoder().encode(report))
}
const capture = (r: JourneyRecord) => Object.fromEntries(gateView(r, 'capture', VIEWER).criteria.map((c) => [c.id, c]))

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-gate-evidence-'))
  mkdirSync(join(dir, '.git'))
  db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed' })
})

describe('a rule check criterion counts warnings, not only errors (#51)', () => {
  it('reads "0 errors" with warnings to fix or waive as not met, naming the run, its counts and each finding', () => {
    ercRun('run-erc-1', ERC, 100)
    setCriterion(db, 'capture.erc', 'met', [{ kind: 'run', ref: 'run-erc-1', label: 'kicad_erc: 0 errors' }], 'trace')
    const c = capture(withStaleEvidence(rec(), acceptedRecord(db, rec(), new Map())))['capture.erc']
    expect(c).toMatchObject({ status: 'not_met', stale: expect.stringMatching(/^The electrical rule check \(run run-erc-\) has 3 findings to fix or waive \(2 lib_symbol_issues, 1 footprint_link_issues\): 0 errors and 3 warnings, and warnings count too/) })
    expect(c?.evidence).toEqual([
      { kind: 'run', ref: 'run-erc-1', label: 'kicad_erc: 0 errors' },
      { kind: 'run', ref: 'run-erc-1', label: 'Electrical rule check, run run-erc-: 0 errors, 3 warnings, 0 excluded in KiCad; 3 to fix or waive (2 lib_symbol_issues, 1 footprint_link_issues), 0 waived' },
      ...['U1', 'U2', 'J1'].map((ref) => ({ kind: 'finding', ref: expect.stringContaining(ref), label: `Symbol ${ref} has an issue` })),
    ])
  })

  it('is met once each finding is waived, and its evidence still lists what was checked', () => {
    ercRun('run-erc-1', ERC, 100)
    setCriterion(db, 'capture.erc', 'met', [{ kind: 'run', ref: 'run-erc-1' }], 'trace')
    const ids = (ruleCheck(db, 'erc', rec())?.findings ?? []).map((f) => f.ref)
    expect(ids).toHaveLength(3)
    for (const id of ids) {
      addWaiver(db, { target: { kind: 'finding', id }, reason: 'The library tables are fixed in the next change.', risk: 'A footprint is not found at layout.', severity: 'cosmetic', caught_where: 'Layout: the footprints are placed', scope: 'this revision only' }, { hash: VIEWER.hash, label: VIEWER.label })
    }
    const c = capture(withStaleEvidence(rec(), acceptedRecord(db, rec(), new Map())))['capture.erc']
    expect(c?.status).toBe('met')
    expect(c?.evidence.at(-1)?.label).toMatch(/0 to fix or waive, 3 waived$/)
  })

  it('reads the newest accepted report: a clean run meets it, and lists its counts', () => {
    ercRun('run-erc-1', ERC, 100)
    ercRun('run-erc-2', CLEAN, 200)
    setCriterion(db, 'capture.erc', 'met', [{ kind: 'run', ref: 'run-erc-2' }], 'trace')
    const c = capture(withStaleEvidence(rec(), acceptedRecord(db, rec(), new Map())))['capture.erc']
    expect(c).toMatchObject({ status: 'met', evidence: [{ ref: 'run-erc-2' }, { ref: 'run-erc-2', label: expect.stringMatching(/0 errors, 0 warnings, 0 excluded in KiCad; 0 to fix or waive, 0 waived$/) }] })
    expect(c?.stale).toBeUndefined()
  })
})

describe('only the accepted design counts (#43, #57)', () => {
  it('a criterion met by a run the default branch\'s record does not hold is not met until its change is accepted', () => {
    setCriterion(db, 'capture.datasheets', 'met', [{ kind: 'run', ref: 'run-on-a-branch' }], 'trace')
    const before = capture(withStaleEvidence(rec(), acceptedRecord(db, rec(), new Map())))['capture.datasheets']
    expect(before).toMatchObject({ status: 'not_met', stale: expect.stringMatching(/change that is not accepted yet: its run run-on-a/) })
    // the change is accepted: its run is merged into the default branch's record
    db.prepare("INSERT INTO runs (id, kind, started, status) VALUES ('run-on-a-branch', 'datasheet.check', 1, 'pass')").run()
    expect(capture(withStaleEvidence(rec(), acceptedRecord(db, rec(), new Map())))['capture.datasheets']?.status).toBe('met')
  })

  it('leaves a person\'s criterion theirs, and evidence that names no run alone', () => {
    setCriterion(db, 'capture.pins', 'met', [{ kind: 'run', ref: 'run-on-a-branch' }], VIEWER.label)
    setCriterion(db, 'capture.stock', 'met', [{ kind: 'record', ref: 'parts' }], 'trace')
    const c = capture(withStaleEvidence(rec(), acceptedRecord(db, rec(), new Map())))
    expect(c['capture.pins']?.status).toBe('met')
    expect(c['capture.stock']?.status).toBe('met')
  })
})

describe('the evidence lists what was checked (#32)', () => {
  it('the requirements baseline names each requirement with its decision and acceptance, and each one struck', () => {
    const ev = baselineEvidence([
      { id: 'REQ-001', text: 'Runs from USB-C at 5 V', status: 'accepted', acceptance: '4.75-5.25 V' },
      { id: 'REQ-002', text: 'Shows the time', status: 'proposed', acceptance: null },
    ], [{ id: 'REQ-003', reason: 'no battery in this revision' }], 'admin@example.com')
    expect(ev).toEqual([
      { kind: 'skill', ref: 'requirements-review', label: 'Requirements review, submitted by admin@example.com: 1 of 2 accepted, 1 not decided, 1 struck' },
      { kind: 'requirement', ref: 'REQ-001', label: 'REQ-001 accepted, measured by "4.75-5.25 V": Runs from USB-C at 5 V' },
      { kind: 'requirement', ref: 'REQ-002', label: 'REQ-002 proposed, with no acceptance criterion: Shows the time' },
      { kind: 'requirement', ref: 'REQ-003', label: 'REQ-003 struck: no battery in this revision' },
    ])
  })
})
