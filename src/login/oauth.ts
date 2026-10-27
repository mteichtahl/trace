/**
 * Signing in to a trace installation from the CLI: OAuth 2.0 authorization code with PKCE (RFC 7636) against the
 * Cognito user pool's hosted domain, with a one-shot callback server on 127.0.0.1 (the first free port of the
 * installation's callback ports; the app client allows http://localhost:<port>/callback).
 *
 *   login(installation)   opens the browser, waits for the redirect, checks `state`, exchanges the code, saves
 *                         the Session in ~/.trace/client.db
 *   refresh()             the refresh_token grant (Cognito keeps the same refresh token)
 *   accessToken()         the current access token, refreshed when under 5 minutes are left
 *   logout()              revokes the refresh token (/oauth2/revoke) and deletes the session
 *
 * Tokens are written only to client.db (0600), never printed or logged.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { z } from 'zod'
import { type Installation, type Session, clearSession, installation as savedInstallation, saveSession, session as savedSession } from '../core/client.js'

export class LoginError extends Error {
  override name = 'LoginError'
}

const REFRESH_MARGIN_S = 300
const LOGIN_TIMEOUT_MS = 5 * 60_000

// ------------------------------------------------------------------ PKCE

export interface Pkce { verifier: string; challenge: string; method: 'S256' }

/** A 43-character base64url verifier (32 random bytes) and its S256 challenge. */
export function pkce(bytes: Buffer = randomBytes(32)): Pkce {
  const verifier = bytes.toString('base64url')
  return { verifier, challenge: challengeFor(verifier), method: 'S256' }
}

export const challengeFor = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

export const newState = (): string => randomBytes(24).toString('base64url')

export function sameState(expected: string, got: string | null | undefined): boolean {
  if (typeof got !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  return a.length === b.length && timingSafeEqual(a, b)
}

const base = (i: Pick<Installation, 'cognitoDomain'>): string => i.cognitoDomain.replace(/\/+$/, '')

export function authorizeUrl(i: Pick<Installation, 'cognitoDomain' | 'clientId'>, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: i.clientId, redirect_uri: redirectUri, scope: 'openid email profile',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })
  return `${base(i)}/oauth2/authorize?${q.toString()}`
}

// ------------------------------------------------------------------ tokens

const TokenResponse = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
}).loose()
export type TokenResponse = z.output<typeof TokenResponse>

const IdClaims = z.object({
  sub: z.string(),
  email: z.string().optional(),
  'cognito:username': z.string().optional(),
  'cognito:groups': z.array(z.string()).optional(),
}).loose()

/** The (unverified) claims of a token we just received over TLS from the token endpoint; used for display only. */
export function claimsOf(jwt: string): z.output<typeof IdClaims> {
  const part = jwt.split('.')[1]
  if (!part) throw new LoginError('the token endpoint returned a malformed token')
  const parsed = IdClaims.safeParse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
  if (!parsed.success) throw new LoginError('the token endpoint returned a token without a subject')
  return parsed.data
}

async function tokenRequest(i: Pick<Installation, 'cognitoDomain'>, form: Record<string, string>, f: typeof fetch): Promise<TokenResponse> {
  const r = await f(`${base(i)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const json: unknown = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = z.object({ error: z.string().optional(), error_description: z.string().optional() }).loose().safeParse(json)
    throw new LoginError(`sign-in refused: ${e.success ? e.data.error_description ?? e.data.error ?? r.status : r.status}`)
  }
  const t = TokenResponse.safeParse(json)
  if (!t.success) throw new LoginError('the token endpoint gave an unexpected answer')
  return t.data
}

export async function exchangeCode(i: Pick<Installation, 'cognitoDomain' | 'clientId'>, code: string, verifier: string, redirectUri: string, f: typeof fetch = fetch): Promise<TokenResponse> {
  return tokenRequest(i, { grant_type: 'authorization_code', client_id: i.clientId, code, code_verifier: verifier, redirect_uri: redirectUri }, f)
}

function toSession(i: Installation, t: TokenResponse, previous?: Session, now = Date.now()): Session {
  const idToken = t.id_token ?? previous?.idToken
  const refreshToken = t.refresh_token ?? previous?.refreshToken
  if (!idToken || !refreshToken) throw new LoginError('the token endpoint did not return an id and a refresh token')
  const id = claimsOf(idToken)
  const access = claimsOf(t.access_token)
  return {
    installation: i.name, sub: id.sub, email: id.email ?? null, groups: access['cognito:groups'] ?? id['cognito:groups'] ?? [],
    accessToken: t.access_token, idToken, refreshToken, expiresAt: Math.floor(now / 1000) + t.expires_in,
  }
}

// ------------------------------------------------------------------ the callback server

export interface Callback { port: number; redirectUri: string; result: Promise<{ code: string }>; close(): void }

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em;max-width:40em"><h1>${title}</h1><p>${text}</p></body>`

/** Listen on the first free port of `ports` for /callback?code=…&state=…; resolves with the code when `state` matches. */
export async function callbackServer(ports: readonly number[], state: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<Callback> {
  let resolveCode!: (v: { code: string }) => void
  let reject!: (e: Error) => void
  const result = new Promise<{ code: string }>((ok, fail) => { resolveCode = ok; reject = fail })
  result.catch(() => undefined)
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
    const q = url.searchParams
    const answer = (status: number, title: string, text: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(title, text))
    }
    if (!sameState(state, q.get('state'))) {
      answer(400, 'Sign-in not accepted', 'This sign-in did not come from the trace command that is waiting. Run <code>tracectl login</code> again.')
      reject(new LoginError('the sign-in redirect carried the wrong state (not this login): refused'))
      return
    }
    const error = q.get('error')
    if (error) {
      answer(400, 'Sign-in failed', 'You can close this tab and run <code>tracectl login</code> again.')
      reject(new LoginError(`sign-in failed: ${q.get('error_description') ?? error}`))
      return
    }
    const code = q.get('code')
    if (!code) { answer(400, 'Sign-in failed', 'No authorization code.'); reject(new LoginError('the redirect carried no code')); return }
    answer(200, 'Signed in to trace', 'You can close this tab and return to the terminal.')
    resolveCode({ code })
  })
  let port = -1
  for (const p of ports) {
    const ok = await new Promise<boolean>((done) => {
      const onErr = (): void => { server.removeListener('listening', onOk); done(false) }
      const onOk = (): void => { server.removeListener('error', onErr); done(true) }
      server.once('error', onErr)
      server.once('listening', onOk)
      server.listen(p, '127.0.0.1')
    })
    // Port 0 (tests) binds an ephemeral port: use the one the system gave.
    if (ok) { const a = server.address(); port = a !== null && typeof a === 'object' ? a.port : p; break }
  }
  if (port < 0) throw new LoginError(`none of the callback ports (${ports.join(', ')}) is free`)
  const timer = setTimeout(() => reject(new LoginError('timed out waiting for the browser sign-in')), timeoutMs)
  timer.unref()
  const close = (): void => { clearTimeout(timer); server.close(); server.closeAllConnections() }
  return { port, redirectUri: `http://localhost:${port}/callback`, result, close }
}

// ------------------------------------------------------------------ the browser

export function openBrowser(url: string, print: (s: string) => void = (s) => { process.stderr.write(`${s}\n`) }): void {
  print(`Opening your browser to sign in. If it does not open, visit:\n  ${url}`)
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch { /* printed above */ }
}

// ------------------------------------------------------------------ login / refresh / logout

export interface LoginOptions {
  fetch?: typeof fetch
  open?: (url: string) => void
  timeoutMs?: number
}

export async function login(i: Installation, o: LoginOptions = {}): Promise<Session> {
  const { verifier, challenge } = pkce()
  const state = newState()
  const cb = await callbackServer(i.callbackPorts, state, o.timeoutMs)
  try {
    ;(o.open ?? openBrowser)(authorizeUrl(i, cb.redirectUri, state, challenge))
    const { code } = await cb.result
    const s = toSession(i, await exchangeCode(i, code, verifier, cb.redirectUri, o.fetch ?? fetch))
    saveSession(s)
    return s
  } finally {
    cb.close()
  }
}

function need(): { i: Installation; s: Session } {
  const i = savedInstallation()
  if (!i) throw new LoginError(NO_INSTALLATION)
  const s = savedSession(i.name)
  if (!s) throw new LoginError('not signed in: run `tracectl login`')
  return { i, s }
}

export const NO_INSTALLATION = 'no trace installation on this machine. Admins: `tracectl install`. Everyone else: ask an admin for the values and run\n' +
  '  tracectl connect --region R --pool POOL_ID --client CLIENT_ID --domain https://….auth.R.amazoncognito.com --api API_RUNTIME_ARN'

export async function refresh(f: typeof fetch = fetch): Promise<Session> {
  const { i, s } = need()
  let t: TokenResponse
  try {
    t = await tokenRequest(i, { grant_type: 'refresh_token', client_id: i.clientId, refresh_token: s.refreshToken }, f)
  } catch (e) {
    throw new LoginError(`${e instanceof Error ? e.message : String(e)}: your session has ended; run \`tracectl login\``)
  }
  const next = toSession(i, t, s)
  saveSession(next)
  return next
}

export async function accessToken(f: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const { s } = need()
  if (s.expiresAt - now / 1000 > REFRESH_MARGIN_S) return s.accessToken
  return (await refresh(f)).accessToken
}

export async function logout(f: typeof fetch = fetch): Promise<boolean> {
  const i = savedInstallation()
  if (!i) return false
  const s = savedSession(i.name)
  if (!s) return false
  try {
    await f(`${base(i)}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: s.refreshToken, client_id: i.clientId }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
  } catch { /* the session is cleared regardless */ }
  return clearSession(i.name)
}
