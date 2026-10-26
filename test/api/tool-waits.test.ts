/**
 * The waits of a project's tool calls through the API: tools.waits holds a status invocation in the project's tool
 * session (where kb.sync runs) and keeps only the waits opened outside any job; tools.check_now wakes one there. The
 * CLI's follower prints each knowledge base line once, and stops when told to or when the worker cannot hold.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, needOf, perform } from '../../src/api/actions.js'
import { parseWorkerRuntimes, remoteJobs, toolSession } from '../../src/api/workers.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { Registry } from '../../src/core/registry.js'
import { followToolWaits } from '../../src/login/kb.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const RUNTIMES = 'acme/board=trace_w_aaaaaaaa-AbCdEf1234 acme/secret=trace_w_bbbbbbbb-ZyXwVu9876'
const ADMIN = { sub: 'admin-1', email: 'admin@example.com', groups: ['trace-admins'] }
const GUEST = { sub: 'guest-7', email: 'guest-7@example.com', groups: ['trace-guests'] }

const KB = { id: 'wait-a', what: 'the knowledge base ingestion job k-1', source: 'timer', jobId: null, text: 'Waiting for the knowledge base ingestion job k-1 (in progress). Checked just now; next check in 10 seconds.' }
const JOBS = { id: 'wait-b', what: 'the graphics card job g-1', source: 'event', jobId: 'job-3', text: 'Waiting for the graphics card job g-1. trace will know as soon as it changes.' }

function fakeAgentCore() {
  const calls: { session: string; body: Record<string, unknown> }[] = []
  const client = {
    async send(cmd: InvokeAgentRuntimeCommand) {
      const body = JSON.parse(new TextDecoder().decode(cmd.input.payload as Uint8Array)) as Record<string, unknown>
      calls.push({ session: cmd.input.runtimeSessionId ?? '', body })
      const out = body.kind === 'check-now' ? { ok: body.waitId === 'wait-a' } : { jobs: [], busy: false, version: 12, waits: [KB, JOBS] }
      return { statusCode: 200, response: { transformToString: async () => JSON.stringify(out) } }
    },
  }
  return { client, calls }
}

describe('tools.waits and tools.check_now', () => {
  const f = fakeAgentCore()
  const jobs: JobsApi = remoteJobs({ runtimes: parseWorkerRuntimes(RUNTIMES), region: 'us-east-1', account: '123456789012', client: f.client })
  const deps: ActionDeps = { github: async () => new FakeGitHub(['acme/board', 'acme/secret']), cognito: () => new FakeCognito(), jobs: async () => jobs, tools: () => new Registry([]), scratch: mkdtempSync(join(tmpdir(), 'trace-api-toolwaits-')) }
  const ctx = (principal: Context['principal']): Context => ({ principal, deps })

  beforeAll(async () => { await assign(ADMIN, { sub: GUEST.sub, email: GUEST.email }, 'acme/board') })

  it('answers the tool session\'s own waits, holding on the worker with afterVersion + waitS', async () => {
    f.calls.length = 0
    const r = (await perform('tools.waits', { repo: 'acme/board' }, ctx(GUEST))).result as { version: number; waits: { id: string }[] }
    expect(r.version).toBe(12)
    expect(r.waits.map((w) => w.id)).toEqual(['wait-a'])
    await perform('tools.waits', { repo: 'acme/board', afterVersion: 12, waitS: 60 }, ctx(GUEST))
    expect(f.calls.map((c) => c.body)).toEqual([{ kind: 'status' }, { kind: 'status', afterVersion: 12, waitS: 60 }])
    expect(f.calls.every((c) => c.session === toolSession('acme/board'))).toBe(true)
    await expect(perform('tools.waits', { repo: 'acme/board', afterVersion: 1, waitS: 241 }, ctx(GUEST))).rejects.toThrow(/waitS/)
  })

  it('needs read on the project, checked before the worker is asked', async () => {
    expect(needOf('tools.waits')).toBe('read')
    expect(needOf('tools.check_now')).toBe('read')
    f.calls.length = 0
    await expect(perform('tools.waits', { repo: 'acme/secret' }, ctx(GUEST))).rejects.toBeInstanceOf(AccessDenied)
    await expect(perform('tools.check_now', { repo: 'acme/secret', waitId: 'wait-a' }, ctx(GUEST))).rejects.toBeInstanceOf(AccessDenied)
    expect(f.calls).toEqual([])
    expect((await perform('tools.check_now', { repo: 'acme/board', waitId: 'wait-a' }, ctx(GUEST))).result).toEqual({ ok: true })
    expect(f.calls[0]).toEqual({ session: toolSession('acme/board'), body: { kind: 'check-now', waitId: 'wait-a' } })
  })
})

describe('followToolWaits (trace remote kb sync)', () => {
  it('prints each knowledge base line, holds on the version it got, and stops when aborted', async () => {
    const stop = new AbortController()
    const asked: Record<string, unknown>[] = []
    const answers = [
      { version: 3, waits: [] },
      { version: 5, waits: [KB, JOBS] },
      { version: 6, waits: [{ ...KB, text: 'Waiting for the knowledge base ingestion job k-1 (complete). Checked just now; no further check is planned.' }] },
    ]
    const invoke = (async (_action: string, args: Record<string, unknown> = {}, o: { signal?: AbortSignal } = {}) => {
      asked.push(args)
      const a = answers.shift()
      if (a) return a
      // hold until the follower is stopped, as the worker would
      return new Promise((_res, rej) => o.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))
    }) as never
    const lines: string[] = []
    const done = followToolWaits('acme/board', (l) => lines.push(l), stop.signal, invoke)
    await new Promise((r) => setTimeout(r, 10))
    stop.abort()
    await done
    expect(lines).toEqual([KB.text, 'Waiting for the knowledge base ingestion job k-1 (complete). Checked just now; no further check is planned.'])
    expect(asked).toEqual([
      { repo: 'acme/board' },
      { repo: 'acme/board', afterVersion: 3, waitS: 60 },
      { repo: 'acme/board', afterVersion: 5, waitS: 60 },
      { repo: 'acme/board', afterVersion: 6, waitS: 60 },
    ])
  })

  it('stops at once with a worker that cannot hold (no version)', async () => {
    let calls = 0
    const invoke = (async () => { calls++; return { version: null, waits: [KB] } }) as never
    const lines: string[] = []
    await followToolWaits('acme/board', (l) => lines.push(l), new AbortController().signal, invoke)
    expect(calls).toBe(1)
    expect(lines).toEqual([KB.text])
  })
})
