/**
 * Everything a route needs, built once per container from the config (src/web/aws.ts in production, fakes in tests),
 * and the one check every authenticated route makes first: the bearer token verified here, locally, before any call
 * goes out (a fast reject; the API runtime checks it again).
 */
import { AuthError, type AccessClaims, Verifier, bearer } from '../api/jwt.js'
import type { WebConfig } from './config.js'
import { type Ctx, type WebRequest, WebError, whoHash } from './http.js'
import type { BedrockPort, CloudWatchPort, CognitoPort, Credentials, PollyPort, StorePort } from './ports.js'

export interface WebDeps {
  config: () => Promise<WebConfig>
  verifier: (c: WebConfig) => Verifier
  cognito: (c: WebConfig) => CognitoPort
  bedrock: (c: WebConfig) => BedrockPort
  polly: (c: WebConfig) => PollyPort
  store: (c: WebConfig) => StorePort
  cloudwatch: (c: WebConfig) => CloudWatchPort
  credentials: Credentials
  /** the API runtime and AppSync's HTTP endpoint are reached with it */
  fetch: typeof fetch
  /** overrides the AgentCore data-plane endpoint (tests; TRACE_AGENTCORE_ENDPOINT) */
  agentcoreEndpoint?: string
  log: (line: Record<string, unknown>) => void
  now: () => number
}

export interface SignedIn {
  token: string
  claims: AccessClaims
  config: WebConfig
}

/**
 * Where the person's bearer token arrives. CloudFront's origin access control signs every request to the function URL
 * and puts its own signature in Authorization, so the /api/* viewer-request function (src/infra/web.ts) moves the
 * viewer's Authorization here first, dropping any value a viewer sent in this header. Must match FORWARDED_AUTH_HEADER.
 */
export const FORWARDED_AUTH_HEADER = 'x-trace-authorization'

/** The person's token: the forwarded header behind CloudFront; Authorization only when it carries a bearer token
 * (local runs without CloudFront, and tests). */
export function personToken(headers: WebRequest['headers']): string | null {
  return bearer(headers[FORWARDED_AUTH_HEADER]) ?? bearer(headers.authorization)
}

/** The verified bearer token of the request, or 401. Sets the log's `who`. */
export async function signedIn(req: WebRequest, ctx: Ctx, deps: WebDeps): Promise<SignedIn> {
  const token = personToken(req.headers)
  if (!token) throw new WebError(401, 'not signed in', 'unauthenticated')
  const config = await deps.config()
  try {
    const claims = await deps.verifier(config).verify(token)
    ctx.who = whoHash(claims.sub)
    return { token, claims, config }
  } catch (e) {
    if (e instanceof AuthError) throw new WebError(401, `not signed in: ${e.message}`, 'unauthenticated')
    throw e
  }
}

/** A container-lifetime cache for a factory keyed by nothing but the config (which never changes in a container). */
export function once<T>(make: (c: WebConfig) => T): (c: WebConfig) => T {
  let v: { value: T } | null = null
  return (c) => (v ??= { value: make(c) }).value
}
