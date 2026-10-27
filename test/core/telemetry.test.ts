/**
 * Telemetry with a real OpenTelemetry SDK (in-memory exporter and reader): the spans and metrics per invocation,
 * job, Claude turn, tool call and GPU job, their attributes, the trace context that crosses processes, and that no
 * argument value, file content, prompt, token or email address is ever recorded.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpanKind, SpanStatusCode, context, metrics, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { projectHash } from '../../src/core/project.js'
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type ClaudeOptions, type RunnerDeps, createRunner } from '../../src/agents/runtime/job.js'
import { type JobRunner, createJobs } from '../../src/agents/runtime/jobs.js'
import { SESSION_HEADER, claudeTelemetry, telemetryNote } from '../../src/agents/runtime/observe.js'
import type { JobPayload } from '../../src/agents/runtime/schemas.js'
import { createAgentServer } from '../../src/agents/runtime/server.js'
import { runBatch, type BatchApi, type BatchJobDetail } from '../../src/gpu/batch.js'
import { GpuJobSchema, runJob } from '../../src/gpu/jobs.js'
import { observedMain } from '../../src/gpu/runner.js'
import { Registry, ToolError, defineTool } from '../../src/core/registry.js'
import {
  addSecret, argShape, continueFromEnv, enabled, personHash, projectDimension, recordProjectMetric, redact, resetMetricsCache, span, traceEnv, withSession,
} from '../../src/core/telemetry.js'
import type { WorkItem } from '../../src/harness/worker.js'
import { SHA, cfgOf, fakeGithub } from '../harness/fake.js'
import { FakeS3 } from './fake-s3.js'

const spans = new InMemorySpanExporter()
class Reader extends MetricReader {
  protected async onForceFlush(): Promise<void> { /* pull only */ }
  protected async onShutdown(): Promise<void> { /* nothing to release */ }
}
let reader = new Reader()
const contextManager = new AsyncLocalStorageContextManager()

beforeAll(() => {
  // this process may itself have inherited a TRACEPARENT (a CI runner, a harness): not this test's parent
  delete process.env.TRACEPARENT
  context.setGlobalContextManager(contextManager.enable())
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }))
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }))
})
afterAll(() => {
  trace.disable(); metrics.disable(); propagation.disable(); context.disable()
})
beforeEach(() => {
  spans.reset()
  metrics.disable()
  reader = new Reader()
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))
  resetMetricsCache()
})

const finished = (): ReadableSpan[] => spans.getFinishedSpans()
const named = (n: string | RegExp): ReadableSpan[] => finished().filter((s) => (typeof n === 'string' ? s.name === n : n.test(s.name)))
const one = (n: string | RegExp): ReadableSpan => {
  const s = named(n)
  expect(s, `one span named ${String(n)} in ${finished().map((x) => x.name).join(', ')}`).toHaveLength(1)
  return s[0] as ReadableSpan
}
const everything = (): string => JSON.stringify(finished().map((s) => ({ name: s.name, attributes: s.attributes, status: s.status, events: s.events })))

/** The metric points of one metric: [attributes, value] with value a number (counter) or the histogram's sum. */
async function points(name: string): Promise<{ attrs: Record<string, unknown>; value: number; count?: number }[]> {
  const { resourceMetrics } = await reader.collect()
  const out: { attrs: Record<string, unknown>; value: number; count?: number }[] = []
  for (const sm of resourceMetrics.scopeMetrics) {
    for (const m of sm.metrics) {
      if (m.descriptor.name !== name) continue
      for (const dp of m.dataPoints as { attributes: Record<string, unknown>; value: number | { sum?: number; count: number } }[]) {
        out.push(typeof dp.value === 'number' ? { attrs: dp.attributes, value: dp.value } : { attrs: dp.attributes, value: dp.value.sum ?? 0, count: dp.value.count })
      }
    }
  }
  return out
}
const total = async (name: string, where: Record<string, unknown> = {}): Promise<number> =>
  (await points(name)).filter((p) => Object.entries(where).every(([k, v]) => p.attrs[k] === v)).reduce((a, p) => a + p.value, 0)

const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) }
}

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const ITEM: WorkItem = { kind: 'ci-red', number: 5, sha: SHA('a'), ref: 'claude/x', own: true, title: 'Fix it' }

// ------------------------------------------------------------------ the guard

describe('the attribute guard', () => {
  it('replaces credentials and email addresses, truncates long strings, and keeps names and sizes only for arguments', () => {
    expect(enabled()).toBe(true)
    expect(redact(`token ${SECRET}`)).toBe('[redacted]')
    expect(redact('AKIAABCDEFGHIJKLMNOP')).toBe('[redacted]')
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).toBe('[redacted]')
    expect(redact('mail marc@example.com')).toBe('[redacted]')
    expect(String(redact('x'.repeat(1000))).length).toBeLessThanOrEqual(256)
    expect(redact(['ok', SECRET])).toEqual(['ok', '[redacted]'])
    expect(redact(7)).toBe(7)
    addSecret('s3cr3t-value-not-shaped-like-a-token')
    expect(redact('it is s3cr3t-value-not-shaped-like-a-token here')).toBe('[redacted]')
    expect(argShape({ b: 1, a: 'long text' })).toEqual({ names: ['a', 'b'], bytes: Buffer.byteLength(JSON.stringify({ b: 1, a: 'long text' })) })
    expect(personHash('Marc@Example.com ')).toBe(personHash('marc@example.com'))
    expect(personHash('marc@example.com')).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ------------------------------------------------------------------ tool calls

describe('tool calls (Registry.call)', () => {
  const reg = new Registry([
    defineTool({
      name: 'files.write', description: 'write', input: z.object({ path: z.string(), content: z.string(), token: z.string() }),
      run: ({ content }) => ({ written: content.length }),
    }),
    defineTool({ name: 'files.fail', description: 'fail', input: z.object({}), run: () => { throw new ToolError(`no such file, and here is the token ${SECRET}`) } }),
    defineTool({ name: 'hil.psu', description: 'psu', hardware: true, input: z.object({}), run: () => 'on' }),
  ])

  it('records one execute_tool span per call with names and sizes, never the values', async () => {
    const args = { path: '/home/me/private/notes.txt', content: 'TOP SECRET FILE BODY', token: SECRET }
    expect(await reg.call('files.write', args, { hardware: false, via: 'mcp' })).toEqual({ written: 20 })
    const s = one('execute_tool files.write')
    expect(s.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'files.write', 'trace.tool.name': 'files.write',
      'trace.tool.via': 'mcp', 'trace.tool.hardware': false, 'trace.tool.arg_names': ['content', 'path', 'token'],
      'trace.tool.args_bytes': Buffer.byteLength(JSON.stringify(args)), 'trace.tool.result_bytes': Buffer.byteLength('{"written":20}'),
      'trace.outcome': 'ok',
    })
    expect(s.status.code).toBe(SpanStatusCode.UNSET)
    const all = everything()
    for (const v of ['TOP SECRET FILE BODY', '/home/me/private/notes.txt', SECRET]) expect(all).not.toContain(v)
    expect(await total('trace.tool.calls', { 'trace.tool.name': 'files.write', 'trace.outcome': 'ok' })).toBe(1)
    expect((await points('trace.tool.duration'))[0]?.count).toBe(1)
  })

  it('marks failures (with the message guarded) and counts them, for tool errors, bad input and refused hardware', async () => {
    await expect(reg.call('files.fail', {}, { hardware: false, via: 'cli' })).rejects.toThrow(ToolError)
    await expect(reg.call('files.write', { path: 3 }, { hardware: false, via: 'cli' })).rejects.toThrow(ToolError)
    await expect(reg.call('hil.psu', {}, { hardware: false, via: 'cli' })).rejects.toThrow(/real hardware/)
    const f = one('execute_tool files.fail')
    expect(f.status.code).toBe(SpanStatusCode.ERROR)
    expect(f.status.message).toBe('[redacted]')
    expect(f.attributes['error.type']).toBe('ToolError')
    expect(f.attributes['trace.outcome']).toBe('error')
    expect(one('execute_tool hil.psu').attributes['trace.tool.hardware']).toBe(true)
    expect(everything()).not.toContain(SECRET)
    expect(await total('trace.tool.errors')).toBe(3)
    expect(await total('trace.tool.errors', { 'trace.tool.name': 'files.fail', 'error.type': 'ToolError' })).toBe(1)
    expect(await total('trace.tool.calls', { 'trace.outcome': 'error' })).toBe(3)
  })

  it('on a project\'s runtime, also counts each call in its per-project series: the project\'s hash and the outcome only', async () => {
    const was = process.env.TRACE_PROJECT
    process.env.TRACE_PROJECT = 'Acme/Board'
    resetMetricsCache()
    try {
      await reg.call('files.write', { path: 'a', content: 'b', token: 'c' }, { hardware: false, via: 'mcp' })
      expect(projectDimension()).toBe(`project-${projectHash('acme/board')}`)
      expect(await points('trace.project.tool.calls')).toEqual([{ attrs: { 'trace.project': `project-${projectHash('acme/board')}`, 'trace.outcome': 'ok' }, value: 1 }])
      expect((await points('trace.project.tool.duration'))[0]?.count).toBe(1)
      // the aggregate series is unchanged: no project on it
      expect((await points('trace.tool.calls')).every((x) => !('trace.project' in x.attrs))).toBe(true)
      // nothing else of the call (its tool's name, its arguments) reaches the per-project series
      recordProjectMetric('trace.claude.cost', 0.5, { 'trace.agent': 'verify' })
      expect(await points('trace.project.claude.cost')).toEqual([{ attrs: { 'trace.project': `project-${projectHash('acme/board')}` }, value: 0.5 }])
    } finally {
      if (was === undefined) delete process.env.TRACE_PROJECT
      else process.env.TRACE_PROJECT = was
      resetMetricsCache()
    }
    // a process that serves no one project (the CLI, the API runtime) records the aggregate only
    expect(projectDimension({})).toBeNull()
    expect(projectDimension({ TRACE_PROJECT: 'not a repo' })).toBeNull()
  })

  it('continues the trace a parent process passed in TRACEPARENT (the MCP server under Claude)', async () => {
    const parent = await span('claude.query', {}, async () => traceEnv())
    const was = process.env.TRACEPARENT
    process.env.TRACEPARENT = parent.TRACEPARENT
    try {
      // an inherited TRACEPARENT is ignored until the process says it continues one (tracectl mcp, the GPU runner)
      await reg.call('files.write', { path: 'p', content: 'c', token: 't' }, { hardware: false, via: 'mcp' })
      expect(one('execute_tool files.write').parentSpanContext).toBeUndefined()
      spans.reset()
      continueFromEnv()
      await reg.call('files.write', { path: 'p', content: 'c', token: 't' }, { hardware: false, via: 'mcp' })
    } finally {
      continueFromEnv(false)
      if (was === undefined) delete process.env.TRACEPARENT
      else process.env.TRACEPARENT = was
    }
    const s = one('execute_tool files.write')
    expect(s.spanContext().traceId).toBe(parent.TRACEPARENT?.split('-')[1])
    expect(s.parentSpanContext?.spanId).toBe(parent.TRACEPARENT?.split('-')[2])
  })
})

// ------------------------------------------------------------------ invocations and jobs

describe('invocations and jobs', () => {
  it('continues the caller\'s trace, carries the AgentCore session into baggage, and nests the job under the invocation', async () => {
    const runner: JobRunner = async () => {
      await span('inside', {}, async () => undefined)
      return 'ok'
    }
    const jobs = createJobs(runner, { echo: () => undefined })
    const server = createAgentServer(jobs)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
      const parentId = '00f067aa0ba902b7'
      const session = 'trace-o-r-5-aaaaaaaaaaaa'
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', traceparent: `00-${traceId}-${parentId}-01`, [SESSION_HEADER]: session },
        body: JSON.stringify({ kind: 'work-item', repository: 'o/r', item: ITEM }),
      })
      expect(((await r.json()) as { accepted: boolean }).accepted).toBe(true)
      await until(() => !jobs.busy() && named('trace.job work-item').length === 1)
    } finally {
      await new Promise((r) => server.close(() => r(undefined)))
    }
    const inv = one('invoke_agent trace-worker')
    expect(inv.kind).toBe(SpanKind.SERVER)
    expect(inv.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(inv.parentSpanContext?.spanId).toBe('00f067aa0ba902b7')
    expect(inv.attributes).toMatchObject({
      'session.id': 'trace-o-r-5-aaaaaaaaaaaa', 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'trace-worker',
      'trace.invocation.kind': 'work-item', 'trace.repository': 'o/r', 'trace.outcome': 'ok',
    })
    const job = one('trace.job work-item')
    expect(job.parentSpanContext?.spanId).toBe(inv.spanContext().spanId)
    expect(job.attributes).toMatchObject({
      'session.id': 'trace-o-r-5-aaaaaaaaaaaa', 'trace.job.kind': 'work-item', 'trace.repository': 'o/r', 'trace.agent': 'specialist',
      'trace.work_item.kind': 'ci-red', 'trace.work_item.number': 5, 'trace.outcome': 'ok',
    })
    expect(String(job.attributes['trace.job.id'])).toMatch(/^job-/)
    expect(one('inside').parentSpanContext?.spanId).toBe(job.spanContext().spanId)
    expect(await total('trace.invocations', { 'trace.agent': 'worker', 'trace.invocation.kind': 'work-item', 'trace.outcome': 'ok' })).toBe(1)
    // the item carried no route and this runner routes nothing: the job is counted as the generic "specialist"
    expect(await total('trace.jobs', { 'trace.job.kind': 'work-item', 'trace.agent': 'specialist', 'trace.outcome': 'ok' })).toBe(1)
  })

  it('continues the dispatcher\'s trace from the payload when the request carries none of that trace (workflow → agent → tools)', async () => {
    const jobs = createJobs(async () => { await span('inside', {}, async () => undefined); return 'ok' }, { echo: () => undefined })
    const server = createAgentServer(jobs)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const traceId = '6729a3b0c1d2e3f405162738495a6b7c'
    const parentId = '1122334455667788'
    const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/invocations`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ kind: 'work-item', repository: 'o/r', item: { ...ITEM, number: 77 }, trace: { traceparent: `00-${traceId}-${parentId}-01` } }),
    })
    try {
      // no trace headers at all (AgentCore did not forward them)
      await post({})
      await until(() => !jobs.busy() && named('trace.job work-item').length === 1)
      // a traceparent of another trace (AgentCore's own): the payload's wins, and an X-Amzn-Trace-Id of it is dropped
      await post({ traceparent: `00-${'9'.repeat(32)}-${'8'.repeat(16)}-01`, 'x-amzn-trace-id': `Root=1-${'9'.repeat(8)}-${'9'.repeat(24)};Parent=${'8'.repeat(16)};Sampled=1` })
      await until(() => !jobs.busy() && named('trace.job work-item').length === 2)
      // the same trace in the headers (a span of AgentCore's in between): the headers are used
      await post({ traceparent: `00-${traceId}-${'a'.repeat(16)}-01` })
      await until(() => !jobs.busy() && named('trace.job work-item').length === 3)
    } finally {
      await new Promise((r) => server.close(() => r(undefined)))
    }
    const invs = named('invoke_agent trace-worker')
    expect(invs.map((i) => i.spanContext().traceId)).toEqual([traceId, traceId, traceId])
    expect(invs.map((i) => i.parentSpanContext?.spanId)).toEqual([parentId, parentId, 'a'.repeat(16)])
    for (const job of named('trace.job work-item')) expect(job.spanContext().traceId).toBe(traceId)
    for (const s of named('inside')) expect(s.spanContext().traceId).toBe(traceId)
  })

  it('records who asked as a hash, never their email, and marks a failed job', async () => {
    const jobs = createJobs(async () => { throw new Error('the push was rejected') }, { echo: () => undefined })
    const task: JobPayload = { kind: 'task', repository: 'o/r', request: 'please rewrite README', requestedBy: 'Marc@Example.com', agent: 'render' }
    withSession('api-session-0001', () => jobs.startJob(task))
    await until(() => !jobs.busy() && named('trace.job task').length === 1)
    const job = one('trace.job task')
    expect(job.attributes).toMatchObject({ 'trace.requested_by.hash': personHash('marc@example.com'), 'trace.agent': 'render', 'session.id': 'api-session-0001', 'trace.outcome': 'error' })
    expect(job.status.code).toBe(SpanStatusCode.ERROR)
    const all = everything()
    expect(all.toLowerCase()).not.toContain('marc@example.com')
    expect(all).not.toContain('please rewrite README')
    expect(await total('trace.jobs', { 'trace.outcome': 'error', 'trace.agent': 'render' })).toBe(1)
  })

  it('says when AgentCore did not give ADOT what it needs for metrics', () => {
    expect(telemetryNote({ OTEL_SDK_DISABLED: 'true' })).toMatch(/off/)
    expect(telemetryNote({})).toMatch(/not enabled/)
    expect(telemetryNote({ AGENT_OBSERVABILITY_ENABLED: 'true' })).toMatch(/OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_LOGS_HEADERS not set/)
    expect(telemetryNote({ AGENT_OBSERVABILITY_ENABLED: 'true', OTEL_RESOURCE_ATTRIBUTES: 'service.name=x', OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'x-aws-log-group=g' })).toMatch(/ADOT/)
  })
})

// ------------------------------------------------------------------ Claude (the Agent SDK's message stream)

const MODEL = 'claude-sonnet-4-6'
const STREAM: unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'sdk-session-1', model: MODEL },
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg1', model: MODEL, content: [{ type: 'text', text: 'I will read the private file' }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg1', model: MODEL, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat /home/me/private/notes.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 4 } } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'TOP SECRET FILE BODY', is_error: false }] } },
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg2', model: MODEL, content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__trace__calc_divider', input: { vin: 12 } }], stop_reason: 'tool_use', usage: { input_tokens: 30, output_tokens: 5 } } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'bad input', is_error: true }] } },
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg3', model: MODEL, content: [{ type: 'text', text: 'Pushed the fix.' }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 9 } } },
  {
    type: 'result', subtype: 'success', is_error: false, result: 'Pushed the fix.', num_turns: 3, total_cost_usd: 0.0123,
    modelUsage: { [MODEL]: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 30, cacheCreationInputTokens: 5, webSearchRequests: 0, costUSD: 0.0123, contextWindow: 200000, maxOutputTokens: 64000 } },
  },
]

describe('Claude', () => {
  it('records the query, one chat span per model response, and one span per tool use, with tokens and cost', async () => {
    await span('trace.job work-item', {}, async () => {
      const t = await claudeTelemetry({ model: MODEL, agent: 'ci-doctor' })
      expect(t.env.TRACEPARENT).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      for (const m of STREAM) t.observe(m)
      t.end({ aborted: false })
    })
    const job = one('trace.job work-item')
    const q = one('claude.query')
    expect(q.parentSpanContext?.spanId).toBe(job.spanContext().spanId)
    expect(q.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.system': 'anthropic', 'gen_ai.request.model': MODEL, 'gen_ai.conversation.id': 'sdk-session-1',
      'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 50, 'gen_ai.usage.cache_read.input_tokens': 30, 'gen_ai.usage.cache_creation.input_tokens': 5,
      'trace.claude.turns': 3, 'trace.claude.cost_usd': 0.0123, 'trace.agent': 'ci-doctor', 'trace.outcome': 'ok',
    })
    const chats = named(/^chat /)
    expect(chats.map((c) => c.attributes['gen_ai.response.id'])).toEqual(['msg1', 'msg2', 'msg3'])
    const first = chats[0] as ReadableSpan
    expect(first.attributes).toMatchObject({ 'gen_ai.request.model': MODEL, 'trace.claude.tool_uses': ['Bash'], 'gen_ai.response.finish_reasons': ['tool_use'], 'gen_ai.usage.output_tokens': 20 })
    for (const c of chats) expect(c.parentSpanContext?.spanId).toBe(q.spanContext().spanId)
    const bash = one('execute_tool Bash')
    expect(bash.attributes).toMatchObject({ 'gen_ai.tool.name': 'Bash', 'gen_ai.tool.call.id': 'tu1', 'trace.outcome': 'ok' })
    expect(one('execute_tool mcp__trace__calc_divider').status.code).toBe(SpanStatusCode.ERROR)
    const all = everything()
    for (const v of ['/home/me/private/notes.txt', 'TOP SECRET FILE BODY', 'I will read the private file', 'Pushed the fix.']) expect(all).not.toContain(v)
    expect(await total('gen_ai.client.token.usage', { 'gen_ai.token.type': 'input', 'gen_ai.request.model': MODEL })).toBe(100)
    expect(await total('gen_ai.client.token.usage', { 'gen_ai.token.type': 'output' })).toBe(50)
    expect(await total('trace.claude.cost', { 'trace.agent': 'ci-doctor' })).toBeCloseTo(0.0123)
  })

  it('marks an aborted or failed query, and ends tool spans left open', async () => {
    const t = await claudeTelemetry({ model: MODEL })
    t.observe(STREAM[2])
    t.end({ aborted: true, error: new Error('stopping Claude: it ran longer than 60 s') })
    expect(one('claude.query').attributes['trace.outcome']).toBe('aborted')
    expect(one('execute_tool Bash').attributes['trace.outcome']).toBe('aborted')
    spans.reset()
    const u = await claudeTelemetry({ model: MODEL })
    u.observe({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 42 })
    u.end({ aborted: false })
    const q = one('claude.query')
    expect(q.status.code).toBe(SpanStatusCode.ERROR)
    expect(q.attributes['error.type']).toBe('error_max_turns')
  })

  it('hands the MCP server the query\'s trace context, so its tool spans join the job\'s trace', async () => {
    const calls: { options: ClaudeOptions }[] = []
    const f = fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] })
    const d: RunnerDeps = {
      exec: async () => ({ stdout: '', stderr: '' }),
      getToken: async () => 'ghs_TESTTOKEN1234567890abcdef',
      github: () => f.gh,
      claude: (a) => { calls.push(a); return (async function* () { for (const m of STREAM) yield m })() },
      settingsOf: () => cfgOf(),
      remoteSettings: async () => cfgOf(),
      workspace: mkdtempSync(join(tmpdir(), 'trace-otel-ws-')), persistent: false, cli: '/app/dist/cli.js', timeoutS: 60, model: MODEL, env: { PATH: '/usr/bin' }, now: Date.now,
    }
    const jobs = createJobs(createRunner(d), { echo: () => undefined })
    jobs.startJob({ kind: 'work-item', repository: 'o/r', item: ITEM })
    await until(() => !jobs.busy() && named('trace.job work-item').length === 1)
    const mcp = calls[0]?.options.mcpServers.trace
    // no ADOT --require here: this process was not started by AgentCore (AGENT_OBSERVABILITY_ENABLED unset)
    expect(mcp?.args).toEqual(['/app/dist/cli.js', 'mcp'])
    const q = one('claude.query')
    expect(mcp?.env?.TRACEPARENT).toBe(`00-${q.spanContext().traceId}-${q.spanContext().spanId}-01`)
    expect(q.parentSpanContext?.spanId).toBe(one('trace.job work-item').spanContext().spanId)
    // routed by the runner (no route on the item, nothing in its text, no model): agents.default
    expect(q.attributes['trace.agent']).toBe('verify')
    const job = one('trace.job work-item')
    expect(job.attributes).toMatchObject({ 'trace.agent': 'verify', 'trace.agent.kind': 'verify', 'trace.route.source': 'default', 'trace.route.confidence': 0.2 })
  })
})

// ------------------------------------------------------------------ GPU jobs

class FakeBatch implements BatchApi {
  submitted: Parameters<BatchApi['submitJob']>[0][] = []
  statuses = ['RUNNABLE', 'RUNNING', 'SUCCEEDED']
  ran = false
  constructor(private readonly s3: FakeS3) {}
  async submitJob(i: Parameters<BatchApi['submitJob']>[0]) { this.submitted.push(i); return { jobId: 'batch-1' } }
  async describeJobs(): Promise<{ jobs: BatchJobDetail[] }> {
    const status = (this.statuses.length > 1 ? this.statuses.shift() : this.statuses[0]) as string
    if (status === 'RUNNING' && !this.ran) {
      this.ran = true
      const env = Object.fromEntries((this.submitted[0]?.containerOverrides.environment ?? []).map((x) => [x.name, x.value]))
      // the container's runner, in its own (fresh) context: only TRACEPARENT links it to the submitter
      await context.with(trace.deleteSpan(context.active()), () => observedMain({ s3: this.s3, env, echo: false }))
    }
    return { jobs: [{ jobId: 'batch-1', status }] }
  }
  async terminateJob() { return {} }
}

describe('GPU jobs', () => {
  it('records a local job: kind, backend, exit code, seconds, and counts it', async () => {
    const r = await runJob({ kind: 'blender', argv: [process.execPath, '-e', 'process.exit(3)'], gpu: false, timeoutSeconds: 30 })
    expect(r.exitCode).toBe(3)
    const s = one('trace.gpu_job blender')
    expect(s.attributes).toMatchObject({ 'trace.gpu.kind': 'blender', 'trace.gpu.backend': 'local', 'trace.gpu.gpu': false, 'trace.gpu.exit_code': 3, 'trace.outcome': 'error' })
    expect(typeof s.attributes['trace.gpu.seconds']).toBe('number')
    expect(s.status.code).toBe(SpanStatusCode.ERROR)
    expect(await total('trace.gpu.jobs', { 'trace.gpu.kind': 'blender', 'trace.gpu.backend': 'local', 'trace.outcome': 'error' })).toBe(1)
  })

  it('passes the trace context to a Batch job, whose runner continues the trace', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gpu-otel-'))
    writeFileSync(join(d, 'a.txt'), 'hello')
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3)
    const env = { TRACE_GPU_QUEUE: 'q', TRACE_GPU_JOB_DEFINITION: 'def', TRACE_GPU_BUCKET: 'bucket', TRACE_GPU_QUEUE_WAIT_S: '60' }
    const job = GpuJobSchema.parse({ kind: 'blender', gpu: true, timeoutSeconds: 60, argv: ['sh', '-c', 'cat "$0" > "$1"', '{in:a.txt}', '{out:b.txt}'], inputs: { 'a.txt': join(d, 'a.txt') }, outputs: ['b.txt'] })
    const r = await span('trace.gpu_job blender', {}, () => runBatch(job, { s3, batch, env, sleep: async () => undefined }))
    expect(r.exitCode).toBe(0)
    const parent = one('trace.gpu_job blender')
    const passed = Object.fromEntries((batch.submitted[0]?.containerOverrides.environment ?? []).map((x) => [x.name, x.value]))
    expect(passed.TRACEPARENT).toBe(`00-${parent.spanContext().traceId}-${parent.spanContext().spanId}-01`)
    expect(parent.attributes).toMatchObject({ 'trace.gpu.batch_job_id': 'batch-1' })
    expect(String(parent.attributes['trace.gpu.job_id'])).toMatch(/^blender-/)
    const run = one('trace.gpu.run blender')
    expect(run.kind).toBe(SpanKind.CONSUMER)
    expect(run.spanContext().traceId).toBe(parent.spanContext().traceId)
    expect(run.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    expect(run.attributes).toMatchObject({ 'trace.gpu.exit_code': 0, 'trace.outcome': 'ok' })
  })
})
