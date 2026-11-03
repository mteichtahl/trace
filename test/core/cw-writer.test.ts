/**
 * The run logs writer (src/core/cw-writer.ts): batched per stream, the stream made once, events in time order, never a
 * throw into the caller, and given up (one warning) after repeated failures.
 */
import { describe, expect, it } from 'vitest'
import { type LogEvent, type LogsApi, runLogWriter } from '../../src/core/cw-writer.js'

type Put = { logGroupName: string; logStreamName: string; logEvents: LogEvent[] }

function fakeLogs(o: { failPuts?: number; exists?: boolean; failAlways?: boolean } = {}): LogsApi & { puts: Put[]; created: string[] } {
  let fails = o.failPuts ?? 0
  const puts: Put[] = []
  const created: string[] = []
  return {
    puts, created,
    async createLogStream(i) {
      if (o.exists || created.includes(i.logStreamName)) throw Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' })
      created.push(i.logStreamName)
    },
    async putLogEvents(i) {
      if (o.failAlways || fails-- > 0) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
      puts.push({ ...i, logEvents: [...i.logEvents] })
    },
  }
}

describe('runLogWriter', () => {
  it('batches a stream\'s lines, makes the stream once, and sends them in time order', async () => {
    const api = fakeLogs()
    const w = runLogWriter({ group: '/trace/t/runs', api, everyMs: 60_000 })
    w.write('job/o/r/1', 'second', 2_000)
    w.write('job/o/r/1', 'first', 1_000)
    w.write('job/o/r/1', 'third', 2_000)
    w.write('tool/o/r/t1', 'other stream', 1_500)
    expect(w.pending()).toBe(true)
    await w.flush()
    expect(api.created.sort()).toEqual(['job/o/r/1', 'tool/o/r/t1'])
    const job = api.puts.find((p) => p.logStreamName === 'job/o/r/1')
    expect(job?.logGroupName).toBe('/trace/t/runs')
    // time order, and the same millisecond keeps its written order
    expect(job?.logEvents.map((e) => e.message)).toEqual(['first', 'second', 'third'])
    w.write('job/o/r/1', 'more', 3_000)
    await w.flush('job/o/r/1')
    expect(api.created.filter((s) => s === 'job/o/r/1')).toHaveLength(1)
    expect(w.pending()).toBe(false)
    await w.close()
  })

  it('flushes on its own after everyMs, and at once at the line limit', async () => {
    const api = fakeLogs()
    const w = runLogWriter({ group: 'g', api, everyMs: 20, lines: 3 })
    w.write('s', 'a')
    await new Promise((r) => setTimeout(r, 60))
    expect(api.puts.map((p) => p.logEvents.length)).toEqual([1])
    for (const l of ['b', 'c', 'd', 'e']) w.write('s', l)
    await new Promise((r) => setTimeout(r, 5))
    // the limit sent three without waiting; the fourth follows
    expect(api.puts[1]?.logEvents.map((e) => e.message)).toEqual(['b', 'c', 'd'])
    await w.close()
    expect(api.puts.flatMap((p) => p.logEvents.map((e) => e.message))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('splits a batch at the byte limit', async () => {
    const api = fakeLogs()
    const w = runLogWriter({ group: 'g', api, everyMs: 60_000, bytes: 100 })
    w.write('s', 'x'.repeat(60))
    w.write('s', 'y'.repeat(60))
    await w.flush()
    expect(api.puts.map((p) => p.logEvents.length)).toEqual([1, 1])
  })

  it('takes an existing stream as made', async () => {
    const api = fakeLogs({ exists: true })
    const w = runLogWriter({ group: 'g', api })
    w.write('s', 'line')
    await w.flush()
    expect(api.puts).toHaveLength(1)
  })

  it('keeps the lines of a failed send for the next try', async () => {
    const api = fakeLogs({ failPuts: 1 })
    const w = runLogWriter({ group: 'g', api, everyMs: 10 })
    w.write('s', 'kept')
    await w.flush()
    expect(api.puts).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 40))
    expect(api.puts.flatMap((p) => p.logEvents.map((e) => e.message))).toEqual(['kept'])
    expect(w.dropped).toBe(false)
    await w.close()
  })

  it('gives up after repeated failures, says so once, and never throws', async () => {
    const warned: string[] = []
    const api = fakeLogs({ failAlways: true })
    const w = runLogWriter({ group: 'g', api, everyMs: 5, failures: 3, warn: (l) => warned.push(l) })
    w.write('s', 'one')
    await w.flush()
    await new Promise((r) => setTimeout(r, 50))
    expect(w.dropped).toBe(true)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/not written to g any more .*throttled/)
    expect(() => w.write('s', 'two')).not.toThrow()
    await expect(w.flush()).resolves.toBeUndefined()
    expect(w.pending()).toBe(false)
    expect(warned).toHaveLength(1)
  })

  it('a client that cannot be made counts as a failure, not a throw', async () => {
    const warned: string[] = []
    const w = runLogWriter({ group: 'g', api: () => Promise.reject(new Error('no credentials')), failures: 1, warn: (l) => warned.push(l) })
    w.write('s', 'x')
    await w.flush()
    expect(w.dropped).toBe(true)
    expect(warned[0]).toMatch(/no credentials/)
  })

  it('keeps at most `queued` lines per stream, and says how many went', async () => {
    const api = fakeLogs()
    const w = runLogWriter({ group: 'g', api, everyMs: 60_000, lines: 100, queued: 3 })
    for (let i = 0; i < 6; i++) w.write('s', `l${i}`, 1_000 + i)
    await w.flush()
    expect(api.puts[0]?.logEvents.map((e) => e.message)).toEqual(['… 3 earlier lines were not kept', 'l3', 'l4', 'l5'])
  })
})
