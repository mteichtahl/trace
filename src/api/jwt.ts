/**
 * Verifies Cognito access tokens, independently of AgentCore's own check (defence in depth).
 *
 *   signature   RS256, against the user pool's JWKS (${issuer}/.well-known/jwks.json), cached; an unknown `kid`
 *               refetches the set at most once a minute (key rotation)
 *   claims      iss = the pool, token_use = 'access', client_id = the CLI app client or the web app's, exp/nbf with 60 s leeway
 *               (verifyId: an id token, token_use = 'id' and aud = the app client; the web backend reads who signed in
 *               from it)
 *
 * Nothing here logs or returns the token.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto'
import { z } from 'zod'

export class AuthError extends Error {
  override name = 'AuthError'
}

const LEEWAY_S = 60
const REFETCH_MIN_MS = 60_000
const JWKS_TTL_MS = 6 * 3600_000

const Jwk = z.object({ kid: z.string(), kty: z.literal('RSA'), n: z.string(), e: z.string(), alg: z.string().optional(), use: z.string().optional() }).loose()
const Jwks = z.object({ keys: z.array(z.unknown()) }).loose()
const Header = z.object({ alg: z.string(), kid: z.string(), typ: z.string().optional() }).loose()

export const AccessClaims = z.object({
  sub: z.string().min(1),
  iss: z.string(),
  token_use: z.string(),
  client_id: z.string().optional(),
  exp: z.number(),
  nbf: z.number().optional(),
  iat: z.number().optional(),
  username: z.string().optional(),
  'cognito:groups': z.array(z.string()).optional(),
}).loose()
export type AccessClaims = z.output<typeof AccessClaims>

export const IdClaims = z.object({
  sub: z.string().min(1),
  iss: z.string(),
  token_use: z.string(),
  aud: z.string(),
  exp: z.number(),
  nbf: z.number().optional(),
  iat: z.number().optional(),
  email: z.string().optional(),
  'cognito:username': z.string().optional(),
  'cognito:groups': z.array(z.string()).optional(),
}).loose()
export type IdClaims = z.output<typeof IdClaims>

export type JwksFetcher = (url: string) => Promise<unknown>

export interface VerifierOptions {
  issuer: string
  /** The app client (or clients) whose tokens are accepted: the CLI's, and the web app's when it exists. */
  clientId: string | readonly string[]
  fetchJwks?: JwksFetcher
  now?: () => number
}

const b64url = (s: string): Buffer => Buffer.from(s, 'base64url')

function decodeJson(part: string, what: string): unknown {
  try {
    return JSON.parse(b64url(part).toString('utf8'))
  } catch {
    throw new AuthError(`malformed token ${what}`)
  }
}

const defaultFetch: JwksFetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new AuthError(`JWKS ${r.status}`)
  return r.json()
}

export class Verifier {
  private readonly issuer: string
  private readonly clientIds: ReadonlySet<string>
  private readonly fetchJwks: JwksFetcher
  private readonly now: () => number
  private keys = new Map<string, KeyObject>()
  private fetchedAt = 0
  private loading: Promise<void> | null = null

  constructor(o: VerifierOptions) {
    const ids = (typeof o.clientId === 'string' ? [o.clientId] : [...o.clientId]).filter(Boolean)
    if (!o.issuer || !ids.length) throw new Error('the verifier needs the Cognito issuer and client id')
    this.issuer = o.issuer.replace(/\/+$/, '')
    this.clientIds = new Set(ids)
    this.fetchJwks = o.fetchJwks ?? defaultFetch
    this.now = o.now ?? Date.now
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const set = Jwks.parse(await this.fetchJwks(`${this.issuer}/.well-known/jwks.json`))
        const keys = new Map<string, KeyObject>()
        for (const k of set.keys) {
          const jwk = Jwk.safeParse(k)
          if (!jwk.success) continue
          keys.set(jwk.data.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.data.n, e: jwk.data.e }, format: 'jwk' }))
        }
        this.keys = keys
        this.fetchedAt = this.now()
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  private async key(kid: string): Promise<KeyObject> {
    const stale = this.now() - this.fetchedAt > JWKS_TTL_MS
    if (stale || (!this.keys.has(kid) && this.now() - this.fetchedAt > REFETCH_MIN_MS)) {
      try {
        await this.load()
      } catch (e) {
        if (!this.keys.size) throw new AuthError(`cannot fetch the signing keys: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const k = this.keys.get(kid)
    if (!k) throw new AuthError('unknown signing key')
    return k
  }

  /** The verified claims of a Cognito access token; throws AuthError otherwise. */
  async verify(token: string): Promise<AccessClaims> {
    const c = await this.checked(token, AccessClaims)
    if (c.token_use !== 'access') throw new AuthError('not an access token')
    if (c.client_id === undefined || !this.clientIds.has(c.client_id)) throw new AuthError('wrong client')
    return c
  }

  /** The verified claims of a Cognito id token (token_use 'id', aud = the app client); throws AuthError otherwise. */
  async verifyId(token: string): Promise<IdClaims> {
    const c = await this.checked(token, IdClaims)
    if (c.token_use !== 'id') throw new AuthError('not an id token')
    if (typeof c.aud !== 'string' || !this.clientIds.has(c.aud)) throw new AuthError('wrong client')
    return c
  }

  /** Signature, issuer and time checks shared by both kinds of token. */
  private async checked<S extends typeof AccessClaims | typeof IdClaims>(token: string, schema: S): Promise<z.output<S>> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new AuthError('malformed token')
    const [h, p, s] = parts as [string, string, string]
    const header = Header.safeParse(decodeJson(h, 'header'))
    if (!header.success) throw new AuthError('malformed token header')
    if (header.data.alg !== 'RS256') throw new AuthError('unexpected signing algorithm')
    const key = await this.key(header.data.kid)
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, b64url(s))
    if (!ok) throw new AuthError('bad signature')
    const claims = schema.safeParse(decodeJson(p, 'payload'))
    if (!claims.success) throw new AuthError('malformed token claims')
    const c = claims.data as z.output<S>
    if (c.iss !== this.issuer) throw new AuthError('wrong issuer')
    const t = this.now() / 1000
    if (c.exp + LEEWAY_S < t) throw new AuthError('token expired')
    if (c.nbf !== undefined && c.nbf - LEEWAY_S > t) throw new AuthError('token not yet valid')
    return c
  }
}

/** The bearer token of an Authorization header value, or null. */
export function bearer(header: string | string[] | undefined): string | null {
  const v = Array.isArray(header) ? header[0] : header
  const m = /^Bearer\s+(\S+)\s*$/i.exec(v ?? '')
  return m?.[1] ?? null
}
