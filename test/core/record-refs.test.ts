/**
 * The record's ids in an agent's words, said as people say them (src/core/record-refs.ts; test-esp32-run2 log R29b,
 * R30, R31). The texts are the run's own: the Implementation specialist's architecture options and an agent question.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { answerLook, plainArchitecture, plainCriterionRefs, plainRecordRefs, runKindsOf, runWords } from '../../src/core/record-refs.js'

const RUNS = new Map([['84ac569329e8472d', 'parts check'], ['c56658a7bd0f4783', 'parts check']])
const look = { run: (id: string) => RUNS.get(id) ?? null, answer: (id: string) => (id === 'aq472364d7dd6243' ? 'you' as const : null) }

describe('run and answer ids', () => {
  it('reads a run as what it is, and drops the id where the words already say it', () => {
    expect(plainRecordRefs('OLED module header. Parts check 84ac569329e8472d: all 12 lines in stock at LCSC/JLCPCB for 10 boards', look))
      .toBe('OLED module header. Parts check: all 12 lines in stock at LCSC/JLCPCB for 10 boards')
    expect(plainRecordRefs('Lowest order estimate of the three (84ac569329e8472d: USD 60.54-89.77 vs 75.05-104.28 for B)', look))
      .toBe('Lowest order estimate of the three (the parts check: USD 60.54-89.77 vs 75.05-104.28 for B)')
    expect(plainRecordRefs('84ac569329e8472d without shipping: USD 60.54-89.77. c56658a7bd0f4783 without shipping: USD 75.05', look))
      .toBe('The parts check without shipping: USD 60.54-89.77. The parts check without shipping: USD 75.05')
    expect(plainRecordRefs('about 180 placements (84ac569329e8472d estimate); run 84ac569329e8472d agrees', look))
      .toBe('about 180 placements (the parts check estimate); the parts check agrees')
  })

  it('reads an answer as the viewer\'s or as the answer, and leaves what it does not know', () => {
    expect(plainRecordRefs('inside the USD 100 of REQ-1db18b, which excludes shipping (answer aq472364d7dd6243)', look))
      .toBe('inside the USD 100 of REQ-1db18b, which excludes shipping (your answer)')
    expect(plainRecordRefs('without shipping (excluded per answer aq472364d7dd6243)', {})).toBe('without shipping (excluded per the answer)')
    // a datasheet's short hash, a run the record does not know, a tool's own name before its run: as they are
    expect(plainRecordRefs('smallest module (13.2 x 16.6 mm, ce6fd419 p3)', look)).toBe('smallest module (13.2 x 16.6 mm, ce6fd419 p3)')
    expect(plainRecordRefs('see 0123456789abcdef', look)).toBe('see 0123456789abcdef')
    expect(plainRecordRefs('bom_check 84ac569329e8472d says so', look)).toBe('bom_check 84ac569329e8472d says so')
  })

  it('knows the runs of a record database by their kind', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, kind TEXT)')
    db.prepare("INSERT INTO runs VALUES ('84ac569329e8472d', 'parts.bom_check'), ('aaaa', 'calc.ldo_thermal'), ('bbbb', 'kicad.board')").run()
    expect(Object.fromEntries(runKindsOf(db))).toEqual({ '84ac569329e8472d': 'parts check', aaaa: 'ldo thermal calculation', bbbb: 'board run' })
    expect(runKindsOf(new DatabaseSync(':memory:')).size).toBe(0)
    expect(runWords('shape.check')).toBe('check')
  })
})

describe('gate criterion ids', () => {
  const criteria = [{ id: 'architect.stock', text: 'Every key part is in stock for the build quantity, or its exception is signed.' }]
  it('says a criterion by its words, wherever an agent named it by its id', () => {
    expect(plainCriterionRefs('The parts check is at risk, so architect.stock is not met.', criteria))
      .toBe('The parts check is at risk, so "every key part is in stock for the build quantity, or its exception is signed" is not met.')
    expect(plainCriterionRefs('It blocks the architect.stock criterion', criteria))
      .toBe('It blocks the criterion "every key part is in stock for the build quantity, or its exception is signed"')
    // not the project's criterion: as it is
    expect(plainCriterionRefs('see case.py and signoff.emc', criteria)).toBe('see case.py and signoff.emc')
  })
})

// test-esp32-run2 R31: Architecture choice's "Read each option" quoted "Parts check 84ac569329e8472d" and "(answer aq472364d7dd6243)"
describe('an architecture as the views show it', () => {
  it('says the runs and answers in each option, score and criterion, and the viewer\'s answer as theirs', () => {
    const a = {
      options: [{ id: 'A', summary: 'Parts check 84ac569329e8472d: all 12 lines in stock (answer aq472364d7dd6243).', why: 'Kept (answer aq472364d7dd6243).', gives_up: null, risks: ['84ac569329e8472d: at risk'] }],
      scores: [{ option: 'A', criterion: 'stock', reason: 'All 12 lines in stock (84ac569329e8472d)' }],
      criteria: [{ id: 'cost', description: 'shipping excluded (answer aq472364d7dd6243)' }], current: 'A',
    }
    const answers = answerLook([{ id: 'aq472364d7dd6243', answeredAt: 1, answeredByHash: 'h-marc' }], 'h-marc')
    const p = plainArchitecture(a, { run: (id) => RUNS.get(id), answer: answers })
    expect(p.options[0]).toMatchObject({ summary: 'Parts check: all 12 lines in stock (your answer).', why: 'Kept (your answer).', gives_up: null, risks: ['The parts check: at risk'] })
    expect(p.scores[0]?.reason).toBe('All 12 lines in stock (the parts check)')
    expect(p.criteria[0]?.description).toBe('shipping excluded (your answer)')
    expect(p.current).toBe('A')
    // someone else's answer
    expect(plainArchitecture(a, { answer: answerLook([{ id: 'aq472364d7dd6243', answeredAt: 1, answeredByHash: 'h-marc' }], 'h-alex') }).options[0]?.why).toBe('Kept (the answer).')
  })
})
