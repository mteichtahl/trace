/**
 * agent.delegate against a fake runtime: it waits on /delegate/wait (held until the worker ends), never on a timer,
 * asks for at most 240 s a call, and keeps its overall timeout and cancel. It opens no wait of its own: the runtime's
 * /delegate/wait handler does (attributed to the specialist's job), so the wait is listed once.
 */
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { activeWaits } from '../../src/core/wait.js'
import { delegate, delegateEnv } from '../../src/tools/agent/tools.js'

interface Call { path: string; body: Record<string, unknown>; at: number }

const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** A runtime whose /delegate/wait holds for its timeoutS (still running), unless the worker ends after `endsAfterMs`. */
async function fakeRuntime(endsAfterMs: number | null): Promise<{ url: string; calls: Call[]; server: Server; seenWaits: string[] }> {
  const calls: Call[] = []
  const seenWaits: string[] = []
  const t0 = Date.now()
  const job = (state: string) => ({ job: { id: 'job-w', state, delegation: state === 'aborted' ? 'cancelled' : state, log: ['2026-10-26T00:00:00.000Z placing parts'], ...(state === 'succeeded' ? { summary: 'done' } : {}) } })
  const server = createServer((req, res) => {
    void (async () => {
      const b = await body(req)
      calls.push({ path: req.url ?? '', body: b, at: Date.now() })
      const send = (x: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)) }
      if (req.url === '/delegate') return send({ accepted: true, jobId: 'job-w' })
      if (req.url === '/delegate/cancel') return send({ jobId: 'job-w', delegation: 'cancelled' })
      if (req.url === '/delegate/wait') {
        seenWaits.push(...activeWaits().map((w) => `${w.source}:${w.what}`))
        const hold = Number(b.timeoutS) * 1000
        const endsIn = endsAfterMs === null ? Infinity : t0 + endsAfterMs - Date.now()
        if (endsIn <= hold) return setTimeout(() => send(job('succeeded')), Math.max(0, endsIn))
        return setTimeout(() => send(job('running')), hold)
      }
      res.writeHead(404); res.end('{}')
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server, seenWaits }
}

describe('agent.delegate', () => {
  const saved = { ...process.env }
  let server: Server | null = null
  afterEach(async () => {
    for (const k of ['TRACE_DELEGATE_URL', 'TRACE_DELEGATE_TOKEN', 'TRACE_DELEGATE_TIMEOUT_S']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined))); server = null
  })
  const env = (url: string, timeoutS: string) => {
    process.env.TRACE_DELEGATE_URL = url
    process.env.TRACE_DELEGATE_TOKEN = 't'.repeat(64)
    process.env.TRACE_DELEGATE_TIMEOUT_S = timeoutS
  }
  const run = () => delegate.run({ brief: 'x', acceptance: ['y'] }, { hardware: false, via: 'test' }) as Promise<Record<string, unknown>>

  it('has no poll interval any more', () => {
    process.env.TRACE_DELEGATE_URL = 'http://127.0.0.1:1'
    process.env.TRACE_DELEGATE_TOKEN = 't'.repeat(64)
    expect(delegateEnv()).toEqual({ url: 'http://127.0.0.1:1', token: 't'.repeat(64), timeoutS: 4 * 3600 })
  })

  it('makes one held wait call that returns the instant the worker ends, asking for at most 240 s', async () => {
    const f = await fakeRuntime(80)
    server = f.server
    env(f.url, '3600')
    const t0 = Date.now()
    const r = await run()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r).toMatchObject({ job_id: 'job-w', state: 'succeeded', summary: 'done' })
    expect(f.calls.map((c) => c.path)).toEqual(['/delegate', '/delegate/wait'])
    expect(f.calls[1]!.body).toEqual({ token: 't'.repeat(64), jobId: 'job-w', timeoutS: 240 })
    // no wait of its own in this process (the runtime's handler holds it): it would be listed twice through the relay
    expect(f.seenWaits).not.toContain('event:the worker job job-w')
    expect(activeWaits().some((w) => w.what === 'the worker job job-w')).toBe(false)
  })

  it('asks again with the time left, back to back (no sleep between), then cancels when the overall timeout passes', async () => {
    const f = await fakeRuntime(null)
    server = f.server
    env(f.url, '0.3')
    const r = await run()
    expect(r).toMatchObject({ job_id: 'job-w', state: 'timeout', delegation: 'cancelled' })
    const paths = f.calls.map((c) => c.path)
    expect(paths[0]).toBe('/delegate')
    expect(paths.at(-1)).toBe('/delegate/cancel')
    const waits = f.calls.filter((c) => c.path === '/delegate/wait')
    expect(waits.length).toBeGreaterThanOrEqual(1)
    expect(paths.slice(1, -1).every((p) => p === '/delegate/wait')).toBe(true)
    // each asks for the time left, never more
    const asked = waits.map((c) => Number(c.body.timeoutS))
    expect(asked[0]).toBeLessThanOrEqual(0.3)
    expect(asked[0]).toBeGreaterThan(0.2)
    expect(asked).toEqual([...asked].sort((a, b) => b - a))
    // no timer between calls: the next call follows the previous answer at once
    const total = f.calls.at(-1)!.at - f.calls[0]!.at
    expect(total).toBeLessThan(1000)
    expect(activeWaits().some((w) => w.what === 'the worker job job-w')).toBe(false)
  })
})
