import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installation, saveInstallation, session } from '../../src/core/client.js'
import { invocationUrl, invokeApi, sessionId } from '../../src/login/invoke.js'
import { accessToken, authorizeUrl, callbackServer, challengeFor, login, logout, pkce, refresh, sameState } from '../../src/login/oauth.js'
import { cmdConnect } from '../../src/login/commands.js'

process.env.TRACE_CLIENT_DB = join(mkdtempSync(join(tmpdir(), 'trace-client-')), 'client.db')

const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

// ------------------------------------------------------------------ a fake Cognito domain (token + revoke) and AgentCore

interface Seen { path: string; headers: IncomingMessage['headers']; body: string }
const seen: Seen[] = []
let tokenAnswer: { status: number; body: unknown } = { status: 200, body: {} }
let apiAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, result: 'hi' } }
let fake: Server
let base = ''

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      const a = (req.url ?? '').startsWith('/oauth2/') ? tokenAnswer : apiAnswer
      res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body))
    })
  })
  await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
})
afterAll(() => { fake.close() })
beforeEach(() => { seen.length = 0 })

const tokens = (sub = 'u1', groups = ['trace-users'], refreshToken: string | undefined = 'refresh-1') => ({
  access_token: jwt({ sub, token_use: 'access', 'cognito:groups': groups }),
  id_token: jwt({ sub, email: `${sub}@example.com`, token_use: 'id' }),
  ...(refreshToken ? { refresh_token: refreshToken } : {}),
  expires_in: 3600, token_type: 'Bearer',
})

describe('PKCE and state', () => {
  it('makes an RFC 7636 verifier and S256 challenge', () => {
    const p = pkce()
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'))
    // RFC 7636 appendix B
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    expect(pkce().verifier).not.toBe(p.verifier)
  })
  it('compares state exactly', () => {
    expect(sameState('abc', 'abc')).toBe(true)
    expect(sameState('abc', 'abd')).toBe(false)
    expect(sameState('abc', 'ab')).toBe(false)
    expect(sameState('abc', null)).toBe(false)
  })
  it('builds the authorize URL', () => {
    const u = new URL(authorizeUrl({ cognitoDomain: 'https://x.auth.us-east-1.amazoncognito.com/', clientId: 'c1' }, 'http://localhost:47821/callback', 'st', 'ch'))
    expect(u.origin + u.pathname).toBe('https://x.auth.us-east-1.amazoncognito.com/oauth2/authorize')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'c1', redirect_uri: 'http://localhost:47821/callback', state: 'st', code_challenge: 'ch', code_challenge_method: 'S256' })
  })
})

describe('the callback server', () => {
  it('takes the first free port and refuses a wrong state', async () => {
    const blocker = createServer()
    await new Promise<void>((ok) => blocker.listen(0, '127.0.0.1', ok))
    const busy = (blocker.address() as AddressInfo).port
    const cb = await callbackServer([busy, 0], 'right-state')
    try {
      expect(cb.port).not.toBe(busy)
      const r = await fetch(`http://127.0.0.1:${cb.port}/callback?code=c&state=wrong`)
      expect(r.status).toBe(400)
      await expect(cb.result).rejects.toThrow(/wrong state/)
    } finally { cb.close(); blocker.close() }
  })
  it('resolves the code when state matches', async () => {
    const cb = await callbackServer([0], 's1')
    try {
      expect((await fetch(`http://127.0.0.1:${cb.port}/callback?code=the-code&state=s1`)).status).toBe(200)
      await expect(cb.result).resolves.toEqual({ code: 'the-code' })
    } finally { cb.close() }
  })
})

describe('login, refresh, access token and logout', () => {
  const inst = () => ({
    name: 'default', region: 'us-east-1', account: '123456789012', stack: '', traceHome: '', userPoolId: 'p', clientId: 'cli-1',
    cognitoDomain: base, apiRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_api-abc', callbackPorts: [0],
  })

  it('runs the whole code flow against a fake token endpoint', async () => {
    saveInstallation(inst())
    tokenAnswer = { status: 200, body: tokens() }
    const s = await login(installation()!, {
      open: (u) => {
        const q = new URL(u).searchParams
        void fetch(`${q.get('redirect_uri')!.replace('localhost', '127.0.0.1')}?code=abc&state=${q.get('state')!}`)
      },
    })
    expect(s).toMatchObject({ sub: 'u1', email: 'u1@example.com', groups: ['trace-users'], refreshToken: 'refresh-1' })
    expect(session()?.sub).toBe('u1')
    const req = seen.find((x) => x.path === '/oauth2/token')!
    const form = new URLSearchParams(req.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('abc')
    expect(form.get('client_id')).toBe('cli-1')
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(form.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/)
  })

  it('refreshes (keeping the refresh token) when under five minutes are left', async () => {
    const s = session()!
    expect(await accessToken(fetch, (s.expiresAt - 3000) * 1000)).toBe(s.accessToken)
    expect(seen).toEqual([])
    tokenAnswer = { status: 200, body: tokens('u1', ['trace-admins'], undefined) }
    const t = await accessToken(fetch, (s.expiresAt - 60) * 1000)
    expect(t).not.toBe(s.accessToken)
    expect(new URLSearchParams(seen[0]!.body).get('grant_type')).toBe('refresh_token')
    expect(session()).toMatchObject({ refreshToken: 'refresh-1', groups: ['trace-admins'] })
    tokenAnswer = { status: 400, body: { error: 'invalid_grant' } }
    await expect(refresh()).rejects.toThrow(/tracectl login/)
  })

  it('logout revokes the refresh token and clears the session', async () => {
    tokenAnswer = { status: 200, body: {} }
    expect(await logout()).toBe(true)
    expect(seen[0]!.path).toBe('/oauth2/revoke')
    expect(new URLSearchParams(seen[0]!.body).get('token')).toBe('refresh-1')
    expect(session()).toBeNull()
    expect(await logout()).toBe(false)
  })
})

describe('invokeApi', () => {
  it('posts to the AgentCore data plane with a bearer token and a session id', async () => {
    expect(invocationUrl('eu-west-1', 'arn:aws:bedrock-agentcore:eu-west-1:1:runtime/x'))
      .toBe('https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aeu-west-1%3A1%3Aruntime%2Fx/invocations?qualifier=DEFAULT')
    apiAnswer = { status: 200, body: { ok: true, result: { repo: 'a/b' } } }
    const r = await invokeApi('status', { repo: 'a/b' }, { endpoint: base, token: async () => 'tok-123' })
    expect(r).toEqual({ repo: 'a/b' })
    const req = seen[0]!
    expect(req.path).toBe(`/runtimes/${encodeURIComponent('arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_api-abc')}/invocations?qualifier=DEFAULT`)
    expect(req.headers.authorization).toBe('Bearer tok-123')
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(sessionId())
    expect(sessionId().length).toBeGreaterThanOrEqual(33)
    expect(JSON.parse(req.body)).toEqual({ action: 'status', repo: 'a/b' })
  })
  it('turns ok:false, 401 and 403 into errors', async () => {
    apiAnswer = { status: 200, body: { ok: false, error: 'nope' } }
    await expect(invokeApi('x', {}, { endpoint: base, token: async () => 't' })).rejects.toThrow('nope')
    apiAnswer = { status: 403, body: { ok: false, error: 'no access' } }
    await expect(invokeApi('x', {}, { endpoint: base, token: async () => 't' })).rejects.toThrow('no access')
    apiAnswer = { status: 401, body: { ok: false, error: 'bad' } }
    await expect(invokeApi('x', {}, { endpoint: base, token: async () => 't' })).rejects.toThrow(/tracectl login/)
  })
})

describe('tracectl connect', () => {
  it('saves an installation from shared values, leaving the optional fields empty', async () => {
    const code = await cmdConnect(['--region', 'us-west-2', '--pool', 'us-west-2_X', '--client', 'c9', '--domain', 'https://t.auth.us-west-2.amazoncognito.com',
      '--api', 'arn:aws:bedrock-agentcore:us-west-2:210987654321:runtime/trace_api-x', '--name', 'lab'])
    expect(code).toBe(0)
    expect(installation('lab')).toMatchObject({ region: 'us-west-2', account: '210987654321', clientId: 'c9', workerRuntimeArn: '', githubSecretArn: '', callbackPorts: [47821, 47822] })
    expect(await cmdConnect(['--region', 'nowhere'])).toBe(2)
  })
})
