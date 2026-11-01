/**
 * The journey view's guided-flow additions (docs/guided-flow.md "Journey view additions"): every stage's guide, with
 * a template's own words where it differs; each stage's steps with their owners; the now and next steps; the next
 * step's place ("Step 3 of 5") and what happens after it; and the open changes merged in (withChanges), with a ready
 * change becoming the next step to review.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type JourneyRecord, type OpenChange, STAGE_IDS, TEMPLATES, type Viewer, askQuestion, journeyView, loadJourney, nextStep, recordOpen, setCriterion, signGate,
  startJourney, withChanges,
} from '../../src/core/journey.js'
import { stageGuideText } from '../../src/core/stage-guides.js'
import { openProject } from '../../src/core/store.js'

const ADMIN: Viewer = { hash: 'a'.repeat(16), label: 'admin@example.com', admin: true, part: 'contributor' }
const USER: Viewer = { hash: 'u'.repeat(16), label: 'user@example.com', admin: false, part: 'contributor' }
const REVIEWER: Viewer = { hash: 'r'.repeat(16), label: 'rev@example.com', admin: false, part: 'reviewer' }
const signer = { hash: ADMIN.hash, label: ADMIN.label }

let db: DatabaseSync
const fresh = (): DatabaseSync => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-guides-'))
  mkdirSync(join(dir, '.git'))
  return openProject(dir)
}
const rec = (): JourneyRecord => loadJourney(db) as JourneyRecord
const meetAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'trace') }
const signAll = (...gates: string[]): void => {
  for (const g of gates) { meetAll(g); for (const c of rec().criteria.filter((x) => x.gate === g)) recordOpen(db, { criterion: c.id }, ADMIN.hash); signGate(db, g, signer) }
}
const ACRONYM = /\b(ERC|DRC|BOM|EMC|MCU|HIL|DFM|DFT|CPL|PR|PCB|RTOS|LDO|SPICE|RAM)\b/
const states = (v: ReturnType<typeof journeyView>, stage: string): string[] => v.stages.find((s) => s.id === stage)?.steps.map((s) => `${s.id}:${s.owner}:${s.state}`) ?? []

describe('stage guides', () => {
  it('every stage has a guide for every template, in plain words', () => {
    for (const t of TEMPLATES) {
      for (const s of STAGE_IDS) {
        const g = stageGuideText(s, t)
        for (const k of ['purpose', 'you_do', 'trace_does', 'you_get', 'typical_time'] as const) {
          expect(g[k].length, `${t} ${s} ${k}`).toBeGreaterThan(5)
          expect(g[k], `${t} ${s} ${k}`).not.toMatch(ACRONYM)
          expect(g[k], `${t} ${s} ${k}`).not.toMatch(/pull request|`/)
        }
      }
    }
  })

  it('a template that does a stage differently gets its own words, the rest falls back', () => {
    expect(stageGuideText('prove', 'firmware').trace_does).toMatch(/unit tests/)
    expect(stageGuideText('prove', 'firmware').trace_does).not.toMatch(/circuit simulation/)
    expect(stageGuideText('prove', 'board').trace_does).toMatch(/circuit simulation/)
    expect(stageGuideText('prove', 'fpga').purpose).toMatch(/timing/)
    expect(stageGuideText('capture', 'firmware')).toEqual(stageGuideText('capture', 'board'))
  })

  it('names what comes next from the project\'s own stages: Firmware goes from Prove to Release, the last has none', () => {
    db = fresh(); startJourney(db, { template: 'firmware', by: 'x' })
    const v = journeyView(rec(), USER)
    expect(v.stages.find((s) => s.id === 'prove')?.guide.next).toMatch(/^Release, to /)
    expect(v.stages.at(-1)?.guide.next).toBeNull()
    db = fresh(); startJourney(db, { template: 'board', by: 'x', later: ['certify', 'sustain'] })
    const b = journeyView(rec(), USER)
    expect(b.stages.find((s) => s.id === 'bringup')?.guide.next).toMatch(/^Certify, to pass the regulatory tests/)
    expect(b.stages.find((s) => s.id === 'sustain')?.guide).toMatchObject({ next: null, purpose: expect.stringMatching(/buildable/) })
  })
})

describe('steps, now, next and after', () => {
  beforeEach(() => { db = fresh(); startJourney(db, { template: 'board', by: ADMIN.label, name: 'Soil sensor' }) })

  it('a fresh journey: the first criterion is now, the next is next, signing is the admins\'', () => {
    const v = journeyView(rec(), USER)
    expect(states(v, 'define')).toEqual(['define.accepted:you:now', 'define.measurable:you:next', 'sign:define:admins:later'])
    expect(v.next).toMatchObject({ kind: 'task', step: { index: 1, total: 3 } })
    expect(v.next.after).toBe('Once it is done, your next step is: every requirement has a criterion that can be measured, with a number and a unit.')
    // a reviewer sees the contributors' steps; an admin signs
    expect(states(journeyView(rec(), REVIEWER), 'define')).toEqual(['define.accepted:contributors:now', 'define.measurable:contributors:next', 'sign:define:admins:later'])
    expect(states(journeyView(rec(), ADMIN), 'define')[2]).toBe('sign:define:you:later')
    // a queued stage has no now
    expect(states(v, 'architect').every((s) => s.endsWith(':later'))).toBe(true)
  })

  it('a ready gate: signing is now, and after it the next stage starts', () => {
    meetAll('define')
    const v = journeyView(rec(), ADMIN)
    expect(states(v, 'define')).toEqual(['define.accepted:you:done', 'define.measurable:you:done', 'sign:define:you:now'])
    expect(v.next).toMatchObject({ kind: 'gate', step: { index: 3, total: 3 } })
    expect(v.next.after).toBe('Once it is signed, Architect starts, to choose how the product is built: its blocks, its key parts, and which block serves each requirement.')
  })

  it('trace working: its criterion is now, and a done stage\'s steps are all done', () => {
    signAll('define')
    setCriterion(db, 'architect.blocks', 'met', [], 'trace')
    const v = journeyView(rec(), USER)
    expect(states(v, 'define').every((s) => s.endsWith(':done'))).toBe(true)
    expect(states(v, 'architect')).toEqual(['architect.blocks:you:done', 'architect.mapped:trace:now', 'architect.stock:trace:next', 'sign:architect:admins:later'])
    expect(v.next).toMatchObject({ kind: 'working', step: { index: 2, total: 4 }, after: 'When trace has done this, trace works on the next criterion: every key part is in stock for the build quantity, or its exception is signed.' })
  })

  it('a blocking question points at no step: nothing is now, the first left is next', () => {
    askQuestion(db, { askedBy: 'the Analog specialist', text: 'Supply range?', blocks: 'the regulator' })
    const v = journeyView(rec(), USER)
    expect(v.next).toMatchObject({ kind: 'answer', step: null })
    expect(states(v, 'define')).toEqual(['define.accepted:you:next', 'define.measurable:you:later', 'sign:define:admins:later'])
    expect(v.next.after).toBe('Once you answer, the agent that asked carries on, and then your next step is: every requirement is accepted or struck.')
  })

  it('waiting on the fab: receiving the boards is now, and the journey\'s end says nothing after', () => {
    signAll('define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'fabricate.order')
    const n = nextStep(rec(), USER)
    expect(n).toMatchObject({ kind: 'waiting_outside', step: { index: 5, total: 7 } })
    expect(n.after).toMatch(/When the boards arrive/)
    signAll('fabricate.received', 'bringup')
    expect(nextStep(rec(), USER)).toMatchObject({ kind: 'done', step: null, after: null })
  })
})

describe('open changes in the journey', () => {
  beforeEach(() => { db = fresh(); startJourney(db, { template: 'board', by: ADMIN.label, name: 'Soil sensor' }) })
  const change = (o: Partial<OpenChange> = {}): OpenChange => ({ number: 7, title: 'the requirements R1-R4', from: 'the Verification specialist', criteria: [], ready: true, recommendation: 'trace recommends accepting it.', ...o })

  it('a ready change overrides a task: the next step is to review it, and its step is now', () => {
    const r = rec()
    const v = withChanges(r, journeyView(r, USER), USER, [change({ criteria: ['define.measurable'] })])
    expect(v.next).toMatchObject({
      kind: 'review', belongs_to: 'you', yours: true, summary: 'trace finished the requirements R1-R4. Review it and accept it into the design.',
      recommendation: 'trace recommends accepting it.', ref: { kind: 'change', id: '7' }, button: 'Review the change', step: { index: 2, total: 4 },
    })
    // placed before the criterion it would satisfy
    expect(states(v, 'define')).toEqual(['define.accepted:you:later', 'change:7:you:now', 'define.measurable:you:next', 'sign:define:admins:later'])
    expect(v.next.after).toBe('Once you accept it, its work counts in the design, and then your next step is: every requirement has a criterion that can be measured, with a number and a unit.')
    // a reviewer reads it; it is the contributors'
    expect(withChanges(r, journeyView(r, REVIEWER), REVIEWER, [change()]).next).toMatchObject({ kind: 'review', belongs_to: 'contributors', yours: false, button: 'Read the change' })
  })

  it('a change not ready (or with no criterion it names) is a step first among those left, and the next step stays', () => {
    const r = rec()
    const v = withChanges(r, journeyView(r, USER), USER, [change({ ready: false })])
    expect(v.next).toMatchObject({ kind: 'task', ref: { kind: 'criterion', id: 'define.accepted' }, step: { index: 2, total: 4 } })
    expect(states(v, 'define')).toEqual(['change:7:you:later', 'define.accepted:you:now', 'define.measurable:you:next', 'sign:define:admins:later'])
  })

  it('a gate ready or a question comes before a change: only a task or trace working gives way', () => {
    meetAll('define')
    let r = rec()
    expect(withChanges(r, journeyView(r, ADMIN), ADMIN, [change()]).next.kind).toBe('gate')
    db = fresh(); startJourney(db, { template: 'board', by: 'x' })
    askQuestion(db, { askedBy: 'agent', text: 'Which?', blocks: 'work' })
    r = rec()
    expect(withChanges(r, journeyView(r, USER), USER, [change()]).next.kind).toBe('answer')
  })

  it('trace working gives way too; a change naming a later stage\'s criterion goes in that stage', () => {
    signAll('define')
    setCriterion(db, 'architect.blocks', 'met', [], 'trace')
    const r = rec()
    const v = withChanges(r, journeyView(r, USER), USER, [change({ number: 9, title: 'the schematic', ready: false, criteria: ['capture.erc'] }), change({ number: 8, title: 'the block diagram' })])
    expect(v.next).toMatchObject({ kind: 'review', ref: { kind: 'change', id: '8' } })
    expect(states(v, 'capture')[0]).toBe('change:9:you:later')
    expect(states(v, 'architect')).toEqual(['architect.blocks:you:done', 'change:8:you:now', 'architect.mapped:trace:next', 'architect.stock:trace:later', 'sign:architect:admins:later'])
    // nothing open: the view is as it was
    expect(withChanges(r, journeyView(r, USER), USER, [])).toEqual(journeyView(r, USER))
  })
})
