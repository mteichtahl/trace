/**
 * Hand one work item (or any invocation) to the trace agent on Bedrock AgentCore Runtime: InvokeAgentRuntime with a
 * deterministic session id, so a repeated dispatch of the same item at the same head lands in the same session (whose
 * runtime dedupes by item), and a new push gets a fresh one.
 */
import { createHash } from 'node:crypto'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, type InvokeAgentRuntimeCommandInput } from '@aws-sdk/client-bedrock-agentcore'
import type { WorkItem } from '../../harness/worker.js'
import { type Accepted, AcceptedSchema, type Invocation, InvocationSchema } from './schemas.js'

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
}

export function arnRegion(arn: string): string | undefined {
  return /^arn:aws[a-z-]*:bedrock-agentcore:([a-z0-9-]+):/.exec(arn)?.[1]
}

/** Send any invocation to the runtime and parse its answer. */
export async function invoke(payload: Invocation, runtimeSessionId: string, opts: DispatchOptions = {}): Promise<unknown> {
  const arn = opts.runtimeArn ?? process.env.TRACE_AGENT_RUNTIME_ARN
  if (!arn) throw new Error('TRACE_AGENT_RUNTIME_ARN is not set: the AgentCore runtime to dispatch to is unknown')
  if (!/^[A-Za-z0-9_-]{33,256}$/.test(runtimeSessionId)) throw new Error(`invalid runtimeSessionId ${JSON.stringify(runtimeSessionId)}`)
  const body = InvocationSchema.parse(payload)
  const region = opts.region ?? arnRegion(arn) ?? process.env.AWS_REGION
  const client: AgentCoreLike = opts.client ?? new BedrockAgentCoreClient(region ? { region } : {})
  const input: InvokeAgentRuntimeCommandInput = {
    agentRuntimeArn: arn,
    runtimeSessionId,
    qualifier: opts.qualifier ?? 'DEFAULT',
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify(body)),
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
  const payload: Invocation = { kind: 'work-item', repository, item, ...(opts.runUrl ? { runUrl: opts.runUrl } : {}) }
  const out = await invoke(payload, opts.sessionId ?? sessionId(repository, item), opts)
  const r = AcceptedSchema.safeParse(out)
  if (!r.success) throw new Error(`unexpected answer from the agent runtime: ${JSON.stringify(out).slice(0, 300)}`)
  return r.data
}
