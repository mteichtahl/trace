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
    throw new HttpError(d.error ?? `${res.status} ${res.statusText}`, res.status, d.code, data)
  }
  return data as T
}
