/**
 * Between Lambda and the HTTP layer: a function URL event as a WebRequest, and Lambda's response stream as a Sink.
 * Kept apart from src/web/lambda.ts, which touches the runtime's `awslambda` global when it loads, so these can be
 * tested anywhere.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import type { Writable } from 'node:stream'
import { type Sink, type WebRequest, parseCookies } from './http.js'

/** A function URL event as a WebRequest (base64 bodies decoded, header names lower-cased; `raw`: the body's bytes). */
export function toRequest(e: APIGatewayProxyEventV2): WebRequest {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(e.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v
  const raw = e.body ? (e.isBase64Encoded ? Buffer.from(e.body, 'base64') : Buffer.from(e.body, 'utf8')) : Buffer.alloc(0)
  const body = raw.toString('utf8')
  return {
    raw,
    method: e.requestContext?.http?.method ?? 'GET',
    path: e.rawPath || '/',
    query: new URLSearchParams(e.rawQueryString ?? ''),
    headers,
    cookies: parseCookies(e.cookies ?? (headers.cookie ? [headers.cookie] : [])),
    body,
  }
}

export interface ResponseMetadata { statusCode: number; headers: Record<string, string>; cookies?: string[] }

/** Lambda's response stream as a Sink: the metadata goes first (`from`: awslambda.HttpResponseStream.from). */
export function streamSink(responseStream: Writable, from: (w: Writable, m: ResponseMetadata) => Writable): Sink {
  let out: Writable | null = null
  return {
    open(statusCode, headers, cookies) {
      if (out) return
      out = from(responseStream, { statusCode, headers, ...(cookies?.length ? { cookies: [...cookies] } : {}) })
    },
    write(chunk) { out?.write(chunk) },
    end() { (out ?? responseStream).end() },
  }
}
