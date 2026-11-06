/**
 * Withdrawing a waiver and taking it again (test-esp32 #149): a waiver taken by mistake (the wrong severity, a reason
 * with the risk pasted into it) could not be corrected or withdrawn. Its author or an admin withdraws it with a reason
 * kept in the record, or takes it again, which records the new one and withdraws the old; what it waived counts again;
 * a waiver a signed gate stands on stays until that stage is reopened.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type JourneyRecord, type Viewer, addWaiver, answerQuestion, askQuestion, gateView, journeyView, loadJourney, recordOpen, returnGate, setCriterion, signBlockers, signGate,
  startJourney, withdrawWaiver,
} from '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'

const ADMIN: Viewer = { hash: 'a'.repeat(16), label: 'admin@example.com', admin: true, part: 'contributor' }
const USER: Viewer = { hash: 'u'.repeat(16), label: 'user@example.com', admin: false, part: 'contributor' }
const OTHER: Viewer = { hash: 'o'.repeat(16), label: 'other@example.com', admin: false, part: 'contributor' }
const as = (v: Viewer) => ({ hash: v.hash, label: v.label, admin: v.admin })

let db: DatabaseSync
const rec = (): JourneyRecord => loadJourney(db) as JourneyRecord
const meetAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'trace') }
const openAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) recordOpen(db, { criterion: c.id }, ADMIN.hash) }
const base = { target: { kind: 'criterion' as const, id: 'define.measurable' }, reason: 'The range test needs the bench. Risk: a short range.', risk: 'Range could fall short.', severity: 'safety' as const, caught_where: 'Bring up', scope: 'this revision only' }
const status = (v: Viewer = USER) => gateView(rec(), 'define', v).criteria.find((c) => c.id === 'define.measurable')?.status

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-withdraw-'))
  mkdirSync(join(dir, '.git'))
  db = openProject(dir)
  startJourney(db, { template: 'board', by: ADMIN.label })
})

describe('withdrawing a waiver', () => {
  it('its author withdraws it with a reason kept in the record, and the criterion is not met again', () => {
    const w = addWaiver(db, base, as(USER))
    expect(w).toMatchObject({ may_withdraw: true, withdraw_blocked: null, withdrawn: null })
    expect(status()).toBe('waived')
    // someone else who is not an admin may not, and is told who may
    expect(journeyView(rec(), OTHER).waivers[0]).toMatchObject({ may_withdraw: false, withdraw_blocked: 'Only user@example.com, who took it, or an admin can withdraw this waiver.' })
    expect(() => withdrawWaiver(db, w.id, as(OTHER), 'I took it by mistake.')).toThrow(/Only user@example.com/)
    // a reason that says nothing is refused, and nothing changes
    expect(() => withdrawWaiver(db, w.id, as(USER), 'no')).toThrow(/why the waiver is withdrawn/)
    expect(rec().waivers[0]?.closedAt).toBeNull()
    const out = withdrawWaiver(db, w.id, as(USER), 'Rated safety by mistake; I meant failure.')
    expect(out).toMatchObject({ closed: true, may_withdraw: false, withdrawn: { by: USER.label, reason: 'Rated safety by mistake; I meant failure.', replaced_by: null } })
    expect(status()).toBe('not_met')
    expect(signBlockers(rec(), 'define', ADMIN).join(' ')).toMatch(/not met or waived: .*every requirement has a criterion that can be measured/)
    // the record keeps it: the waiver, closed, and the withdrawal with its reason
    expect(rec().waivers).toHaveLength(1)
    expect(rec().decisions[0]).toMatchObject({ kind: 'waiver.withdrawn', ref: w.id, by: USER.label, detail: { reason: 'Rated safety by mistake; I meant failure.', replaced_by: null } })
    expect(() => withdrawWaiver(db, w.id, as(USER), 'Again, to be sure.')).toThrow(/already withdrawn/)
    // what it waived can be waived again
    expect(addWaiver(db, { ...base, severity: 'failure' }, as(USER))).toMatchObject({ closed: false, severity: 'failure' })
    expect(status()).toBe('waived')
  })

  it('an admin may withdraw anyone\'s', () => {
    const w = addWaiver(db, base, as(USER))
    expect(journeyView(rec(), ADMIN).waivers[0]?.may_withdraw).toBe(true)
    expect(withdrawWaiver(db, w.id, as(ADMIN), 'The bench is not ready this revision.').withdrawn?.by).toBe(ADMIN.label)
  })

  it('"Take it again" records the new waiver and withdraws the old in one step; the criterion stays waived', () => {
    const w = addWaiver(db, base, as(USER))
    expect(() => addWaiver(db, { ...base, severity: 'failure' }, as(OTHER), { replaces: w.id })).toThrow(/Only user@example.com/)
    // the new one is held to the same bar; refused, the old one stands
    expect(() => addWaiver(db, { ...base, reason: 'not needed' }, as(USER), { replaces: w.id })).toThrow(/not needed/)
    expect(rec().waivers.filter((x) => x.closedAt === null)).toHaveLength(1)
    const again = addWaiver(db, { ...base, severity: 'failure', reason: 'The range test needs the bench.' }, as(USER), { replaces: w.id })
    expect(again).toMatchObject({ closed: false, severity: 'failure', reason: 'The range test needs the bench.' })
    const old = journeyView(rec(), USER).waivers.find((x) => x.id === w.id)
    expect(old).toMatchObject({ closed: true, withdrawn: { by: USER.label, replaced_by: again.id } })
    expect(status()).toBe('waived')
    expect(rec().decisions.slice(0, 2).map((d) => d.kind).sort()).toEqual(['waiver.added', 'waiver.withdrawn'])
  })

  // round 2's #299: an answer that waives records the waivers in the person's name; they withdraw the same way
  it('a waiver recorded from an answer is withdrawn by the person who answered, like any other', () => {
    for (const g of ['define', 'architect', 'capture', 'prove']) { meetAll(g); openAll(g); signGate(db, g, { hash: ADMIN.hash, label: ADMIN.label }) }
    const finding = 'layout.fit@urn:trace:case-finding:J1'
    const q = askQuestion(db, { askedBy: 'the Implementation specialist', text: 'Waive the J1 clash?', blocks: 'layout.fit', options: [
      { id: 'waive', label: 'Waive the J1 finding', recommended: true, why: 'The connector overhang is intended.', waives: { targets: [{ kind: 'finding', id: finding }], risk: 'The plug may not seat.', severity: 'safety', caught_where: 'Bring up: plug it in', scope: 'this revision only' } },
    ] })
    const [id] = answerQuestion(db, q, { hash: USER.hash, label: USER.label }, { option: 'waive' }).waivers ?? []
    expect(journeyView(rec(), USER).waivers.find((w) => w.id === id)).toMatchObject({ by: USER.label, may_withdraw: true })
    withdrawWaiver(db, id as string, as(USER), 'Rated safety by mistake; it is a failure at worst.')
    // the finding is no longer waived anywhere the record is read
    expect(rec().waivers.some((w) => w.target === finding && w.closedAt === null)).toBe(false)
  })

  it('a waiver a signed gate stands on stays until that stage is reopened, and says so', () => {
    const w = addWaiver(db, base, as(USER))
    meetAll('define'); setCriterion(db, 'define.measurable', 'not_met', [], 'trace')
    openAll('define'); recordOpen(db, { waiver: w.id }, ADMIN.hash)
    signGate(db, 'define', { hash: ADMIN.hash, label: ADMIN.label }, { acknowledged: [w.id] })
    const blocked = 'The requirements baseline gate was signed by admin@example.com with this waiver acknowledged, so the signature stands on it. To withdraw it, an admin reopens Define first (return the current gate and reopen Define); the requirements baseline gate is then signed again without it.'
    expect(journeyView(rec(), ADMIN).waivers[0]).toMatchObject({ may_withdraw: false, withdraw_blocked: blocked })
    expect(() => withdrawWaiver(db, w.id, as(ADMIN), 'Rated safety by mistake.')).toThrow(blocked)
    expect(() => addWaiver(db, { ...base, severity: 'failure' }, as(USER), { replaces: w.id })).toThrow(/signature stands on it/)
    // reopened, the signature no longer counts: the waiver can be withdrawn, and the gate is signed again without it
    returnGate(db, 'architect', { hash: ADMIN.hash, label: ADMIN.label }, { reason: 'A waiver at Define was rated wrongly.', reopen: 'define' })
    expect(withdrawWaiver(db, w.id, as(USER), 'Rated safety by mistake.').closed).toBe(true)
    expect(status()).toBe('not_met')
  })
})
