/**
 * The wait relay: a job's MCP server (simulated in-process by src/core/wait-report.ts, pointed at a real runtime
 * server on 127.0.0.1:0) reports its waits; the runtime mirrors them as that job's, a held status for the job wakes
 * on them, check-now reaches the child's real timer, and the job's end cleans up. Plus the endpoints' refusals and
 * holds, and /delegate/wait's wait attributed to the specialist's job.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from '../../src/core/config.js'
import { activeWaits, checkNow, isMirrored, trackEventWait, waitWithTimer } from '../../src/core/wait.js'
import { type WaitReporter, startWaitReporter } from '../../src/core/wait-report.js'
import { createDelegations } from '../../src/agents/runtime/delegation.js'
import { openWaitRelay } from '../../src/agents/runtime/job.js'
import { type JobRunner, type Jobs, createJobs } from '../../src/agents/runtime/jobs.js'
import type { JobPayload } from '../../src/agents/runtime/schemas.js'
import { createAgentServer, handler } from '../../src/agents/runtime/server.js'
import { MAX_WAKES_S, type WaitRelay, createWaitRelay } from '../../src/agents/runtime/wait-relay.js'

const TASK: JobPayload = { kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm@example.com', agent: 'impl' }
const quiet = { echo: () => undefined }

interface StatusAnswer { version: number; waits: { id: string; what: string; source: string; text: string; jobId: string | null }[] }

describe('the wait relay', () => {
  const cleanup: (() => Promise<void> | void)[] = []
  afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })

  const serve = async (jobs: Jobs, relay: WaitRelay, delegations = createDelegations()): Promise<string> => {
    const s = createAgentServer(jobs, { delegations, waitRelay: relay, log: () => undefined })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    cleanup.push(async () => { await jobs.shutdown(200); jobs.dispose(); s.closeAllConnections(); await new Promise((r) => s.close(() => r(undefined))) })
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  }
  const post = async (url: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
    return { status: r.status, json: (await r.json()) as Record<string, unknown> }
  }

  it('mirrors a job\'s tool wait as that job\'s: held status wakes and lists it, check-now reaches the child\'s timer, the job\'s end cleans up', async () => {
    const relay = createWaitRelay()
    let base = ''
    let reporter: WaitReporter | null = null
    let checks = 0
    let release!: () => void
    const stopTimer = new AbortController()
    let timer: Promise<unknown> | null = null
    let childWaitId = ''
    const gate = new Promise<void>((r) => { release = r })
    // the job: registered on the relay (as job.ts does), its "MCP child" reports with the env it was given
    const runner: JobRunner = async (_p, ctx) => {
      const w = openWaitRelay({ waitRelay: relay, waitsUrl: base }, ctx.jobId)
      try {
        reporter = startWaitReporter({ url: w.env.TRACE_WAITS_URL!, token: w.env.TRACE_WAITS_TOKEN! }, { log: () => undefined })
        // outside withJob, as in the child process: nothing there knows the job
        timer = waitWithTimer({
          what: 'the graphics card job g-7', why: 'AWS Batch sends no event this process can receive', intervalMs: 60_000,
          now: () => Date.now() - 10_000, signal: stopTimer.signal,
          check: async () => { checks++; return { done: false, state: 'RUNNABLE' } },
        })
        await gate
        return 'done'
      } finally {
        w.close()
      }
    }
    const jobs = createJobs(runner, quiet)
    base = await serve(jobs, relay)
    cleanup.push(() => { reporter?.stop(); stopTimer.abort() })
    const inv = (body: unknown) => post(`${base}/invocations`, body)

    const { jobId } = (await inv(TASK)).json as { jobId: string }
    const first = (await inv({ kind: 'status', jobId })).json as unknown as StatusAnswer
    // held until the child's wait reaches this job's record (or already there)
    const checked = (w: StatusAnswer['waits'][number] | undefined): boolean => Boolean(w?.text.includes('(runnable)'))
    let mirrored: StatusAnswer['waits'][number] | undefined = first.waits.find((w) => w.what === 'the graphics card job g-7')
    let v = first.version
    // each held answer comes with a change: opened, then updated after the child's first check
    while (!checked(mirrored)) {
      const held = (await inv({ kind: 'status', jobId, afterVersion: v, waitS: 5 })).json as unknown as StatusAnswer
      expect(held.version).toBeGreaterThan(v)
      v = held.version
      mirrored = held.waits.find((w) => w.what === 'the graphics card job g-7')
    }
    if (!mirrored) throw new Error('not mirrored')
    expect(mirrored.jobId).toBe(jobId)
    expect(mirrored.source).toBe('timer')
    expect(mirrored.text).toMatch(/^Waiting for the graphics card job g-7 \(runnable\)\. Checked 1\d seconds ago; next check in [45]\d seconds\.$/)
    childWaitId = activeWaits().find((w) => w.what === 'the graphics card job g-7' && !isMirrored(w.id))!.id
    // in-process the child's id is taken on this record, so the mirror has its own; a separate process keeps it
    expect(mirrored.id).not.toBe(childWaitId)
    expect(relay.mirroredOf(jobId)).toEqual([mirrored.id])
    await vi.waitFor(() => expect(relay.heldOf(jobId)).toBe(1), { timeout: 2000, interval: 5 })
    await vi.waitFor(() => expect(checks).toBe(1), { timeout: 2000, interval: 5 })

    // check-now on the mirrored wait wakes the child's real timer: one extra check
    expect((await inv({ kind: 'check-now', waitId: mirrored.id })).json).toEqual({ ok: true })
    await vi.waitFor(() => expect(checks).toBe(2), { timeout: 2000, interval: 5 })
    // the loop holds again
    await vi.waitFor(() => expect(relay.heldOf(jobId)).toBe(1), { timeout: 2000, interval: 5 })

    // the child's wait ends: the mirror goes with it
    stopTimer.abort()
    await timer
    await reporter!.flushed()
    expect(activeWaits().some((w) => w.what === 'the graphics card job g-7')).toBe(false)
    expect(relay.mirroredOf(jobId)).toEqual([])

    // one left open when the job ends is cleaned up then; the token dies
    const ev = trackEventWait({ what: 'the knowledge base sync k-9' })
    await reporter!.flushed()
    expect(activeWaits().find((w) => w.what === 'the knowledge base sync k-9' && isMirrored(w.id))?.jobId).toBe(jobId)
    release()
    await jobs.waitForEnd(jobId, { timeoutMs: 2000 })
    expect(activeWaits().filter((w) => w.what === 'the knowledge base sync k-9').map((w) => isMirrored(w.id))).toEqual([false])
    await reporter!.loop
    ev.end()
  })

  it('refuses a wrong token (403), bad bodies (400), and stops the child after a refusal', async () => {
    const relay = createWaitRelay()
    const jobs = createJobs(async () => 'x', quiet)
    const base = await serve(jobs, relay)
    relay.register('job-a')
    cleanup.push(() => relay.unregister('job-a'))
    const notice = { id: 'wait-x', what: 'x', source: 'event', startedAt: new Date().toISOString(), jobId: null, state: null, lastCheckedAt: null, nextCheckAt: null, intervalMs: null, checks: 0, why: null }
    expect((await post(`${base}/waits/report`, { token: 'f'.repeat(64), change: { type: 'opened', notice } })).status).toBe(403)
    expect((await post(`${base}/waits/wakes`, { token: 'f'.repeat(64), timeoutS: 1 })).status).toBe(403)
    expect((await post(`${base}/waits/report`, { token: 'f'.repeat(64) })).status).toBe(400)
    expect((await post(`${base}/waits/wakes`, { token: 'f'.repeat(64) })).status).toBe(400)
    const lines: string[] = []
    const r = startWaitReporter({ url: base, token: 'f'.repeat(64) }, { log: (l) => lines.push(l) })!
    await r.loop
    expect(lines.join('\n')).toMatch(/refused the wait relay \(403\)/)
    // stopped: reports nothing more
    const w = trackEventWait({ what: 'after the refusal' })
    w.end()
    await r.flushed()
    expect(relay.mirroredOf('job-a')).toEqual([])
  })

  it('answers non-loopback callers 403', async () => {
    const relay = createWaitRelay()
    const token = relay.register('job-a')
    cleanup.push(() => relay.unregister('job-a'))
    const jobs = createJobs(async () => 'x', quiet)
    cleanup.push(() => jobs.dispose())
    for (const path of ['/waits/report', '/waits/wakes']) {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ token, timeoutS: 1 }))]), { method: 'POST', url: path, headers: {}, socket: { remoteAddress: '10.0.0.5' } }) as unknown as IncomingMessage
      const out = new EventEmitter() as EventEmitter & { status?: number; body?: string; writeHead: (s: number) => void; end: (b: string) => void; headersSent: boolean; writableFinished: boolean }
      out.headersSent = false
      out.writableFinished = false
      out.writeHead = (s: number) => { out.status = s; out.headersSent = true }
      const done = new Promise<void>((r) => { out.end = (b: string) => { out.body = b; out.writableFinished = true; r() } })
      handler(jobs, { waitRelay: relay, log: () => undefined })(req, out as unknown as ServerResponse)
      await done
      expect(out.status).toBe(403)
      expect(JSON.parse(out.body!)).toMatchObject({ error: expect.stringMatching(/own jobs/) as unknown })
    }
  })

  it('/waits/wakes is held at most 240 s, and released (listening stops) when the client goes', async () => {
    const real = createWaitRelay()
    const asked: number[] = []
    const relay: WaitRelay = { ...real, wakes: (t, o) => { asked.push(o.timeoutMs); return real.wakes(t, { ...o, timeoutMs: Math.min(o.timeoutMs, 30) }) } }
    const jobs = createJobs(async () => 'x', quiet)
    const base = await serve(jobs, relay)
    const token = real.register('job-a')
    cleanup.push(() => real.unregister('job-a'))
    expect((await post(`${base}/waits/wakes`, { token, timeoutS: 3600 })).json).toEqual({ waitIds: [] })
    expect(asked).toEqual([MAX_WAKES_S * 1000])
    expect(MAX_WAKES_S).toBe(240)

    const gone = new AbortController()
    const p = post(`${base}/waits/wakes`, { token, timeoutS: 200 }, gone.signal).catch(() => 'aborted')
    await vi.waitFor(() => expect(real.heldOf('job-a')).toBe(1), { timeout: 2000, interval: 5 })
    gone.abort()
    expect(await p).toBe('aborted')
    await vi.waitFor(() => expect(real.heldOf('job-a')).toBe(0), { timeout: 2000, interval: 5 })
  })

  it('a wake asked for while none is held is answered on the next call; the job\'s end releases a held one', async () => {
    const relay = createWaitRelay()
    const token = relay.register('job-a')
    const now = new Date(Date.now() - 10_000).toISOString()
    relay.report(token, { type: 'opened', notice: { id: 'wait-child1', what: 'the batch job', source: 'timer', startedAt: now, jobId: null, state: null, lastCheckedAt: now, nextCheckAt: now, intervalMs: 60_000, checks: 1, why: 'no event' } })
    const [id] = relay.mirroredOf('job-a')
    expect(id).toBe('wait-child1')
    expect(activeWaits().find((w) => w.id === id)?.jobId).toBe('job-a')
    expect(checkNow(id!)).toBe(true)
    expect(await relay.wakes(token, { timeoutMs: 1000 })).toEqual(['wait-child1'])
    const held = relay.wakes(token, { timeoutMs: 10_000 })
    relay.unregister('job-a')
    expect(await held).toEqual([])
    expect(activeWaits().some((w) => w.id === id)).toBe(false)
    expect(() => relay.report(token, { type: 'ended', notice: { id: 'wait-child1', what: 'x', source: 'timer', startedAt: now, state: null, lastCheckedAt: null, nextCheckAt: null, intervalMs: null, checks: 0, why: null } })).toThrow(/not a running job/)
  })

  it('/delegate/wait\'s wait carries the specialist\'s job id', async () => {
    const release = new Map<string, () => void>()
    const jobs = createJobs((_p, ctx) => new Promise((res) => { release.set(ctx.jobId, () => res('ok')) }), quiet)
    const d = createDelegations()
    const base = await serve(jobs, createWaitRelay(), d)
    const cfg = resolve({}).config
    const token = d.register({ jobId: 'job-spec', kind: 'impl', repository: 'o/r', dir: '/w', cfg, branch: 'claude/x', defaultBranch: 'main', session: 's' })
    const w = d.start({ token, brief: 'x', acceptance: ['y'] }, (p) => jobs.startJob(p))
    const waiting = post(`${base}/delegate/wait`, { token, jobId: w.jobId, timeoutS: 30 })
    await vi.waitFor(() => expect(activeWaits().find((x) => x.what === `the worker job ${w.jobId}`)?.jobId).toBe('job-spec'), { timeout: 2000, interval: 5 })
    expect(activeWaits().filter((x) => x.what === `the worker job ${w.jobId}`)).toHaveLength(1)
    const st = (await post(`${base}/invocations`, { kind: 'status', jobId: 'job-spec' })).json as unknown as StatusAnswer
    expect(st.waits.map((x) => x.what)).toEqual([`the worker job ${w.jobId}`])
    release.get(w.jobId)!()
    expect((await waiting).json.job).toMatchObject({ delegation: 'succeeded' })
  })
})
