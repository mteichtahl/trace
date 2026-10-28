/** Recorded hand-offs between specialists: the quality bar, the guards, the store, answers, declines and the views. */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentFactsStore, applyAgentFactsSchema, loadAgentFacts } from '../../src/core/agent-facts.js'
import { S3Backend } from '../../src/core/central.js'
import {
  type HandoffAsker, HandoffError, type HandoffRequest, addHandoff, answerHandoff, answerProblems, checkRequest, declineHandoff, handoffTitle, handoffViews, loadDeclines,
  loadHandoffs, markFailed, markStarted, nextFor, requestProblems,
} from '../../src/core/handoffs.js'
import { JOURNEY_TABLES, applyJourneySchema, loadJourney, startJourney } from '../../src/core/journey.js'
import { JourneyStore, forgetNoJourney } from '../../src/core/journey-store.js'
import { FakeS3 } from './fake-s3.js'

const THERMAL: HandoffAsker = { agent: 'thermal', label: 'the Thermal specialist', jobId: 'job-t1' }
const GOOD: HandoffRequest = {
  to: 'ams',
  question: 'What is the worst-case dissipation of the LDO U3 at 85 °C ambient with a 500 mA load?',
  evidence: [{ kind: 'run', ref: 'run-42' }, { kind: 'datasheet', ref: 'TPS7A20 sha256:ab12 p.7' }],
  blocks: 'the junction temperature check of U3 across corners',
  recommendation: 'About 0.9 W from the 5 V to 3.3 V drop at 500 mA.',
  acceptance: ['the dissipation in watts at 500 mA and 85 °C, with the run id', 'the input voltage it assumes'],
}
const OPEN = { enabled: ['verify', 'impl', 'ams', 'emc', 'render', 'thermal'] as const, limits: { perJob: 3, perProject: 10 }, declined: new Set<string>() }

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  applyAgentFactsSchema(d)
  return d
}

describe('the quality bar (guard 2)', () => {
  it('passes a request with the question, evidence, what it blocks and acceptance; the recommendation is optional', () => {
    expect(requestProblems(GOOD)).toEqual([])
    expect(requestProblems({ ...GOOD, recommendation: undefined })).toEqual([])
  })

  it('refuses a vague request with everything that is missing, before anything is written', () => {
    const p = requestProblems({ to: 'ams', question: 'LDO?', evidence: [], blocks: 'n/a', acceptance: [] })
    expect(p).toHaveLength(4)
    expect(p.join('\n')).toMatch(/the question or task, in plain words[\s\S]*the evidence[\s\S]*what it blocks[\s\S]*acceptance/)
    expect(requestProblems({ ...GOOD, acceptance: ['ok'] })).toEqual([expect.stringMatching(/each item a concrete thing/)])
    expect(requestProblems({ ...GOOD, recommendation: 'yes' })).toEqual([expect.stringMatching(/your recommended answer/)])
    expect(() => checkRequest({ to: 'ams', question: 'What about it?' })).toThrow(/not specific enough to send[\s\S]*Nothing was recorded/)
    const d = db()
    expect(() => addHandoff(d, THERMAL, { ...GOOD, evidence: [] }, OPEN)).toThrow(HandoffError)
    expect(loadHandoffs(d)).toEqual([])
  })
})

describe('the guards (guard 1)', () => {
  it('records a request to an enabled specialist, depth 1, requested', () => {
    const d = db()
    const h = addHandoff(d, THERMAL, GOOD, OPEN)
    expect(h).toMatchObject({ fromAgent: 'thermal', fromJob: 'job-t1', toKind: 'ams', depth: 1, state: 'requested', jobId: null, acceptance: GOOD.acceptance })
    expect(h.id).toMatch(/^ho[0-9a-f]{14}$/)
  })

  it('never to itself, an unknown or disabled specialist, or from the worker; and not when the limits are 0', () => {
    const d = db()
    expect(() => addHandoff(d, THERMAL, { ...GOOD, to: 'thermal' }, OPEN)).toThrow(/cannot hand off to yourself/)
    expect(() => addHandoff(d, THERMAL, { ...GOOD, to: 'worker' }, OPEN)).toThrow(/not a specialist/)
    expect(() => addHandoff(d, THERMAL, GOOD, { ...OPEN, enabled: ['thermal', 'verify'] })).toThrow(/not enabled on this project/)
    expect(() => addHandoff(d, { ...THERMAL, agent: 'worker' }, GOOD, OPEN)).toThrow(/Only a specialist/)
    expect(() => addHandoff(d, THERMAL, GOOD, { ...OPEN, limits: { perJob: 0, perProject: 10 } })).toThrow(/turned off/)
  })

  it('depth 1: a job a hand-off started raises none, and never hands the question back (no A→B→A)', () => {
    const d = db()
    const h = addHandoff(d, THERMAL, GOOD, OPEN)
    markStarted(d, h.id, 'job-a1')
    const receiver: HandoffAsker = { agent: 'ams', label: 'the Analog specialist', jobId: 'job-a1' }
    // from its row, whatever its environment says
    expect(() => addHandoff(d, receiver, { ...GOOD, to: 'thermal' }, OPEN)).toThrow(/asked you this .* cannot hand it back/)
    expect(() => addHandoff(d, receiver, { ...GOOD, to: 'emc' }, OPEN)).toThrow(/started by a hand-off .* raises none/)
    // and from its environment before the row is written
    expect(() => addHandoff(d, { ...receiver, jobId: 'job-a2', handoff: { id: h.id, from: 'thermal' } }, { ...GOOD, to: 'thermal' }, OPEN)).toThrow(/cannot hand it back/)
  })

  it('at most N open per job and per project; closed ones do not count', () => {
    const d = db()
    const limits = { perJob: 2, perProject: 3 }
    const q = (n: number) => ({ ...GOOD, question: `${GOOD.question} Case ${n}.` })
    const a = addHandoff(d, THERMAL, q(1), { ...OPEN, limits })
    addHandoff(d, THERMAL, q(2), { ...OPEN, limits })
    expect(() => addHandoff(d, THERMAL, q(3), { ...OPEN, limits })).toThrow(/already has 2 open hand-offs \(agents.handoff_max_per_job 2\)/)
    addHandoff(d, { ...THERMAL, jobId: 'job-t2' }, q(4), { ...OPEN, limits })
    expect(() => addHandoff(d, { ...THERMAL, jobId: 'job-t3' }, q(5), { ...OPEN, limits })).toThrow(/project already has 3 open hand-offs/)
    // one declined by a person, one failed: places free up
    markFailed(d, a.id, 'its job failed')
    expect(() => addHandoff(d, { ...THERMAL, jobId: 'job-t3' }, q(5), { ...OPEN, limits })).not.toThrow()
  })

  it('the same question to a specialist that declined, failed or could not answer it is refused: ask a person', () => {
    const d = db()
    const h = addHandoff(d, THERMAL, GOOD, OPEN)
    expect(() => addHandoff(d, { ...THERMAL, jobId: 'job-t9' }, GOOD, { ...OPEN, declined: new Set([h.id]) })).toThrow(/declined by a person. Do not ask again: ask a person with journey.ask/)
    markFailed(d, h.id, 'its job was cancelled')
    expect(() => addHandoff(d, { ...THERMAL, jobId: 'job-t9' }, { ...GOOD, question: (GOOD.question ?? '').toUpperCase() }, OPEN)).toThrow(/its job failed/)
  })
})

describe('answers', () => {
  const answer = { answered: true, text: '0.85 W at 500 mA and 85 °C, from a 5.0 V input.', evidence: [{ kind: 'run', ref: 'run-77' }], confidence: 0.8, acceptanceMet: true }

  it('only the job started for the hand-off may answer it, once, with a complete answer', () => {
    const d = db()
    const h = addHandoff(d, THERMAL, GOOD, OPEN)
    expect(() => answerHandoff(d, h.id, 'job-a1', answer)).toThrow(/Only the job started for hand-off/)
    markStarted(d, h.id, 'job-a1')
    expect(() => answerHandoff(d, h.id, 'job-other', answer)).toThrow(/Only the job started for hand-off .* \(job job-a1\)/)
    expect(() => answerHandoff(d, h.id, null, answer)).toThrow(/Only the job started/)
    expect(() => answerHandoff(d, h.id, 'job-a1', { ...answer, evidence: [], confidence: undefined })).toThrow(/not complete[\s\S]*evidence[\s\S]*confidence/)
    expect(answerProblems({ ...answer, acceptanceMet: false })).toEqual([expect.stringMatching(/which acceptance item is not met/)])
    const out = answerHandoff(d, h.id, 'job-a1', answer)
    expect(out).toMatchObject({ state: 'answered', answer: answer.text, confidence: 0.8, acceptanceMet: true, answerEvidence: [{ kind: 'run', ref: 'run-77' }] })
    expect(() => answerHandoff(d, h.id, 'job-a1', answer)).toThrow(/already answered/)
    // an answered one cannot fail afterwards
    expect(markFailed(d, h.id, 'late')).toBe(false)
  })

  it('a receiver that cannot answer says why: unanswered', () => {
    const d = db()
    const h = addHandoff(d, THERMAL, GOOD, OPEN)
    markStarted(d, h.id, 'job-a1')
    expect(() => answerHandoff(d, h.id, 'job-a1', { answered: false, text: 'no', evidence: [] })).toThrow(/why it cannot be answered/)
    expect(answerHandoff(d, h.id, 'job-a1', { answered: false, text: 'The LDO part number is not on the schematic: U3 has no value.', evidence: [] })).toMatchObject({ state: 'unanswered', confidence: null })
  })
})

describe('the store and the journey record', () => {
  beforeEach(() => forgetNoJourney())

  it('keeps hand-offs in the agents\' facts, and people\'s declines in the journey record', async () => {
    const b = new S3Backend('bucket', 'projects', new FakeS3())
    const facts = new AgentFactsStore(b, 'acme/board')
    const journey = new JourneyStore(b, 'acme/board')
    await journey.update((x) => { startJourney(x, { template: 'board', by: 'a@example.com', name: 'Soil sensor' }); return { result: null } })
    const h = (await facts.update((x) => ({ result: addHandoff(x, THERMAL, GOOD, OPEN) }))).result
    expect((await facts.read((x) => loadAgentFacts(x))).result.handoffs).toEqual([expect.objectContaining({ id: h.id, state: 'requested' })])
    expect(JOURNEY_TABLES).toContain('handoff_declines')
    const by = { hash: 'h-user', label: 'u@example.com' }
    await expect(journey.update((x) => ({ result: declineHandoff(x, h, by, 'ok', { jobState: null }) }))).rejects.toThrow(/Say in a line why/)
    await expect(journey.update((x) => ({ result: declineHandoff(x, h, by, 'two\nlines here', { jobState: null }) }))).rejects.toThrow(/one line/)
    await expect(journey.update((x) => ({ result: declineHandoff(x, h, by, 'The bench measures it on Friday.', { jobState: 'running' }) }))).rejects.toThrow(/already running: cancel that job/)
    await expect(journey.update((x) => ({ result: declineHandoff(x, undefined, by, 'The bench measures it on Friday.', { jobState: null }) }))).rejects.toThrow(/no such hand-off/)
    const d = (await journey.update((x) => ({ result: declineHandoff(x, h, by, 'The bench measures it on Friday.', { jobState: 'queued' }) }))).result
    expect(d).toMatchObject({ id: h.id, reason: 'The bench measures it on Friday.', by: 'u@example.com' })
    const r = (await journey.read((x) => loadJourney(x))).result!
    expect(r.declines).toEqual([expect.objectContaining({ handoffId: h.id, reason: 'The bench measures it on Friday.' })])
    expect(r.decisions[0]).toMatchObject({ kind: 'handoff.declined', ref: h.id, summary: expect.stringMatching(/^The Analog and mixed-signal specialist will not answer the Thermal specialist's hand-off: .* Declined: The bench/) })
    await expect(journey.update((x) => ({ result: declineHandoff(x, h, by, 'Again, for the bench.', { jobState: 'queued' }) }))).rejects.toThrow(/already declined/)
    // the agents' fact is untouched: people never write it
    expect((await facts.read((x) => loadHandoffs(x))).result[0]?.state).toBe('requested')
  })

  it('an answered or ended hand-off cannot be declined', () => {
    const j = new DatabaseSync(':memory:')
    applyJourneySchema(j)
    const d = db()
    const h = addHandoff(d, THERMAL, GOOD, OPEN)
    markFailed(d, h.id, 'its job failed (no runtime)')
    expect(() => declineHandoff(j, loadHandoffs(d)[0], { hash: 'h', label: 'u' }, 'Not needed any more.', { jobState: null })).toThrow(/already ended/)
    expect(loadDeclines(j)).toEqual([])
  })
})

describe('the views', () => {
  it('say who asked whom, the request, where it stands with its job and a person\'s decline, and the answer', () => {
    const d = db()
    const a = addHandoff(d, THERMAL, GOOD, OPEN)
    const b = addHandoff(d, THERMAL, { ...GOOD, to: 'emc', question: 'Does the 2 MHz switcher on the 5 V rail fail the class B limit at 30 MHz?' }, OPEN)
    const c = addHandoff(d, { ...THERMAL, jobId: 'job-t2' }, { ...GOOD, to: 'impl', question: 'Can U3 move 10 mm from the MOSFET Q1 without breaking the routing of the power nets?' }, OPEN)
    markStarted(d, a.id, 'job-a1')
    markStarted(d, b.id, 'job-e1')
    const jobs = new Map([['job-a1', { state: 'running', handle: 'p1.s.job-a1' }], ['job-e1', { state: 'queued', handle: 'p1.s.job-e1' }], ['job-t1', { state: 'running', handle: 'p1.s.job-t1' }]])
    let v = handoffViews(loadHandoffs(d), [], jobs)
    expect(v.map((x) => [x.to, x.state])).toEqual([['impl', 'requested'], ['emc', 'queued'], ['ams', 'running']])
    expect(v[2]).toMatchObject({ from: 'thermal', from_name: 'Thermal', from_job_handle: 'p1.s.job-t1', to_name: 'Analog and mixed-signal', summary: expect.stringMatching(/^Thermal → Analog and mixed-signal: What is the worst-case/), job: { id: 'job-a1', handle: 'p1.s.job-a1' } })
    answerHandoff(d, a.id, 'job-a1', { answered: true, text: '0.85 W at 500 mA and 85 °C, from a 5.0 V input.', evidence: [{ kind: 'run', ref: 'run-77' }], confidence: 0.8, acceptanceMet: false, unmet: 'the input voltage is assumed, not measured' })
    v = handoffViews(loadHandoffs(d), [{ handoffId: b.id, reason: 'EMC is measured at the lab.', by: 'u@example.com', byHash: 'h', at: 1 }], new Map([...jobs, ['job-e1', { state: 'succeeded', handle: 'x' }]]))
    expect(v.find((x) => x.id === a.id)).toMatchObject({ state: 'answered', says: 'Answered, but not everything asked for is met.', answer: { answered: true, confidence: 0.8, acceptance_met: false, unmet: 'the input voltage is assumed, not measured' } })
    expect(v.find((x) => x.id === b.id)).toMatchObject({ state: 'declined', declined: { reason: 'EMC is measured at the lab.', by: 'u@example.com' }, says: 'Declined by u@example.com: EMC is measured at the lab.' })
    expect(v.find((x) => x.id === c.id)?.state).toBe('requested')
    // its job ended without answering: failed, even before the runtime closed it
    markStarted(d, c.id, 'job-i1')
    expect(handoffViews(loadHandoffs(d), [], new Map([['job-i1', { state: 'failed', handle: 'y' }]])).find((x) => x.id === c.id)?.state).toBe('failed')
  })

  it('tell the asker what to do next: never ask again after a decline, a failure or no answer', () => {
    expect(nextFor({ state: 'answered', id: 'ho1', to_name: 'EMC' })).toMatch(/Use the answer/)
    expect(nextFor({ state: 'queued', id: 'ho1', to_name: 'EMC' })).toMatch(/carry on with what it does not block/)
    for (const s of ['declined', 'failed', 'unanswered'] as const) expect(nextFor({ state: s, id: 'ho1', to_name: 'EMC' })).toMatch(/Do not hand it off again: .* ask a person with journey.ask/)
  })

  it('a hand-off job\'s title says who asked', () => {
    expect(handoffTitle('thermal', 'What is the\n LDO dissipation?')).toBe('Asked by the Thermal specialist: What is the LDO dissipation?')
  })
})
