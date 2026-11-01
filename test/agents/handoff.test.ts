/**
 * Hand-offs on the runtime: the asking job's token, starting the receiving job from the recorded request (depth 1, its
 * hand-off id, a queued task of its own), the loopback endpoint, and the runner's side: the asking job is offered
 * journey.handoff, the receiving one only journey.handoff_answer, a declined one never runs, and one that ends without
 * answering closes its hand-off as failed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SPECIALISTS, toolsOf } from '../../src/agents/index.js'
import { HANDOFF_ANSWER_TOOL, HANDOFF_TOOL, specialistPrompt } from '../../src/agents/specialist.js'
import { createHandoffRuntime, endedWithout, handoffPayload } from '../../src/agents/runtime/handoff.js'
import { type ClaudeOptions, type RunnerDeps, createRunner } from '../../src/agents/runtime/job.js'
import { createJobs, jobKey, pausable } from '../../src/agents/runtime/jobs.js'
import { titleOf } from '../../src/agents/runtime/job-index.js'
import { HandoffTaskPayload, InvocationSchema, type JobPayload, TaskPayload, isHandoff } from '../../src/agents/runtime/schemas.js'
import { createAgentServer } from '../../src/agents/runtime/server.js'
import { createWaitRelay } from '../../src/agents/runtime/wait-relay.js'
import { AgentFactsStore } from '../../src/core/agent-facts.js'
import { S3Backend } from '../../src/core/central.js'
import { addHandoff, answerHandoff, declineHandoff, loadHandoffs } from '../../src/core/handoffs.js'
import { JobIndexStore, putJob } from '../../src/core/job-index.js'
import { startJourney } from '../../src/core/journey.js'
import { JourneyStore, forgetNoJourney } from '../../src/core/journey-store.js'
import { FakeS3 } from '../core/fake-s3.js'
import { cfgOf, fakeGithub } from '../harness/fake.js'

const REQ = {
  to: 'ams', question: 'What is the worst-case dissipation of the LDO U3 at 85 °C ambient with a 500 mA load?',
  evidence: [{ kind: 'run', ref: 'run-42' }], blocks: 'the junction temperature check of U3', acceptance: ['the dissipation in watts at 500 mA, with the run id'],
}
const OPEN = { enabled: ['verify', 'impl', 'ams', 'emc', 'render', 'thermal'] as const, limits: { perJob: 3, perProject: 10 }, declined: new Set<string>() }
const ASKER = { jobId: 'job-th1', kind: 'thermal' as const, repository: 'o/r', enabled: [...OPEN.enabled], limits: OPEN.limits }

function stores() {
  const b = new S3Backend('bucket', 'projects', new FakeS3())
  return { facts: new AgentFactsStore(b, 'o/r'), journey: new JourneyStore(b, 'o/r') }
}
const raise = async (s: ReturnType<typeof stores>, job = 'job-th1', r = REQ) =>
  (await s.facts.update((db) => ({ result: addHandoff(db, { agent: 'thermal', label: 'the Thermal specialist', jobId: job }, r, OPEN) }))).result

beforeEach(() => forgetNoJourney())

describe('the receiving job', () => {
  it('is a task of the asked specialist built from the recorded request only: depth 1, its hand-off id, a key of its own', async () => {
    const s = stores()
    const h = await raise(s)
    const p = handoffPayload(h, 'o/r')
    expect(HandoffTaskPayload.safeParse(p).success).toBe(true)
    expect(p).toMatchObject({ kind: 'task', agent: 'ams', request: REQ.question, requestedBy: 'the Thermal specialist (job job-th1)', handoff: { id: h.id, from: 'thermal', fromJob: 'job-th1', depth: 1, acceptance: REQ.acceptance } })
    expect(isHandoff(p)).toBe(true)
    expect(jobKey(p)).toBe(`o/r:handoff:${h.id}`)
    expect(pausable(p)).toBe(false)
    expect(titleOf(p)).toBe(`Asked by the Thermal specialist: ${REQ.question}`)
    // never from a caller: /invocations does not accept one (it is not a task with extra keys)
    expect(InvocationSchema.safeParse({ ...p }).success).toBe(false)
  })

  it('is started by the runtime for the token\'s own requested hand-off only, and marks it started (or failed)', async () => {
    const s = stores()
    const rt = createHandoffRuntime({ ...s, repository: 'o/r' })
    const token = rt.register(ASKER)
    const h = await raise(s)
    const other = await raise(s, 'job-other', { ...REQ, question: `${REQ.question} At 1 A.` })
    const started: JobPayload[] = []
    const startJob = (p: JobPayload) => { started.push(p); return { accepted: true, jobId: 'job-a1' } }
    await expect(rt.start('x'.repeat(64), h.id, startJob)).rejects.toThrow(/not a running specialist job/)
    await expect(rt.start(token, other.id, startJob)).rejects.toThrow(/not a hand-off this job raised/)
    const r = await rt.start(token, h.id, startJob)
    expect(r).toMatchObject({ accepted: true, jobId: 'job-a1', handoff: h.id })
    expect(started).toHaveLength(1)
    expect((await s.facts.read((db) => loadHandoffs(db))).result.find((x) => x.id === h.id)).toMatchObject({ state: 'started', jobId: 'job-a1' })
    // a second start does nothing
    expect(await rt.start(token, h.id, startJob)).toMatchObject({ accepted: false, reason: 'it is started already' })
    expect(started).toHaveLength(1)
    // one the jobs refuse is closed as failed
    const third = await raise(s, 'job-th1', { ...REQ, question: `${REQ.question} At 2 A.` })
    expect(await rt.start(token, third.id, () => ({ accepted: false, jobId: '', reason: 'shutting down' }))).toMatchObject({ accepted: false })
    expect((await s.facts.read((db) => loadHandoffs(db))).result.find((x) => x.id === third.id)).toMatchObject({ state: 'failed', why: expect.stringMatching(/not accepted \(shutting down\)/) })
    rt.unregister('job-th1')
    await expect(rt.start(token, h.id, startJob)).rejects.toThrow(/not a running specialist job/)
  })

  it('is not started once a person declined it, and stops at its turn when declined while queued', async () => {
    const s = stores()
    await s.journey.update((db) => { startJourney(db, { template: 'board', by: 'a@example.com', name: 'x' }); return { result: null } })
    const rt = createHandoffRuntime({ ...s, repository: 'o/r' })
    const token = rt.register(ASKER)
    const h = await raise(s)
    await s.journey.update((db) => ({ result: declineHandoff(db, h, { hash: 'h', label: 'u@example.com' }, 'The bench measures it.', { jobState: null }) }))
    expect(await rt.start(token, h.id, () => { throw new Error('not started') })).toMatchObject({ accepted: false, reason: 'declined by u@example.com: The bench measures it.' })
    expect(await rt.begin(h.id, 'job-a1')).toEqual({ declined: { reason: 'The bench measures it.', by: 'u@example.com' } })
    expect((await s.facts.read((db) => loadHandoffs(db))).result[0]).toMatchObject({ state: 'failed', why: 'declined by u@example.com: The bench measures it.' })
  })

  it('settles: a job that ended without answering closes its hand-off, an answered one is left as it is', async () => {
    const s = stores()
    const rt = createHandoffRuntime({ ...s, repository: 'o/r' })
    const h = await raise(s)
    await rt.begin(h.id, 'job-a1')
    await s.facts.update((db) => ({ result: answerHandoff(db, h.id, 'job-a1', { answered: true, text: '0.85 W at 500 mA and 85 °C ambient.', evidence: [{ kind: 'run', ref: 'run-9' }], confidence: 0.8, acceptanceMet: true }) }))
    expect(await rt.settle(h.id, endedWithout('succeeded', 'done'))).toBe(false)
    const h2 = await raise(s, 'job-th1', { ...REQ, question: `${REQ.question} At 1 A.` })
    await rt.begin(h2.id, 'job-a2')
    expect(await rt.settle(h2.id, endedWithout('aborted', 'cancelled by u@example.com'))).toBe(true)
    expect((await s.facts.read((db) => loadHandoffs(db))).result.map((x) => [x.state, x.why])).toEqual([['answered', null], ['failed', 'its job was cancelled (cancelled by u@example.com)']])
  })
  it('carries on: once answered, the asking specialist starts again on the answering branch when its own job has ended', async () => {
    const b = new S3Backend('bucket', 'projects', new FakeS3())
    const s = { facts: new AgentFactsStore(b, 'o/r'), journey: new JourneyStore(b, 'o/r') }
    const jobs = new JobIndexStore(b, 'o/r')
    const at = 1_800_000_000
    const rt = createHandoffRuntime({ ...s, jobs, repository: 'o/r', now: () => at })
    const h = await raise(s)
    await rt.begin(h.id, 'job-a1')
    const started: JobPayload[] = []
    const startJob = (p: JobPayload) => { started.push(p); return { accepted: true, jobId: 'job-c1' } }
    // not answered yet: nothing starts
    expect(await rt.carryOn(h.id, 'claude/handoff-x', startJob)).toBeNull()
    await s.facts.update((db) => ({ result: answerHandoff(db, h.id, 'job-a1', { answered: true, text: '0.85 W at 500 mA and 85 °C ambient (run-9).', evidence: [{ kind: 'run', ref: 'run-9' }], confidence: 0.8, acceptanceMet: true }) }))
    // the asking job still running: it reads the answer itself
    await jobs.update((db) => { putJob(db, 'job-th1', { state: 'running', kind: 'task', agent: 'thermal', title: 'x', startedAt: at - 60, beatAt: at - 10 }, at); return { result: null } })
    expect(await rt.carryOn(h.id, 'claude/handoff-x', startJob)).toBeNull()
    // ended: the asking specialist starts again on the answering branch, told the answer
    await jobs.update((db) => { putJob(db, 'job-th1', { state: 'succeeded', endedAt: at - 5 }, at); return { result: null } })
    expect(await rt.carryOn(h.id, 'claude/handoff-x', startJob)).toBe('job-c1')
    expect(started).toHaveLength(1)
    const p = started[0]!
    expect(p).toMatchObject({ kind: 'task', repository: 'o/r', agent: 'thermal', branch: 'claude/handoff-x', requestedBy: `hand-off ${h.id}` })
    expect(TaskPayload.safeParse(p).success).toBe(true)
    if (p.kind !== 'task') throw new Error('not a task')
    expect(p.request).toContain(REQ.question)
    expect(p.request).toContain('0.85 W at 500 mA')
    expect(p.request).toMatch(/you are on that branch.*push to the same branch/s)
    expect(p.request).toMatch(/ask a person \(journey\.ask\) rather than hand the same question back/)
  })
})

describe('POST /handoff', () => {
  it('starts the receiving job on this runtime, in the asking job\'s session, for loopback callers with a token', async () => {
    const s = stores()
    const rt = createHandoffRuntime({ ...s, repository: 'o/r' })
    const token = rt.register({ ...ASKER, jobId: 'job-asker' })
    const h = await raise(s, 'job-asker')
    const sessions: (string | undefined)[] = []
    const jobs = createJobs(async () => 'ok', { echo: () => undefined })
    const realStart = jobs.startJob.bind(jobs)
    jobs.startJob = (p, session) => { sessions.push(session); return realStart(p, session) }
    // the asking job, running in its AgentCore session
    jobs.jobStatus = (id?: string) => (id === 'job-asker' ? [{ id, kind: 'task', key: 'k', state: 'running', startedAt: '', log: [], session: 'sess-asker' }] : [])
    const server = createAgentServer(jobs, { handoffs: rt, delegations: undefined })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/handoff`
    try {
      const bad = await fetch(url, { method: 'POST', body: JSON.stringify({ token: 'x'.repeat(64), id: h.id }) })
      expect(bad.status).toBe(403)
      const r = await fetch(url, { method: 'POST', body: JSON.stringify({ token, id: h.id }) })
      expect(r.status).toBe(200)
      const out = await r.json() as { accepted: boolean; jobId: string }
      expect(out.accepted).toBe(true)
      expect(sessions).toEqual(['sess-asker'])
      expect((await s.facts.read((db) => loadHandoffs(db))).result[0]).toMatchObject({ state: 'started', jobId: out.jobId })
      const none = createAgentServer(jobs, { handoffs: null })
      await new Promise<void>((r2) => none.listen(0, '127.0.0.1', r2))
      expect((await fetch(`http://127.0.0.1:${(none.address() as AddressInfo).port}/handoff`, { method: 'POST', body: '{}' })).status).toBe(404)
      await new Promise((r2) => none.close(() => r2(undefined)))
    } finally {
      await new Promise((r) => server.close(() => r(undefined)))
      await jobs.shutdown(200)
    }
  })
})

describe('in the job runner', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const TOKEN = 'ghs_TESTTOKEN1234567890abcdef'

  function setup(result = 'Done.') {
    const ws = mkdtempSync(join(tmpdir(), 'trace-handoff-ws-')); dirs.push(ws)
    const calls: { prompt: string; options: ClaudeOptions }[] = []
    const s = stores()
    const handoffs = createHandoffRuntime({ ...s, repository: 'o/r' })
    const f = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] })
    const d: RunnerDeps = {
      exec: async () => ({ stdout: '', stderr: '' }), getToken: async () => TOKEN, github: () => f.gh,
      claude: (a) => { calls.push(a); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result, num_turns: 3 } })() },
      settingsOf: () => cfgOf({ agents: { handoff_max_per_job: 2 } }), remoteSettings: async () => cfgOf(), workspace: ws, persistent: false, cli: '/app/dist/cli.js', timeoutS: 60,
      env: { PATH: '/usr/bin' }, now: Date.now, delegateUrl: 'http://127.0.0.1:8080', waitRelay: createWaitRelay(), handoffs,
    }
    return { d, calls, s, handoffs }
  }
  const ctx = (jobId: string) => ({ jobId, signal: new AbortController().signal, log: () => undefined, startJob: () => ({ accepted: true, jobId: 'x' }), route: () => undefined })

  it('offers an asking specialist journey.handoff, with its token, the enabled specialists and the limits in its MCP server only', async () => {
    const h = setup()
    let seen: Record<string, string> | undefined
    h.d.claude = (a) => { h.calls.push(a); seen = a.options.mcpServers.trace!.env; return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1 } })() }
    await createRunner(h.d)({ kind: 'task', repository: 'o/r', request: 'Check junction temperatures of U3', requestedBy: 'm@example.com', agent: 'thermal' }, ctx('job-th1'))
    const { prompt, options } = h.calls[0]!
    expect(seen!.TRACE_MCP_TOOLS!.split(',')).toEqual(toolsOf(SPECIALISTS.thermal, { delegate: false, handoff: 'ask' }))
    expect(seen!.TRACE_MCP_TOOLS).toContain(HANDOFF_TOOL)
    expect(seen!.TRACE_MCP_TOOLS).not.toContain(HANDOFF_ANSWER_TOOL)
    expect(seen).toMatchObject({ TRACE_HANDOFF_URL: 'http://127.0.0.1:8080', TRACE_HANDOFF_ENABLED: 'verify,impl,ams,emc,render,thermal', TRACE_HANDOFF_LIMITS: '2,10' })
    expect(seen!.TRACE_HANDOFF_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(options.env.TRACE_HANDOFF_TOKEN).toBeUndefined()
    expect(prompt).toMatch(/ASKING ANOTHER SPECIALIST[\s\S]*- ams: the Analog and mixed-signal specialist/)
    expect(prompt).not.toMatch(/- thermal: the Thermal specialist/)
    expect(prompt).toMatch(/a job another specialist started cannot hand off again/)
    // its token is dead once it ended
    await expect(h.handoffs.start(seen!.TRACE_HANDOFF_TOKEN!, 'ho0000000000000a', () => ({ accepted: true, jobId: 'x' }))).rejects.toThrow(/not a running specialist job/)
  })

  it('runs the receiving job as the asked specialist with the hand-off header and only the answer tool; it closes the hand-off when it ends unanswered', async () => {
    const h = setup('I looked; no answer recorded.')
    const ho = await raise(h.s)
    let seen: Record<string, string> | undefined
    h.d.claude = (a) => { h.calls.push(a); seen = a.options.mcpServers.trace!.env; return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'I looked.', num_turns: 2 } })() }
    const routes: unknown[] = []
    const out = await createRunner(h.d)(handoffPayload(ho, 'o/r'), { ...ctx('job-a1'), route: (r: unknown) => { routes.push(r) } })
    expect(out).toMatch(/^ams: done in 2 turns/)
    expect(routes).toEqual([expect.objectContaining({ kind: 'ams', source: 'explicit' })])
    const { prompt } = h.calls[0]!
    expect(prompt).toMatch(/THE JOB: the Thermal specialist \(job job-th1\) asked you this, as hand-off ho[0-9a-f]{14}/)
    expect(prompt).toContain(`> ${REQ.question}`)
    expect(prompt).toMatch(/A good answer contains:\n1\. the dissipation in watts/)
    expect(prompt).toMatch(/ANSWERING THE HAND-OFF: answer it with journey_handoff_answer/)
    expect(prompt).not.toContain('ASKING ANOTHER SPECIALIST')
    expect(prompt).toMatch(/GUARDRAILS[\s\S]*$/)
    expect(seen!.TRACE_MCP_TOOLS).toContain(HANDOFF_ANSWER_TOOL)
    expect(seen!.TRACE_MCP_TOOLS).not.toContain(HANDOFF_TOOL + ',')
    expect(seen!.TRACE_MCP_TOOLS!.split(',')).not.toContain(HANDOFF_TOOL)
    expect(seen).toMatchObject({ TRACE_HANDOFF_ID: ho.id, TRACE_JOB_ID: 'job-a1', TRACE_AGENT: 'ams' })
    expect(seen!.TRACE_HANDOFF_TOKEN).toBeUndefined()
    // it ended without answering: failed, with its report, so the asker is told
    expect((await h.s.facts.read((db) => loadHandoffs(db))).result[0]).toMatchObject({ state: 'failed', jobId: 'job-a1', why: expect.stringMatching(/^its job finished without answering it \(its report: I looked\.\)/) })
  })

  it('does not run a hand-off a person declined while it was queued', async () => {
    const h = setup()
    await h.s.journey.update((db) => { startJourney(db, { template: 'board', by: 'a@example.com', name: 'x' }); return { result: null } })
    const ho = await raise(h.s)
    await h.s.journey.update((db) => ({ result: declineHandoff(db, ho, { hash: 'h', label: 'u@example.com' }, 'Measured on the bench instead.', { jobState: 'queued' }) }))
    const out = await createRunner(h.d)(handoffPayload(ho, 'o/r'), ctx('job-a1'))
    expect(out).toMatch(/declined by u@example.com: Measured on the bench instead\./)
    expect(h.calls).toEqual([])
  })

  it('the prompt of a hand-off job keeps its parts locked and its guardrails last', () => {
    const p = specialistPrompt(SPECIALISTS.ams, {
      cfg: cfgOf(), repository: 'o/r', rules: null, handoff: 'answer',
      job: { kind: 'handoff', branch: 'claude/handoff-x', handoff: handoffPayload({ id: 'ho0123456789abcd', fromAgent: 'thermal', fromLabel: 'the Thermal specialist', fromJob: 'job-1', toKind: 'ams', question: REQ.question, evidence: REQ.evidence, blocks: REQ.blocks, recommendation: null, acceptance: REQ.acceptance, depth: 1, state: 'started', createdAt: 0, jobId: 'job-a1', startedAt: 0, answer: null, answerEvidence: [], confidence: null, acceptanceMet: null, answeredAt: null, why: null, endedAt: null }, 'o/r').handoff },
    })
    expect(p).toMatch(/Its recommended answer, to confirm or correct:\n\(none given\)/)
    expect(p.trimEnd().split('\n').at(-1)).toMatch(/workflow permissions\.$/)
  })
})
