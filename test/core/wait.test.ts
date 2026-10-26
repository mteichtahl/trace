import { describe, expect, it } from 'vitest'
import { EventBus, activeWaits, checkNow, describeWait, duration, trackEventWait, waitWithTimer, type WaitNotice } from '../../src/core/wait.js'

/** A clock that moves only when the wait sleeps; `woken` records sleeps cut short by checkNow. */
function fakeTime(start = Date.parse('2026-10-27T00:00:00Z')) {
  let t = start
  const slept: number[] = []
  const woken: number[] = []
  return {
    now: () => t,
    slept, woken,
    sleep: (ms: number, early: AbortSignal) => new Promise<void>((resolve) => {
      slept.push(ms)
      if (early.aborted) { woken.push(ms); return resolve() }
      // give checkNow a turn to land before time moves on
      setImmediate(() => {
        if (early.aborted) { woken.push(ms); return resolve() }
        t += ms
        resolve()
      })
    }),
  }
}

describe('duration', () => {
  it('reads like a person would say it', () => {
    expect(duration(1_000)).toBe('just now')
    expect(duration(40_000)).toBe('40 seconds')
    expect(duration(60_000)).toBe('1 minute')
    expect(duration(13 * 60_000)).toBe('13 minutes')
    expect(duration(65 * 60_000)).toBe('1 hour 5 minutes')
    expect(duration(2 * 3600_000)).toBe('2 hours')
  })
})

describe('waitWithTimer', () => {
  it('records every check and says when it will look next', async () => {
    const f = fakeTime()
    const seen: WaitNotice[] = []
    let n = 0
    const r = await waitWithTimer({
      what: 'the order', why: 'JLCPCB sends no event', intervalMs: 60_000, now: f.now, sleep: f.sleep,
      check: async () => (++n < 3 ? { done: false, state: 'PENDING' } : { done: true, value: 'shipped', state: 'SHIPPED' }),
      report: (x) => seen.push(x),
    })
    expect(r).toMatchObject({ done: true, value: 'shipped', checks: 3 })
    expect(seen).toHaveLength(3)
    expect(seen[0]).toMatchObject({ source: 'timer', why: 'JLCPCB sends no event', state: 'PENDING', checks: 1, intervalMs: 60_000 })
    expect(Date.parse(seen[0]!.nextCheckAt!) - Date.parse(seen[0]!.lastCheckedAt!)).toBe(60_000)
    expect(seen[2]!.nextCheckAt).toBeNull()
    expect(activeWaits().some((w) => w.id === r.waitId)).toBe(false)
  })

  it('backs off while idle and drops back the moment the state changes', async () => {
    const f = fakeTime()
    const states = ['A', 'A', 'A', 'B', 'B']
    let i = 0
    await waitWithTimer({
      what: 'x', why: 'no event', intervalMs: 10, factor: 2, maxIntervalMs: 30, now: f.now, sleep: f.sleep,
      check: async () => (i < states.length ? { done: false, state: states[i++]! } : { done: true, value: 1 }),
    })
    // A (first: base), A (idle: 20), A (idle: 30 cap), B (changed: base), B (idle: 20)
    expect(f.slept).toEqual([10, 20, 30, 10, 20])
  })

  it('stops at the deadline, never sleeping past it', async () => {
    const f = fakeTime()
    const r = await waitWithTimer({
      what: 'x', why: 'no event', intervalMs: 50, deadlineAt: f.now() + 120, now: f.now, sleep: f.sleep,
      check: async () => ({ done: false, state: 'RUNNING' }),
    })
    expect(r).toMatchObject({ done: false, reason: 'deadline', state: 'RUNNING' })
    expect(f.slept).toEqual([50, 50, 20])
  })

  it('checks now when asked, and stops when aborted', async () => {
    const abort = new AbortController()
    let checks = 0
    let woken = 0
    // an hour-long sleep that ends only when woken
    const sleep = (_ms: number, early: AbortSignal): Promise<void> => new Promise((resolve) => {
      if (early.aborted) { woken++; return resolve() }
      early.addEventListener('abort', () => { woken++; resolve() }, { once: true })
    })
    const p = waitWithTimer({
      what: 'the build', why: 'no event', intervalMs: 3_600_000, sleep, signal: abort.signal,
      check: async () => { checks++; return { done: false } },
    })
    await new Promise((r) => setImmediate(r))
    const w = activeWaits().find((x) => x.what === 'the build')!
    expect(w).toBeDefined()
    expect(checkNow(w.id)).toBe(true)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(checks).toBe(2)
    expect(woken).toBe(1)
    abort.abort()
    expect(await p).toMatchObject({ done: false, reason: 'aborted' })
    expect(checkNow(w.id)).toBe(false)
  })

  it('leaves the record when a check throws', async () => {
    await expect(waitWithTimer({ what: 'boom', why: 'no event', intervalMs: 1, check: async () => { throw new Error('no') } })).rejects.toThrow('no')
    expect(activeWaits().some((w) => w.what === 'boom')).toBe(false)
  })
})

describe('describeWait', () => {
  it('says what, when it last looked and when it will look next', () => {
    const now = Date.parse('2026-10-27T10:15:00Z')
    const n: WaitNotice = {
      id: 'w', what: 'JLCPCB to confirm the order', source: 'timer', startedAt: '2026-10-27T10:00:00Z', jobId: null, state: 'IN_REVIEW',
      lastCheckedAt: '2026-10-27T10:13:00Z', nextCheckAt: '2026-10-27T10:28:00Z', intervalMs: 900_000, checks: 3, why: 'no event feed',
    }
    expect(describeWait(n, now)).toBe('Waiting for JLCPCB to confirm the order (in review). Checked 2 minutes ago; next check in 13 minutes.')
    expect(describeWait({ ...n, source: 'event', state: null }, now)).toBe('Waiting for JLCPCB to confirm the order. trace will know as soon as it changes.')
  })
})

describe('EventBus', () => {
  it('resolves on the first matching event, or null on timeout or abort', async () => {
    const bus = new EventBus<{ id: string; state: string }>()
    const p = bus.waitFor((e) => e.id === 'a' && e.state === 'done')
    bus.emit({ id: 'b', state: 'done' })
    bus.emit({ id: 'a', state: 'running' })
    bus.emit({ id: 'a', state: 'done' })
    expect(await p).toEqual({ id: 'a', state: 'done' })
    expect(bus.size).toBe(0)
    expect(await bus.waitFor(() => true, { timeoutMs: 5 })).toBeNull()
    const abort = new AbortController()
    const q = bus.waitFor(() => true, { signal: abort.signal })
    abort.abort()
    expect(await q).toBeNull()
    expect(bus.size).toBe(0)
  })

  it('does not miss an event that happened before the wait began', async () => {
    const bus = new EventBus<string>()
    expect(await bus.waitFor((e) => e === 'x', { already: () => 'x' })).toBe('x')
  })

  it('keeps going when one listener throws', () => {
    const bus = new EventBus<number>()
    const got: number[] = []
    bus.on(() => { throw new Error('bad') })
    bus.on((n) => got.push(n))
    bus.emit(1)
    expect(got).toEqual([1])
  })
})

describe('trackEventWait', () => {
  it('is on the record with its latest state, without a timer', () => {
    const w = trackEventWait({ what: 'the worker job job-1', state: 'running' })
    w.update('committing')
    const n = activeWaits().find((x) => x.id === w.id)!
    expect(n).toMatchObject({ source: 'event', state: 'committing', nextCheckAt: null, intervalMs: null })
    expect(checkNow(w.id)).toBe(false)
    w.end()
    expect(activeWaits().some((x) => x.id === w.id)).toBe(false)
  })
})

describe('waitChanges and withJob', () => {
  it('emits opened, updated and ended with the line and a growing version, and attributes waits to their job', async () => {
    const { waitChanges, waitsVersion, withJob } = await import('../../src/core/wait.js')
    const seen: { type: string; version: number; jobId: string | null; line: string }[] = []
    const stop = waitChanges.on((c) => seen.push({ type: c.type, version: c.version, jobId: c.notice.jobId, line: c.line }))
    const v0 = waitsVersion()
    const w = withJob('job-7', () => trackEventWait({ what: 'the render' }))
    w.update('RUNNING')
    w.update('RUNNING') // no change, no event
    w.end()
    w.end() // already ended, no event
    let n = 0
    await waitWithTimer({ what: 'the ingestion job', why: 'no event', intervalMs: 1, sleep: async () => undefined, check: async () => (++n < 2 ? { done: false, state: 'IN_PROGRESS' } : { done: true, value: 1, state: 'COMPLETE' }) })
    stop()
    expect(seen.map((s) => s.type)).toEqual(['opened', 'updated', 'ended', 'opened', 'updated', 'updated', 'ended'])
    expect(seen.map((s) => s.version)).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => v0 + i))
    expect(seen.slice(0, 3).every((s) => s.jobId === 'job-7')).toBe(true)
    expect(seen[3]?.jobId).toBeNull()
    expect(seen[1]?.line).toBe('Waiting for the render (running). trace will know as soon as it changes.')
    expect(seen[4]?.line).toMatch(/^Waiting for the ingestion job \(in progress\)\. Checked just now; next check in a moment\.$/)
  })
})
