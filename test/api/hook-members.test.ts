/**
 * hook.members and the web backend's own identity (src/api/actions-hooks.ts, src/api/backend-auth.ts): who to tell when
 * GitHub says a change moved. The API runtime decides, as for project.members; the backend asks with a token of its
 * own app client (client credentials, one scope), which may call this one action and nothing else, and which nobody
 * else's token may stand in for.
 */
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACTION_NAMES, type ActionDeps, perform } from '../../src/api/actions.js'
import { BACKEND_SCOPE_FULL, backendPrincipal, peekClient } from '../../src/api/backend-auth.js'
import { listen } from '../../src/api/server.js'
import { AuthError, Verifier } from '../../src/api/jwt.js'
import { AccessDenied, type Principal, assign, classOf, isAdmin, who } from '../../src/core/access.js'
import { register } from '../../src/core/onboard.js'
import { Registry } from '../../src/core/registry.js'
import { CLIENT_ID, FakeCognito, FakeGitHub, ISSUER, accessToken, jwks, sign } from './fixtures.js'

const HOOKS_CLIENT = 'hooks-client-123'
const ADMIN = { sub: 'h-admin', email: 'h-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'h-user', email: 'h-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'h-rev', email: 'h-rev@example.com', groups: ['trace-users'] }
const BACKEND: Principal = { sub: HOOKS_CLIENT, email: null, groups: [], kind: 'backend', name: 'web-hooks' }

const cognito = new FakeCognito()
const deps: ActionDeps = {
  github: async () => new FakeGitHub([]),
  cognito: () => cognito,
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: false, jobId: '' }), jobStatus: async () => [] }),
  tools: () => new Registry([]),
  scratch: '/tmp/trace-hook-members',
}
const run = async (p: Principal, action: string, args: Record<string, unknown> = {}) => (await perform(action, args, { principal: p, deps })).result

/** A client-credentials token, as Cognito issues one: no username, the client's id as sub, its scopes. */
const backendToken = (o: { client?: string; scope?: string; extra?: Record<string, unknown> } = {}): string => {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: o.client ?? HOOKS_CLIENT, iss: ISSUER, token_use: 'access', client_id: o.client ?? HOOKS_CLIENT, scope: o.scope ?? BACKEND_SCOPE_FULL, exp: now + 3600, iat: now, ...o.extra })
}

let server: Server
let url = ''
const call = async (token: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

beforeAll(async () => {
  for (const p of [ADMIN, USER, REVIEWER]) cognito.add(p.email, p.sub, p.groups[0])
  await register('acme/board', null)
  await register('acme/empty', null)
  await assign(ADMIN, USER, 'acme/board', { class: 'user' })
  await assign(ADMIN, REVIEWER, 'acme/board', { part: 'reviewer', class: 'user' })
  const v = new Verifier({ issuer: ISSUER, clientId: CLIENT_ID, fetchJwks: async () => jwks() })
  server = await listen({ verifier: v, deps, log: () => undefined, backendClientId: HOOKS_CLIENT }, 0, '127.0.0.1')
  server.keepAliveTimeout = 60_000
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invocations`
})
afterAll(() => { server.close() })

describe('hook.members', () => {
  it('answers the subs of everyone on a project (the people assigned, any part, and every admin), nothing else', async () => {
    const r = await run(BACKEND, 'hook.members', { repo: 'Acme/Board' })
    expect(r).toEqual({ repo: 'acme/board', project: true, subs: ['h-admin', 'h-rev', 'h-user'] })
    // no emails, names or parts leave
    expect(JSON.stringify(r)).not.toContain('@')
    // a project nobody is assigned to: its admins still hear
    expect(await run(BACKEND, 'hook.members', { repo: 'acme/empty' })).toEqual({ repo: 'acme/empty', project: true, subs: ['h-admin'] })
  })

  it('a repository that is not a project is said so, with nobody', async () => {
    expect(await run(BACKEND, 'hook.members', { repo: 'someone/else' })).toEqual({ repo: 'someone/else', project: false, subs: [] })
  })

  it('refuses every person, admins too, and every connected system: it is the backend\'s alone', async () => {
    const service: Principal = { sub: 'svc', email: null, groups: ['trace-users'], kind: 'service', name: 'ci', scopes: ['read', 'write'] }
    for (const p of [ADMIN, USER, REVIEWER, service]) await expect(run(p, 'hook.members', { repo: 'acme/board' })).rejects.toBeInstanceOf(AccessDenied)
  })

  it('the backend\'s identity reaches nothing else: no class, no project, every other action refused', async () => {
    expect(classOf(BACKEND)).toBeNull()
    expect(isAdmin(BACKEND)).toBe(false)
    expect(who(BACKEND)).toBe('backend:web-hooks')
    for (const a of ACTION_NAMES.filter((x) => x !== 'hook.members')) {
      await expect(run(BACKEND, a, { repo: 'acme/board' }), a).rejects.toBeInstanceOf(AccessDenied)
    }
  })
})

describe('the backend\'s token at the API runtime', () => {
  it('is taken only from its own client, without a username, with its scope', () => {
    const now = Math.floor(Date.now() / 1000)
    const claims = { sub: HOOKS_CLIENT, iss: ISSUER, token_use: 'access', client_id: HOOKS_CLIENT, scope: BACKEND_SCOPE_FULL, exp: now + 60 }
    expect(backendPrincipal(claims, HOOKS_CLIENT)).toEqual(BACKEND)
    expect(() => backendPrincipal({ ...claims, client_id: 'other' }, HOOKS_CLIENT)).toThrow(AuthError)
    expect(() => backendPrincipal({ ...claims, username: 'someone@example.com' }, HOOKS_CLIENT)).toThrow(AuthError)
    expect(() => backendPrincipal({ ...claims, scope: 'trace-external/read' }, HOOKS_CLIENT)).toThrow(/trace-internal\/members/)
    expect(() => backendPrincipal(claims, '')).toThrow(AuthError)
    expect(peekClient(backendToken())).toBe(HOOKS_CLIENT)
    expect(peekClient('not.a.jwt')).toBeNull()
  })

  it('over HTTP: the backend\'s token calls hook.members; it is refused everything else; others are refused hook.members', async () => {
    expect(await call(backendToken(), { action: 'hook.members', repo: 'acme/board' })).toEqual({ status: 200, body: { ok: true, result: { repo: 'acme/board', project: true, subs: ['h-admin', 'h-rev', 'h-user'] } } })
    expect(await call(backendToken(), { action: 'project.members', repo: 'acme/board' })).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
    expect(await call(backendToken(), { action: 'projects' })).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
    // a person's token, even an admin's, may not ask
    expect((await call(accessToken('h-admin', ['trace-admins']), { action: 'hook.members', repo: 'acme/board' })).status).toBe(403)
    // the client's token without its scope, or with a username, is not the backend's: 401
    expect((await call(backendToken({ scope: 'trace-external/read' }), { action: 'hook.members', repo: 'acme/board' })).status).toBe(401)
    expect((await call(backendToken({ extra: { username: 'x@example.com' } }), { action: 'hook.members', repo: 'acme/board' })).status).toBe(401)
    // a token of a client the API does not know is refused as before
    expect((await call(backendToken({ client: 'stranger' }), { action: 'hook.members', repo: 'acme/board' })).status).toBe(401)
  })
})
