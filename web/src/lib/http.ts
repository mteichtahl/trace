/**
 * The one way the app talks to /api. CloudFront reaches the Lambda function URL through origin access control, which
 * signs the request for the function, and a signed POST or PUT must carry the SHA-256 of its body in
 * `x-amz-content-sha256` (CloudFront does not compute it). So every body we send is hashed here first.
 */

export class HttpError extends Error {
  override name = 'HttpError'
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

/** What a person is told when trace's web firewall is holding back their network's requests (a 429). */
export const RATE_LIMITED = 'trace has had too many requests from your network in the last few minutes, so it is holding them back. Close any other trace tabs, wait a few minutes and try again.'

/**
 * What a person is told when trace's service did not answer because it is being updated or restarted: the API
 * runtime's 424 while a deploy replaces it (test-esp32 #223), CloudFront's 502 or 504, or the web backend's own 503.
 */
export const UPDATING = 'trace is updating, so it could not answer just now. Try again in a minute.'

/** The statuses that mean trace's service is updating or starting, not that the request was wrong. */
export const UPDATING_STATUSES: ReadonlySet<number> = new Set([424, 502, 503, 504])

/** True for an error that says trace's service is updating or starting: worth trying again a little later. */
export const isUpdating = (e: unknown): boolean =>
  !!e && typeof e === 'object' && UPDATING_CODES.has(String((e as { code?: unknown }).code))

/** The codes for it: the app's own (a bare status), and the web backend's (src/web/call.ts). */
const UPDATING_CODES = new Set(['updating', 'api_updating', 'api_unavailable'])

/** Words for an answer that came with a status and none of trace's own: never a bare number. */
export function statusWords(status: number): string {
  if (UPDATING_STATUSES.has(status)) return UPDATING
  if (status === 401) return 'You are signed out. Sign in again.'
  if (status === 403) return 'no access'
  if (status === 404) return 'trace could not find that.'
  if (status === 413) return 'That is too large to send.'
  if (status >= 500) return `trace's service had a problem answering (HTTP ${status}). Try again; if it keeps happening, an admin can look at its logs.`
  return `trace could not do that (HTTP ${status}).`
}

/** Hex SHA-256 of a string (UTF-8), with the browser's crypto.subtle. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  token?: string | null
  signal?: AbortSignal
  headers?: Record<string, string>
}

/** The raw request: JSON in, JSON out; adds the body hash and bearer token. Throws HttpError on a non-2xx answer. */
export async function request<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const method = o.method ?? (o.body === undefined ? 'GET' : 'POST')
  const headers: Record<string, string> = { accept: 'application/json', ...o.headers }
  let body: string | undefined
  if (method === 'POST' || method === 'PUT') {
    body = o.body === undefined ? '' : JSON.stringify(o.body)
    headers['content-type'] = 'application/json'
    headers['x-amz-content-sha256'] = await sha256Hex(body)
  }
  if (o.token) headers.authorization = `Bearer ${o.token}`
  const res = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: o.signal })
  const text = await res.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string }
    // trace's web firewall (src/infra/edge.ts) answers 429 with no body when one address sent too many requests
    if (res.status === 429 && !d.error) throw new HttpError(RATE_LIMITED, 429, 'rate_limited', data)
    // an answer with none of trace's words (the API runtime's 424 while a deploy replaces it, CloudFront's own pages):
    // said in words, never as a bare status
    const error = typeof d.error === 'string' && d.error.trim() ? d.error : undefined
    if (!error && UPDATING_STATUSES.has(res.status)) throw new HttpError(UPDATING, res.status, 'updating', data)
    throw new HttpError(error ?? statusWords(res.status), res.status, d.code, data)
  }
  return data as T
}
