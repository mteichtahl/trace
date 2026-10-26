/**
 * The jobs' event channel and what is built on it: waitForEnd / waitForChange (no race, no timer), POST /delegate/wait
 * (answered the instant the worker ends, the token's own children only, capped, cleaned up when the client goes),
 * a status invocation that holds until something changes, and check-now.
 */
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from '../../src/core/config.js'
import { activeWaits, waitWithTimer } from '../../src/core/wait.js'
import { MAX_WAIT_S, createDelegations } from '../../src/agents/runtime/delegation.js'
import { type JobEvent, type JobRunner, type Jobs, createJobs } from '../../src/agents/runtime/jobs.js'
import type { JobPayload } from '../../src/agents/runtime/schemas.js'
import { createAgentServer } from '../../src/agents/runtime/server.js'

const TASK: JobPayload = { kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm@example.com', agent: 'impl' }
const quiet = { echo: () => undefined }

/** A runner whose jobs end when released. */
function held() {
  const release = new Map<string, (summary: string) => void>()
  const runner: JobRunner = (_p, ctx) => new Promise((res, rej) => {
    release.set(ctx.jobId, res)
    ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason as Error))
  })
  return { runner, release }
}

describe('the jobs\' events', () => {
  it('emits started, log, routed and ended, each bumping the version', async () => {
    const seen: JobEvent[] = []
    const jobs = createJobs(async (_p, ctx) => { ctx.log('working'); ctx.route?.({ kind: 'impl', source: 'label', confidence: 1, reason: 'r' } as never); return 'done' }, quiet)
    jobs.events.on((e) => seen.push(e))
    expect(jobs.version()).toBe(0)
    const { jobId } = jobs.startJob(TASK)
    const end = await jobs.waitForEnd(jobId, { timeoutMs: 1000 })
    expect(end).toMatchObject({ id: jobId, state: 'succeeded', summary: 'done' })
    const types = seen.map((e) => e.type)
    expect(types[0]).toBe('log')
    expect(types).toContain('started')
    expect(types).toContain('routed')
    expect(types.at(-1)).toBe('ended')
    expect(seen.find((e) => e.type === 'log' && e.line.endsWith(' working'))).toBeTruthy()
    const versions = seen.map((e) => e.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
    expect(jobs.version()).toBe(versions.at(-1))
    expect(jobs.versionOf(jobId)).toBe(jobs.version())
    expect(jobs.versionOf('job-nope')).toBe(0)
  })

  it('waitForEnd resolves at once for a finished job, on the end event otherwise, and null on timeout, abort or an unknown id', async () => {
    const h = held()
    const jobs = createJobs(h.runner, quiet)
    const a = jobs.startJob(TASK).jobId
    const pending = jobs.waitForEnd(a)
    let done = false
    void pending.then(() => { done = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    h.release.get(a)!('ok')
    expect(await pending).toMatchObject({ id: a, state: 'succeeded' })
    // already ended: at once (no timeout needed)
    expect(await jobs.waitForEnd(a)).toMatchObject({ id: a, state: 'succeeded' })
    expect(await jobs.waitForEnd('job-nope')).toBeNull()
    const b = jobs.startJob({ ...TASK, request: 'y' }).jobId
    expect(await jobs.waitForEnd(b, { timeoutMs: 10 })).toBeNull()
    const c = new AbortController()
    const aborted = jobs.waitForEnd(b, { signal: c.signal })
    c.abort()
    expect(await aborted).toBeNull()
    expect(jobs.events.size).toBe(0)
    await jobs.shutdown(100)
  })

  it('waitForEnd never misses an end that happens between the check and listening', async () => {
    const h = held()
    const jobs = createJobs(h.runner, quiet)
    const id = jobs.startJob(TASK).jobId
    // end the job from inside the subscription: the instant waitFor starts listening, before `already` is asked
    const on = jobs.events.on.bind(jobs.events)
    const spy = vi.spyOn(jobs.events, 'on').mockImplementation((l) => {
      const off = on(l)
      h.release.get(id)!('raced')
      return off
    })
    // the release resolves a promise: the end lands a microtask later, while waitFor listens
    expect(await jobs.waitForEnd(id, { timeoutMs: 1000 })).toMatchObject({ id, state: 'succeeded', summary: 'raced' })
    spy.mockRestore()
  })

  it('waitForChange holds until the scope changes after the version, at once if it has, and the version on timeout', async () => {
    const h = held()
    const jobs = createJobs(h.runner, quiet)
    const a = jobs.startJob(TASK).jobId
    const b = jobs.startJob({ ...TASK, request: 'y' }).jobId
    const v = jobs.version()
    expect(await jobs.waitForChange(v - 1)).toBe(v)
    expect(await jobs.waitForChange(v, { timeoutMs: 10 })).toBe(v)
    // a change to b does not wake a wait on a
    const onA = jobs.waitForChange(jobs.versionOf(a), { jobId: a, timeoutMs: 1000 })
    h.release.get(b)!('b done')
    await jobs.waitForEnd(b)
    h.release.get(a)!('a done')
    expect(await onA).toBeGreaterThan(jobs.versionOf(b))
    expect(jobs.events.size).toBe(0)
  })
})

describe('the runtime server, event-driven', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => { await close?.(); close = null })
  const serve = async (jobs: Jobs, delegations = createDelegations()): Promise<string> => {
    const s = createAgentServer(jobs, { delegations, log: () => undefined })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    close = async () => { await jobs.shutdown(100); await new Promise((r) => s.close(() => r(undefined))) }
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  }
  const post = async (url: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
    return { status: r.status, json: (await r.json()) as Record<string, unknown> }
  }
  const cfg = resolve({}).config
  const parent = (jobId = 'job-p') => ({ jobId, kind: 'impl' as const, repository: 'o/r', dir: '/w', cfg, branch: 'claude/x', defaultBranch: 'main', session: 's' })

  it('/delegate/wait answers the instant the worker ends, for the token\'s own children only', async () => {
    const h = held()
    const jobs = createJobs(h.runner, quiet)
    const d = createDelegations()
    const base = await serve(jobs, d)
    const a = d.register(parent())
    const b = d.register(parent('job-q'))
    const w = d.start({ token: a, brief: 'x', acceptance: ['y'] }, (p) => jobs.startJob(p))
    expect((await post(`${base}/delegate/wait`, { token: b, jobId: w.jobId, timeoutS: 5 })).status).toBe(404)
    expect((await post(`${base}/delegate/wait`, { token: 'f'.repeat(64), jobId: w.jobId, timeoutS: 5 })).status).toBe(403)
    expect((await post(`${base}/delegate/wait`, { token: a, jobId: w.jobId })).status).toBe(400)
    const t0 = Date.now()
    const waiting = post(`${base}/delegate/wait`, { token: a, jobId: w.jobId, timeoutS: 30 })
    await vi.waitFor(() => expect(activeWaits().some((x) => x.what === `the worker job ${w.jobId}`)).toBe(true), { timeout: 2000, interval: 5 })
    setTimeout(() => h.release.get(w.jobId)!('done in 2 turns'), 50)
    const r = await waiting
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.json.job).toMatchObject({ id: w.jobId, state: 'succeeded', delegation: 'succeeded', summary: 'done in 2 turns' })
    expect(activeWaits().some((x) => x.what === `the worker job ${w.jobId}`)).toBe(false)
    // ended: answered at once; /delegate/status still answers the same
    expect((await post(`${base}/delegate/wait`, { token: a, jobId: w.jobId, timeoutS: 30 })).json.job).toMatchObject({ delegation: 'succeeded' })
    expect((await post(`${base}/delegate/status`, { token: a, jobId: w.jobId })).json.job).toMatchObject({ delegation: 'succeeded' })
    expect(jobs.events.size).toBe(0)
  })

  it('/delegate/wait answers "still running" after timeoutS, capped at 240 s', async () => {
    const h = held()
    const real = createJobs(h.runner, quiet)
    const asked: (number | undefined)[] = []
    // the same jobs, its waitForEnd recording the timeout asked for (and keeping the test short)
    const jobs: Jobs = { ...real, waitForEnd: (id, o) => { asked.push(o?.timeoutMs); return real.waitForEnd(id, { ...o, timeoutMs: Math.min(o?.timeoutMs ?? 0, 30) }) } }
    const d = createDelegations()
    const base = await serve(jobs, d)
    const a = d.register(parent())
    const w = d.start({ token: a, brief: 'x', acceptance: ['y'] }, (p) => real.startJob(p))
    expect((await post(`${base}/delegate/wait`, { token: a, jobId: w.jobId, timeoutS: 3600 })).json.job).toMatchObject({ state: 'running', delegation: 'running' })
    expect(asked).toEqual([MAX_WAIT_S * 1000])
    expect(MAX_WAIT_S).toBe(240)
  })

  it('/delegate/wait stops listening when the client goes away', async () => {
    const h = held()
    const real = createJobs(h.runner, quiet)
    const d = createDelegations()
    const base = await serve(real, d)
    const a = d.register(parent())
    const w = d.start({ token: a, brief: 'x', acceptance: ['y'] }, (p) => real.startJob(p))
    const gone = new AbortController()
    const p = post(`${base}/delegate/wait`, { token: a, jobId: w.jobId, timeoutS: 200 }, gone.signal).catch(() => 'aborted')
    await vi.waitFor(() => expect(real.events.size).toBeGreaterThan(0), { timeout: 2000, interval: 5 })
    gone.abort()
    expect(await p).toBe('aborted')
    await vi.waitFor(() => expect(real.events.size).toBe(0), { timeout: 2000, interval: 5 })
    await vi.waitFor(() => expect(activeWaits().some((x) => x.what === `the worker job ${w.jobId}`)).toBe(false), { timeout: 2000, interval: 5 })
    expect(real.jobStatus(w.jobId)[0]?.state).toBe('running')
  })

  it('status answers at once with version and waits, and with afterVersion + waitS holds until a change', async () => {
    const h = held()
    const jobs = createJobs(h.runner, quiet)
    const base = await serve(jobs)
    const inv = (body: unknown) => post(`${base}/invocations`, body)
    const first = (await inv({ kind: 'status' })).json
    expect(first).toMatchObject({ jobs: [], busy: false, version: 0 })
    expect(Array.isArray(first.waits)).toBe(true)
    expect((await inv({ kind: 'status', waitS: 241, afterVersion: 0 })).status).toBe(400)
    // nothing changes: held for waitS, then answered as it stands
    const t0 = Date.now()
    expect((await inv({ kind: 'status', afterVersion: 0, waitS: 0.1 })).json).toMatchObject({ version: 0 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90)
    // a job starts while the answer is held: answered then
    const held2 = inv({ kind: 'status', afterVersion: 0, waitS: 30 })
    await vi.waitFor(() => expect(jobs.events.size).toBe(1), { timeout: 2000, interval: 5 })
    const id = jobs.startJob(TASK).jobId
    const r = (await held2).json as { jobs: { id: string }[]; version: number; busy: boolean }
    expect(r.version).toBeGreaterThan(0)
    expect(r.jobs.map((j) => j.id)).toContain(id)
    // one job's scope: held until that job ends
    const v = r.version
    const onJob = inv({ kind: 'status', jobId: id, afterVersion: jobs.versionOf(id), waitS: 30 })
    await vi.waitFor(() => expect(jobs.events.size).toBe(1), { timeout: 2000, interval: 5 })
    h.release.get(id)!('ok')
    const ended = (await onJob).json as { jobs: { state: string }[]; version: number }
    expect(ended.jobs[0]?.state).toBe('succeeded')
    expect(ended.version).toBeGreaterThan(v)
    expect(jobs.events.size).toBe(0)
  })

  it('status lists every open wait with its plain-language text; check-now wakes a timer wait', async () => {
    const jobs = createJobs(async () => 'x', quiet)
    const base = await serve(jobs)
    let checks = 0
    const stop = new AbortController()
    const timer = waitWithTimer({ what: 'the test thing', why: 'it sends no event', intervalMs: 60_000, now: () => Date.now() - 10_000, signal: stop.signal, check: async () => { checks++; return { done: false, state: 'IDLE' } } })
    await vi.waitFor(() => expect(checks).toBe(1), { timeout: 2000, interval: 5 })
    const st = (await post(`${base}/invocations`, { kind: 'status' })).json as { waits: { id: string; what: string; source: string; text: string }[] }
    const w = st.waits.find((x) => x.what === 'the test thing')!
    expect(w).toMatchObject({ source: 'timer' })
    expect(w.text).toMatch(/^Waiting for the test thing \(idle\)\. Checked 1\d seconds ago; next check in [45]\d seconds\.$/)
    expect((await post(`${base}/invocations`, { kind: 'check-now', waitId: w.id })).json).toEqual({ ok: true })
    await vi.waitFor(() => expect(checks).toBe(2), { timeout: 2000, interval: 5 })
    expect((await post(`${base}/invocations`, { kind: 'check-now', waitId: 'wait-nope' })).json).toEqual({ ok: false })
    expect((await post(`${base}/invocations`, { kind: 'check-now' })).status).toBe(400)
    stop.abort()
    expect(await timer).toMatchObject({ done: false, reason: 'aborted' })
  })

  it('check-now is not refused in single-project mode (it names no project)', async () => {
    const jobs = createJobs(async () => 'x', quiet)
    const s = createAgentServer(jobs, { project: 'acme/board', log: () => undefined })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    close = () => new Promise((r) => s.close(() => r()))
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    expect((await post(`${base}/invocations`, { kind: 'check-now', waitId: 'wait-x' })).json).toEqual({ ok: false })
  })
})
