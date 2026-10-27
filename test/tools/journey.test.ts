/** The journey tools: an agent reads the journey, asks people, checks the criteria trace owns and says when it is stuck. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_HIDDEN_TOOLS, apiTool } from '../../src/agents/runtime/tool.js'
import { bucketStore } from '../../src/api/action-kit.js'
import { AgentFactsStore, loadAgentFacts, projectsFromEnv } from '../../src/core/agent-facts.js'
import { backendFor } from '../../src/core/central.js'
import { answerQuestion, loadJourney, startJourney } from '../../src/core/journey.js'
import { JourneyStore } from '../../src/core/journey-store.js'
import { Registry, ToolError } from '../../src/core/registry.js'
import { Work } from '../../src/core/store.js'
import { allTools } from '../../src/tools/index.js'
import { journeyScope, tools, waitForAnswer } from '../../src/tools/journey/tools.js'

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
})
