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
  type JourneyRecord, type PendingChanges, type Viewer, applyChange, guardsFabricate, isReleased, journeyView, loadJourney, loadOrders, nextRevision,
  pendingBlockers, recordOpen, recordOrder, returnForChange, setCriterion, signBlockers, signGate, startJourney, withPending,
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
const OPEN: PendingChanges = { changes: [{ number: 12, title: 'Swap the regulator', ready: true, stage: 'signoff' }], requirements: [] }

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
    // a change of a later stage does not hold an earlier gate
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
    expect(v.next.summary).toMatch(/release approval gate is locked: 1 change is still open/)
    expect(withPending(rec(), before, ADMIN, NONE)).toEqual(before)
  })
})

describe('every gate, while its stage has work pending', () => {
  it('cannot be reviewed or signed while a change of its stage (or an earlier one) is open', () => {
    start()
    meetAll('define'); openAll('define')
    const mine: PendingChanges = { changes: [{ number: 7, title: 'Draft the requirements', ready: true, stage: 'define' }], requirements: [] }
    expect(signBlockers(rec(), 'define', ADMIN, [], mine)).toEqual([expect.stringMatching(/^Accept or discard 1 open change first \("Draft the requirements"\): a stage is reviewed and signed once its work is settled/)])
    expect(() => signGate(db, 'define', signer, { pending: mine })).toThrow(/open change/)
    // a change whose stage is not known holds it too; one of a later stage does not
    expect(pendingBlockers(rec(), 'define', { changes: [{ number: 8, title: 'An edit', stage: null }], requirements: [] })).toHaveLength(1)
    expect(pendingBlockers(rec(), 'define', { changes: [{ number: 9, title: 'Route the board', stage: 'layout' }], requirements: [] })).toEqual([])
    expect(signGate(db, 'define', signer, { pending: NONE })).toMatchObject({ advanced_to: 'architect' })
  })

  it('cannot be signed while an agent is still working, and the next step watches the job', () => {
    start()
    meetAll('define'); openAll('define')
    const busy: PendingChanges = { changes: [], requirements: [], work: [{ id: 'job-1', title: 'Check the intent', state: 'running' }] }
    expect(pendingBlockers(rec(), 'define', busy)).toEqual([expect.stringMatching(/^Wait for 1 job still working to finish, or stop it \("Check the intent"\)/)])
    expect(() => signGate(db, 'define', signer, { pending: busy })).toThrow(/still working/)
    const before = journeyView(rec(), ADMIN)
    expect(before.next).toMatchObject({ kind: 'gate', ref: { kind: 'gate', id: 'define' } })
    const v = withPending(rec(), before, ADMIN, busy)
    expect(v.gates.find((g) => g.id === 'define')).toMatchObject({ may_sign: false, pending: [expect.stringMatching(/still working/)] })
    expect(v.next).toMatchObject({ kind: 'working', belongs_to: 'trace', job_id: 'job-1' })
    expect(v.next.summary).toMatch(/is locked: 1 job is still working/)
  })

  it('stays locked when trace cannot look', () => {
    start()
    expect(pendingBlockers(rec(), 'define', { ...NONE, unknown: 'GitHub did not answer' })).toEqual([expect.stringMatching(/so this gate stays locked/)])
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
    // the stage's person criteria are agreed again, and the stages built on it are done again
    expect(r.criteria.filter((c) => c.gate === 'define').every((c) => c.status === 'not_met')).toBe(true)
    expect(r.criteria.filter((c) => ['architect', 'capture', 'layout'].includes(c.gate)).every((c) => c.status === 'not_met')).toBe(true)
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

describe('an architecture change', () => {
  it('before release takes the project back to Architect: Define stays signed, trace re-checks Architect, later work is redone', () => {
    start()
    sign('define', 'architect', 'capture', 'prove')
    expect(applyChange(db, 'architect', 'Architecture B (Two boards) was chosen after the architecture review', ADMIN.label)).toEqual({ stage: 'architect', revision: null })
    const r = rec()
    expect(r.journey).toMatchObject({ currentStage: 'architect', revision: 'A' })
    const live = r.signatures.filter((x) => x.supersededAt === null).map((x) => x.gate)
    expect(live).toEqual(['define'])
    expect(r.criteria.find((c) => c.id === 'architect.blocks')?.status).toBe('not_met')
    expect(r.criteria.find((c) => c.id === 'architect.mapped')?.status).toBe('met')
    expect(r.criteria.filter((c) => c.gate === 'capture').every((c) => c.status === 'not_met')).toBe(true)
    const v = journeyView(r, ADMIN)
    expect(v.next).toMatchObject({ kind: 'task', ref: { kind: 'skill', id: 'architecture-choice' }, button: 'Open Architecture choice' })
    expect(v.next.summary).toMatch(/^Back in Architect: Architecture B \(Two boards\) was chosen after the architecture review\. Agree the change in Architecture choice\.$/)
    // at or before Architect, nothing happens
    expect(applyChange(db, 'architect', 'again', ADMIN.label)).toBeNull()
  })

  it('after release starts the next revision at Architect, leaving the released one as it was', () => {
    start()
    sign('define', 'architect', 'capture', 'prove', 'layout', 'signoff')
    expect(rec().journey.currentStage).toBe('fabricate')
    expect(isReleased(rec())).toBe(true)
    recordOrder(db, { number: 'JLC-1', paid: 120, ship_date: '2026-11-20' }, signer)
    const a = rec().signatures.filter((x) => x.revision === 'A')
    expect(applyChange(db, 'architect', 'Architecture B was chosen after the architecture review', ADMIN.label)).toEqual({ stage: 'architect', revision: 'B' })
    const r = rec()
    expect(r.journey).toMatchObject({ revision: 'B', currentStage: 'architect' })
    expect(isReleased(r)).toBe(false)
    // revision A's record is untouched: its signatures and its order
    expect(r.signatures.filter((x) => x.revision === 'A')).toEqual(a)
    expect(loadOrders(db).map((o) => o.revision)).toEqual(['A'])
    // Define carries into B signed, saying so; nothing from Architect on is signed in B
    const b = r.signatures.filter((x) => x.revision === 'B')
    expect(b.map((x) => x.gate)).toEqual(['define'])
    expect(b[0]?.notes).toBe('Carried from revision A: the change starts at Architect.')
    const v = journeyView(r, ADMIN)
    expect(v.revision).toBe('B')
    expect(v.stages.map((s) => s.state).slice(0, 3)).toEqual(['done', 'reopened', 'queued'])
    expect(v.gates.find((g) => g.id === 'define')?.state).toBe('signed')
    expect(v.next.summary).toMatch(/^Revision B starts in Architect: Architecture B was chosen after the architecture review\. Agree the change in Architecture choice\.$/)
    expect(r.decisions[0]?.summary).toBe('Revision B started at Architect: Architecture B was chosen after the architecture review. Revision A stays as released.')
  })

  it('counts as a change only when the architecture decided differs', () => {
    const was: DesignDecision = { id: 'd1', kind: 'architecture.choice', target: 'architecture', choice: 'chosen', detail: { option: 'A' }, by: 'a', byHash: 'h', at: 1, supersededAt: null }
    expect(changesStage({ kind: 'architecture.choice', target: 'architecture', choice: 'chosen', detail: { option: 'A' } }, [was])).toBeNull()
    expect(changesStage({ kind: 'architecture.choice', target: 'architecture', choice: 'chosen', detail: { option: 'B' } }, [was])).toBe('architect')
    expect(changesStage({ kind: 'architecture.criteria', target: 'architecture', choice: 'fixed', detail: { criteria: [] } }, [])).toBe('architect')
  })

  it('names revisions in order', () => {
    expect(['A', 'B', 'Z', 'AZ', 'ZZ'].map(nextRevision)).toEqual(['B', 'C', 'AA', 'BA', 'AAA'])
  })
})

describe('a requirement change after release', () => {
  it('starts the next revision at Define', () => {
    start()
    sign('define', 'architect', 'capture', 'prove', 'layout', 'signoff')
    expect(applyChange(db, 'define', 'requirement R5 was changed after the requirements baseline', 'trace')).toEqual({ stage: 'define', revision: 'B' })
    expect(rec().journey).toMatchObject({ revision: 'B', currentStage: 'define' })
    expect(rec().signatures.filter((x) => x.revision === 'B')).toEqual([])
    expect(journeyView(rec(), ADMIN).next.ref).toEqual({ kind: 'skill', id: 'requirements-review' })
  })
})
