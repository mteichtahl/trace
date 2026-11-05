/**
 * Recommendations are answers (test-esp32 log #137, #139): an option that asks the person to do something is refused
 * unless it says what detail it needs; an option that needs one is answered only with it (the record, the Question
 * answer bar, the inbox); and a recommendation that only just fits a hard limit must say its margin.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentFactsStore, addAgentQuestion, loadAgentFacts } from '../../src/core/agent-facts.js'
import { S3Backend } from '../../src/core/central.js'
import { type AgentFacts, type JourneyRecord, type QuestionRow, type Viewer, answerQuestion, inboxItems, loadJourney, startJourney } from '../../src/core/journey.js'
import { JourneyStore, forgetNoJourney } from '../../src/core/journey-store.js'
import { tightMargins } from '../../src/core/margins.js'
import { type CheckInput, checkSkill } from '../../src/api/skill-checks.js'
import { SPECIALISTS } from '../../src/agents/index.js'
import { composeSpecialist } from '../../src/agents/specialist.js'
import { entry } from '../../src/prompts/catalog.js'
import { cfgOf } from '../harness/fake.js'
import { FakeS3 } from './fake-s3.js'

describe('the specialists are told', () => {
  it('that a recommendation is an answer, and to show every layer and the margin against a hard limit', () => {
    const c = composeSpecialist(SPECIALISTS.impl, { cfg: cfgOf(), repository: 'o/r', job: { kind: 'preview' }, rules: null })
    const part = c.parts.find((p) => p.id === 'specialist.journey.recommend')
    expect(part?.text).toBe(entry('specialist.journey.recommend').default)
    expect(entry('specialist.journey.recommend').mode).toBe('locked')
    expect(part?.text).toMatch(/never a task\s+for the person/)
    expect(part?.text).toMatch(/a module's own board too/)
    expect(part?.text).toMatch(/Under 5 % of the limit, or under 1 mm/)
  })
})

const IMPL = { agent: 'impl', label: 'the Implementation specialist', jobId: 'job-1' }
const CONTRIB: Viewer = { hash: 'h-user', label: 'u@example.com', admin: false, part: 'contributor', sub: 'sub-user-0001' }
const MODULE = 'A 0.96 inch SSD1306 I2C module, 27.3 x 27.3 mm board'
const NEEDS = "the module's part number, or a link to its dimensioned drawing"

async function started() {
  const b = new S3Backend('bucket', 'projects', new FakeS3())
  const journey = new JourneyStore(b, 'acme/board')
  const facts = new AgentFactsStore(b, 'acme/board')
  await journey.update((db) => { startJourney(db, { template: 'board', by: 'a@example.com', name: 'Clock' }); return { result: null } })
  const record = async (): Promise<JourneyRecord> => (await journey.read((db) => loadJourney(db))).result!
  const read = async (): Promise<AgentFacts> => (await facts.read((db) => loadAgentFacts(db))).result
  const ask = async (options: Parameters<typeof addAgentQuestion>[2]['options']) => {
    const r = await record()
    return (await facts.update((db) => ({ result: addAgentQuestion(db, IMPL, { text: 'Which OLED module should the case be shaped around?', blocks: 'the case design', options }, r) }))).result
  }
  return { journey, record, read, ask }
}

describe('an option is an answer, not a task for the person', () => {
  beforeEach(() => forgetNoJourney())

  it('refuses an option that asks the person to supply something, unless it says what it needs', async () => {
    const s = await started()
    // the run's recommendation, word for word
    await expect(s.ask([
      { id: 'a', label: 'Name the 0.96 inch SSD1306 I2C module to buy (MPN or link with a dimensioned drawing)', recommended: true, why: 'the case is shaped around its board' },
      { id: 'b', label: 'Shape it around a 1.3 inch module', why: 'if a bigger display is wanted' },
    ])).rejects.toThrow(/Option a \("Name the 0\.96 inch.*asks the person to do something.*needs/)
    // an alternative that asks is refused as well
    await expect(s.ask([
      { id: 'a', label: MODULE, recommended: true, why: 'the common module for the SSD1306' },
      { id: 'b', label: 'Measure the module you have', why: 'if you already bought one' },
    ])).rejects.toThrow(/Option b/)
    // the answer, with the detail it needs from the person
    const id = await s.ask([
      { id: 'a', label: MODULE, recommended: true, why: 'the common module for the SSD1306', needs: NEEDS },
      { id: 'b', label: 'A bare 0.96 inch panel on the main board', why: 'if no module is bought' },
    ])
    expect((await s.read()).questions.find((q) => q.id === id)?.options[0]).toMatchObject({ id: 'a', needs: NEEDS })
  })

  it('is answered only with the detail it needs, and the answer carries it', async () => {
    const s = await started()
    const id = await s.ask([
      { id: 'a', label: MODULE, recommended: true, why: 'the common module for the SSD1306', needs: NEEDS },
      { id: 'b', label: 'A bare 0.96 inch panel on the main board', why: 'if no module is bought' },
    ])
    const f = await s.read()
    const answer = (a: { option: string; answer?: string }) => s.journey.update((db) => ({ result: answerQuestion(db, id, { hash: CONTRIB.hash, label: CONTRIB.label }, { ...a, lasts: 'once' }, { facts: f }) }))
    await expect(answer({ option: 'a' })).rejects.toThrow(/needs the module's part number, or a link to its dimensioned drawing: give it with the answer/)
    await expect(answer({ option: 'a', answer: 'n/a' })).rejects.toThrow(/give it with the answer/)
    const done = await answer({ option: 'a', answer: 'generic GND-VCC-SCL-SDA module, 27.3 x 27.3 mm, active area 21.74 x 10.86 mm' })
    expect(done.result.answered?.answer).toBe(`${MODULE}: generic GND-VCC-SCL-SDA module, 27.3 x 27.3 mm, active area 21.74 x 10.86 mm`)
  })

  it('gets no one-tap answer in the inbox: the person gives the detail in Question answer', async () => {
    const s = await started()
    await s.ask([
      { id: 'a', label: MODULE, recommended: true, why: 'the common module for the SSD1306', needs: NEEDS },
      { id: 'b', label: 'A bare 0.96 inch panel on the main board', why: 'if no module is bought' },
    ])
    const [item] = inboxItems('acme/board', await s.record(), CONTRIB, undefined, await s.read())
    expect(item).toMatchObject({ kind: 'question', action: 'Answer' })
    expect(item?.summary).toContain(`It recommends ${MODULE}.`)
    expect(item).not.toHaveProperty('recommended')
  })

  it('does not meet "The answer resolves what it blocks" until the detail is given', () => {
    const question = {
      id: 'q1', options: [{ id: 'a', label: MODULE, recommended: true, why: 'w', needs: NEEDS }, { id: 'b', label: 'A bare panel', recommended: false, why: 'w' }],
    } as unknown as QuestionRow
    const resolves = (draft: Record<string, unknown>) => checkSkill('question-answer', {
      r: null, viewer: { admin: false } as CheckInput['viewer'], requirements: [], struck: [], erc: null, drc: null, bom: null, board: null, placement: null,
      instruments: [], orders: [], tests: [], gate: null, question, draft,
    })?.find((c) => c.id === 'resolves')
    expect(resolves({ option: 'a', lasts: 'once' })).toMatchObject({ status: 'not_met', detail: expect.stringContaining(NEEDS) })
    expect(resolves({ option: 'a', detail: 'n/a', lasts: 'once' })?.status).toBe('not_met')
    expect(resolves({ option: 'a', detail: 'ER-OLEDM0.96-1, drawing on page 3', lasts: 'once' })?.status).toBe('met')
    // an option that needs nothing resolves as before
    expect(resolves({ option: 'b', lasts: 'once' })?.status).toBe('met')
  })
})

describe('a recommendation close to a hard limit says so', () => {
  beforeEach(() => forgetNoJourney())

  it('reads a quantity set against a limit, in the same unit', () => {
    // the run's recommendation (test-esp32 log #139)
    expect(tightMargins('Move J2 5.5 mm west with a socket of at most 5.5 mm: the stack totals 19.97 mm against the 20 mm height limit.')).toEqual([{ value: 19.97, limit: 20, unit: 'mm' }])
    expect(tightMargins('totals 19.2 mm, under the 20 mm maximum')).toEqual([{ value: 19.2, limit: 20, unit: 'mm' }])
    expect(tightMargins('draws 0.97 A against a limit of 1 A')).toEqual([{ value: 0.97, limit: 1, unit: 'A' }])
    // room enough, a different unit, or no limit named: nothing
    expect(tightMargins('totals 17.5 mm against the 20 mm height limit')).toEqual([])
    expect(tightMargins('totals 19.97 mm against the 20 cm limit')).toEqual([])
    expect(tightMargins('move J2 5.5 mm west, ≤ 5.5 mm socket')).toEqual([])
    // over the limit is not "close": it does not fit, and is a different finding
    expect(tightMargins('totals 21 mm against the 20 mm height limit')).toEqual([])
  })

  it('refuses a recommended option within the margin unless it names the margin', async () => {
    const s = await started()
    const why = 'Board 1.6 mm + module board 1.0 mm + socket 5.5 mm + display 11.87 mm totals 19.97 mm against the 20 mm height limit.'
    await expect(s.ask([
      { id: 'a', label: 'Move J2 5.5 mm west, socket at most 5.5 mm', recommended: true, why },
      { id: 'b', label: 'Mount the module on the lid, 4-wire cable to J2', why: 'no re-layout' },
    ])).rejects.toThrow(/Option a comes to 19\.97 mm against a 20 mm limit: 0\.03 mm of margin\. Add it up again from every layer/)
    // said plainly, it may still be offered (a person can weigh it)
    await expect(s.ask([
      { id: 'a', label: 'Move J2 5.5 mm west, socket at most 5.5 mm', recommended: true, why: `${why} Only 0.03 mm of margin: too close to rely on.` },
      { id: 'b', label: 'Mount the module on the lid, 4-wire cable to J2', why: 'no re-layout' },
    ])).resolves.toMatch(/^aq/)
    // an alternative is not held to it: only what trace recommends
    await expect(s.ask([
      { id: 'b', label: 'Mount the module on the lid, 4-wire cable to J2', recommended: true, why: 'no re-layout, 6 mm of room' },
      { id: 'a', label: 'Move J2 5.5 mm west, socket at most 5.5 mm', why },
    ])).resolves.toMatch(/^aq/)
  })
})
