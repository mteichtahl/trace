/**
 * trace's chat agent: AG-UI over SSE at /api/agui, reached directly with @ag-ui/client's HttpAgent and registered
 * with CopilotKit v2 as a self-managed agent (no CopilotKit runtime). The web backend checks the person's token and
 * project access on every request, which is what a self-managed agent requires. Every request carries the bearer
 * token and the body's SHA-256 (CloudFront origin access control), and retries once after a refresh on 401.
 */
import { HttpAgent } from '@ag-ui/client'
import { refresh, token } from '@/lib/auth'
import { sha256Hex } from '@/lib/http'

export const AGENT_ID = 'trace'
/** a second registration for chats embedded in Focus mode, so they keep their own thread */
export const FOCUS_AGENT_ID = 'trace-focus'

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

export function createTraceAgent(agentId = AGENT_ID): HttpAgent {
  return new HttpAgent({ url: '/api/agui', agentId, fetch: signedFetch })
}
