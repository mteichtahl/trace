/**
 * Traces and metrics for trace, through the OpenTelemetry API only. With no SDK registered (local runs, tests, the
 * CLI) every call here is a no-op: the API's default providers record nothing and cost almost nothing. On Bedrock
 * AgentCore the image starts Node with the ADOT auto-instrumentation (`--require …/register`), which registers the SDK
 * and exports spans to X-Ray (CloudWatch Transaction Search) and metrics as CloudWatch EMF; see the README's
 * "Observability" section.
 *
 *   span(name, attrs, fn)          run fn inside a span (status and error recorded, ended in every case)
 *   recordMetric(name, value, a)   add to a counter or record into a histogram (METRICS lists them)
 *   withSession(id, fn)            run fn with OTel baggage session.id (AgentCore groups a session's traces by it)
 *   traceEnv()                     TRACEPARENT/TRACESTATE/BAGGAGE for a child process or a Batch job
 *   flush()                        push what is buffered (before process.exit)
 *
 * What may be recorded: names, kinds, ids, counts, sizes, durations and outcomes. Never argument values, file
 * contents, prompts, tokens or email addresses. Every attribute goes through `redact`, which truncates strings and
 * replaces anything shaped like a credential, as a guard against a mistake upstream.
 */
import { createHash } from 'node:crypto'
import {
  type Attributes, type AttributeValue, type Context, type Span, type SpanOptions, type Tracer,
  ROOT_CONTEXT, SpanKind, SpanStatusCode, context, isSpanContextValid, metrics, propagation, trace,
} from '@opentelemetry/api'

export { SpanKind }
export type { Span }

const SCOPE = 'trace'

// ------------------------------------------------------------------ attribute keys

/**
 * The attribute keys trace records. OpenTelemetry GenAI semantic conventions where one applies
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/), `trace.*` for the rest.
 */
export const ATTR = {
  // GenAI semantic conventions
  genAiSystem: 'gen_ai.system',
  genAiProvider: 'gen_ai.provider.name',
  genAiOperation: 'gen_ai.operation.name',
  genAiAgentName: 'gen_ai.agent.name',
  genAiConversationId: 'gen_ai.conversation.id',
  genAiRequestModel: 'gen_ai.request.model',
  genAiResponseModel: 'gen_ai.response.model',
  genAiResponseId: 'gen_ai.response.id',
  genAiFinishReasons: 'gen_ai.response.finish_reasons',
  genAiInputTokens: 'gen_ai.usage.input_tokens',
  genAiOutputTokens: 'gen_ai.usage.output_tokens',
  genAiCacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
  genAiCacheCreationTokens: 'gen_ai.usage.cache_creation.input_tokens',
  genAiTokenType: 'gen_ai.token.type',
  genAiToolName: 'gen_ai.tool.name',
  genAiToolCallId: 'gen_ai.tool.call.id',
  genAiToolType: 'gen_ai.tool.type',
  // general conventions
  sessionId: 'session.id',
  errorType: 'error.type',
  // trace's own
  invocationKind: 'trace.invocation.kind',
  action: 'trace.action',
  jobId: 'trace.job.id',
  jobKind: 'trace.job.kind',
  workItemKind: 'trace.work_item.kind',
  workItemNumber: 'trace.work_item.number',
  repository: 'trace.repository',
  agent: 'trace.agent',
  /** sha256 of the lower-cased email, 16 hex characters (the same hash the agents' memory uses) */
  requestedBy: 'trace.requested_by.hash',
  principal: 'trace.principal.hash',
  principalClass: 'trace.principal.class',
  outcome: 'trace.outcome',
  status: 'http.response.status_code',
  toolName: 'trace.tool.name',
  toolVia: 'trace.tool.via',
  toolHardware: 'trace.tool.hardware',
  toolArgNames: 'trace.tool.arg_names',
  toolArgsBytes: 'trace.tool.args_bytes',
  toolResultBytes: 'trace.tool.result_bytes',
  durationMs: 'trace.duration_ms',
  claudeTurns: 'trace.claude.turns',
  claudeCostUsd: 'trace.claude.cost_usd',
  claudeToolUses: 'trace.claude.tool_uses',
  claudeParentToolUseId: 'trace.claude.parent_tool_use_id',
  claudeSubtype: 'trace.claude.result',
  gpuKind: 'trace.gpu.kind',
  gpuBackend: 'trace.gpu.backend',
  gpuWanted: 'trace.gpu.gpu',
  gpuJobId: 'trace.gpu.job_id',
  gpuBatchJobId: 'trace.gpu.batch_job_id',
  gpuExitCode: 'trace.gpu.exit_code',
  gpuSeconds: 'trace.gpu.seconds',
  gpuInputs: 'trace.gpu.inputs',
  gpuOutputs: 'trace.gpu.outputs',
} as const

export type AttrKey = (typeof ATTR)[keyof typeof ATTR]
export type Attrs = Partial<Record<AttrKey, AttributeValue | undefined>>

/** Outcomes, the same words in spans and metrics. */
export type Outcome = 'ok' | 'error' | 'denied' | 'aborted' | 'rejected'

// ------------------------------------------------------------------ redaction

const MAX_STRING = 256
const MAX_ARRAY = 64

/** Shapes of credentials that must never reach a span: GitHub tokens, AWS keys, JWTs, auth headers, private keys. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /\b(authorization|bearer|basic)\b\s*[:=]?\s*[A-Za-z0-9+/=._-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bx-access-token:/i,
]
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/

const secrets = new Set<string>()

/** Register a secret this process holds (a token read from Secrets Manager): it is redacted wherever it appears. */
export function addSecret(s: string): void {
  if (s.length >= 8) {
    secrets.add(s)
    secrets.add(Buffer.from(`x-access-token:${s}`).toString('base64'))
  }
}

function redactString(s: string): string {
  for (const t of secrets) if (s.includes(t)) return '[redacted]'
  if (SECRET_PATTERNS.some((p) => p.test(s))) return '[redacted]'
  if (EMAIL.test(s)) return '[redacted]'
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING - 1)}…` : s
}

/** The attribute guard: strings truncated and anything credential-shaped (or an email address) replaced. */
export function redact(v: AttributeValue): AttributeValue {
  if (typeof v === 'string') return redactString(v)
  if (Array.isArray(v)) {
    const a = v.slice(0, MAX_ARRAY)
    return (a.every((x) => typeof x === 'string' || x === null || x === undefined)
      ? (a as (string | null | undefined)[]).map((x) => (typeof x === 'string' ? redactString(x) : x))
      : a) as AttributeValue
  }
  return v
}

/** Drop undefined values and guard the rest. */
export function attributes(attrs: Attrs): Attributes {
  const out: Attributes = {}
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) out[k] = redact(v)
  return out
}

/** A person's id for spans: sha256 of the lower-cased email (or sub), 16 hex characters. The email itself is never recorded. */
export const personHash = (who: string): string => createHash('sha256').update(who.trim().toLowerCase()).digest('hex').slice(0, 16)

/** Names and sizes of a tool's arguments, never their values. */
export function argShape(args: unknown): { names: string[]; bytes: number } {
  const names = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).sort() : []
  return { names, bytes: byteSize(args) }
}

export function byteSize(v: unknown): number {
  if (v === undefined) return 0
  try {
    return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? Number(x) : x)) ?? '')
  } catch {
    return 0
  }
}

// ------------------------------------------------------------------ context: sessions and propagation

export const SESSION_BAGGAGE = 'session.id'

/** Run fn with session.id in the OTel baggage (and so on every span below it, and in traceEnv()). */
export function withSession<T>(sessionId: string | undefined, fn: () => T): T {
  if (!sessionId) return fn()
  const bag = (propagation.getBaggage(context.active()) ?? propagation.createBaggage()).setEntry(SESSION_BAGGAGE, { value: sessionId })
  return context.with(propagation.setBaggage(context.active(), bag), fn)
}

/** The session id in the active baggage, if any. */
export function currentSession(ctx: Context = context.active()): string | undefined {
  return propagation.getBaggage(ctx)?.getEntry(SESSION_BAGGAGE)?.value
}

/** Continue a trace from incoming headers (traceparent, tracestate, baggage, X-Amzn-Trace-Id), as the propagator reads them. */
export function fromHeaders(headers: Record<string, string | string[] | undefined>, base: Context = context.active()): Context {
  return propagation.extract(base, headers, {
    keys: (c) => Object.keys(c),
    get: (c, k) => {
      const v = c[k.toLowerCase()] ?? c[k]
      return Array.isArray(v) ? v[0] : v
    },
  })
}

/** The active trace context as environment variables for a child process or a Batch job (empty without a span). */
export function traceEnv(ctx: Context = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {}
  propagation.inject(ctx, carrier)
  const out: Record<string, string> = {}
  if (carrier.traceparent) out.TRACEPARENT = carrier.traceparent
  if (carrier.tracestate) out.TRACESTATE = carrier.tracestate
  if (carrier.baggage) out.BAGGAGE = carrier.baggage
  return out
}

let envParent: { key: string; ctx: Context } | null = null
let inheritEnv = false

/**
 * Let this process continue the trace its parent passed in TRACEPARENT/BAGGAGE when nothing is active: the trace
 * MCP server under Claude, the GPU runner. Off by default, so a TRACEPARENT a process merely inherited (a CI runner,
 * a developer's shell) never captures its spans.
 */
export function continueFromEnv(on = true): void {
  inheritEnv = on
}

/** The parent this process was given in TRACEPARENT/BAGGAGE (the MCP server under Claude, a GPU job), if any. */
export function envContext(env: NodeJS.ProcessEnv = process.env): Context | null {
  if (!env.TRACEPARENT) return null
  const key = `${env.TRACEPARENT}|${env.TRACESTATE ?? ''}|${env.BAGGAGE ?? ''}`
  if (envParent?.key !== key) {
    const carrier: Record<string, string> = { traceparent: env.TRACEPARENT }
    if (env.TRACESTATE) carrier.tracestate = env.TRACESTATE
    if (env.BAGGAGE) carrier.baggage = env.BAGGAGE
    envParent = { key, ctx: propagation.extract(ROOT_CONTEXT, carrier) }
  }
  return envParent.ctx
}

/** The active context, or (after continueFromEnv) the process's TRACEPARENT parent when nothing is active. */
export function parentContext(): Context {
  const active = context.active()
  if (trace.getSpan(active)) return active
  const fromEnv = inheritEnv ? envContext() : null
  if (!fromEnv) return active
  // keep any baggage set in-process on top of the inherited one
  const bag = propagation.getBaggage(active)
  return bag ? propagation.setBaggage(fromEnv, bag) : fromEnv
}

// ------------------------------------------------------------------ spans

export const tracer = (): Tracer => trace.getTracer(SCOPE)

export interface SpanOpts { kind?: SpanKind; parent?: Context; startTime?: number }

/**
 * Run fn inside a span: its status is set from the result (an exception records error.type and the message, then
 * rethrows), and it ends in every case. The session id in the baggage is copied onto the span.
 */
export async function span<T>(name: string, attrs: Attrs, fn: (s: Span) => Promise<T> | T, o: SpanOpts = {}): Promise<T> {
  const parent = o.parent ?? parentContext()
  const session = currentSession(parent)
  const opts: SpanOptions = {
    kind: o.kind ?? SpanKind.INTERNAL,
    attributes: attributes({ ...attrs, ...(session ? { [ATTR.sessionId]: session } : {}) }),
    ...(o.startTime !== undefined ? { startTime: o.startTime } : {}),
  }
  return tracer().startActiveSpan(name, opts, parent, async (s) => {
    try {
      const out = await fn(s)
      return out
    } catch (e) {
      fail(s, e)
      throw e
    } finally {
      s.end()
    }
  })
}

/** Start a span without making it active (for one that outlives the code that starts it). End it with endSpan. */
export function startSpan(name: string, attrs: Attrs, o: SpanOpts = {}): Span {
  const parent = o.parent ?? parentContext()
  const session = currentSession(parent)
  return tracer().startSpan(name, {
    kind: o.kind ?? SpanKind.INTERNAL,
    attributes: attributes({ ...attrs, ...(session ? { [ATTR.sessionId]: session } : {}) }),
    ...(o.startTime !== undefined ? { startTime: o.startTime } : {}),
  }, parent)
}

/** Set (guarded) attributes on a span. */
export function setAttrs(s: Span, attrs: Attrs): void {
  s.setAttributes(attributes(attrs))
}

/** Set (guarded) attributes on the active span, if there is one. */
export function annotate(attrs: Attrs): void {
  const s = trace.getActiveSpan()
  if (s) setAttrs(s, attrs)
}

/** Mark a span failed: error.type is the error's class, the message is guarded like any attribute. */
export function fail(s: Span, e: unknown, type?: string): void {
  const err = e instanceof Error ? e : new Error(String(e))
  s.setAttribute(ATTR.errorType, type ?? err.name ?? 'Error')
  s.setAttribute(ATTR.outcome, 'error')
  s.setStatus({ code: SpanStatusCode.ERROR, message: String(redact(err.message)) })
}

export function ok(s: Span): void {
  s.setStatus({ code: SpanStatusCode.OK })
}

/** Run fn with `s` as the active span (its children nest under it). */
export function inSpan<T>(s: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), s), fn)
}

// ------------------------------------------------------------------ tool calls (Registry.call)

/**
 * One span and three metrics per tool call: `execute_tool <name>` with the tool's name, where the call came from,
 * whether hardware was allowed, the argument names and size (never their values), the result's size, the duration
 * and the outcome.
 */
export async function observeTool<T>(name: string, args: unknown, ctx: { via: string; hardware: boolean }, hardwareTool: boolean, run: () => Promise<T>): Promise<T> {
  const shape = argShape(args)
  const t0 = performance.now()
  let outcome: Outcome = 'ok'
  let errorType: string | undefined
  try {
    return await span(`execute_tool ${name}`, {
      [ATTR.genAiOperation]: 'execute_tool',
      [ATTR.genAiToolName]: name,
      [ATTR.genAiToolType]: 'function',
      [ATTR.toolName]: name,
      [ATTR.toolVia]: ctx.via,
      [ATTR.toolHardware]: hardwareTool,
      [ATTR.toolArgNames]: shape.names,
      [ATTR.toolArgsBytes]: shape.bytes,
    }, async (s) => {
      const out = await run()
      setAttrs(s, { [ATTR.toolResultBytes]: byteSize(out), [ATTR.outcome]: 'ok' })
      return out
    })
  } catch (e) {
    outcome = 'error'
    errorType = e instanceof Error ? e.name : 'Error'
    throw e
  } finally {
    const ms = performance.now() - t0
    const dims: MetricAttrs = { [ATTR.toolName]: name, [ATTR.outcome]: outcome }
    recordMetric('trace.tool.calls', 1, dims)
    recordMetric('trace.tool.duration', ms, dims)
    if (outcome !== 'ok') recordMetric('trace.tool.errors', 1, { [ATTR.toolName]: name, [ATTR.errorType]: errorType })
  }
}

// ------------------------------------------------------------------ metrics

/** Every metric trace records. On AgentCore they land in the `bedrock-agentcore` CloudWatch namespace (EMF). */
export const METRICS = {
  'trace.invocations': { kind: 'counter', unit: '{invocation}', description: 'Invocations of a trace runtime (worker or API)' },
  'trace.jobs': { kind: 'counter', unit: '{job}', description: 'Jobs finished, by kind and outcome' },
  'trace.job.duration': { kind: 'histogram', unit: 's', description: 'How long a job ran' },
  'trace.tool.calls': { kind: 'counter', unit: '{call}', description: 'Tool calls through the registry' },
  'trace.tool.errors': { kind: 'counter', unit: '{call}', description: 'Tool calls that failed' },
  'trace.tool.duration': { kind: 'histogram', unit: 'ms', description: 'How long a tool call took' },
  'gen_ai.client.token.usage': { kind: 'histogram', unit: '{token}', description: 'Tokens Claude used per job, by type (input, output, cache_read, cache_creation)' },
  'trace.claude.cost': { kind: 'counter', unit: 'USD', description: 'Estimated cost of Claude per job (the Agent SDK\'s estimate)' },
  'trace.gpu.jobs': { kind: 'counter', unit: '{job}', description: 'GPU jobs (renders, autorouters), by kind, backend and outcome' },
  'trace.gpu.duration': { kind: 'histogram', unit: 's', description: 'How long a GPU job took, queue wait included' },
} as const satisfies Record<string, { kind: 'counter' | 'histogram'; unit: string; description: string }>

export type MetricName = keyof typeof METRICS

/** Metric dimensions must stay few and low-cardinality (each combination is a CloudWatch metric): no ids, no repositories. */
export type MetricAttrs = Partial<Record<AttrKey, string | number | boolean | undefined>>

interface Instruments { add: (v: number, a: Attributes) => void }
let cache = new WeakMap<object, Map<MetricName, Instruments>>()

function instrument(name: MetricName): Instruments {
  const provider = metrics.getMeterProvider()
  let byName = cache.get(provider)
  if (!byName) { byName = new Map(); cache.set(provider, byName) }
  let ins = byName.get(name)
  if (!ins) {
    const def = METRICS[name]
    const meter = provider.getMeter(SCOPE)
    if (def.kind === 'counter') {
      const c = meter.createCounter(name, { unit: def.unit, description: def.description })
      ins = { add: (v, a) => c.add(v, a) }
    } else {
      const h = meter.createHistogram(name, { unit: def.unit, description: def.description })
      ins = { add: (v, a) => h.record(v, a) }
    }
    byName.set(name, ins)
  }
  return ins
}

/** Add `value` to a counter, or record it into a histogram (by METRICS[name].kind). Negative or non-finite values are ignored. */
export function recordMetric(name: MetricName, value: number, attrs: MetricAttrs = {}): void {
  if (!Number.isFinite(value) || value < 0) return
  const a: Attributes = {}
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) a[k] = typeof v === 'string' ? redactString(v) : v
  instrument(name).add(value, a)
}

/** For tests: forget the instruments made for earlier meter providers. */
export function resetMetricsCache(): void {
  cache = new WeakMap()
}

// ------------------------------------------------------------------ the SDK

interface Flushable { forceFlush?: () => Promise<void>; getDelegate?: () => unknown }

/** Whether an SDK is registered (ADOT, or a test's provider): spans would be recorded. */
export function enabled(): boolean {
  // The no-op tracer hands out spans with an invalid context; any SDK gives a real one. The probe is never ended,
  // so it is never exported.
  return isSpanContextValid(trace.getTracer(SCOPE).startSpan('trace.probe', {}, ROOT_CONTEXT).spanContext())
}

/** Push buffered spans and metrics (best effort, bounded by timeoutMs). Call it before process.exit. */
export async function flush(timeoutMs = 5000): Promise<void> {
  const providers = [trace.getTracerProvider() as Flushable, metrics.getMeterProvider() as Flushable]
  const all = providers.map((p) => {
    const d = (p.getDelegate?.() ?? p) as Flushable
    return typeof d.forceFlush === 'function' ? d.forceFlush().catch(() => undefined) : Promise.resolve()
  })
  await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, timeoutMs).unref())])
}

/** The ADOT auto-instrumentation's register module, when installed (it is a dependency; the images have it). */
export const ADOT_REGISTER = '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register'

/**
 * Node arguments that load ADOT in a child Node process (the MCP server under Claude), only when this process runs
 * with AgentCore observability on (AGENT_OBSERVABILITY_ENABLED=true) and an SDK is registered here.
 */
export async function childNodeArgs(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if ((env.AGENT_OBSERVABILITY_ENABLED ?? '').toLowerCase() !== 'true' || ['1', 'true'].includes((env.OTEL_SDK_DISABLED ?? '').toLowerCase())) return []
  if (!enabled()) return []
  try {
    const { createRequire } = await import('node:module')
    return ['--require', createRequire(import.meta.url).resolve(ADOT_REGISTER)]
  } catch {
    return []
  }
}

/**
 * Start ADOT in this process when it was not started with --require (the GPU runner): only when an OTLP endpoint is
 * configured (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) and the SDK is not disabled.
 * Returns whether an SDK is now registered.
 */
export async function startSdkIfConfigured(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (enabled()) return true
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return false
  if (['1', 'true'].includes((env.OTEL_SDK_DISABLED ?? '').toLowerCase())) return false
  try {
    const { createRequire } = await import('node:module')
    createRequire(import.meta.url)(ADOT_REGISTER)
  } catch (e) {
    process.stderr.write(`trace: could not start OpenTelemetry: ${e instanceof Error ? e.message : String(e)}\n`)
    return false
  }
  return enabled()
}
