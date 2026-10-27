/**
 * The web backend's HTTP layer, independent of Lambda so every route can be tested with plain objects.
 *
 *   WebRequest   method, path, query, lower-cased headers, cookies and the body as text (a Lambda function URL event
 *                is turned into one by src/web/lambda.ts)
 *   Sink         where an answer goes: open(status, headers, cookies) once, then write and end. Lambda's response
 *                stream in production; a recorder in tests. SSE routes write as they go; JSON routes write once.
 *   Reply        what a JSON route returns; the router sends it with `cache-control: no-store`
 *   WebError     a refusal with its status, message and optional code: `{ ok: false, error, code? }`
 *   route()      method + path pattern (`:name` segments) → handler; the router answers 404 and 405 itself
 *
 * Security headers are CloudFront's (a response headers policy), never set here. Every request is logged as one JSON
 * line: who (a hash of the person's sub, never an email or a token), method, path, status, ms.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export interface WebRequest {
  method: string
  path: string
  query: URLSearchParams
  /** lower-cased names */
  headers: Readonly<Record<string, string>>
  cookies: Readonly<Record<string, string>>
  body: string
}

export interface Sink {
  open(status: number, headers: Record<string, string>, cookies?: readonly string[]): void
  write(chunk: string): void
  end(): void
}

export interface Reply {
  status?: number
  body: unknown
  cookies?: readonly string[]
}

export class WebError extends Error {
  override name = 'WebError'
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
}

/** The answer to a request: a JSON reply, or a stream the handler writes itself (SSE). */
export type Answer = Reply | { stream: (sink: Sink) => Promise<void> }

export interface Ctx {
  /** set by a handler once it knows who is asking: the log's `who` */
  who?: string
  params: Record<string, string>
}

export type Handler = (req: WebRequest, ctx: Ctx) => Promise<Answer>

export interface Route { method: string; parts: string[]; handler: Handler }

export const route = (method: string, pattern: string, handler: Handler): Route => ({ method, parts: pattern.split('/').filter(Boolean), handler })

export const JSON_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

export const MB = 1024 * 1024

/** A person as the logs know them: sha256 of the sub, 16 hex characters (the shape of telemetry's personHash). */
export const whoHash = (sub: string): string => createHash('sha256').update(sub.trim().toLowerCase()).digest('hex').slice(0, 16)

/** Parse a JSON body against a schema; too large → 413, not JSON or the wrong shape → 400. */
export function parseBody<S extends z.ZodType>(req: WebRequest, schema: S, limit = MB): z.output<S> {
  if (Buffer.byteLength(req.body) > limit) throw new WebError(413, `the body is larger than ${Math.round(limit / MB)} MB`)
  let json: unknown
  try {
    json = req.body.trim() ? JSON.parse(req.body) : {}
  } catch {
    throw new WebError(400, 'the body is not JSON')
  }
  const r = schema.safeParse(json)
  if (!r.success) throw new WebError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'bad_request')
  return r.data
}

/**
 * Cookies from a Cookie header value or Lambda's `cookies` list. A name sent more than once is dropped altogether: a
 * second cookie of the same name can only come from somewhere else (a sibling host, another path) trying to stand in
 * for ours, and which one the browser lists first is not ours to guess.
 */
export function parseCookies(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const twice = new Set<string>()
  for (const v of values) {
    for (const part of v.split(';')) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      const k = part.slice(0, i).trim()
      const raw = part.slice(i + 1).trim()
      if (Object.hasOwn(out, k)) twice.add(k)
      try { out[k] = decodeURIComponent(raw) } catch { out[k] = raw }
    }
  }
  for (const k of twice) delete out[k]
  return out
}

export interface CookieOptions { path: string; maxAge: number }

/** An HttpOnly, Secure, SameSite=Strict cookie (or its removal, maxAge 0). */
export const cookie = (name: string, value: string, o: CookieOptions): string =>
  `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=${o.path}; Max-Age=${o.maxAge}`

export interface RouterOptions {
  log?: (line: Record<string, unknown>) => void
  now?: () => number
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The router: finds the route, runs it, maps errors, writes the answer and logs one line. */
export function router(routes: readonly Route[], o: RouterOptions = {}): (req: WebRequest, sink: Sink) => Promise<void> {
  const log = o.log ?? ((l) => { process.stdout.write(`${JSON.stringify(l)}\n`) })
  const now = o.now ?? Date.now
  return async (req, sink) => {
    const t0 = now()
    const ctx: Ctx = { params: {} }
    let status = 200
    let error: string | undefined
    const send = (r: Reply): void => {
      status = r.status ?? 200
      const text = JSON.stringify(r.body)
      sink.open(status, { ...JSON_HEADERS }, r.cookies)
      sink.write(text)
      sink.end()
    }
    try {
      const parts = req.path.split('/').filter(Boolean)
      let matched: Route | null = null
      let pathMatched = false
      for (const r of routes) {
        if (r.parts.length !== parts.length) continue
        const params: Record<string, string> = {}
        const ok = r.parts.every((p, i) => {
          const seg = parts[i] ?? ''
          if (p.startsWith(':')) { try { params[p.slice(1)] = decodeURIComponent(seg) } catch { return false } return true }
          return p === seg
        })
        if (!ok) continue
        pathMatched = true
        if (r.method === req.method) { matched = r; ctx.params = params; break }
      }
      if (!matched) throw pathMatched ? new WebError(405, 'method not allowed') : new WebError(404, 'not found')
      const answer = await matched.handler(req, ctx)
      if ('stream' in answer) {
        status = 200
        await answer.stream(sink)
      } else {
        send(answer)
      }
    } catch (e) {
      const we = e instanceof WebError ? e : null
      status = we?.status ?? 500
      error = we ? we.message : 'internal error'
      if (!we) error = `internal error: ${message(e)}`.slice(0, 300)
      try {
        send({ status, body: { ok: false, error: we ? we.message : 'internal error', ...(we?.code ? { code: we.code } : {}) } })
      } catch { /* the stream had already started */ }
    } finally {
      log({ at: new Date(t0).toISOString(), who: ctx.who ?? null, method: req.method, path: req.path, status, ms: now() - t0, ...(error ? { error } : {}) })
    }
  }
}
