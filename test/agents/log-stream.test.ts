/**
 * The worker runtime's run logs (src/agents/runtime/log-stream.ts): every job's lines to job/<repo>/<id>, a tool call
 * with a run id to tool/<repo>/<runId> (src/agents/runtime/tool.ts), the quiet gaps learned when either ends, and
 * nothing of it ever failing the job or the call.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createJobs } from '../../src/agents/runtime/jobs.js'
import { endLine, parseJobLine, runLogsFromEnv, streamJobs, toolRun } from '../../src/agents/runtime/log-stream.js'
import { InvocationSchema, type JobPayload, ToolPayload } from '../../src/agents/runtime/schemas.js'
import { toolRunner } from '../../src/agents/runtime/tool.js'
import { type Backend, Conflict } from '../../src/core/central.js'
import { type LogEvent, type LogsApi, runLogWriter } from '../../src/core/cw-writer.js'
import { reportLine, reportProgress } from '../../src/core/progress.js'
import { learnQuiet, quietKey, quietStepKey, readQuiet } from '../../src/core/quiet.js'
import { Registry, ToolError, defineTool } from '../../src/core/registry.js'
import { markOf, newToolRunId } from '../../src/core/run-logs.js'

type Ev = LogEvent & { stream: string }
function fakeLogs(o: { fail?: boolean } = {}): LogsApi & { events: Ev[]; lines(stream: string): string[] } {
  const events: Ev[] = []
  return {
    events,
    lines: (stream) => events.filter((e) => e.stream === stream).map((e) => e.message),
    createLogStream: async () => { if (o.fail) throw new Error('AccessDenied') },
    putLogEvents: async (i) => { if (o.fail) throw new Error('AccessDenied'); for (const e of i.logEvents) events.push({ ...e, stream: i.logStreamName }) },
  }
}

/** An in-memory central store with conditional puts (the quiet profile's). */
function memoryBackend(): Backend & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  const etags = new Map<string, string>()
  let n = 0
  return {
    url: 'memory://', objects,
    async get(key: string) { const b = objects.get(key); return b ? { body: b, etag: etags.get(key) ?? '' } : null },
    async put(key: string, body: Uint8Array, o?: { ifMatch?: string; ifNoneMatch?: boolean }) {
      if (o?.ifNoneMatch && objects.has(key)) throw new Conflict('exists')
      if (o?.ifMatch && etags.get(key) !== o.ifMatch) throw new Conflict('changed')
      objects.set(key, body)
      etags.set(key, `e${++n}`)
      return { etag: etags.get(key) ?? '' }
    },
  } as unknown as Backend & { objects: Map<string, Uint8Array> }
}

const TASK: JobPayload = { kind: 'task', repository: 'MTeichtahl/Potroller', request: 'Add an LED to the\nboard', requestedBy: 'm@example.com', agent: 'impl' }

describe('parseJobLine and endLine', () => {
  it('reads a JobInfo.log line back into its time and text', () => {
    expect(parseJobLine('2026-11-03T10:44:02.123Z routed to impl: x y')).toEqual({ at: Date.parse('2026-11-03T10:44:02.123Z'), text: 'routed to impl: x y' })
    expect(parseJobLine('no time here', 5)).toEqual({ at: 5, text: 'no time here' })
  })

  it('ends a run in the marks the app reads', () => {
    expect(endLine({ state: 'succeeded', summary: 'opened PR #3' })).toBe('✓ done: opened PR #3')
    expect(endLine({ state: 'failed', error: 'git push failed\nmore' })).toBe('✗ git push failed more')
    expect(endLine({ state: 'failed' })).toBe('✗ failed')
    expect(endLine({ state: 'aborted', error: 'cancelled by m' })).toBe('✗ stopped: cancelled by m')
    expect(endLine({ state: 'paused', summary: 'paused by m' })).toBe('⏸ paused: paused by m')
    expect(markOf(endLine({ state: 'succeeded' }))).toBe('ok')
    expect(markOf(endLine({ state: 'failed', error: 'x' }))).toBe('error')
  })
})

describe('runLogsFromEnv', () => {
  it('writes nothing without TRACE_RUNS_LOG_GROUP', () => {
    expect(runLogsFromEnv({})).toBeNull()
    expect(runLogsFromEnv({ TRACE_RUNS_LOG_GROUP: '/trace/t/runs' }, { api: fakeLogs() })?.group).toBe('/trace/t/runs')
  })
})

describe('streamJobs', () => {
  it('writes a job\'s title, every line at its own time, and its end to job/<slug>/<id>; then learns its gaps', async () => {
    const api = fakeLogs()
    const writer = runLogWriter({ group: 'g', api, everyMs: 60_000 })
    const learned: unknown[][] = []
    let t = Date.parse('2026-11-03T10:00:00Z')
    const jobs = createJobs(async (_p, ctx) => {
      t += 5_000; ctx.log('▸ Load the board')
      t += 40_000; ctx.log('loaded')
      return 'opened PR #7'
    }, { echo: () => undefined, now: () => t })
    const stop = streamJobs(jobs, writer, { learn: async (...a) => { learned.push(a) } })
    const { jobId } = jobs.startJob(TASK)
    await jobs.waitForEnd(jobId)
    await new Promise((r) => setTimeout(r, 5))
    await writer.flush()
    const stream = `job/mteichtahl/potroller/${jobId}`
    const lines = api.lines(stream)
    expect(lines[0]).toBe('▸ Add an LED to the board')
    expect(lines).toContain('▸ Load the board')
    expect(lines).toContain('loaded')
    expect(lines[lines.length - 1]).toBe('✓ done: opened PR #7')
    // each line at the time the job said it
    const loaded = api.events.find((e) => e.message === 'loaded')
    expect(loaded?.timestamp).toBe(Date.parse('2026-11-03T10:00:45Z'))
    // its gaps, by step: 40 s in "Load the board"
    expect(learned).toHaveLength(1)
    const [repo, run, kind, what, gaps] = learned[0] as [string, string, string, string, Record<string, number>]
    expect([repo, run, kind, what]).toEqual(['mteichtahl/potroller', `job:${jobId}`, 'job', 'impl'])
    expect(gaps['Load the board']).toBe(40)
    stop()
    jobs.dispose()
  })

  it('writes a failure as ✗ <why>, and skips a job without a repository', async () => {
    const api = fakeLogs()
    const writer = runLogWriter({ group: 'g', api, everyMs: 60_000 })
    const jobs = createJobs(async () => { throw new Error('no token') }, { echo: () => undefined })
    streamJobs(jobs, writer)
    const { jobId } = jobs.startJob(TASK)
    await jobs.waitForEnd(jobId)
    const sweep = jobs.startJob({ kind: 'sweep', repositories: ['a/b', 'c/d'] } as JobPayload)
    await jobs.waitForEnd(sweep.jobId)
    await writer.flush()
    expect(api.lines(`job/mteichtahl/potroller/${jobId}`).pop()).toBe('✗ no token')
    expect(api.events.every((e) => e.stream.startsWith('job/mteichtahl/potroller/'))).toBe(true)
    jobs.dispose()
  })

  it('never fails or holds a job when the log cannot be written or the profile cannot be learned', async () => {
    const warned: string[] = []
    const writer = runLogWriter({ group: 'g', api: fakeLogs({ fail: true }), everyMs: 1, failures: 1, warn: (l) => warned.push(l) })
    const jobs = createJobs(async (_p, ctx) => { ctx.log('working'); return 'ok' }, { echo: () => undefined })
    streamJobs(jobs, writer, { learn: () => { throw new Error('store down') } })
    const { jobId } = jobs.startJob(TASK)
    expect((await jobs.waitForEnd(jobId))?.state).toBe('succeeded')
    await writer.flush()
    await new Promise((r) => setTimeout(r, 10))
    expect(writer.dropped).toBe(true)
    expect(warned).toHaveLength(1)
    jobs.dispose()
  })

  it('learns into the project\'s quiet profile (src/core/quiet.ts), once per run', async () => {
    const store = memoryBackend()
    const learn = (repo: string, run: string, kind: 'job' | 'tool' | 'check', what: string, gaps: Record<string, number>) => learnQuiet(store, repo, run, kind, what, gaps)
    await learn('o/r', 'job:1', 'job', 'impl', { Starting: 30 })
    await learn('o/r', 'job:1', 'job', 'impl', { Starting: 99 })
    const q = await readQuiet(store, 'o/r')
    expect(q.steps[quietStepKey('job', 'impl', 'Starting')]).toEqual([30])
    expect(store.objects.has(quietKey('o/r'))).toBe(true)
  })
})

describe('a tool call\'s stream (ToolJob.runId)', () => {
  const ran: string[] = []
  const registry = new Registry([
    defineTool({ name: 'sim.slow', description: 'reports progress', input: z.object({}), run: async () => {
      reportLine('meshing')
      reportProgress(0.5, 'half')
      await new Promise((r) => setTimeout(r, 1))
      reportLine('solved')
      ran.push('sim.slow')
      return { ok: true }
    } }),
    defineTool({ name: 'calc.fail', description: 'fails', input: z.object({}), run: () => { throw new ToolError('bad input\nsecond line') } }),
  ])
  const checkout = async () => { const dir = mkdtempSync(join(tmpdir(), 'trace-tool-log-')); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) } }

  it('accepts a run id made by newToolRunId and refuses anything else', () => {
    const runId = newToolRunId()
    expect(ToolPayload.parse({ kind: 'tool', repository: 'o/r', name: 'sim.slow', runId }).runId).toBe(runId)
    expect(InvocationSchema.safeParse({ kind: 'tool', repository: 'o/r', name: 'sim.slow', runId: '../x' }).success).toBe(false)
    expect(ToolPayload.parse({ kind: 'tool', repository: 'o/r', name: 'sim.slow' }).runId).toBeUndefined()
  })

  it('writes ▸ <tool>, what the tool reports, then ✓ done in N s; and learns the call\'s gaps as tool:<runId>', async () => {
    const api = fakeLogs()
    const writer = runLogWriter({ group: 'g', api, everyMs: 60_000 })
    const learned: unknown[][] = []
    const run = toolRunner({ registry: () => registry, checkout, runLogs: writer, learn: async (...a) => { learned.push(a) } })
    const runId = newToolRunId()
    expect(await run({ kind: 'tool', repository: 'MTeichtahl/Potroller', name: 'sim.slow', args: {}, runId })).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 5))
    await writer.flush()
    const lines = api.lines(`tool/mteichtahl/potroller/${runId}`)
    expect(lines.slice(0, 4)).toEqual(['▸ sim.slow', 'meshing', '50% · half', 'solved'])
    expect(lines[4]).toMatch(/^✓ done in \d+(\.\d)? s$/)
    expect(learned[0]?.slice(0, 4)).toEqual(['mteichtahl/potroller', `tool:${runId}`, 'tool', 'sim.slow'])
  })

  it('writes ✗ <the first line of why> for a failure, and the caller still gets the error', async () => {
    const api = fakeLogs()
    const writer = runLogWriter({ group: 'g', api, everyMs: 60_000 })
    const run = toolRunner({ registry: () => registry, checkout, runLogs: writer })
    const runId = newToolRunId()
    await expect(run({ kind: 'tool', repository: 'o/r', name: 'calc.fail', args: {}, runId })).rejects.toThrow('bad input')
    await writer.flush()
    expect(api.lines(`tool/o/r/${runId}`)).toEqual(['▸ calc.fail', '✗ bad input'])
  })

  it('writes nothing without a run id, or without the group, and a refused call has no stream', async () => {
    const api = fakeLogs()
    const writer = runLogWriter({ group: 'g', api, everyMs: 60_000 })
    await toolRunner({ registry: () => registry, checkout, runLogs: writer })({ kind: 'tool', repository: 'o/r', name: 'sim.slow', args: {} })
    await toolRunner({ registry: () => registry, checkout })({ kind: 'tool', repository: 'o/r', name: 'sim.slow', args: {}, runId: newToolRunId() })
    await expect(toolRunner({ registry: () => registry, checkout, runLogs: writer })({ kind: 'tool', repository: 'o/r', name: 'calc.none', args: {}, runId: newToolRunId() })).rejects.toThrow(/no tool/)
    await writer.flush()
    expect(api.events).toEqual([])
  })

  it('a tool call whose log cannot be written still answers', async () => {
    const writer = runLogWriter({ group: 'g', api: fakeLogs({ fail: true }), failures: 1, warn: () => undefined })
    const run = toolRunner({ registry: () => registry, checkout, runLogs: writer, learn: () => Promise.reject(new Error('down')) })
    expect(await run({ kind: 'tool', repository: 'o/r', name: 'sim.slow', args: {}, runId: newToolRunId() })).toEqual({ ok: true })
  })

  it('toolRun names its stream by the project\'s slug, and stops writing once it has ended', async () => {
    const api = fakeLogs()
    const writer = runLogWriter({ group: 'g', api, everyMs: 60_000 })
    expect(toolRun(writer, { repository: 'not a repo', runId: 't1', name: 'x.y' })).toBeNull()
    const log = toolRun(writer, { repository: 'A/B', runId: 'tmhz0abcd12345678', name: 'x.y', now: () => 0 })
    log?.done()
    log?.sink.line('late')
    log?.failed(new Error('twice'))
    await writer.flush()
    expect(api.lines('tool/a/b/tmhz0abcd12345678')).toEqual(['▸ x.y', '✓ done in 0.0 s'])
  })
})
