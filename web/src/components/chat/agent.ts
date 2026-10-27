/**
 * trace's chat agent: AG-UI over SSE at /api/agui, reached directly with @ag-ui/client's HttpAgent and registered
 * with CopilotKit v2 as a self-managed agent (no CopilotKit runtime). The web backend checks the person's token and
 * project access on every request, which is what a self-managed agent requires. Every request carries the bearer
 * token and the body's SHA-256 (CloudFront origin access control), and retries once after a refresh on 401.
 *
 * What goes on the wire is shaped here, per agent (`setWire`), so every run (the app's own and CopilotKit's
 * follow-ups after a confirm or a decision card) carries it:
 *   - only the viewer's own turns and trace's replies to them are sent as the conversation; messages by other people
 *     on the project (`foreign` ids) go as forwardedProps.others, quoted as data, never as the viewer's requests
 *   - forwardedProps.readOnly when the thread holds other people's messages (or the view is read-only): trace offers
 *     no start_task there
 *   - forwardedProps { repo, thread, after }: where the backend keeps trace's reply (chats.reply, after the viewer's
 *     own latest turn, `after` being the id chats.append gave it)
 */
import { HttpAgent } from '@ag-ui/client'
import type { Message, RunAgentInput } from '@ag-ui/client'
import { refresh, token } from '@/lib/auth'
import { sha256Hex } from '@/lib/http'

export const AGENT_ID = 'trace'
/** a second registration for chats embedded in Focus mode, so they keep their own thread */
export const FOCUS_AGENT_ID = 'trace-focus'

export interface Wire {
  repo?: string
  thread?: string
  /** the stored id of the viewer's latest turn: trace's reply is kept after it */
  after?: string
  /** ids of messages written by other people (and trace's replies to them) */
  foreign: Map<string, string>
  readOnly?: boolean
}

const wires = new Map<string, Wire>()
export const wireOf = (agentId: string): Wire => {
  let w = wires.get(agentId)
  if (!w) { w = { foreign: new Map() }; wires.set(agentId, w) }
  return w
}
export const setWire = (agentId: string, w: Partial<Wire>) => { wires.set(agentId, { ...wireOf(agentId), ...w }) }
export const resetWire = (agentId: string, w: Partial<Wire> = {}) => { wires.set(agentId, { foreign: new Map(), ...w }) }

/** The run input as it goes out: the viewer's own conversation, the rest as quoted data. Pure, so it is tested. */
export function shapeInput(input: RunAgentInput, w: Wire): RunAgentInput {
  const own: Message[] = []
  const others: string[] = []
  for (const m of input.messages) {
    const quoted = w.foreign.get(m.id)
    if (quoted === undefined) own.push(m)
    else if (quoted) others.push(quoted)
  }
  const prev = input.forwardedProps && typeof input.forwardedProps === 'object' ? (input.forwardedProps as Record<string, unknown>) : {}
  const readOnly = Boolean(w.readOnly) || others.length > 0
  return {
    ...input,
    messages: own,
    forwardedProps: {
      ...prev,
      ...(w.repo ? { repo: w.repo } : {}),
      ...(w.thread ? { thread: w.thread } : {}),
      ...(w.after ? { after: w.after } : {}),
      ...(others.length ? { others } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    },
  }
}

export async function signedFetch(url: string, init: RequestInit): Promise<Response> {
  const body = typeof init.body === 'string' ? init.body : init.body == null ? '' : String(init.body)
  const go = async () => {
    const headers = new Headers(init.headers)
    headers.set('x-amz-content-sha256', await sha256Hex(body))
    const t = token()
    if (t) headers.set('authorization', `Bearer ${t}`)
    return fetch(url, { ...init, headers, credentials: 'same-origin' })
  }
  const res = await go()
  if (res.status === 401 && (await refresh())) return go()
  return res
}

class TraceAgent extends HttpAgent {
  constructor(private readonly wireId: string) {
    super({ url: '/api/agui', agentId: wireId, fetch: signedFetch })
  }
  protected override requestInit(input: RunAgentInput): RequestInit {
    return super.requestInit(shapeInput(input, wireOf(this.wireId)))
  }
  override clone(): TraceAgent {
    const c = new TraceAgent(this.wireId)
    c.threadId = this.threadId
    c.setMessages(structuredClone(this.messages))
    return c
  }
}

export function createTraceAgent(agentId = AGENT_ID): HttpAgent {
  return new TraceAgent(agentId)
}
