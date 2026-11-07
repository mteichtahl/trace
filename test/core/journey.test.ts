import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type JourneyRecord, type Viewer, addWaiver, answerQuestion, askQuestion, gateView, inboxItems, journeyView, loadJourney, nextStep, recordOpen,
  returnGate, setCriterion, signBlockers, signGate, sortInbox, startJourney, templateStages, applyJourneySchema, copyJourneyTables, getDraft, loadOrders, putDraft,
  recordOrder, dismissStuck, JOURNEY_TABLES, updateAbout, buildChanges, reviewWaitsOn,
} from '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'
import { merge } from '../../src/core/dbmerge.js'

const ADMIN: Viewer = { hash: 'a'.repeat(16), label: 'admin@example.com', admin: true, part: 'contributor' }
const USER: Viewer = { hash: 'u'.repeat(16), label: 'user@example.com', admin: false, part: 'contributor' }
const REVIEWER: Viewer = { hash: 'r'.repeat(16), label: 'rev@example.com', admin: false, part: 'reviewer' }
const signer = { hash: ADMIN.hash, label: ADMIN.label }

let db: DatabaseSync
const fresh = (): DatabaseSync => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-journey-'))
  mkdirSync(join(dir, '.git'))  // the folder is the project's root, never a database above it
  return openProject(dir)
}
const rec = (): JourneyRecord => loadJourney(db) as JourneyRecord
const meetAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'trace') }
const openAll = (gate: string, who = ADMIN.hash): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) recordOpen(db, { criterion: c.id }, who) }

const ACRONYM = /\b(ERC|DRC|BOM|EMC|MCU|HIL|DFM|DFT|CPL|PR|PCB|RTOS|LDO)\b/

describe('templates', () => {
  it('keep only the stages each needs, with optional later stages after', () => {
    const ids = (t: Parameters<typeof templateStages>[0], later: Parameters<typeof templateStages>[1] = []) => templateStages(t, later).map((s) => s.id)
    expect(ids('board')).toEqual(['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup'])
    expect(ids('mixed')).toEqual(ids('board'))
    expect(ids('fpga')).toEqual(['define', 'architect', 'prove', 'signoff', 'release', 'fabricate', 'bringup'])
    expect(ids('firmware')).toEqual(['define', 'architect', 'prove', 'release', 'bringup'])
    expect(ids('board', ['sustain', 'certify'])).toEqual([...ids('board'), 'certify', 'sustain'])
  })

  it('add the firmware track to the gates for Firmware and Mixed only', () => {
    const crit = (t: Parameters<typeof templateStages>[0]) => templateStages(t).flatMap((s) => s.gates.flatMap((g) => g.criteria.map((c) => c.id)))
    expect(crit('board')).not.toContain('prove.firmware')
    expect(crit('mixed')).toEqual(expect.arrayContaining(['define.firmware', 'architect.peripherals', 'capture.alternates', 'prove.firmware', 'prove.size', 'prove.logic', 'layout.pins', 'fabricate.received.firmware', 'bringup.firmware']))
    expect(crit('firmware')).toEqual(expect.arrayContaining(['define.firmware', 'prove.firmware', 'prove.size', 'bringup.package']))
    expect(crit('firmware')).not.toContain('architect.stock')
    expect(crit('fpga')).toContain('prove.logic')
  })

  it('give Fabricate two gates and Release none, and speak plainly', () => {
    const fab = templateStages('board').find((s) => s.id === 'fabricate')
    expect(fab?.gates.map((g) => g.name)).toEqual(['order approval', 'boards received'])
    expect(templateStages('board').find((s) => s.id === 'release')?.gates).toEqual([])
    for (const t of ['board', 'fpga', 'firmware', 'mixed'] as const) {
      for (const g of templateStages(t, ['certify', 'produce', 'sustain']).flatMap((s) => s.gates)) {
        for (const c of g.criteria) expect(`${c.text} ${c.evidence}`).not.toMatch(ACRONYM)
      }
    }
  })
})

describe('the journey record', () => {
  beforeEach(() => { db = fresh(); startJourney(db, { template: 'board', by: ADMIN.label, name: 'Soil sensor' }) })

  it('starts at Define, everything else queued, and refuses a second start', () => {
    const v = journeyView(rec(), ADMIN)
    expect(v.current_stage).toBe('define')
    expect(v.revision).toBe('A')
    expect(v.stages.map((s) => s.state)).toEqual(['current', ...Array(8).fill('queued')])
    expect(v.stages[0]?.progress).toBe('Define · 0 of 2 criteria met')
    expect(v.stages[1]?.progress).toBe('Queued: starts when the requirements baseline gate is signed')
    expect(v.decisions[0]?.summary).toMatch(/Board template, at Define/)
    expect(() => startJourney(db, { template: 'fpga', by: 'x' })).toThrow(/already has a journey/)
  })

  it('names the one next step: a person\'s task first, for a contributor; reading form for a reviewer', () => {
    const n = nextStep(rec(), USER)
    expect(n).toMatchObject({ kind: 'task', belongs_to: 'you', yours: true, button: 'Continue', ref: { kind: 'criterion', id: 'define.accepted' } })
    expect(n.summary).toBe('Define: Every requirement is accepted or struck.')
    expect(nextStep(rec(), REVIEWER)).toMatchObject({ kind: 'task', belongs_to: 'contributors', yours: false, button: 'Read the stage' })
    setCriterion(db, 'define.accepted', 'met', [], 'trace')
    setCriterion(db, 'define.measurable', 'met', [], 'trace')
    expect(nextStep(rec(), ADMIN)).toMatchObject({ kind: 'gate', belongs_to: 'you', button: 'Review and sign', recommendation: 'trace recommends signing.' })
    expect(nextStep(rec(), ADMIN).summary).toBe('The requirements baseline gate is ready. All 2 criteria met. trace recommends signing.')
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'gate', belongs_to: 'admins', yours: false, button: 'Read the evidence' })
  })

  it('says when trace is working on a criterion of its own', () => {
    meetAll('define'); openAll('define'); signGate(db, 'define', signer)
    setCriterion(db, 'architect.blocks', 'met', [], 'trace')
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'working', belongs_to: 'trace', button: 'Watch' })
    expect(nextStep(rec(), USER).summary).toBe('trace is working on Architect: every requirement maps to at least one block.')
  })

  it('a person\'s review of trace\'s work waits for that work: Layout says trace is working until the board is routed', () => {
    for (const g of ['define', 'architect', 'capture', 'prove']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    expect(rec().journey.currentStage).toBe('layout')
    // nothing laid out yet: not "approve the renders"
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'working', belongs_to: 'trace', ref: { kind: 'criterion', id: 'layout.routed' } })
    setCriterion(db, 'layout.routed', 'met', [], 'trace')
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'working', ref: { kind: 'criterion', id: 'layout.drc' } })
    setCriterion(db, 'layout.drc', 'met', [], 'trace')
    // routed and checked: the renders are the person's to approve, though trace still has the lengths and fit to do
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'task', belongs_to: 'you', ref: { kind: 'criterion', id: 'layout.renders' } })
  })

  it('a blocking question comes first, with the recommended answer as its button', () => {
    const q = askQuestion(db, { askedBy: 'the Analog specialist', text: 'What is the sensor\'s supply range?', blocks: 'sizing the regulator', options: [
      { id: 'b', label: '1.8 to 3.6 V', why: 'the widest' }, { id: 'a', label: '2.7 to 3.6 V', recommended: true, why: 'from the datasheet' },
    ] })
    expect(rec().questions[0]?.options[0]?.id).toBe('a')
    const n = nextStep(rec(), USER)
    expect(n).toMatchObject({ kind: 'answer', yours: true, button: 'Use 2.7 to 3.6 V', ref: { kind: 'question', id: q } })
    expect(n.recommendation).toBe('trace recommends 2.7 to 3.6 V: from the datasheet')
    // asked of someone else: waiting on them
    const other = askQuestion(db, { askedBy: 'the router', askedOf: 'someone-else', text: 'Which connector?', blocks: 'routing' })
    db.prepare('UPDATE questions SET asked_at=0 WHERE id=?').run(other)
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'waiting_person', yours: false })
    expect(nextStep(rec(), ADMIN).button).toBe('Answer it for them')
  })

  it('answers need a reason when they differ from the recommendation, and refuse vague words', () => {
    const q = askQuestion(db, { askedBy: 'agent', text: 'Which?', blocks: 'work', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B' }] })
    expect(() => answerQuestion(db, q, signer, { option: 'b' })).toThrow(/Say in a line why you chose otherwise/)
    expect(() => answerQuestion(db, q, signer, { answer: 'it depends', reason: 'meh meh' })).toThrow(/does not unblock/)
    expect(() => answerQuestion(db, q, signer, { option: 'zz' })).toThrow(/"zz" is not one of this question's options/)
    const v = answerQuestion(db, q, signer, { option: 'b', reason: 'B is in stock' })
    expect(v.answered).toMatchObject({ answer: 'B', option_id: 'b', reason: 'B is in stock', by: ADMIN.label })
    expect(() => answerQuestion(db, q, signer, { option: 'a' })).toThrow(/already answered/)
    expect(rec().decisions[0]?.summary).toMatch(/not the recommended A, because B is in stock/)
  })

  it('answering "Approve …" to a question that names a person\'s criterion meets it, with the question as evidence', () => {
    for (const g of ['define', 'architect', 'capture', 'prove']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    const renders = (): string | undefined => rec().criteria.find((c) => c.id === 'layout.renders')?.status
    // a criterion trace owns is never met this way, nor one another stage owns, nor by an answer that does not approve
    const declined = askQuestion(db, { askedBy: 'the Implementation specialist', text: 'Do you approve the board renders (layout.renders)?', blocks: 'layout.renders', options: [
      { id: 'a', label: 'Approve the renders', recommended: true }, { id: 'b', label: 'Re-render first with a J1 3D model' },
    ], sources: [{ kind: 'run', ref: 'render-1' }] })
    answerQuestion(db, declined, signer, { option: 'b', reason: 'the connector should show' })
    expect(renders()).toBe('not_met')
    const q = askQuestion(db, { askedBy: 'the Implementation specialist', text: 'Do you approve the board renders for layout.renders? Also mentions layout.routed and define.accepted.', blocks: 'layout.renders', options: [
      { id: 'a', label: 'Approve the renders', recommended: true }, { id: 'b', label: 'Send back with changes' },
    ], sources: [{ kind: 'run', ref: 'render-2' }] })
    answerQuestion(db, q, signer, { option: 'a' })
    const c = rec().criteria.find((x) => x.id === 'layout.renders')
    expect(c).toMatchObject({ status: 'met', checkedBy: ADMIN.label })
    expect(c?.evidence).toEqual([{ kind: 'question', ref: q, label: `Approve the renders, answered by ${ADMIN.label}` }, { kind: 'run', ref: 'render-2' }])
    expect(rec().criteria.find((x) => x.id === 'layout.routed')?.status).toBe('not_met')
    expect(rec().decisions.some((d) => d.kind === 'criterion.approved' && d.ref === 'layout.renders')).toBe(true)
  })

  it('the release report review waits on coverage, interference, the parts list and the documents, met or waived', () => {
    const waits = (): string[] => reviewWaitsOn(rec(), 'signoff.report').map((c) => c.id)
    expect(waits()).toEqual(['signoff.coverage', 'signoff.emc', 'signoff.bom', 'signoff.docs'])
    setCriterion(db, 'signoff.coverage', 'met', [], 'trace')
    setCriterion(db, 'signoff.bom', 'met', [], 'trace')
    setCriterion(db, 'signoff.docs', 'met', [], 'trace')
    expect(waits()).toEqual(['signoff.emc'])
    addWaiver(db, { target: { kind: 'criterion', id: 'signoff.emc' }, reason: 'A bench board with no radio target.', risk: 'Interference is not estimated.', severity: 'cosmetic', caught_where: 'Bring up', scope: 'this revision only' }, signer)
    expect(waits()).toEqual([])
    // a criterion with nothing to review first, or none at all, waits on nothing
    expect(reviewWaitsOn(rec(), 'define.accepted')).toEqual([])
    expect(reviewWaitsOn(rec(), 'nope')).toEqual([])
  })

  it('waivers: reason, risk, severity and scope; safety must be caught somewhere', () => {
    const base = { target: { kind: 'criterion' as const, id: 'define.measurable' }, reason: 'The range test needs the bench.', risk: 'Range could fall short.', severity: 'degraded' as const, caught_where: 'Bring up', scope: 'this revision only' }
    expect(() => addWaiver(db, { ...base, reason: 'not needed' }, signer)).toThrow(/not needed/)
    expect(() => addWaiver(db, { ...base, severity: 'safety', caught_where: null }, signer)).toThrow(/safety/)
    expect(() => addWaiver(db, { ...base, target: { kind: 'criterion', id: 'nope' } }, signer)).toThrow(/no criterion/)
    const w = addWaiver(db, base, signer)
    expect(w).toMatchObject({ stage: 'define', gate: 'define', severity: 'degraded', acknowledged: null })
    expect(gateView(rec(), 'define', ADMIN).criteria.find((c) => c.id === 'define.measurable')?.status).toBe('waived')
    expect(() => addWaiver(db, base, signer)).toThrow(/already waived/)
  })

  // test-esp32 #142: the answer "Waive the Q1, R4, R5 findings" was not a waiver, and the person had nowhere to take one
  it('an answer choosing an option that waives records the waivers in the person\'s name, with its reason, risk and severity', () => {
    for (const g of ['define', 'architect', 'capture', 'prove']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    const found = ['Q1', 'R4', 'R5'].map((r) => `layout.fit@urn:trace:case-finding:${r}`)
    const waives = { targets: found.map((id) => ({ kind: 'finding' as const, id })), risk: 'A part under the window could touch the display glass.', severity: 'cosmetic' as const, caught_where: 'Bring up: fit the lid', scope: 'this revision only' }
    const ask = (): string => askQuestion(db, { askedBy: 'the Implementation specialist', text: 'Three parts sit under the display window with nothing covering them from above (layout.fit). Waive them or model the module glass?', blocks: 'layout.fit', options: [
      { id: 'waive', label: 'Waive the Q1, R4, R5 findings', recommended: true, why: 'The module glass covers the window; the fit engine does not model it.', waives },
      { id: 'model', label: 'Model the module under the lid in case.py', why: 'Measured, not waived, but a longer job.' },
    ] })
    // another option records nothing
    answerQuestion(db, ask(), signer, { option: 'model', reason: 'measure it instead' })
    expect(rec().waivers).toEqual([])
    // the recommendation chosen with no reason of the person's: the option's why is the reason
    const q = ask()
    const v = answerQuestion(db, q, signer, { option: 'waive' })
    expect(v.waivers).toHaveLength(3)
    expect(rec().waivers.map((w) => ({ kind: w.targetKind, target: w.target, by: w.by, severity: w.severity, stage: w.stage }))).toEqual(found.map((target) => ({ kind: 'finding', target, by: ADMIN.label, severity: 'cosmetic', stage: 'layout' })))
    expect(rec().waivers[0]).toMatchObject({ reason: 'The module glass covers the window; the fit engine does not model it.', risk: waives.risk, caughtWhere: 'Bring up: fit the lid', scope: 'this revision only' })
    const logged = rec().decisions.filter((d) => d.kind === 'waiver.added')
    expect(logged).toHaveLength(3)
    expect(logged[0]?.summary).toMatch(new RegExp(`in answer to question ${q}`))
    // the gate lists them for the signer to acknowledge, as any waiver of the stage
    expect(gateView(rec(), 'layout', ADMIN).waivers).toHaveLength(3)
    // asked again: a finding already waived is not waived twice; the person's own reason is kept
    answerQuestion(db, ask(), signer, { option: 'waive', reason: 'The glass sits 1 mm above the parts.' })
    expect(rec().waivers).toHaveLength(3)
  })

  it('an option that waives a criterion records it; a vague reason is refused and the answer is not kept', () => {
    const waives = { targets: [{ kind: 'criterion' as const, id: 'define.measurable' }], risk: 'Range could fall short.', severity: 'degraded' as const, caught_where: 'Bring up', scope: 'this revision only' }
    const q = askQuestion(db, { askedBy: 'the Verification specialist', text: 'Waive define.measurable until the range test on the bench?', blocks: 'define.measurable', options: [
      { id: 'a', label: 'Keep asking for a number', recommended: true, why: 'A number makes it testable.' },
      { id: 'w', label: 'Waive it until bring-up', why: 'ok', waives },
    ] })
    expect(() => answerQuestion(db, q, signer, { option: 'w', reason: 'bench' })).toThrow(/records a waiver in your name/)
    expect(rec().questions.find((x) => x.id === q)?.answeredAt).toBeNull()
    expect(rec().waivers).toEqual([])
    const v = answerQuestion(db, q, signer, { option: 'w', reason: 'The range test needs the bench.' })
    expect(v.waivers).toHaveLength(1)
    expect(gateView(rec(), 'define', ADMIN).criteria.find((c) => c.id === 'define.measurable')?.status).toBe('waived')
  })
})

describe('signing a gate', () => {
  beforeEach(() => { db = fresh(); startJourney(db, { template: 'board', by: ADMIN.label }) })

  it('needs every criterion met or waived, every piece of evidence opened by the signer, and waivers acknowledged', () => {
    setCriterion(db, 'define.accepted', 'met', [{ kind: 'record', ref: 'requirements' }], 'trace')
    expect(signBlockers(rec(), 'define', ADMIN)).toEqual([
      '1 criterion is not met or waived: every requirement has a criterion that can be measured, with a number and a unit.',
      'Open the evidence for 2 more criteria.',
    ])
    const w = addWaiver(db, { target: { kind: 'criterion', id: 'define.measurable' }, reason: 'Checked on the bench later.', risk: 'A vague limit.', severity: 'cosmetic', caught_where: 'Bring up', scope: 'this revision only' }, signer)
    openAll('define')
    expect(signBlockers(rec(), 'define', ADMIN)).toEqual(['Open 1 waiver taken in this stage.', 'Acknowledge 1 waiver taken in this stage.'])
    // someone else's opens do not count
    recordOpen(db, { waiver: w.id }, USER.hash)
    expect(signBlockers(rec(), 'define', ADMIN)).toContain('Open 1 waiver taken in this stage.')
    recordOpen(db, { waiver: w.id }, ADMIN.hash)
    expect(signBlockers(rec(), 'define', ADMIN)).toEqual(['Acknowledge 1 waiver taken in this stage.'])
    expect(signBlockers(rec(), 'define', ADMIN, [w.id])).toEqual([])
    expect(signBlockers(rec(), 'define', { ...USER, hash: ADMIN.hash })).toEqual(['Only an admin can sign a gate.', 'Acknowledge 1 waiver taken in this stage.'])
    expect(() => signGate(db, 'define', signer)).toThrow(/Acknowledge 1 waiver/)
    const r = signGate(db, 'define', signer, { acknowledged: [w.id], notes: 'fine' })
    expect(r).toMatchObject({ advanced_to: 'architect', summary: 'Gate signed. Architect started.' })
    expect(r.gate).toMatchObject({ state: 'signed', signature: { by: ADMIN.label, notes: 'fine' } })
    expect(rec().waivers[0]?.acknowledgedBy).toBe(ADMIN.label)
    expect(() => signGate(db, 'define', signer)).toThrow(/not in the current stage|already signed/)
    const v = journeyView(rec(), ADMIN)
    expect(v.stages.slice(0, 2).map((s) => s.state)).toEqual(['done', 'current'])
  })

  it('passes Release with Sign-off, signs Fabricate\'s two gates in order, and finishes at Bring up', () => {
    for (const g of ['define', 'architect', 'capture', 'prove', 'layout']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    meetAll('signoff'); openAll('signoff')
    expect(signGate(db, 'signoff', signer)).toMatchObject({ advanced_to: 'fabricate', released: true })
    expect(journeyView(rec(), ADMIN).stages.find((s) => s.id === 'release')?.state).toBe('done')
    meetAll('fabricate.received'); openAll('fabricate.received')
    expect(signBlockers(rec(), 'fabricate.received', ADMIN)).toContain('Sign the order approval gate first.')
    meetAll('fabricate.order'); openAll('fabricate.order')
    expect(signGate(db, 'fabricate.order', signer)).toMatchObject({ advanced_to: null, released: false })
    expect(signGate(db, 'fabricate.received', signer).advanced_to).toBe('bringup')
    meetAll('bringup'); openAll('bringup'); signGate(db, 'bringup', signer)
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'done', summary: 'Revision A is accepted.' })
  })

  it('waits on the maker once the order is signed', () => {
    for (const g of ['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'fabricate.order']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'waiting_outside', belongs_to: 'outside', summary: 'Waiting for JLCPCB to make and ship the boards.', button: 'Check now' })
  })

  it('a return names what must change; reopening an earlier stage supersedes later signatures', () => {
    for (const g of ['define', 'architect', 'capture']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    expect(() => returnGate(db, 'prove', { hash: USER.hash, label: USER.label }, { reason: 'no' })).toThrow(/Say what has to change/)
    expect(() => returnGate(db, 'define', { hash: USER.hash, label: USER.label }, { reason: 'something changed here' })).toThrow(/current stage/)
    const r = returnGate(db, 'prove', { hash: USER.hash, label: USER.label }, { reason: 'The regulator misses its spec at a corner.', reopen: 'capture' })
    expect(r.reopened).toBe('capture')
    const v = journeyView(rec(), USER)
    expect(v.current_stage).toBe('capture')
    expect(v.stages.find((s) => s.id === 'capture')).toMatchObject({ state: 'reopened', reopened: { reason: 'The regulator misses its spec at a corner.' } })
    expect(v.gates.find((g) => g.id === 'capture')?.state).not.toBe('signed')
    expect(v.gates.find((g) => g.id === 'define')?.state).toBe('signed')
    expect(rec().decisions.map((d) => d.kind).slice(0, 2)).toEqual(['stage.reopened', 'gate.returned'])
    // nothing met again yet: the next step says what failed
    db.prepare("UPDATE gate_criteria SET status='not_met' WHERE gate='capture'").run()
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'failed', button: 'See what failed', summary: 'Capture was reopened: The regulator misses its spec at a corner.' })
  })

  it('Firmware passes Release from Prove into Bring up', () => {
    db = fresh()
    startJourney(db, { template: 'firmware', by: 'x' })
    for (const g of ['define', 'architect']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    meetAll('prove'); openAll('prove')
    expect(signGate(db, 'prove', signer).advanced_to).toBe('bringup')
  })
})

describe('the inbox', () => {
  beforeEach(() => { db = fresh(); startJourney(db, { template: 'board', by: 'x', name: 'Soil sensor', build: { quantity: 10, unit_cost: 18.4 } }) })

  it('gates go to admins, questions to whom they were asked (or the contributors), most blocking and oldest first', () => {
    meetAll('define')
    const q = askQuestion(db, { askedBy: 'the Analog specialist', text: 'Supply range?', blocks: 'the regulator', options: [{ id: 'a', label: '2.7 to 3.6 V', recommended: true }] })
    askQuestion(db, { askedBy: 'agent', text: 'A thought, no rush.', options: [] })
    askQuestion(db, { askedBy: 'the router', askedOf: 'someone-else', text: 'Which way?', blocks: 'routing' })
    const stuck = askQuestion(db, { askedBy: 'the router', kind: 'stuck', text: '3 nets cannot fit between U4\'s pins.' })
    db.prepare('UPDATE questions SET asked_at=1 WHERE id=?').run(stuck)
    const admin = sortInbox(inboxItems('acme/board', rec(), ADMIN))
    expect(admin.map((i) => i.kind).sort()).toEqual(['gate', 'question', 'stuck'])
    expect(admin[0]?.kind).toBe('stuck')
    expect(admin.find((i) => i.kind === 'question')).toMatchObject({ ref: { kind: 'question', id: q }, recommended: { id: 'a', label: '2.7 to 3.6 V' }, action: 'Answer' })
    expect(admin.find((i) => i.kind === 'gate')?.summary).toBe('Soil sensor: the requirements baseline gate is ready. All 2 criteria met or waived; trace recommends signing.')
    expect(inboxItems('acme/board', rec(), USER).map((i) => i.kind).sort()).toEqual(['question', 'stuck'])
    expect(inboxItems('acme/board', rec(), REVIEWER)).toEqual([])
    expect(inboxItems('acme/board', rec(), { ...REVIEWER, hash: 'someone-else' }).map((i) => i.summary)).toEqual(['Soil sensor: the router asks: Which way?'])
  })

  it('a dismissed stuck report leaves the inbox and the views; the log keeps it, with the reason', () => {
    const stuck = askQuestion(db, { askedBy: 'the router', kind: 'stuck', text: '3 nets cannot fit between U4\'s pins.', jobId: 'job-3' })
    const q = askQuestion(db, { askedBy: 'the router', text: 'Which way?', blocks: 'routing' })
    expect(inboxItems('acme/board', rec(), USER).map((i) => i.ref.id).sort()).toEqual([q, stuck].sort())
    expect(() => dismissStuck(db, q, signer, 'Not a stuck report at all.')).toThrow(/no stuck report/)
    expect(() => dismissStuck(db, stuck, signer, 'ok')).toThrow(/why it can be dismissed/)
    expect(() => dismissStuck(db, stuck, signer, 'two\nlines')).toThrow(/one line/)
    expect(dismissStuck(db, 'job-3', signer, 'U4 moves to the other side; the router is rerun.')).toMatchObject({ id: stuck, job_id: 'job-3', by: ADMIN.label })
    expect(inboxItems('acme/board', rec(), USER).map((i) => i.ref.id)).toEqual([q])
    expect(journeyView(rec(), USER).questions.map((x) => x.id)).toEqual([q])
    expect(rec().dismissals).toEqual([expect.objectContaining({ stuckId: stuck, reason: 'U4 moves to the other side; the router is rerun.' })])
    expect(rec().decisions[0]).toMatchObject({ kind: 'stuck.dismissed', ref: stuck, summary: expect.stringMatching(/^The router was stuck: .* Dismissed: U4 moves/) })
    expect(() => dismissStuck(db, stuck, signer, 'Again, for the record.')).toThrow(/already dismissed/)
    // the dismissal is part of the record a release copies into the repository
    expect(JOURNEY_TABLES).toContain('stuck_dismissals')
  })

  it('the order gate is money about to be spent', () => {
    for (const g of ['define', 'architect', 'capture', 'prove', 'layout', 'signoff']) { meetAll(g); openAll(g); signGate(db, g, signer) }
    meetAll('fabricate.order')
    const items = inboxItems('acme/board', rec(), ADMIN)
    expect(items).toEqual([expect.objectContaining({ kind: 'spend', action: 'Review order', summary: 'Soil sensor: the order for 10 boards is ready (target US$184, no quote yet). Money is spent when you sign.' })])
  })
})

describe('merging the journey across branches', () => {
  it('keeps the newer row and the union of logs', () => {
    const base = fresh(); startJourney(base, { template: 'board', by: 'x' })
    const dir = mkdtempSync(join(tmpdir(), 'trace-jm-'))
    const ours = join(dir, 'ours.db'); const theirs = join(dir, 'theirs.db'); const b = join(dir, 'base.db')
    base.exec(`VACUUM INTO '${b}'`); base.exec(`VACUUM INTO '${ours}'`); base.exec(`VACUUM INTO '${theirs}'`)
    const th = new DatabaseSync(theirs)
    th.prepare("UPDATE gate_criteria SET status='met', updated=? WHERE id='define.accepted'").run(Date.now() / 1000 + 10)
    th.prepare("INSERT INTO decisions (id, at, kind, summary) VALUES ('d-theirs', 1, 'x', 'theirs')").run()
    th.close()
    expect(merge(b, ours, theirs)).toEqual([])
    const o = new DatabaseSync(ours)
    expect(o.prepare("SELECT status FROM gate_criteria WHERE id='define.accepted'").get()?.status).toBe('met')
    expect(o.prepare("SELECT 1 AS x FROM decisions WHERE id='d-theirs'").get()?.x).toBe(1)
    o.close()
  })
})

describe('orders and drafts', () => {
  it('records an order once per fab number (a second time corrects it), logged in words', () => {
    db = fresh()
    startJourney(db, { template: 'board', by: 'x', build: { quantity: 5, currency: 'EUR', fab: 'JLCPCB' } })
    expect(recordOrder(db, { number: 'Y1-0001', paid: 80, ship_date: '2026-11-04' }, signer)).toMatchObject({ created: true, order: { boards: 5, currency: 'EUR', state: 'placed', revision: 'A' } })
    expect(recordOrder(db, { number: 'Y1-0001', paid: 82.5, ship_date: null }, signer)).toMatchObject({ created: false, order: { paid: 82.5, shipDate: null } })
    expect(loadOrders(db)).toHaveLength(1)
    expect(rec().decisions[0]?.summary).toBe('Order updated with JLCPCB: number Y1-0001, 5 boards, EUR 82.50 paid.')
    expect(() => recordOrder(db, { number: 'Y2', paid: -1, ship_date: null }, signer)).toThrow(/negative/)
    expect(() => recordOrder(db, { number: 'Y2', paid: 1, ship_date: 'Friday' }, signer)).toThrow(/as a date/)
  })

  it('keeps drafts in the store only: a release copy carries the orders and never the drafts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-drafts-'))
    const store = new DatabaseSync(join(dir, 'journey.db'))
    applyJourneySchema(store, { store: true })
    startJourney(store, { template: 'board', by: 'x' })
    recordOrder(store, { number: 'Y9', paid: null, ship_date: null }, signer)
    expect(putDraft(store, 'h'.repeat(16), 'waiver', { step: 2, data: { reason: 'r' } })).toBe(true)
    expect(getDraft(store, 'h'.repeat(16), 'waiver')).toMatchObject({ step: 2, data: { reason: 'r' } })
    expect(getDraft(store, 'o'.repeat(16), 'waiver')).toBeNull()
    expect(() => putDraft(store, 'h'.repeat(16), 'big', { step: 0, data: 'x'.repeat(300_000) })).toThrow(/256 KB/)
    store.close()
    const repo = fresh()
    copyJourneyTables(repo, join(dir, 'journey.db'))
    expect(loadOrders(repo).map((o) => o.number)).toEqual(['Y9'])
    expect(repo.prepare("SELECT 1 AS x FROM sqlite_master WHERE name='skill_drafts'").get()).toBeUndefined()
    const again = new DatabaseSync(join(dir, 'journey.db'))
    expect(putDraft(again, 'h'.repeat(16), 'waiver', null)).toBe(true)
    expect(getDraft(again, 'h'.repeat(16), 'waiver')).toBeNull()
    again.close()
  })
})

describe('changing what a project is (Settings)', () => {
  let db: DatabaseSync
  beforeEach(() => { db = fresh(); startJourney(db, { template: 'board', by: 'x', name: 'Soil sensor', icon: '{"glyph":"board","colour":"blue"}' }) })

  it('changes the name, description, icon and build plan, and logs it', () => {
    const r = updateAbout(db, { name: 'Soil probe', description: 'Reads moisture.', icon: '{"glyph":"sensor","colour":"green"}', build: { quantity: 25, budget: 400 } }, 'Ada')
    expect(r.journey).toMatchObject({ name: 'Soil probe', description: 'Reads moisture.', icon: '{"glyph":"sensor","colour":"green"}' })
    expect(r.journey.build).toMatchObject({ quantity: 25, budget: 400, unit_cost: null, fab: 'JLCPCB' })
    expect(r.decisions[0]).toMatchObject({ kind: 'project.updated', by: 'Ada', summary: expect.stringMatching(/renamed the project to Soil probe/) })
  })

  it('adds a later stage with its gates, and removes one that has not started', () => {
    const on = updateAbout(db, { later: ['certify'] }, 'Ada')
    expect(on.journey.later).toEqual(['certify'])
    expect(on.stages.at(-1)?.id).toBe('certify')
    expect(on.gates.some((g) => g.stage === 'certify')).toBe(true)
    const off = updateAbout(db, { later: [] }, 'Ada')
    expect(off.stages.some((s) => s.id === 'certify')).toBe(false)
    expect(off.gates.some((g) => g.stage === 'certify')).toBe(false)
  })

  it('keeps the build budget and the cloud-work allowance apart, each logged by its own name (test-esp32 run 2, #151, #152)', () => {
    updateAbout(db, { build: { budget: 100 } }, 'Ada')
    // raising the allowance to keep trace working leaves what the build may cost as it is
    const r = updateAbout(db, { build: { cloud_budget: 150 } }, 'Ada')
    expect(r.journey.build).toMatchObject({ budget: 100, cloud_budget: 150 })
    expect(r.decisions[0]!.summary).toBe('Ada set the cloud-work allowance per revision to US$150.')
    const up = updateAbout(db, { build: { budget: 275, quantity: 12 } }, 'Ada')
    expect(up.decisions[0]!.summary).toBe('Ada raised the build budget per revision from US$100 to US$275, changed the build plan.')
    expect(up.journey.build).toMatchObject({ budget: 275, cloud_budget: 150, quantity: 12 })
  })

  it('reads a build plan of before the allowance as having none, never its build budget as one', () => {
    // a project made before: its stored build JSON has one budget and no allowance
    db.prepare("UPDATE journey SET build=? WHERE id='current'").run(JSON.stringify({ quantity: 10, unit_cost: 8, budget: 100, currency: 'USD', fab: 'JLCPCB', hardware: false }))
    expect(loadJourney(db)!.journey.build).toMatchObject({ budget: 100, cloud_budget: null })
    // nothing changed, nothing written: the stored row is left as it was
    const before = loadJourney(db)!.decisions.length
    updateAbout(db, { build: { budget: 100 } }, 'Ada')
    expect(loadJourney(db)!.decisions.length).toBe(before)
    expect(buildChanges(loadJourney(db)!.journey.build, { ...loadJourney(db)!.journey.build, budget: null })).toEqual(['removed the build budget per revision (was US$100)'])
  })

  it('refuses a name too short and writes nothing when nothing changed', () => {
    expect(() => updateAbout(db, { name: 'x' }, 'Ada')).toThrow()
    const before = loadJourney(db)!.decisions.length
    updateAbout(db, { name: 'Soil sensor' }, 'Ada')
    expect(loadJourney(db)!.decisions.length).toBe(before)
  })
})
