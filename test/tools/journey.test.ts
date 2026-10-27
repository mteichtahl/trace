/** The journey tools: an agent reads the journey, asks people, checks the criteria trace owns and says when it is stuck. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_HIDDEN_TOOLS, apiTool } from '../../src/agents/runtime/tool.js'
import { bucketStore } from '../../src/api/action-kit.js'
import { AgentFactsStore, loadAgentFacts, projectsFromEnv } from '../../src/core/agent-facts.js'
import { backendFor } from '../../src/core/central.js'
import { answerQuestion, dismissStuck, loadJourney, startJourney } from '../../src/core/journey.js'
import { JourneyStore } from '../../src/core/journey-store.js'
import { Registry, ToolError } from '../../src/core/registry.js'
import { Work } from '../../src/core/store.js'
import { allTools } from '../../src/tools/index.js'
import { JOURNEY_WRITE_FILTER, eventsOf, journeyScope, tools, waitForAnswer } from '../../src/tools/journey/tools.js'
import { type SnsApi, type SqsApi, sweepInFlight } from '../../src/gpu/batch.js'
import { projectHash } from '../../src/core/project.js'
import { activeWaits } from '../../src/core/wait.js'

const home = mkdtempSync(join(tmpdir(), 'trace-journey-tools-'))
// where the API finds it too (src/api/action-kit.ts bucketStore): <TRACE_HOME>/projects locally
const projects = backendFor(join(home, 'central', 'projects'))
const journey = new JourneyStore(projects, 'acme/board')
const facts = new AgentFactsStore(projects, 'acme/board')
const ENV = { TRACE_HOME: join(home, 'central'), TRACE_PROJECT: 'acme/board', TRACE_AGENT: 'verify', TRACE_AGENT_LABEL: 'the Verification specialist', TRACE_JOB_ID: 'job-7' }
const saved: Record<string, string | undefined> = {}
const registry = new Registry(tools)
const call = (name: string, args: unknown) => registry.call(name, args, { hardware: false, via: 'test' })
let runId = ''

const opts = [
  { id: 'a', label: '2.7 to 3.6 V', recommended: true, why: 'the sensor datasheet, page 4' },
  { id: 'b', label: '1.8 to 3.6 V', why: 'if a coin cell must run it' },
]

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v }
  await journey.update((db) => { startJourney(db, { template: 'board', by: 'a@example.com', name: 'Soil sensor' }); return { result: null } })
  // a run in this checkout's record, to cite as evidence
  const w = new Work()
  runId = w.start('verify.run', { subject: 'REQ-001' })
  w.finish(runId, 'pass', 'mapped')
  w.close()
})
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

describe('the journey tools', () => {
  it('are in the registry, offered to agents with a project in scope, and never through the API', () => {
    for (const t of ['journey.status', 'journey.ask', 'journey.check', 'journey.stuck']) {
      const tool = allTools().get(t)
      expect(tool, t).toBeDefined()
      expect(API_HIDDEN_TOOLS.has(t)).toBe(true)
      expect(apiTool(tool)).toBe(false)
      expect(Registry.available(tool!)).toBe(true)
    }
    const h = process.env.TRACE_HOME
    delete process.env.TRACE_HOME
    expect(Registry.available(allTools().get('journey.ask')!)).toBe(false)
    process.env.TRACE_HOME = h
  })

  it('use the same projects store as the API', () => {
    expect(bucketStore('projects', ENV.TRACE_HOME).url).toBe(projects.url)
    expect(bucketStore('projects', 's3://b/central').url).toBe(`${projectsFromEnv({ TRACE_PROJECT: 'acme/board', TRACE_HOME: 's3://b/central' })!.projects}`)
  })

  it('act as the agent and job the runner set, with no argument naming a project or an agent', () => {
    expect(journeyScope().asker).toEqual({ agent: 'verify', label: 'the Verification specialist', jobId: 'job-7' })
    expect(journeyScope({ ...ENV, TRACE_AGENT: undefined, TRACE_AGENT_LABEL: undefined, TRACE_JOB_ID: undefined, GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42' }).asker)
      .toEqual({ agent: 'worker', label: 'the worker agent', jobId: 'gh-42' })
    expect(() => journeyScope({ TRACE_PROJECT: 'acme/board' })).toThrow(ToolError)
    for (const t of tools) expect(Object.keys(t.input.shape)).not.toEqual(expect.arrayContaining(['repo', 'repository', 'project', 'agent']))
  })

  it('journey.status: the stage, its gate\'s criteria with their owners, and the next step', async () => {
    const s = await call('journey.status', {}) as { started: boolean; stage: string; gates: { id: string; criteria: { id: string; owner: string; status: string }[] }[]; next: { kind: string } }
    expect(s).toMatchObject({ started: true, stage: 'define', next: { kind: 'task' } })
    expect(s.gates[0]?.criteria.map((c) => [c.id, c.owner])).toEqual([['define.accepted', 'person'], ['define.measurable', 'person']])
  })

  it('journey.ask validates the recommendation rule, records the question in the agents\' facts, and returns its id', async () => {
    await expect(call('journey.ask', { text: 'What is the supply range?', options: [opts[0]] })).rejects.toThrow(/options: /)
    await expect(call('journey.ask', { text: 'What is the supply range?', options: [opts[0], { ...opts[1], recommended: true }] })).rejects.toThrow(/Recommend exactly one option/)
    await expect(call('journey.ask', { text: 'What is the supply range?', options: [opts[0], { ...opts[1], why: '' }] })).rejects.toThrow(/say why, for every option/)
    await expect(call('journey.ask', { text: 'What is the supply range?', options: opts, sources: [{ kind: 'run', ref: 'no-such-run' }] })).rejects.toThrow(/no run "no-such-run"/)
    await expect(call('journey.ask', { text: 'What is the supply range?', options: opts, sources: [{ kind: 'file', ref: '../../etc/passwd' }] })).rejects.toThrow(/path in the repository/)
    await expect(call('journey.ask', { text: 'What is the supply range?', options: opts, repo: 'acme/other' })).rejects.toThrow(/repo/)
    const r = await call('journey.ask', { text: 'What is the supply range?', blocks: 'sizing the regulator', options: opts, sources: [{ kind: 'run', ref: runId }, { kind: 'file', ref: 'package.json' }] }) as { question_id: string; for: string; answered: null }
    expect(r).toMatchObject({ for: 'the contributors', answered: null })
    const f = (await facts.read((db) => loadAgentFacts(db))).result
    expect(f.questions).toEqual([expect.objectContaining({ id: r.question_id, askedBy: 'the Verification specialist', jobId: 'job-7', askedPart: 'contributors', blocks: 'sizing the regulator' })])
    // by sub
    const one = await call('journey.ask', { text: 'Is the coin cell the only source?', options: opts, sub: 'abcdef12-3456-7890' }) as { for: string }
    expect(one.for).toBe('one person')
    // the journey record itself is never written by the tools
    expect((await journey.read((db) => loadJourney(db)?.questions)).result).toEqual([])
  })

  it('journey.ask waits for the answer on its declared timer, and says when it will look next when none comes', async () => {
    const asked = await call('journey.ask', { text: 'Which connector for the probe?', options: opts }) as { question_id: string }
    const id = asked.question_id
    let t = 1_000_000
    const sleeps: number[] = []
    // nobody answers: it gives up at the deadline, with the next check time and what to do
    const none = await waitForAnswer(journeyScope(), id, 60_000, { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms } })
    expect(none).toMatchObject({ answered: null, next: expect.stringMatching(/Never take the recommended option as the answer/) })
    expect(sleeps[0]).toBe(30_000)
    // a person answers (through the API, into the journey record, under the agent's question id)
    const f = (await facts.read((db) => loadAgentFacts(db))).result
    let checks = 0
    const answered = await waitForAnswer(journeyScope(), id, 3_600_000, {
      now: () => t,
      sleep: async (ms) => {
        t += ms
        if (++checks === 2) await journey.update((db) => ({ result: answerQuestion(db, id, { hash: 'h', label: 'u@example.com' }, { option: 'a' }, { facts: f }) }))
      },
    })
    expect(answered).toMatchObject({ answered: { answer: '2.7 to 3.6 V', option: 'a', by: 'u@example.com' } })
    expect(await call('journey.status', { question: id })).toMatchObject({ question: { id, answered: { answer: '2.7 to 3.6 V' } } })
  })

  it('journey.check refuses a person\'s criterion and a met one without evidence; records a trace-owned one', async () => {
    await expect(call('journey.check', { criterion: 'define.accepted', status: 'met', evidence: [{ kind: 'run', ref: runId }] })).rejects.toThrow(/a person's to meet/)
    await expect(call('journey.check', { criterion: 'architect.mapped', status: 'met' })).rejects.toThrow(/needs its evidence/)
    await expect(call('journey.check', { criterion: 'Capture ERC', status: 'met' })).rejects.toThrow(/criterion id/)
    const r = await call('journey.check', { criterion: 'architect.mapped', status: 'met', evidence: [{ kind: 'run', ref: runId }], note: 'every requirement maps to a block' }) as { check_id: string; gate: { id: string; met: number } }
    expect(r).toMatchObject({ criterion: 'architect.mapped', gate: { id: 'architect', met: 1 } })
    expect((await facts.read((db) => loadAgentFacts(db))).result.checks).toEqual([expect.objectContaining({ criterion: 'architect.mapped', status: 'met', by: 'verify', jobId: 'job-7' })])
  })

  it('journey.stuck needs why and a recommendation; resolved clears this job\'s', async () => {
    await expect(call('journey.stuck', { why: 'The simulator is not installed here.' })).rejects.toThrow(/give why and recommendation/)
    await expect(call('journey.stuck', { why: 'The simulator is not installed here.', recommendation: 'Run on GPU.', options: [opts[0], { ...opts[1], recommended: true }] })).rejects.toThrow(/exactly one/)
    const r = await call('journey.stuck', { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }) as { stuck_id: string }
    expect(r.stuck_id).toMatch(/^st/)
    expect((await facts.read((db) => loadAgentFacts(db))).result.stuck).toEqual([expect.objectContaining({ id: r.stuck_id, jobId: 'job-7', resolvedAt: null })])
    expect(await call('journey.stuck', { resolved: true })).toMatchObject({ resolved: 1 })
    expect(await call('journey.stuck', { resolved: true })).toMatchObject({ resolved: 0 })
  })

  it('journey.status shows a stuck report a person dismissed, with the reason, so the agent knows', async () => {
    const r = await call('journey.stuck', { why: 'The probe is not on the bench network.', recommendation: 'Plug the probe in.' }) as { stuck_id: string }
    expect((await call('journey.status', {}) as { stuck: { id: string; dismissed?: unknown }[] }).stuck.find((x) => x.id === r.stuck_id)).toMatchObject({ id: r.stuck_id, answered: null })
    const f = (await facts.read((db) => loadAgentFacts(db))).result
    await journey.update((db) => ({ result: dismissStuck(db, 'job-7', { hash: 'h', label: 'u@example.com' }, 'The probe is retired; use the logic analyser.', { facts: f }) }))
    const st = await call('journey.status', {}) as { stuck: { id: string; dismissed?: { reason: string; by: string } }[]; questions: { kind: string }[] }
    expect(st.stuck.find((x) => x.id === r.stuck_id)?.dismissed).toMatchObject({ reason: 'The probe is retired; use the logic analyser.', by: 'u@example.com' })
    expect(st.questions.every((q) => q.kind === 'question')).toBe(true)
    expect(await call('journey.status', { question: r.stuck_id })).toMatchObject({ question: { dismissed: { reason: 'The probe is retired; use the logic analyser.' } } })
    await call('journey.stuck', { resolved: true })
  })
})

// ------------------------------------------------------------------ journey.ask's wait, on the project's events

const TOPIC = `arn:aws:sns:us-east-1:123456789012:trace-${projectHash('acme/board')}-batch-events`

/** SQS and SNS in memory: each receive takes the next scripted step (a function may write the record first). */
class Fakes {
  t = 5_000_000
  now = (): number => this.t
  created: string[] = []
  deleted: string[] = []
  subscribed: { Attributes: Record<string, string> }[] = []
  unsubscribed: string[] = []
  receives: number[] = []
  failSubscribe: Error | null = null
  failReceive: Error | null = null
  constructor(public script: (null | string[] | (() => Promise<string[]>))[] = []) {}
  sqs: SqsApi = {
    createQueue: async (i) => { this.created.push(i.QueueName); return { QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${i.QueueName}` } },
    receiveMessage: async (i) => {
      this.receives.push(this.t)
      if (this.failReceive) throw this.failReceive
      const next = this.script.shift() ?? null
      if (!next) { this.t += i.WaitTimeSeconds * 1000; return { Messages: [] } }
      const bodies = typeof next === 'function' ? await next() : next
      this.t += 100
      return { Messages: bodies.map((Body, k) => ({ Body, ReceiptHandle: `r${k}` })) }
    },
    deleteMessage: async () => ({}),
    deleteQueue: async (i) => { this.deleted.push(i.QueueUrl); return {} },
    listQueues: async () => ({ QueueUrls: [] }),
    getQueueAttributes: async () => ({ Attributes: { CreatedTimestamp: String(Math.floor(this.t / 1000)) } }),
  }
  sns: SnsApi = {
    subscribe: async (i) => { if (this.failSubscribe) throw this.failSubscribe; this.subscribed.push(i); return { SubscriptionArn: `${TOPIC}:sub-1` } },
    unsubscribe: async (i) => { this.unsubscribed.push(i.SubscriptionArn); return {} },
    listSubscriptionsByTopic: async () => ({ Subscriptions: [] }),
  }
}

const S3_WRITE = JSON.stringify({ source: 'aws.s3', 'detail-type': 'Object Created', detail: { bucket: { name: 'central' }, object: { key: 'projects/acme/board/journey/journey.db' } } })

describe('journey.ask waits on events where the project has them', () => {
  const ask = async (text: string): Promise<string> => (await call('journey.ask', { text, options: opts }) as { question_id: string }).question_id
  const answer = (id: string) => async (): Promise<string[]> => {
    const f = (await facts.read((db) => loadAgentFacts(db))).result
    await journey.update((db) => ({ result: answerQuestion(db, id, { hash: 'h', label: 'u@example.com' }, { option: 'a' }, { facts: f }) }))
    return [S3_WRITE]
  }

  it('takes the topic from the worker\'s environment: none without one, or with another project\'s', () => {
    expect(eventsOf({}, 'acme/board')).toBeNull()
    expect(eventsOf({ TRACE_BATCH_EVENTS_TOPIC: TOPIC.replace(projectHash('acme/board'), projectHash('acme/other')) }, 'acme/board')).toBeNull()
    const e = eventsOf({ TRACE_BATCH_EVENTS_TOPIC: TOPIC }, 'acme/board')
    expect(e).toMatchObject({ topic: TOPIC, project: 'acme/board', queueName: expect.stringMatching(new RegExp(`^trace-${projectHash('acme/board')}-wait-ask-[0-9a-f]{8}$`)) })
    // each wait its own queue
    expect(eventsOf({ TRACE_BATCH_EVENTS_TOPIC: TOPIC }, 'acme/board')?.queueName).not.toBe(e?.queueName)
  })

  it('is told when the journey record is written, reads it once, and returns the answer; the queue goes with it', async () => {
    const id = await ask('Which header for the debug port?')
    const k = new Fakes([null, [S3_WRITE], answer(id)])
    const lines: string[] = []
    let sawEventWait = false
    const realReceive = k.sqs.receiveMessage
    k.sqs.receiveMessage = async (i) => { sawEventWait ||= activeWaits().some((w) => w.source === 'event' && w.what.includes(id)); return realReceive(i) }
    const out = await waitForAnswer(journeyScope(), id, 3_600_000, { now: k.now, log: (l) => lines.push(l), events: { ...eventsOf({ TRACE_BATCH_EVENTS_TOPIC: TOPIC }, 'acme/board')!, sqs: k.sqs, sns: k.sns } })
    await sweepInFlight()
    expect(out).toMatchObject({ answered: { answer: '2.7 to 3.6 V', option: 'a', by: 'u@example.com' }, waited_on: 'events' })
    // a queue of its own, subscribed with the journey-write filter, raw delivery; both removed when done
    expect(k.subscribed).toEqual([expect.objectContaining({ Attributes: { RawMessageDelivery: 'true', FilterPolicyScope: 'MessageBody', FilterPolicy: JSON.stringify(JOURNEY_WRITE_FILTER) } })])
    expect(k.unsubscribed).toHaveLength(1)
    expect(k.deleted).toHaveLength(1)
    expect(sawEventWait).toBe(true)
    // no timer: three long polls, the first empty, and it says when its safety reads are
    expect(k.receives).toHaveLength(3)
    expect(lines.join('\n')).toMatch(/told when the journey record changes; .* 30 seconds and 90 seconds after subscribing, then every 5 minutes \(next at \d{4}-/)
    expect(activeWaits().some((w) => w.what.includes(id))).toBe(false)
  })

  it('reads the record on its safety checks, in case a message is lost, and says nothing more is planned at the deadline', async () => {
    const id = await ask('Which crystal load capacitance should be used?')
    const k = new Fakes()
    const out = await waitForAnswer(journeyScope(), id, 10 * 60_000, { now: k.now, log: () => undefined, events: { ...eventsOf({ TRACE_BATCH_EVENTS_TOPIC: TOPIC }, 'acme/board')!, sqs: k.sqs, sns: k.sns } })
    await sweepInFlight()
    expect(out).toMatchObject({ answered: null, waited_on: 'events', next_check_at: null, next: expect.stringMatching(/Never take the recommended option[\s\S]*no further check is planned/) })
    // the long polls stop at each safety read: 30 s, 90 s, then every 5 minutes, up to the 10-minute deadline
    const start = k.receives[0]!
    expect(k.receives.map((t) => Math.round((t - start) / 1000))).toEqual([0, 20, 30, 50, 70, 90, 110, 130, 150, 170, 190, 210, 230, 250, 270, 290, 310, 330, 350, 370, 390, 410, 430, 450, 470, 490, 510, 530, 550, 570, 590])
  })

  it('falls back to its timer when subscribing fails, for what is left of the wait, and says why and when it looks next', async () => {
    const id = await ask('Which pull-up value for the I2C bus?')
    const k = new Fakes()
    k.failSubscribe = new Error('AuthorizationError')
    const sleeps: number[] = []
    const lines: string[] = []
    const out = await waitForAnswer(journeyScope(), id, 60_000, {
      now: k.now, log: (l) => lines.push(l), sleep: async (ms) => { sleeps.push(ms); k.t += ms },
      events: { ...eventsOf({ TRACE_BATCH_EVENTS_TOPIC: TOPIC }, 'acme/board')!, sqs: k.sqs, sns: k.sns },
    })
    await sweepInFlight()
    expect(out).toMatchObject({ answered: null, waited_on: 'timer', why_timer: expect.stringMatching(/setting up its event subscription failed \(AuthorizationError\)/), next_check_at: expect.any(String) })
    expect(sleeps[0]).toBe(30_000)
    expect(lines.join('\n')).toMatch(/waiting on a timer: setting up/)
    // what it made before failing is removed
    expect(k.deleted).toHaveLength(1)
  })

  it('falls back to its timer when receiving fails mid-wait, and still finds the answer', async () => {
    const id = await ask('Which ferrite bead on the supply input?')
    const k = new Fakes([null])
    let n = 0
    const realReceive = k.sqs.receiveMessage
    k.sqs.receiveMessage = async (i) => { if (++n === 2) throw new Error('QueueDoesNotExist'); return realReceive(i) }
    const out = await waitForAnswer(journeyScope(), id, 3_600_000, {
      now: k.now, log: () => undefined,
      sleep: async (ms) => { k.t += ms; await answer(id)() },
      events: { ...eventsOf({ TRACE_BATCH_EVENTS_TOPIC: TOPIC }, 'acme/board')!, sqs: k.sqs, sns: k.sns },
    })
    await sweepInFlight()
    expect(out).toMatchObject({ answered: { option: 'a' }, waited_on: 'timer', why_timer: expect.stringMatching(/receiving its events failed/) })
    expect(k.unsubscribed).toHaveLength(1)
  })
})
