/**
 * Hand one work item (or any invocation) to the trace agent on Bedrock AgentCore Runtime: InvokeAgentRuntime with a
 * deterministic session id, so a repeated dispatch of the same item at the same head lands in the same session (whose
 * runtime dedupes by item), and a new push gets a fresh one.
 */
import { createHash, randomBytes } from 'node:crypto'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, type InvokeAgentRuntimeCommandInput } from '@aws-sdk/client-bedrock-agentcore'
import { traceEnv } from '../../core/telemetry.js'
import type { WorkItem } from '../../harness/worker.js'
import { type Accepted, AcceptedSchema, type Invocation, InvocationSchema, type TraceContext, TraceContextSchema } from './schemas.js'

export const SESSION_MIN = 33
export const SESSION_MAX = 256

const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

/**
 * `trace-<owner>-<repo>-<number>-<sha12>`, only [A-Za-z0-9_-], 33–256 characters. A long name is cut and given a hash
 * of the full name, so two long names never collide; a short one is padded with a hash.
 */
export function sessionId(repository: string, item: Pick<WorkItem, 'number' | 'sha'>): string {
  const [owner = '', repo = ''] = repository.split('/')
  const sha = item.sha === 'issue' ? 'issue' : clean(item.sha).slice(0, 12)
  const base = `trace-${clean(owner)}-${clean(repo)}-${item.number}-${sha}`
  const hash = createHash('sha256').update(`${repository}#${item.number}@${item.sha}`).digest('hex')
  if (base.length > SESSION_MAX) return `${base.slice(0, SESSION_MAX - 25)}-${hash.slice(0, 24)}`
  if (base.length < SESSION_MIN) return `${base}-${hash}`.slice(0, Math.max(SESSION_MIN, base.length + 17))
  return base
}

export interface AgentCoreLike {
  send(cmd: InvokeAgentRuntimeCommand): Promise<{ response?: { transformToString(): Promise<string> } | undefined; statusCode?: number | undefined }>
}

export interface DispatchOptions {
  runtimeArn?: string
  region?: string
  qualifier?: string
  runUrl?: string
  client?: AgentCoreLike
  /** Overrides the session id (status/sweep invocations). */
  sessionId?: string
  /** The trace to continue (default: the active span's, when an OpenTelemetry SDK records one). */
  trace?: TraceContext
}

// ------------------------------------------------------------------ trace context across the dispatch

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/**
 * A trace context for a caller with no OpenTelemetry SDK (the GitHub workflow's dispatch step): a child of the
 * TRACEPARENT it was given, if any, else a new trace. A new trace id starts with the time in seconds (8 hex digits),
 * so it is also a valid X-Ray trace id (xrayTraceHeader) and X-Ray indexes it under the right time.
 */
export function newTraceContext(env: Record<string, string | undefined> = process.env, now: () => number = Date.now): TraceContext {
  const parent = TRACEPARENT.exec((env.TRACEPARENT ?? '').trim())
  const traceId = parent?.[1] && !/^0+$/.test(parent[1])
    ? parent[1]
    : `${Math.floor(now() / 1000).toString(16).padStart(8, '0').slice(-8)}${randomBytes(12).toString('hex')}`
  const sampled = parent?.[3] ?? '01'
  return { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-${sampled}`, ...(env.TRACESTATE?.trim() ? { tracestate: env.TRACESTATE.trim().slice(0, 512) } : {}) }
}

/** The same context as an X-Amzn-Trace-Id (Root=1-<8 hex>-<24 hex>;Parent=<16 hex>;Sampled=0|1). */
export function xrayTraceHeader(t: TraceContext): string | undefined {
  const m = TRACEPARENT.exec(t.traceparent)
  if (!m?.[1] || !m[2]) return undefined
  return `Root=1-${m[1].slice(0, 8)}-${m[1].slice(8)};Parent=${m[2]};Sampled=${(parseInt(m[3] ?? '0', 16) & 1).toString()}`
}

/** The active span's context (an SDK is recording: the API runtime), or undefined. */
function activeTrace(): TraceContext | undefined {
  const e = traceEnv()
  const r = TraceContextSchema.safeParse({ ...(e.TRACEPARENT ? { traceparent: e.TRACEPARENT } : {}), ...(e.TRACESTATE ? { tracestate: e.TRACESTATE } : {}), ...(e.BAGGAGE ? { baggage: e.BAGGAGE } : {}) })
  return r.success ? r.data : undefined
}

export function arnRegion(arn: string): string | undefined {
  return /^arn:aws[a-z-]*:bedrock-agentcore:([a-z0-9-]+):/.exec(arn)?.[1]
}

/** Send any invocation to the runtime and parse its answer. */
export async function invoke(payload: Invocation, runtimeSessionId: string, opts: DispatchOptions = {}): Promise<unknown> {
  const arn = opts.runtimeArn ?? process.env.TRACE_AGENT_RUNTIME_ARN
  if (!arn) throw new Error('TRACE_AGENT_RUNTIME_ARN is not set: the AgentCore runtime to dispatch to is unknown')
  if (!/^[A-Za-z0-9_-]{33,256}$/.test(runtimeSessionId)) throw new Error(`invalid runtimeSessionId ${JSON.stringify(runtimeSessionId)}`)
  // the trace goes both ways AgentCore might pass it on: its trace headers, and the payload (observe.ts invocationHeaders)
  const t = payload.trace ?? opts.trace ?? activeTrace()
  const body = InvocationSchema.parse(t ? { ...payload, trace: t } : payload)
  const region = opts.region ?? arnRegion(arn) ?? process.env.AWS_REGION
  const client: AgentCoreLike = opts.client ?? new BedrockAgentCoreClient(region ? { region } : {})
  const xray = t ? xrayTraceHeader(t) : undefined
  const input: InvokeAgentRuntimeCommandInput = {
    agentRuntimeArn: arn,
    runtimeSessionId,
    qualifier: opts.qualifier ?? 'DEFAULT',
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify(body)),
    ...(t ? { traceParent: t.traceparent, ...(t.tracestate ? { traceState: t.tracestate } : {}), ...(t.baggage ? { baggage: t.baggage } : {}), ...(xray ? { traceId: xray } : {}) } : {}),
  }
  const out = await client.send(new InvokeAgentRuntimeCommand(input))
  const text = out.response ? await out.response.transformToString() : ''
  if (out.statusCode !== undefined && out.statusCode >= 300) throw new Error(`the agent runtime answered ${out.statusCode}: ${text.slice(0, 500)}`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`the agent runtime answered with something that is not JSON: ${text.slice(0, 200)}`)
  }
}

export async function dispatch(item: WorkItem, repository: string, opts: DispatchOptions = {}): Promise<Accepted> {
  const payload: Invocation = { kind: 'work-item', repository, item, ...(opts.runUrl ? { runUrl: opts.runUrl } : {}), ...(opts.trace ? { trace: opts.trace } : {}) }
  const out = await invoke(payload, opts.sessionId ?? sessionId(repository, item), opts)
  const r = AcceptedSchema.safeParse(out)
  if (!r.success) throw new Error(`unexpected answer from the agent runtime: ${JSON.stringify(out).slice(0, 300)}`)
  return r.data
}
