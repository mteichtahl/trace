/**
 * POST /api/call: `{ action, ...args }` to the API runtime as the signed-in person, exactly as the `tracectl` CLI calls it
 * (src/login/invoke.ts: InvokeAgentRuntime over HTTPS with the person's bearer token), and its answer back as is,
 * status and body, streamed through as it arrives.
 *
 *   before   the bearer is verified here (a fast reject; the runtime verifies it again and decides access)
 *   refused  BACKEND_ONLY actions (chats.reply: trace's words are kept by the chat agent from what it said)
 *   session  one runtime session per person: `trace-web-<first 40 hex of sha256(sub)>`, stable across containers
 *   after    an ok answer to a mutating action (src/web/events.ts changeOf) publishes `record.changed` to every member
 *            of the project (`project.members`, asked with the same token) and to the caller; without a repo (an
 *            admin's people or integrations change, me.set) to the caller only. A failed publish is logged and never
 *            fails the call: the answer has already gone out.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { invocationUrl } from '../api/runtime-url.js'
import type { WebConfig } from './config.js'
import { type WebDeps, signedIn } from './deps.js'
import { changeOf, type LiveEvent, type Publisher, appsyncPublisher, userChannel } from './events.js'
import { JSON_HEADERS, MB, WebError, parseBody, route } from './http.js'

const Body = z.object({ action: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.]*$/, 'an action name') }).catchall(z.unknown())

/** Actions only the web backend itself calls: trace's replies are kept by the chat agent (src/web/agui.ts) from what
 * it said, never from what an app sends. */
export const BACKEND_ONLY = new Set(['chats.reply'])

const CALL_TIMEOUT_MS = 14 * 60_000

/** The person's stable runtime session id (AgentCore needs 33 to 256 characters). */
export const runtimeSession = (sub: string): string => `trace-web-${createHash('sha256').update(sub).digest('hex').slice(0, 40)}`

export interface CallAnswer { status: number; text: string; json: unknown }

export interface Caller { config: WebConfig; token: string; sub: string }

/** One action through the API runtime as the person. With `onChunk`, the body is passed on as it arrives. */
export async function callApi(deps: WebDeps, who: Caller, action: string, args: Record<string, unknown>, o: { signal?: AbortSignal; onStart?: (status: number) => void; onChunk?: (s: string) => void } = {}): Promise<CallAnswer> {
  const url = invocationUrl(who.config.region, who.config.apiRuntimeArn, deps.agentcoreEndpoint)
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS)
  const r = await deps.fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${who.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': runtimeSession(who.sub),
    },
    body: JSON.stringify({ ...args, action }),
    signal,
  })
  o.onStart?.(r.status)
  let text = ''
  if (r.body && o.onChunk) {
    const dec = new TextDecoder()
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      const s = dec.decode(chunk, { stream: true })
      text += s
      if (s) o.onChunk(s)
    }
    const tail = dec.decode()
    text += tail
    if (tail) o.onChunk(tail)
  } else {
    text = await r.text()
  }
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, text, json }
}

const Ok = z.object({ ok: z.literal(true) }).loose()
const Members = z.object({ ok: z.literal(true), result: z.array(z.object({ sub: z.string().min(1) }).loose()) }).loose()

/** Publish `record.changed` for an ok answer to a mutating action. Never throws. */
export async function publishChange(deps: WebDeps, who: Caller, action: string, args: Record<string, unknown>, answer: CallAnswer, publisher?: Publisher): Promise<void> {
  const what = changeOf(action)
  if (!what || answer.status !== 200 || !Ok.safeParse(answer.json).success) return
  try {
    const repo = typeof args.repo === 'string' ? args.repo.toLowerCase() : undefined
    const subs = new Set<string>([who.sub])
    if (repo && action !== 'me.set') {
      const m = await callApi(deps, who, 'project.members', { repo })
      const parsed = Members.safeParse(m.json)
      if (parsed.success) for (const x of parsed.data.result) subs.add(x.sub)
      else deps.log({ warning: 'publish: project.members did not answer', status: m.status, action })
    }
    const event: LiveEvent = { type: 'record.changed', ...(repo ? { repo } : {}), what, at: new Date(deps.now()).toISOString() }
    const pub = publisher ?? appsyncPublisher(who.config, deps.credentials, deps.fetch)
    const results = await Promise.allSettled([...subs].map((s) => pub.publish(userChannel(s), [event])))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) deps.log({ warning: 'publish: some events were not delivered', action, failed, of: subs.size })
  } catch (e) {
    deps.log({ warning: 'publish failed', action, error: e instanceof Error ? e.message : String(e) })
  }
}

export function callRoutes(deps: WebDeps, publisher?: () => Publisher) {
  return [
    route('POST', '/api/call', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const { action, ...args } = parseBody(req, Body, MB)
      if (BACKEND_ONLY.has(action)) throw new WebError(403, 'that action is the chat agent\'s own', 'backend_only')
      const who: Caller = { config: s.config, token: s.token, sub: s.claims.sub }
      return {
        stream: async (sink) => {
          let opened = false
          const open = (status: number): void => { if (!opened) { opened = true; sink.open(status, { ...JSON_HEADERS }) } }
          const answer = await callApi(deps, who, action, args, { onStart: open, onChunk: (c) => sink.write(c) })
          open(answer.status)
          sink.end()
          await publishChange(deps, who, action, args, answer, publisher?.())
        },
      }
    }),
  ]
}
