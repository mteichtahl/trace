/** The agents' facts beside the journey record: the store (conditional writes), the rules each fact must meet, and how the views merge them. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AgentFactError, AgentFactsStore, addAgentQuestion, addCriterionCheck, addStuck, loadAgentFacts, loadChecks, projectsFromEnv, resolveStuck,
} from '../../src/core/agent-facts.js'
import { S3Backend } from '../../src/core/central.js'
import {
  type AgentFacts, type JourneyRecord, type Viewer, answerQuestion, gateView, inboxItems, journeyView, loadJourney, mergeAgentFacts, returnGate, setCriterion,
  signGate, recordOpen, startJourney,
} from '../../src/core/journey.js'
import { JourneyStore, forgetNoJourney } from '../../src/core/journey-store.js'
import { FakeS3 } from './fake-s3.js'

const VERIFY = { agent: 'verify', label: 'the Verification specialist', jobId: 'job-1' }
const opts = [
  { id: 'a', label: '2.7 to 3.6 V', recommended: true, why: 'the sensor datasheet, page 4' },
  { id: 'b', label: '1.8 to 3.6 V', recommended: false, why: 'if a coin cell must run it' },
]
const CONTRIB: Viewer = { hash: 'h-user', label: 'u@example.com', admin: false, part: 'contributor', sub: 'sub-user-0001' }
const OTHER: Viewer = { hash: 'h-other', label: 'o@example.com', admin: false, part: 'contributor', sub: 'sub-other-0001' }
const REVIEWER: Viewer = { hash: 'h-rev', label: 'r@example.com', admin: false, part: 'reviewer', sub: 'sub-rev-0001' }
const ADMIN: Viewer = { hash: 'h-admin', label: 'a@example.com', admin: true, part: 'contributor', sub: 'sub-admin-0001' }

const stores = (s3 = new FakeS3()) => {
  const b = new S3Backend('bucket', 'projects', s3)
  return { s3, journey: new JourneyStore(b, 'acme/board'), facts: new AgentFactsStore(b, 'acme/board') }
}
async function started(template: 'board' | 'firmware' = 'board') {
  const s = stores()
  await s.journey.update((db) => { startJourney(db, { template, by: 'a@example.com', name: 'Soil sensor' }); return { result: null } })
  const record = async (): Promise<JourneyRecord> => (await s.journey.read((db) => loadJourney(db))).result!
  const facts = async (): Promise<AgentFacts> => (await s.facts.read((db) => loadAgentFacts(db))).result
  return { ...s, record, read: facts }
}

describe('the agent facts store', () => {
  beforeEach(() => forgetNoJourney())

  it('keeps one database per project under projects/<slug>/journey-agent/, beside (never inside) the journey record', async () => {
    const s = await started()
    const r = await s.record()
    const w = await s.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the supply range?', blocks: 'sizing the regulator', options: opts }, r) }))
    expect(w.version).toBe(1)
    expect([...s.s3.objects.keys()].sort()).toEqual(['bucket/projects/acme/board/journey-agent/facts.db', 'bucket/projects/acme/board/journey/journey.db'])
    // the journey record is untouched: the question is the agents' fact
    expect((await s.record()).questions).toEqual([])
    expect((await s.read()).questions).toEqual([expect.objectContaining({ id: w.result, askedBy: 'the Verification specialist', askedPart: 'contributors', stage: 'define', jobId: 'job-1' })])
  })

  it('re-runs a fact that lost a race on a fresh copy, keeping the other writer\'s fact', async () => {
    const s = await started()
    const r = await s.record()
    let runs = 0
    s.s3.interleave = () => s.facts.update((db) => ({ result: addCriterionCheck(db, { ...VERIFY, jobId: 'job-2' }, { criterion: 'architect.mapped', status: 'met', evidence: [{ kind: 'run', ref: 'run-a' }] }, r) }))
    // the first write of the database: If-None-Match, which the other writer wins
    const out = await s.facts.update((db) => { runs++; return { result: addStuck(db, VERIFY, { why: 'The board file does not load in KiCad 9.', recommendation: 'Open it in KiCad 9 and save it once.' }, r) } })
    expect(s.s3.conflicts).toBe(1)
    expect(runs).toBe(2)
    expect(out.version).toBe(2)
    const f = await s.read()
    expect(f.checks.map((c) => c.criterion)).toEqual(['architect.mapped'])
    expect(f.stuck.map((x) => x.why)).toEqual(['The board file does not load in KiCad 9.'])
  })

  it('finds its bucket and project from the session: the worker\'s TRACE_PROJECT_HOME, else TRACE_HOME\'s sibling', () => {
    expect(projectsFromEnv({ TRACE_PROJECT: 'Acme/Board', TRACE_PROJECT_HOME: 's3://b/projects/acme/board' })).toEqual({ projects: 's3://b/projects', repository: 'Acme/Board' })
    // another project's home is not used
    expect(projectsFromEnv({ TRACE_PROJECT: 'acme/board', TRACE_PROJECT_HOME: 's3://b/projects/acme/other' })).toBeNull()
    expect(projectsFromEnv({ GITHUB_REPOSITORY: 'acme/board', TRACE_HOME: 's3://b/central' })).toEqual({ projects: 's3://b/projects', repository: 'acme/board' })
    expect(projectsFromEnv({ TRACE_MEMORY_REPOSITORY: 'acme/board', TRACE_HOME: '/srv/trace' })).toEqual({ projects: '/srv/trace/projects', repository: 'acme/board' })
    expect(projectsFromEnv({ TRACE_HOME: 's3://b/central' })).toBeNull()
  })
})

describe('the rules a fact must meet', () => {
  it('a question: two options or more, exactly one recommended, a reason each, ids unique, recommended first', async () => {
    const s = await started()
    const r = await s.record()
    const ask = (options: typeof opts, text = 'What is the supply range?') => s.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text, options }, r) }))
    await expect(ask([opts[0]!])).rejects.toThrow(/at least two options/)
    await expect(ask([{ ...opts[0]!, recommended: false }, opts[1]!])).rejects.toThrow(/Recommend exactly one option \(0/)
    await expect(ask([opts[0]!, { ...opts[1]!, recommended: true }])).rejects.toThrow(/exactly one option \(2/)
    await expect(ask([opts[0]!, { ...opts[1]!, id: 'a' }])).rejects.toThrow(/its own id/)
    await expect(ask(opts, 'Range?')).rejects.toThrow(/full sentence/)
    await s.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the supply range?', options: [opts[1]!, opts[0]!] }, r) }))
    expect((await s.read()).questions[0]?.options.map((o) => o.id)).toEqual(['a', 'b'])
    // nowhere to answer without a journey
    expect(() => addAgentQuestion(null as never, VERIFY, { text: 'What is the supply range?', options: opts }, null)).toThrow(AgentFactError)
  })

  it('a check: only a criterion trace owns, a met one with evidence; the newest check stands', async () => {
    const s = await started()
    const r = await s.record()
    const check = (criterion: string, status: 'met' | 'not_met', evidence = [{ kind: 'run', ref: 'run-1' }]) =>
      s.facts.update((db) => ({ result: addCriterionCheck(db, VERIFY, { criterion, status, evidence }, r) }))
    await expect(check('define.accepted', 'met')).rejects.toThrow(/a person's to meet/)
    await expect(check('nowhere.at_all', 'met')).rejects.toThrow(/no criterion called/)
    await expect(check('architect.mapped', 'met', [])).rejects.toThrow(/needs its evidence/)
    await check('architect.mapped', 'met')
    await check('architect.mapped', 'not_met', [{ kind: 'run', ref: 'run-2' }])
    const all = (await s.facts.read((db) => loadChecks(db))).result
    expect(all.map((c) => c.status)).toEqual(['met', 'not_met'])
    expect((await s.read()).checks).toEqual([expect.objectContaining({ criterion: 'architect.mapped', status: 'not_met', revision: 'A', by: 'verify' })])
  })

  it('stuck: why and a recommendation; one open per job; resolved when the agent moves on', async () => {
    const s = await started()
    const r = await s.record()
    await expect(s.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'stuck', recommendation: 'Do something.' }, r) }))).rejects.toThrow(/full sentence/)
    await expect(s.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: '' }, r) }))).rejects.toThrow(/recommend/)
    await s.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }, r) }))
    await s.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The GPU queue refuses the job.', recommendation: 'Raise the queue limit.' }, r) }))
    expect((await s.read()).stuck.map((x) => x.resolvedAt === null)).toEqual([false, true])
    await s.facts.update((db) => ({ result: resolveStuck(db, { jobId: 'job-1', resolution: 'moved on' }) }))
    expect((await s.read()).stuck.every((x) => x.resolvedAt !== null)).toBe(true)
  })
})

describe('merging the agents\' facts into the journey views', () => {
  it('an agent\'s question is a question for the right person: by sub, else by part', async () => {
    const s = await started()
    const r = await s.record()
    await s.facts.update((db) => {
      addAgentQuestion(db, VERIFY, { text: 'What is the supply range?', blocks: 'sizing the regulator', options: opts }, r)
      addAgentQuestion(db, VERIFY, { text: 'Is the coin cell the only power source?', blocks: 'the power budget', options: opts, askedOfSub: CONTRIB.sub }, r)
      addAgentQuestion(db, VERIFY, { text: 'May the board cost more than US$40?', blocks: 'the parts choice', options: opts, askedPart: 'admins' }, r)
      return { result: null }
    })
    const f = await s.read()
    const kinds = (v: Viewer) => inboxItems('acme/board', r, v, undefined, f).map((i) => i.summary.replace(/^Soil sensor: the Verification specialist asks: /, '').split('?')[0])
    expect(kinds(CONTRIB)).toEqual(['What is the supply range', 'Is the coin cell the only power source'])
    expect(kinds(OTHER)).toEqual(['What is the supply range'])
    expect(kinds(REVIEWER)).toEqual([])
    expect(kinds(ADMIN)).toEqual(['What is the supply range', 'May the board cost more than US$40'])
    expect(inboxItems('acme/board', r, CONTRIB, undefined, f)[0]).toMatchObject({ kind: 'question', blocking: true, recommended: { id: 'a', label: '2.7 to 3.6 V' } })
    // without the facts, nothing (the record itself has no question)
    expect(inboxItems('acme/board', r, CONTRIB)).toEqual([])
    const v = journeyView(r, OTHER, undefined, f)
    expect(v.questions.map((q) => [q.for, q.for_you])).toEqual([['contributors', true], ['person', false], ['admins', false]])
    expect(journeyView(r, CONTRIB, undefined, f).next).toMatchObject({ kind: 'answer', yours: true, button: 'Use 2.7 to 3.6 V' })
  })

  it('a person\'s answer goes into the record under the agent\'s question id, and the agent reads it there', async () => {
    const s = await started()
    const r = await s.record()
    const { result: id } = await s.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the supply range?', blocks: 'sizing the regulator', options: opts }, r) }))
    const f = await s.read()
    await expect(s.journey.update((db) => ({ result: answerQuestion(db, id, { hash: CONTRIB.hash, label: CONTRIB.label }, { option: 'b' }, { facts: f }) }))).rejects.toThrow(/why you chose otherwise/)
    const answered = await s.journey.update((db) => ({ result: answerQuestion(db, id, { hash: CONTRIB.hash, label: CONTRIB.label }, { option: 'a' }, { facts: f }) }))
    expect(answered.result).toMatchObject({ id, answered: { answer: '2.7 to 3.6 V', by: CONTRIB.label } })
    // the record has the question with its answer (what was asked stays with what was decided)
    const after = await s.record()
    expect(after.questions).toEqual([expect.objectContaining({ id, text: 'What is the supply range?', answer: '2.7 to 3.6 V', optionId: 'a', answeredBy: CONTRIB.label })])
    expect(after.decisions[0]).toMatchObject({ kind: 'question.answered', ref: id })
    // merged: answered, and gone from the inbox; the agent's routing stands
    expect(inboxItems('acme/board', after, CONTRIB, undefined, f)).toEqual([])
    expect(mergeAgentFacts(after, f).questions).toEqual([expect.objectContaining({ id, from: 'agent', askedPart: 'contributors', answeredAt: expect.any(Number) })])
    await expect(s.journey.update((db) => ({ result: answerQuestion(db, id, { hash: CONTRIB.hash, label: CONTRIB.label }, { option: 'a' }, { facts: f }) }))).rejects.toThrow(/already answered/)
  })

  it('an agent\'s checks move the criteria trace owns; when all are met the gate is ready, and only an admin\'s own acts sign it', async () => {
    const s = await started('firmware')
    // Define is people's: met by their acts (here, as the record's own rows), then signed
    await s.journey.update((db) => {
      for (const c of ['define.accepted', 'define.measurable', 'define.firmware']) { setCriterion(db, c, 'met', [], 'a@example.com'); recordOpen(db, { criterion: c }, ADMIN.hash) }
      signGate(db, 'define', ADMIN)
      return { result: null }
    })
    let r = await s.record()
    expect(r.journey.currentStage).toBe('architect')
    // Architect (firmware): blocks (person), mapped and peripherals (trace)
    await s.facts.update((db) => {
      addCriterionCheck(db, VERIFY, { criterion: 'architect.mapped', status: 'met', evidence: [{ kind: 'run', ref: 'run-map' }] }, r)
      addCriterionCheck(db, VERIFY, { criterion: 'architect.peripherals', status: 'met', evidence: [{ kind: 'file', ref: 'docs/pins.md' }] }, r)
      return { result: null }
    })
    let f = await s.read()
    let g = gateView(r, 'architect', ADMIN, f)
    expect(g.criteria.map((c) => [c.id, c.status])).toEqual([['architect.blocks', 'not_met'], ['architect.mapped', 'met'], ['architect.peripherals', 'met']])
    expect(g.criteria.find((c) => c.id === 'architect.mapped')?.evidence).toEqual([{ kind: 'run', ref: 'run-map' }])
    expect(g.state).toBe('open')
    // an agent can never meet a person's criterion, even by writing a check row straight into its own database
    await s.facts.update((db) => {
      db.prepare("INSERT INTO criterion_checks (id, criterion, status, evidence, checked_at, by, revision) VALUES ('forged', 'architect.blocks', 'met', '[]', ?, 'verify', 'A')").run(Date.now() / 1000 + 5)
      return { result: null }
    })
    f = await s.read()
    expect(gateView(r, 'architect', ADMIN, f).criteria.find((c) => c.id === 'architect.blocks')?.status).toBe('not_met')
    // the person's act meets it: then all are met, the gate is ready, an admin hears of it
    await s.journey.update((db) => { setCriterion(db, 'architect.blocks', 'met', [{ kind: 'record', ref: 'blocks' }], 'u@example.com'); return { result: null } })
    r = await s.record()
    g = gateView(r, 'architect', ADMIN, f)
    expect(g.state).toBe('ready')
    expect(gateView(r, 'architect', ADMIN).state).toBe('open') // without the agents' facts it would not be
    expect(inboxItems('acme/board', r, ADMIN, undefined, f).map((i) => i.kind)).toEqual(['gate'])
    expect(journeyView(r, ADMIN, undefined, f).next).toMatchObject({ kind: 'gate', yours: true })
    // signing: the same rules (evidence opened by the signer), with the agents' checks counted
    await expect(s.journey.update((db) => ({ result: signGate(db, 'architect', ADMIN, { facts: f }) }))).rejects.toThrow(/Open the evidence for 3 more criteria/)
    const signed = await s.journey.update((db) => {
      for (const c of ['architect.blocks', 'architect.mapped', 'architect.peripherals']) recordOpen(db, { criterion: c }, ADMIN.hash)
      return { result: signGate(db, 'architect', ADMIN, { facts: f }) }
    })
    expect(signed.result).toMatchObject({ advanced_to: 'prove', gate: { state: 'signed' } })
    // the signature keeps the agent's evidence
    const sig = (await s.record()).signatures.at(-1)!.criteria as { id: string; status: string; evidence: unknown[] }[]
    expect(sig.find((c) => c.id === 'architect.mapped')).toMatchObject({ status: 'met', evidence: [{ kind: 'run', ref: 'run-map' }] })
  })

  it('a check counts on its revision only, not from before its stage was reopened, and not over a newer one of the record\'s', async () => {
    const s = await started()
    let r = await s.record()
    await s.journey.update((db) => {
      for (const c of ['define.accepted', 'define.measurable']) { setCriterion(db, c, 'met', [], 'a'); recordOpen(db, { criterion: c }, ADMIN.hash) }
      signGate(db, 'define', ADMIN)
      return { result: null }
    })
    r = await s.record()
    await s.facts.update((db) => ({ result: addCriterionCheck(db, VERIFY, { criterion: 'architect.mapped', status: 'met', evidence: [{ kind: 'run', ref: 'r' }] }, r) }))
    const f = await s.read()
    expect(gateView(r, 'architect', ADMIN, f).criteria.find((c) => c.id === 'architect.mapped')?.status).toBe('met')
    // another revision's check does not count
    const other: AgentFacts = { ...f, checks: f.checks.map((c) => ({ ...c, revision: 'B' })) }
    expect(gateView(r, 'architect', ADMIN, other).criteria.find((c) => c.id === 'architect.mapped')?.status).toBe('not_met')
    // reopened after it: the check is from before, so it no longer counts
    await new Promise((res) => setTimeout(res, 15))
    await s.journey.update((db) => ({ result: returnGate(db, 'architect', { hash: CONTRIB.hash, label: CONTRIB.label }, { reason: 'The map misses two requirements.', reopen: 'architect' }) }))
    r = await s.record()
    expect(gateView(r, 'architect', ADMIN, f).criteria.find((c) => c.id === 'architect.mapped')?.status).toBe('not_met')
    // a newer row of the record's own (a checker tool's) wins over an older check
    await s.journey.update((db) => { setCriterion(db, 'architect.stock', 'not_met', [{ kind: 'run', ref: 'newer' }], 'trace'); return { result: null } })
    const older: AgentFacts = { ...f, checks: [{ ...f.checks[0]!, criterion: 'architect.stock', checkedAt: 1 }] }
    expect(gateView(await s.record(), 'architect', ADMIN, older).criteria.find((c) => c.id === 'architect.stock')?.evidence).toEqual([{ kind: 'run', ref: 'newer' }])
  })

  it('a stuck agent is a stuck item for the contributors, with its recommendation, until it moves on', async () => {
    const s = await started()
    const r = await s.record()
    await s.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }, r) }))
    let f = await s.read()
    const items = inboxItems('acme/board', r, CONTRIB, undefined, f)
    expect(items).toEqual([expect.objectContaining({ kind: 'stuck', blocking: true, action: 'See options', summary: 'Soil sensor: the Verification specialist is stuck: The simulator is not installed here. It recommends: Run it on the GPU queue.' })])
    expect(inboxItems('acme/board', r, REVIEWER, undefined, f)).toEqual([])
    expect(journeyView(r, CONTRIB, undefined, f).next).toMatchObject({ kind: 'answer', recommendation: 'the Verification specialist recommends: Run it on the GPU queue.' })
    await s.facts.update((db) => ({ result: resolveStuck(db, { jobId: 'job-1', resolution: 'moved on' }) }))
    f = await s.read()
    expect(inboxItems('acme/board', r, CONTRIB, undefined, f)).toEqual([])
  })
})
