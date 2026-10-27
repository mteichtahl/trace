/** Cancelling a job on its worker (invocation kind `cancel`), and the Batch jobs a cancelled job's tools left running. */
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { type JobRunner, createJobs } from '../../src/agents/runtime/jobs.js'
import type { JobPayload } from '../../src/agents/runtime/schemas.js'
import { KEPT, createAgentServer } from '../../src/agents/runtime/server.js'
import { inFlight, terminateInFlight, trackInFlight } from '../../src/gpu/inflight.js'

const TASK: JobPayload = { kind: 'task', repository: 'o/r', request: 'x', requestedBy: 'm@example.com', agent: 'impl' }
const quiet = { echo: () => undefined }

async function serve(jobs: ReturnType<typeof createJobs>): Promise<{ base: string; close(): void }> {
  const s = createAgentServer(jobs, { log: () => undefined })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }
}
const post = async (url: string, body: unknown) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>

describe('cancel', () => {
  it('aborts a running job and answers once it has stopped; a finished or unknown job is not cancelled', async () => {
    let reason = ''
    const runner: JobRunner = (_p, ctx) => new Promise((_res, rej) => { ctx.signal.addEventListener('abort', () => { reason = (ctx.signal.reason as Error).message; rej(ctx.signal.reason as Error) }) })
    const jobs = createJobs(runner, quiet)
    const s = await serve(jobs)
    try {
      const { jobId } = jobs.startJob(TASK)
      expect(await post(`${s.base}/invocations`, { kind: 'cancel', jobId, reason: 'cancelled by m@example.com' })).toEqual({ ok: true, state: 'aborted', kept: KEPT })
      expect(reason).toBe('cancelled by m@example.com')
      expect(jobs.jobStatus(jobId)[0]).toMatchObject({ state: 'aborted', error: 'cancelled by m@example.com' })
      expect(await post(`${s.base}/invocations`, { kind: 'cancel', jobId })).toMatchObject({ ok: false, state: 'aborted', reason: 'The job has already aborted.' })
      expect(await post(`${s.base}/invocations`, { kind: 'cancel', jobId: 'job-nope' })).toMatchObject({ ok: false, state: null, reason: 'There is no such job on this worker.' })
    } finally {
      s.close()
    }
  })

  it('terminates the Batch jobs still in flight when the job\'s tool server closes, and forgets the ones that ended', async () => {
    const terminated: string[] = []
    const forgetA = trackInFlight({ jobId: 'batch-a', terminate: async (r) => { terminated.push(`batch-a: ${r}`) } })
    trackInFlight({ jobId: 'batch-b', terminate: async () => { throw new Error('denied') } })
    forgetA()
    trackInFlight({ jobId: 'batch-c', terminate: async (r) => { terminated.push(`batch-c: ${r}`) } })
    const lines: string[] = []
    expect((await terminateInFlight('the job ended', (l) => lines.push(l))).sort()).toEqual(['batch-b', 'batch-c'])
    expect(terminated).toEqual(['batch-c: the job ended'])
    expect(lines).toEqual(['could not terminate Batch job batch-b: denied'])
    expect(inFlight()).toEqual([])
  })
})
