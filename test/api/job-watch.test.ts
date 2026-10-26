/**
 * Following a job through the API without polling: `job` forwards afterVersion + waitS to the worker as a held status
 * invocation and surfaces its version and waits; `job.check_now` forwards check-now to the job's session. Both check
 * read access on the job's project before the worker is asked.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, needOf, perform } from '../../src/api/actions.js'
import { jobHandle, parseWorkerRuntimes, remoteJobs, taskSession } from '../../src/api/workers.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const RUNTIMES = 'acme/board=trace_w_aaaaaaaa-AbCdEf1234 acme/secret=trace_w_bbbbbbbb-ZyXwVu9876'
const ADMIN = { sub: 'admin-1', email: 'admin@example.com', groups: ['trace-admins'] }
const GUEST = { sub: 'guest-9', email: 'guest-9@example.com', groups: ['trace-guests'] }

function fakeAgentCore() {
  const calls: { session: string; body: Record<string, unknown> }[] = []
  const client = {
    async send(cmd: InvokeAgentRuntimeCommand) {
      const body = JSON.parse(new TextDecoder().decode(cmd.input.payload as Uint8Array)) as Record<string, unknown>
      calls.push({ session: cmd.input.runtimeSessionId ?? '', body })
      const out = body.kind === 'check-now'
        ? { ok: body.waitId === 'wait-1' }
        : { jobs: [{ id: body.jobId, kind: 'task', state: 'running', repository: 'acme/board' }], busy: true, version: 7,
            waits: [{ id: 'wait-1', what: 'the knowledge base update', source: 'timer', text: 'Waiting for the knowledge base update. Checked just now; next check in 1 minute.', nextCheckAt: '2026-10-26T00:01:00.000Z' }] }
      return { statusCode: 200, response: { transformToString: async () => JSON.stringify(out) } }
    },
  }
  return { client, calls }
}

describe('following a job through the API', () => {
  const f = fakeAgentCore()
  const jobs: JobsApi = remoteJobs({ runtimes: parseWorkerRuntimes(RUNTIMES), region: 'us-east-1', account: '123456789012', client: f.client })
  const handle = jobHandle(taskSession({ repository: 'acme/board', request: 'x' }), 'job-1')
  const secret = jobHandle(taskSession({ repository: 'acme/secret', request: 'x' }), 'job-1')
  const deps: ActionDeps = { github: async () => new FakeGitHub(['acme/board', 'acme/secret']), cognito: () => new FakeCognito(), jobs: async () => jobs, tools: () => new Registry([]), scratch: mkdtempSync(join(tmpdir(), 'trace-api-watch-')) }
  const ctx = (principal: Context['principal']): Context => ({ principal, deps })

  beforeAll(async () => { await assign(ADMIN, { sub: GUEST.sub, email: GUEST.email }, 'acme/board') })

  it('job answers at once without afterVersion, and holds on the worker with it; version and waits come back', async () => {
    f.calls.length = 0
    const now = (await perform('job', { id: handle }, ctx(GUEST))).result as Record<string, unknown>
    expect(now).toMatchObject({ id: handle, workerJobId: 'job-1', state: 'running', version: 7 })
    expect((now.waits as { text: string }[])[0]?.text).toMatch(/next check in 1 minute/)
    expect(f.calls[0]?.body).toEqual({ kind: 'status', jobId: 'job-1' })
    await perform('job', { id: handle, afterVersion: 7, waitS: 120 }, ctx(GUEST))
    expect(f.calls[1]?.body).toEqual({ kind: 'status', jobId: 'job-1', afterVersion: 7, waitS: 120 })
    await expect(perform('job', { id: handle, afterVersion: 7, waitS: 300 }, ctx(GUEST))).rejects.toThrow(/waitS/)
    // jobStatus is unchanged: the job views only
    expect(await jobs.jobStatus(handle)).toEqual([{ id: handle, workerJobId: 'job-1', kind: 'task', state: 'running', repository: 'acme/board' }])
  })

  it('job.check_now needs read on the job\'s project, checked before the worker is asked', async () => {
    expect(needOf('job.check_now')).toBe(needOf('job'))
    f.calls.length = 0
    await expect(perform('job.check_now', { id: secret, waitId: 'wait-1' }, ctx(GUEST))).rejects.toBeInstanceOf(AccessDenied)
    await expect(perform('job.check_now', { id: 'job-nope', waitId: 'wait-1' }, ctx(GUEST))).rejects.toBeInstanceOf(AccessDenied)
    expect(f.calls).toEqual([])
    expect((await perform('job.check_now', { id: handle, waitId: 'wait-1' }, ctx(GUEST))).result).toEqual({ ok: true })
    expect((await perform('job.check_now', { id: handle, waitId: 'wait-2' }, ctx(GUEST))).result).toEqual({ ok: false })
    expect(f.calls.map((c) => c.body)).toEqual([{ kind: 'check-now', waitId: 'wait-1' }, { kind: 'check-now', waitId: 'wait-2' }])
    // in the job's own session: the microVM whose waits the status answer listed
    expect(f.calls[0]?.session).toBe(taskSession({ repository: 'acme/board', request: 'x' }))
  })
})
