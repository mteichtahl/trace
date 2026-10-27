/**
 * Calling the API runtime as the signed-in person. With JWT inbound auth, InvokeAgentRuntime cannot go through the
 * AWS SDK (SigV4): it is a plain HTTPS POST (AWS docs, InvokeAgentRuntime / runtime-oauth)
 *
 *   POST https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<url-encoded ARN>/invocations?qualifier=DEFAULT
 *   Authorization: Bearer <access token>
 *   Content-Type: application/json
 *   X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <33–256 characters, one per CLI process>
 *
 * The body is { action, ...args }; the API answers { ok, result } or { ok: false, error }.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { installation } from '../core/client.js'
import { invocationUrl } from '../api/runtime-url.js'
import { LoginError, NO_INSTALLATION, accessToken } from './oauth.js'

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(readonly status: number, message: string) { super(message) }
}

const Answer = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }).loose(),
  z.object({ ok: z.literal(false), error: z.string() }).loose(),
])

/** One runtime session id per CLI process (AgentCore requires at least 33 characters). */
const SESSION_ID = `trace-cli-${randomUUID()}`
export const sessionId = (): string => SESSION_ID

export { invocationUrl }

export interface InvokeOptions {
  fetch?: typeof fetch
  /** Overrides the data-plane endpoint (tests; TRACE_AGENTCORE_ENDPOINT). */
  endpoint?: string
  token?: () => Promise<string>
  /** Stops the call (a held one, say) when it aborts; the 15-minute limit applies either way. */
  signal?: AbortSignal
}

export async function invokeApi(action: string, args: Record<string, unknown> = {}, o: InvokeOptions = {}): Promise<unknown> {
  const i = installation()
  if (!i) throw new LoginError(NO_INSTALLATION)
  if (!i.apiRuntimeArn) throw new LoginError('this installation has no API runtime ARN: run `trace connect` with --api')
  const f = o.fetch ?? fetch
  const token = await (o.token ?? (() => accessToken(f)))()
  const r = await f(invocationUrl(i.region, i.apiRuntimeArn, o.endpoint ?? process.env.TRACE_AGENTCORE_ENDPOINT), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': SESSION_ID,
    },
    body: JSON.stringify({ ...args, action }),
    signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(15 * 60_000)]) : AbortSignal.timeout(15 * 60_000),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  const a = Answer.safeParse(json)
  if (r.status === 401) throw new ApiError(401, 'not signed in (or the session expired): run `trace login`')
  if (r.status === 403) throw new ApiError(403, a.success && !a.data.ok ? a.data.error : 'no access')
  if (!a.success) {
    const m = z.object({ message: z.string() }).loose().safeParse(json)
    throw new ApiError(r.status, `the API answered ${r.status}${m.success ? `: ${m.data.message}` : ''}`)
  }
  if (!a.data.ok) throw new ApiError(r.status, a.data.error)
  return a.data.result
}
