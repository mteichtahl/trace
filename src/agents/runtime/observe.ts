/**
 * What the agent records about its own work (src/core/telemetry.ts has the primitives; all of it is a no-op without
 * an OpenTelemetry SDK):
 *
 *   invoke_agent <runtime>   one per POST /invocations (server.ts, src/api/server.ts), continuing the caller's trace
 *                            from its headers, with the AgentCore session id in baggage session.id
 *   trace.job <kind>         one per job (jobs.ts), under the invocation that started it
 *   claude.query             one per Agent SDK query() (job.ts runClaude), with the totals from the result message
 *   chat <model>             one per model response (consecutive assistant messages sharing message.id)
 *   execute_tool <name>      one per tool_use Claude made, from the tool_use to its tool_result
 *
 * Only names, ids, counts, tokens, cost and outcomes are recorded: never prompts, tool inputs or tool results.
 */
import { z } from 'zod'
import type { IncomingHttpHeaders } from 'node:http'
import { context, trace } from '@opentelemetry/api'
import {
  ATTR, type Attrs, type Outcome, type Span, SpanKind, childNodeArgs, fail, fromHeaders, ok, parentContext, personHash, recordMetric, recordProjectMetric, setAttrs, span, startSpan, traceEnv, withSession,
} from '../../core/telemetry.js'
import type { JobPayload, TraceContext } from './schemas.js'

/** Claude runs through Bedrock on AgentCore (CLAUDE_CODE_USE_BEDROCK=1); otherwise the Anthropic API. */
export const genAiSystem = (env: NodeJS.ProcessEnv = process.env): string =>
  (['1', 'true'].includes((env.CLAUDE_CODE_USE_BEDROCK ?? '').toLowerCase()) ? 'aws.bedrock' : 'anthropic')

/**
 * One line about telemetry at start-up. The image starts Node with the ADOT auto-instrumentation
 * (`--require …/register`, agent/Dockerfile); AgentCore Runtime supplies its OTEL_* configuration. Without the logs
 * headers ADOT has nowhere to send metrics (EMF), so say so rather than lose them silently.
 */
export function telemetryNote(env: NodeJS.ProcessEnv = process.env): string {
  if (['1', 'true'].includes((env.OTEL_SDK_DISABLED ?? '').toLowerCase())) return 'telemetry: off (OTEL_SDK_DISABLED)'
  if ((env.AGENT_OBSERVABILITY_ENABLED ?? '').toLowerCase() !== 'true') return 'telemetry: AgentCore observability is not enabled here (AGENT_OBSERVABILITY_ENABLED)'
  const missing = ['OTEL_RESOURCE_ATTRIBUTES', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS'].filter((k) => !env[k])
  return missing.length ? `telemetry: warning: ${missing.join(' and ')} not set: spans are exported, metrics may not be` : 'telemetry: AgentCore observability (ADOT)'
}

/** The header AgentCore Runtime sends each invocation's session id in (InvokeAgentRuntime's runtimeSessionId). */
export const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'

const w3cTraceId = (tp: string | undefined): string | undefined => (tp ? /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(tp.trim())?.[1] : undefined)
/** An X-Amzn-Trace-Id's Root (1-<8 hex>-<24 hex>) as the W3C trace id it stands for. */
const xrayTraceId = (h: string | undefined): string | undefined => {
  const m = h ? /(?:^|;)\s*Root=1-([0-9a-f]{8})-([0-9a-f]{24})/i.exec(h) : null
  return m ? `${m[1]}${m[2]}`.toLowerCase() : undefined
}
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/**
 * The headers an invocation continues its trace from. A caller (the GitHub workflow's dispatch, the API) sends its
 * trace context both as InvokeAgentRuntime's traceparent/tracestate/baggage headers and in the payload (`trace`).
 * When the request reaches here with a traceparent or X-Amzn-Trace-Id of that same trace (AgentCore's own span in
 * between), the headers are used; otherwise the payload's context replaces them, so workflow → agent → tools → GPU
 * jobs stay one trace whether or not AgentCore forwards the headers.
 */
export function invocationHeaders(headers: IncomingHttpHeaders, t?: TraceContext): IncomingHttpHeaders {
  const want = t ? w3cTraceId(t.traceparent) : undefined
  if (!t || !want) return headers
  if (w3cTraceId(first(headers.traceparent)) === want || xrayTraceId(first(headers['x-amzn-trace-id'])) === want) return headers
  const out: IncomingHttpHeaders = { ...headers, traceparent: t.traceparent }
  delete out['x-amzn-trace-id']
  delete out.tracestate
  if (t.tracestate) out.tracestate = t.tracestate
  if (t.baggage) out.baggage = t.baggage
  return out
}

/** The runtime session id of a request, if AgentCore sent one. */
export function sessionOf(headers: IncomingHttpHeaders): string | undefined {
  const v = headers[SESSION_HEADER]
  const s = Array.isArray(v) ? v[0] : v
  return s && /^[A-Za-z0-9_-]{1,256}$/.test(s) ? s : undefined
}

/**
 * One invocation of a runtime as a span (`invoke_agent trace-<runtime>`, SERVER), continuing the caller's trace from
 * the request headers (traceparent, X-Amzn-Trace-Id, baggage) with the AgentCore session id in baggage session.id,
 * so every span below it (jobs started from it included) carries the session. Counts trace.invocations.
 */
export async function observeInvocation<T>(runtime: 'worker' | 'api' | 'external' | 'mcp', headers: IncomingHttpHeaders, attrs: Attrs,
  fn: (s: Span, outcome: (o: Outcome, more?: Attrs) => void) => Promise<T> | T): Promise<T> {
  const session = sessionOf(headers)
  const system = genAiSystem()
  let outcome: Outcome = 'ok'
  let kind = attrs[ATTR.invocationKind] ?? attrs[ATTR.action]
  try {
    return await context.with(fromHeaders(headers as Record<string, string | string[] | undefined>), () => withSession(session, () =>
      span(`invoke_agent trace-${runtime}`, {
        [ATTR.genAiOperation]: 'invoke_agent', [ATTR.genAiAgentName]: `trace-${runtime}`, [ATTR.genAiSystem]: system, [ATTR.genAiProvider]: system,
        ...(session ? { [ATTR.genAiConversationId]: session } : {}),
        ...attrs,
      }, (s) => fn(s, (o, more = {}) => {
        outcome = o
        // the action as a metric dimension only once it is known to be a real one (each value is a CloudWatch metric)
        if (more[ATTR.action] !== undefined && (o === 'ok' || o === 'denied')) kind = more[ATTR.action]
        setAttrs(s, { ...more, [ATTR.outcome]: o })
        if (o === 'ok' || o === 'rejected') ok(s)
        else fail(s, new Error(typeof more[ATTR.errorType] === 'string' ? String(more[ATTR.errorType]) : o), o)
      }), { kind: SpanKind.SERVER })))
  } catch (e) {
    outcome = 'error'
    throw e
  } finally {
    recordMetric('trace.invocations', 1, { [ATTR.agent]: runtime, ...(typeof kind === 'string' ? { [ATTR.invocationKind]: kind } : {}), [ATTR.outcome]: outcome })
  }
}

/** The span attributes of a job: kind, repository, agent, the item, and who asked (hashed, never the email). */
export function jobAttrs(p: JobPayload, jobId: string, agent: string): Attrs {
  const base: Attrs = { [ATTR.jobId]: jobId, [ATTR.jobKind]: p.kind, [ATTR.agent]: agent }
  switch (p.kind) {
    case 'work-item':
      return {
        ...base, [ATTR.repository]: p.repository, [ATTR.workItemKind]: p.item.kind, [ATTR.workItemNumber]: p.item.number,
        ...(p.item.route ? { [ATTR.agentKind]: p.item.route.kind, [ATTR.routeSource]: p.item.route.source, [ATTR.routeConfidence]: p.item.route.confidence, [ATTR.routeReason]: p.item.route.reason } : {}),
      }
    case 'task':
      if ('delegation' in p) return { ...base, [ATTR.repository]: p.repository, [ATTR.parentJobId]: p.delegation.parentJobId, [ATTR.agentKind]: 'worker' }
      return { ...base, [ATTR.repository]: p.repository, [ATTR.requestedBy]: personHash(p.requestedBy), ...(p.issue ? { [ATTR.workItemNumber]: p.issue } : {}), ...(p.agent ? { [ATTR.agentKind]: p.agent } : {}) }
    case 'sweep':
      return base
  }
}

/**
 * One job as a span (`trace.job <kind>`, under whatever is active: the invocation that started it) plus the job
 * count and duration metrics. `run` never throws (jobs.ts records the failure on the job); the outcome is read from
 * the job's state once it has run.
 */
export async function observeJob(p: JobPayload, jobId: string, agent: string, state: () => { state: string; error?: string | undefined; agent?: string | undefined }, run: () => Promise<void>): Promise<void> {
  const t0 = performance.now()
  let outcome: Outcome = 'ok'
  try {
    await span(`trace.job ${p.kind}`, jobAttrs(p, jobId, agent), async (s) => {
      await run()
      const st = state()
      outcome = st.state === 'succeeded' ? 'ok' : st.state === 'aborted' ? 'aborted' : 'error'
      if (outcome === 'ok') ok(s)
      else fail(s, new Error(st.error ?? st.state), outcome === 'aborted' ? 'aborted' : 'job_failed')
      setAttrs(s, { [ATTR.outcome]: outcome })
    })
  } catch {
    // telemetry never stops a job; run() itself does not throw
  } finally {
    // the agent once routed (the specialist), else the one it started as
    const dims = { [ATTR.jobKind]: p.kind, [ATTR.agent]: state().agent ?? agent, [ATTR.outcome]: outcome }
    recordProjectMetric('trace.jobs', 1, dims)
    recordProjectMetric('trace.job.duration', (performance.now() - t0) / 1000, dims)
  }
}

// ------------------------------------------------------------------ the Agent SDK's message stream

const Usage = z.object({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
}).loose()

const Block = z.object({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().nullish(),
}).loose()

const AssistantMsg = z.object({
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullish(),
  message: z.object({
    id: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullish(),
    usage: Usage.nullish(),
    content: z.array(Block).optional(),
  }).loose(),
}).loose()

const UserMsg = z.object({
  type: z.literal('user'),
  message: z.object({ content: z.union([z.string(), z.array(Block)]).optional() }).loose(),
}).loose()

const InitMsg = z.object({ type: z.literal('system'), subtype: z.literal('init'), session_id: z.string().optional(), model: z.string().optional() }).loose()

const ModelUsage = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadInputTokens: z.number().default(0),
  cacheCreationInputTokens: z.number().default(0),
  costUSD: z.number().default(0),
}).loose()

const ResultMsg = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
  modelUsage: z.record(z.string(), ModelUsage).optional(),
}).loose()

interface Turn { id: string; span: Span; model: string; tools: string[]; usage: z.infer<typeof Usage> | null; stop: string | null }

export interface ClaudeTelemetry {
  /** Environment for the trace MCP server (TRACEPARENT/BAGGAGE: its tool spans join this trace). */
  env: Record<string, string>
  /** Node arguments that load ADOT in the MCP server (empty unless observability is on). */
  nodeArgs: string[]
  /** Feed every SDK message. Never throws. */
  observe(m: unknown): void
  /** End every open span. */
  end(how: { aborted: boolean; error?: unknown }): void
}

export interface ClaudeTelemetryOptions {
  model?: string | undefined
  agent?: string | undefined
  maxTurns?: number | undefined
  now?: () => number
}

/** Spans for one query(): claude.query, a chat span per model response, an execute_tool span per tool use. */
export async function claudeTelemetry(o: ClaudeTelemetryOptions = {}): Promise<ClaudeTelemetry> {
  const now = o.now ?? Date.now
  const system = genAiSystem()
  const agent = o.agent ?? 'worker'
  const root = startSpan('claude.query', {
    [ATTR.genAiOperation]: 'invoke_agent', [ATTR.genAiSystem]: system, [ATTR.genAiProvider]: system, [ATTR.genAiAgentName]: `claude/${agent}`,
    [ATTR.agent]: agent, ...(o.model ? { [ATTR.genAiRequestModel]: o.model } : {}),
  }, { kind: SpanKind.CLIENT })
  // the job's span when one is active, else the process's TRACEPARENT parent
  const rootCtx = trace.setSpan(parentContext(), root)
  const env = traceEnv(rootCtx)
  const nodeArgs = await childNodeArgs()
  const tools = new Map<string, { span: Span; name: string }>()
  let turn: Turn | null = null
  let boundary = now()
  let result: z.infer<typeof ResultMsg> | null = null
  let ended = false

  const closeTurn = (): void => {
    if (!turn) return
    const u = turn.usage
    setAttrs(turn.span, {
      [ATTR.claudeToolUses]: turn.tools,
      ...(turn.stop ? { [ATTR.genAiFinishReasons]: [turn.stop] } : {}),
      ...(u?.input_tokens != null ? { [ATTR.genAiInputTokens]: u.input_tokens } : {}),
      ...(u?.output_tokens != null ? { [ATTR.genAiOutputTokens]: u.output_tokens } : {}),
      ...(u?.cache_read_input_tokens != null ? { [ATTR.genAiCacheReadTokens]: u.cache_read_input_tokens } : {}),
      ...(u?.cache_creation_input_tokens != null ? { [ATTR.genAiCacheCreationTokens]: u.cache_creation_input_tokens } : {}),
    })
    ok(turn.span)
    turn.span.end(new Date(now()))
    boundary = now()
    turn = null
  }

  const onAssistant = (m: z.infer<typeof AssistantMsg>): void => {
    const id = m.message.id ?? `turn-${boundary}`
    if (turn && turn.id !== id) closeTurn()
    if (!turn) {
      const model = m.message.model ?? o.model ?? 'claude'
      turn = {
        id, model, tools: [], usage: null, stop: null,
        span: startSpan(`chat ${model}`, {
          [ATTR.genAiOperation]: 'chat', [ATTR.genAiSystem]: system, [ATTR.genAiProvider]: system,
          [ATTR.genAiRequestModel]: model, [ATTR.genAiResponseModel]: model, [ATTR.genAiResponseId]: id,
          ...(m.parent_tool_use_id ? { [ATTR.claudeParentToolUseId]: m.parent_tool_use_id } : {}),
        }, { kind: SpanKind.CLIENT, parent: rootCtx, startTime: boundary }),
      }
    }
    if (m.message.usage) turn.usage = m.message.usage
    if (m.message.stop_reason) turn.stop = m.message.stop_reason
    for (const b of m.message.content ?? []) {
      if (b.type !== 'tool_use' || !b.name) continue
      turn.tools.push(b.name)
      if (b.id && !tools.has(b.id)) {
        tools.set(b.id, {
          name: b.name,
          span: startSpan(`execute_tool ${b.name}`, {
            [ATTR.genAiOperation]: 'execute_tool', [ATTR.genAiToolName]: b.name, [ATTR.genAiToolCallId]: b.id,
            ...(m.parent_tool_use_id ? { [ATTR.claudeParentToolUseId]: m.parent_tool_use_id } : {}),
          }, { kind: SpanKind.INTERNAL, parent: rootCtx }),
        })
      }
    }
  }

  const onUser = (m: z.infer<typeof UserMsg>): void => {
    closeTurn()
    if (!Array.isArray(m.message.content)) return
    for (const b of m.message.content) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const t = tools.get(b.tool_use_id)
      if (!t) continue
      tools.delete(b.tool_use_id)
      if (b.is_error) fail(t.span, new Error(`${t.name} returned an error`), 'tool_error')
      else { setAttrs(t.span, { [ATTR.outcome]: 'ok' }); ok(t.span) }
      t.span.end()
    }
    boundary = now()
  }

  const onResult = (m: z.infer<typeof ResultMsg>): void => {
    closeTurn()
    result = m
    const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
    for (const [model, u] of Object.entries(m.modelUsage ?? {})) {
      const dims = { [ATTR.genAiRequestModel]: model, [ATTR.agent]: agent }
      const per = { input: u.inputTokens, output: u.outputTokens, cache_read: u.cacheReadInputTokens, cache_creation: u.cacheCreationInputTokens }
      for (const [type, n] of Object.entries(per) as [keyof typeof totals, number][]) {
        totals[type] += n
        if (n > 0) recordMetric('gen_ai.client.token.usage', n, { ...dims, [ATTR.genAiTokenType]: type })
      }
    }
    if (m.total_cost_usd !== undefined) recordProjectMetric('trace.claude.cost', m.total_cost_usd, { [ATTR.agent]: agent })
    setAttrs(root, {
      [ATTR.claudeSubtype]: m.subtype,
      [ATTR.genAiInputTokens]: totals.input, [ATTR.genAiOutputTokens]: totals.output,
      [ATTR.genAiCacheReadTokens]: totals.cache_read, [ATTR.genAiCacheCreationTokens]: totals.cache_creation,
      ...(m.num_turns !== undefined ? { [ATTR.claudeTurns]: m.num_turns } : {}),
      ...(m.total_cost_usd !== undefined ? { [ATTR.claudeCostUsd]: m.total_cost_usd } : {}),
      ...(Object.keys(m.modelUsage ?? {}).length ? { [ATTR.genAiResponseModel]: Object.keys(m.modelUsage ?? {}).join(',') } : {}),
    })
  }

  return {
    env,
    nodeArgs,
    observe(m) {
      if (ended) return
      try {
        const a = AssistantMsg.safeParse(m)
        if (a.success) return onAssistant(a.data)
        const u = UserMsg.safeParse(m)
        if (u.success) return onUser(u.data)
        const r = ResultMsg.safeParse(m)
        if (r.success) return onResult(r.data)
        const i = InitMsg.safeParse(m)
        if (i.success && i.data.session_id) setAttrs(root, { [ATTR.genAiConversationId]: i.data.session_id })
      } catch {
        // telemetry never stops a job
      }
    },
    end(how) {
      if (ended) return
      ended = true
      try {
        closeTurn()
        for (const t of tools.values()) { setAttrs(t.span, { [ATTR.outcome]: 'aborted' }); t.span.end() }
        tools.clear()
        const r: z.infer<typeof ResultMsg> | null = result
        let outcome: Outcome = 'ok'
        if (how.aborted) { outcome = 'aborted'; fail(root, how.error ?? new Error('aborted'), 'aborted') }
        else if (how.error !== undefined) { outcome = 'error'; fail(root, how.error) }
        else if (!r) { outcome = 'error'; fail(root, new Error('Claude ended without a result'), 'no_result') }
        else if (r.subtype !== 'success' || r.is_error) { outcome = 'error'; fail(root, new Error(`Claude stopped (${r.subtype})`), r.subtype) }
        else ok(root)
        setAttrs(root, { [ATTR.outcome]: outcome })
        root.end()
      } catch {
        // telemetry never stops a job
      }
    },
  }
}
