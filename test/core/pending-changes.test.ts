/**
 * Nothing goes to Fabricate while the design is changing (docs/user-journey.md): the gates into Fabricate stay locked
 * while a change is pending, and a requirement that changes after the baseline takes the project back to Define.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type JourneyRecord, type PendingChanges, type Viewer, guardsFabricate, journeyView, loadJourney, pendingBlockers, recordOpen, returnForChange,
  setCriterion, signBlockers, signGate, startJourney, withPending,
} from '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'
import { changesStage } from '../../src/api/actions-design.js'
import type { DesignDecision } from '../../src/tools/design/decisions.js'

const ADMIN: Viewer = { hash: 'a'.repeat(16), label: 'admin@example.com', admin: true, part: 'contributor' }
const signer = { hash: ADMIN.hash, label: ADMIN.label }
let db: DatabaseSync
const rec = (): JourneyRecord => loadJourney(db) as JourneyRecord
const meetAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'trace') }
const openAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) recordOpen(db, { criterion: c.id }, ADMIN.hash) }
const sign = (...gates: string[]): void => { for (const g of gates) { meetAll(g); openAll(g); signGate(db, g, signer) } }
const start = (template: 'board' | 'fpga' | 'firmware' = 'board'): void => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-pending-'))
  mkdirSync(join(dir, '.git'))
  db = openProject(dir)
  startJourney(db, { template, by: ADMIN.label, name: 'Soil sensor' })
}

const NONE: PendingChanges = { changes: [], requirements: [] }
const OPEN: PendingChanges = { changes: [{ number: 12, title: 'Swap the regulator', ready: true }], requirements: [] }

describe('the gates into Fabricate', () => {
  it('are Sign-off (it passes Release) and the order approval, and only where the project has a Fabricate stage', () => {
    start('board')
    const r = rec()
    expect(r.gates.filter((g) => guardsFabricate(r, g.id)).map((g) => g.id)).toEqual(['signoff', 'fabricate.order'])
    start('fpga')
    expect(rec().gates.filter((g) => guardsFabricate(rec(), g.id)).map((g) => g.id)).toEqual(['signoff', 'fabricate.order'])
    start('firmware')
    expect(rec().gates.some((g) => guardsFabricate(rec(), g.id))).toBe(false)
  })

  it('cannot be signed while a change from trace is open, and can once it is settled', () => {
    start()
    sign('define', 'architect', 'capture', 'prove', 'layout')
    meetAll('signoff'); openAll('signoff')
    expect(signBlockers(rec(), 'signoff', ADMIN, [], OPEN)).toEqual([expect.stringMatching(/^Accept or discard 1 open change from trace first \("Swap the regulator"\)/)])
    expect(() => signGate(db, 'signoff', signer, { pending: OPEN })).toThrow(/Accept or discard 1 open change/)
    expect(rec().journey.currentStage).toBe('signoff')
    // the other gates are not held by it
    expect(pendingBlockers(rec(), 'layout', OPEN)).toEqual([])
    expect(signGate(db, 'signoff', signer, { pending: NONE })).toMatchObject({ advanced_to: 'fabricate' })
    meetAll('fabricate.order'); openAll('fabricate.order')
    expect(() => signGate(db, 'fabricate.order', signer, { pending: OPEN })).toThrow(/open change/)
  })

  it('stay locked when trace cannot tell whether anything is pending', () => {
    start()
    expect(pendingBlockers(rec(), 'signoff', { ...NONE, unknown: 'GitHub did not answer' })).toEqual([expect.stringMatching(/could not check for open changes just now \(GitHub did not answer\), so Fabricate stays locked/)])
    expect(pendingBlockers(rec(), 'signoff', { ...NONE, requirements: ['R5'] })).toEqual([expect.stringMatching(/^Requirement R5 was changed after the requirements baseline/)])
  })

  it('show the lock in the view, and the next step settles the change instead of signing', () => {
    start()
    sign('define', 'architect', 'capture', 'prove', 'layout')
    meetAll('signoff'); openAll('signoff')
    const before = journeyView(rec(), ADMIN)
    expect(before.next).toMatchObject({ kind: 'gate', ref: { kind: 'gate', id: 'signoff' } })
    const v = withPending(rec(), before, ADMIN, OPEN)
    expect(v.gates.find((g) => g.id === 'signoff')).toMatchObject({ may_sign: false, missing: [expect.stringMatching(/open change/)] })
    expect(v.next).toMatchObject({ kind: 'review', yours: true, ref: { kind: 'change', id: '12' }, button: 'Review the change' })
    expect(v.next.summary).toMatch(/release approval gate is locked: 1 change from trace is still open/)
    expect(withPending(rec(), before, ADMIN, NONE)).toEqual(before)
  })
})

describe('a requirement that changes after the baseline', () => {
  it('takes the project back to Define: later signatures stop counting and the baseline is agreed again', () => {
    start()
    sign('define', 'architect', 'capture', 'prove', 'layout')
    expect(rec().journey.currentStage).toBe('signoff')
    expect(returnForChange(db, 'define', 'requirement R5 was changed after the requirements baseline', 'trace')).toBe('define')
    const r = rec()
    expect(r.journey.currentStage).toBe('define')
    expect(r.signatures.every((s) => s.supersededAt !== null)).toBe(true)
    // the person's criteria are agreed again; trace's evidence carries forward
    expect(r.criteria.filter((c) => c.gate === 'define').every((c) => c.status === 'not_met')).toBe(true)
    expect(r.criteria.filter((c) => c.gate === 'architect' && c.owner === 'trace').every((c) => c.status === 'met')).toBe(true)
    const v = journeyView(r, ADMIN)
    expect(v.next).toMatchObject({ kind: 'task', yours: true, ref: { kind: 'skill', id: 'requirements-review' } })
    expect(v.next.summary).toMatch(/^Back in Define: requirement R5 was changed after the requirements baseline/)
    expect(r.decisions[0]?.summary ?? '').toMatch(/Define was reopened/)
    // nothing happens when the project is in Define already
    expect(returnForChange(db, 'define', 'again', 'trace')).toBeNull()
  })

  it('is a change only when the decision differs from the one standing', () => {
    const was: DesignDecision = { id: 'd1', kind: 'requirement', target: 'R5', choice: 'accepted', detail: { text: 'Runs 2 years on AA cells' }, by: 'a', byHash: 'h', at: 1, supersededAt: null }
    expect(changesStage({ kind: 'requirement', target: 'R5', choice: 'accepted', detail: { text: 'Runs 2 years on AA cells' } }, [was])).toBeNull()
    expect(changesStage({ kind: 'requirement', target: 'R5', choice: 'struck', detail: { text: 'Runs 2 years on AA cells', reason: 'dropped' } }, [was])).toBe('define')
    expect(changesStage({ kind: 'requirement', target: 'R5', choice: 'accepted', detail: { text: 'Runs 3 years on AA cells' } }, [was])).toBe('define')
    expect(changesStage({ kind: 'pins.agreed', target: 'U1', choice: 'agreed', detail: {} }, [])).toBeNull()
  })
})
