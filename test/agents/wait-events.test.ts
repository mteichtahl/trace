/**
 * Waits as events: a wait opened inside a job carries its id and counts as that job's change, so a held status
 * answer wakes on it; one opened outside any job (a tool call) wakes an unscoped status, and appears in its waits.
 */
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { trackEventWait, waitWithTimer } from '../../src/core/wait.js'
import { type JobRunner, createJobs } from '../../src/agents/runtime/jobs.js'
import type { JobPayload } from '../../src/agents/runtime/schemas.js'
import { createAgentServer } from '../../src/agents/runtime/server.js'

const TASK: JobPayload = { kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm@example.com', agent: 'impl' }
const quiet = { echo: () => undefined }

describe('waits in the job registry', () => {
  it('a job\'s waits carry its id and wake a watcher of that job', async () => {
    let step!: (s: string) => void
    let finish!: () => void
    const runner: JobRunner = async () => {
      const w = trackEventWait({ what: 'the graphics card job g-1' })
      await new Promise<void>((res) => { step = (s) => w.update(s); finish = () => { w.end(); res() } })
      return 'done'
    }
    const jobs = createJobs(runner, quiet)
    const { jobId } = jobs.startJob(TASK)
    await new Promise((r) => setImmediate(r))
    const v = jobs.versionOf(jobId)
    const woke = jobs.waitForChange(v, { jobId, timeoutMs: 2000 })
    step('RUNNING')
    expect(await woke).toBeGreaterThan(v)
    finish()
    expect(await jobs.waitForEnd(jobId, { timeoutMs: 1000 })).toMatchObject({ state: 'succeeded' })
  })

  it('a wait outside any job wakes an unscoped watcher, not a job-scoped one', async () => {
    const jobs = createJobs(async () => 'done', quiet)
    const v = jobs.version()
    const scoped = jobs.waitForChange(v, { jobId: 'job-other', timeoutMs: 50 })
    const any = jobs.waitForChange(v, { timeoutMs: 2000 })
    const w = trackEventWait({ what: 'the knowledge base ingestion job' })
    expect(await any).toBeGreaterThan(v)
    expect(await scoped).toBe(0)
    w.end()
  })
})

describe('a held status answer and the waits of tool calls', () => {
  it('answers the moment a timer wait outside any job is checked, listing it with its line; a job\'s status lists only its own', async () => {
    const jobs = createJobs(async () => 'done', quiet)
    const server = createAgentServer(jobs, { log: () => undefined })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const status = async (body: Record<string, unknown>) => (await (await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'status', ...body }),
    })).json()) as { version: number; waits: { id: string; what: string; text: string; jobId: string | null }[] }
    try {
      const first = await status({})
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      let n = 0
      const wait = waitWithTimer({
        what: 'the knowledge base ingestion job k-1', why: 'Bedrock sends no event when an ingestion job finishes', intervalMs: 60_000,
        sleep: async () => { await gate },
        check: async () => (++n > 1 ? { done: true, value: 1 } : { done: false, state: 'IN_PROGRESS' }),
      })
      const held = await status({ afterVersion: first.version, waitS: 5 })
      expect(held.version).toBeGreaterThan(first.version)
      const k = held.waits.find((w) => w.what.includes('k-1'))
      expect(k?.jobId).toBeNull()
      expect(k?.text).toMatch(/^Waiting for the knowledge base ingestion job k-1 \(in progress\)\. Checked just now; next check in 1 minute\.$/)
      // a job's own status leaves out waits that are not that job's
      expect((await status({ jobId: 'job-none' })).waits).toEqual([])
      release()
      await wait
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
