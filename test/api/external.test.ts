/**
 * External access (docs/external-access.md): connected systems' tokens, the systems' allow-list (with the shared tools
 * closed and the task cap), the services.* admin actions with a fake Cognito, the shared rate limit against a fake
 * DynamoDB, and the external runtime end to end.
 */
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ACTION_NAMES, type ActionDeps, perform } from '../../src/api/actions.js'
import type { ExternalAccess } from '../../src/api/action-kit.js'
import { EXTERNAL_OFF, externalFromEnv } from '../../src/api/actions-services.js'
import { Verifier } from '../../src/api/jwt.js'
import { RateLimiter, externalScratch, listen, scratchFor } from '../../src/api/server.js'
import { SharedLimit } from '../../src/api/rate-limit.js'
import { JobIndexStore, putJob } from '../../src/core/job-index.js'
import { bucketStore } from '../../src/api/action-kit.js'
import { PROJECTS_PREFIX } from '../../src/core/project.js'
import { ServiceVerifier, tokenScopes } from '../../src/api/service-auth.js'
import { SERVICE_ACTIONS } from '../../src/api/service-policy.js'
import { AccessDenied, type Principal, type Service, assign, assignments, classOf, getService, require_, who } from '../../src/core/access.js'
import { Registry, defineTool } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub, ISSUER, jwks, sign } from './fixtures.js'

const ADMIN: Principal = { sub: 'admin-x', email: 'admin@example.com', groups: ['trace-admins'] }
const RS = 'trace-external'
const now = () => Math.floor(Date.now() / 1000)

/** A client-credentials access token as Cognito issues one: no username, the resource server's scopes. */
const svcToken = (clientId: string, scope: string, extra: Record<string, unknown> = {}): string =>
  sign({ sub: clientId, iss: ISSUER, token_use: 'access', client_id: clientId, scope, exp: now() + 3600, iat: now(), ...extra })

const scratch = mkdtempSync(join(tmpdir(), 'trace-ext-'))
const cognito = new FakeCognito()
const github = new FakeGitHub(['acme/board', 'acme/secret'])
const started: unknown[] = []
const tools = new Registry([
  defineTool({ name: 'calc.echo', description: 'echo', input: z.object({ x: z.number() }), run: (a) => a }),
  defineTool({ name: 'datasheets.add', description: 'writes the shared library', input: z.object({ mpn: z.string() }), run: () => ({ ok: true }) }),
  defineTool({ name: 'parts.search', description: 'the paid parts search', input: z.object({ q: z.string() }), run: () => ({ ok: true }) }),
  defineTool({ name: 'kb.sync', description: 'records a sync', input: z.object({}), run: () => ({ ok: true }) }),
])
const EXT: ExternalAccess = { tokenUrl: 'https://auth.example.com/oauth2/token', apiUrl: 'https://agentcore.example/ext', mcpUrl: 'https://agentcore.example/mcp', resourceServer: RS, prefix: 'tr' }
const deps = (external: ExternalAccess | null = EXT): ActionDeps => ({
  github: async () => github,
  cognito: () => cognito,
  jobs: async () => ({
    repositoryOf: (id) => (id.startsWith('job-') ? 'acme/board' : null),
    startJob: async (p) => { started.push(p); return { accepted: true, jobId: 'job-9' } },
    jobStatus: async () => [],
    runTool: async (p) => ({ ran: p.name }),
  }),
  tools: () => tools,
  scratch,
  external,
})
const ctx = (principal: Principal, external: ExternalAccess | null = EXT) => ({ principal, deps: deps(external) })

const svc = (scopes: ('read' | 'write')[], sub = 'svc-p'): Principal => ({ sub, email: null, groups: [scopes.includes('write') ? 'trace-users' : 'trace-guests'], kind: 'service', name: 'p', scopes })

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// ------------------------------------------------------------------ the admin actions

describe('services.* (admins, fake Cognito)', () => {
  const logs: string[] = []
  let created: { client_id: string; secret: string } = { client_id: '', secret: '' }

  it('are off, in those words, without external access; list and history still answer', async () => {
    await expect(perform('services.create', { name: 'off-sys', scopes: ['read'] }, ctx(ADMIN, null))).rejects.toThrow(/External access is off/i)
    expect(EXTERNAL_OFF).toMatch(/external access is off/i)
    expect((await perform('services.list', {}, ctx(ADMIN, null))).result).toMatchObject({ enabled: false, services: [] })
    expect((await perform('services.history', { name: 'off-sys' }, ctx(ADMIN, null))).result).toMatchObject({ entries: [] })
  })

  it('are for admins only', async () => {
    await expect(perform('services.list', {}, ctx({ sub: 'u', email: 'u@x', groups: ['trace-users'] }))).rejects.toThrow(AccessDenied)
  })

  it('create: an app client with the scopes, the secret once, the addresses, and the projects', async () => {
    const r = (await perform('services.create', { name: 'ci-dash', description: 'CI', scopes: ['read', 'write'], projects: [{ repo: 'acme/board', part: 'contributor' }] }, ctx(ADMIN))).result as Record<string, unknown>
    created = { client_id: String(r.client_id), secret: String(r.secret) }
    logs.push(JSON.stringify(r.service))
    expect(r).toMatchObject({ token_url: EXT.tokenUrl, api_url: EXT.apiUrl, mcp_url: EXT.mcpUrl, resource_server: RS, service: { name: 'ci-dash', scopes: ['read', 'write'], projects: [{ repo: 'acme/board', part: 'contributor' }] } })
    expect(cognito.calls).toContain('createClient tr-svc-ci-dash trace-external/read trace-external/write')
    expect(created.secret).toMatch(/xyzzy/)
    // the store never holds the secret
    expect(JSON.stringify(await getService(created.client_id))).not.toContain(created.secret)
    await expect(perform('services.create', { name: 'ci-dash', scopes: ['read'] }, ctx(ADMIN))).rejects.toThrow(/exists already/)
    await expect(perform('services.create', { name: 'Bad Name', scopes: ['read'] }, ctx(ADMIN))).rejects.toThrow()
    await expect(perform('services.create', { name: 'ro-x', scopes: ['read'], projects: [{ repo: 'acme/board', part: 'contributor' }] }, ctx(ADMIN))).rejects.toThrow(/reviewer/)
  })

  it('list: every system with its projects and secrets by id, never a value', async () => {
    const r = (await perform('services.list', {}, ctx(ADMIN))).result as { services: (Service & { secrets: { id: string }[] })[] }
    const s = r.services.find((x) => x.name === 'ci-dash')
    expect(s?.secrets.map((k) => k.id)).toEqual([`${created.client_id}-s1`])
    expect(JSON.stringify(r)).not.toContain('xyzzy')
  })

  it('assign returns the part; a read-only system is always a reviewer, and the assignment shows service:<name>', async () => {
    const r = (await perform('services.assign', { name: 'ci-dash', repo: 'acme/secret', part: 'reviewer' }, ctx(ADMIN))).result
    expect(r).toMatchObject({ repo: 'acme/secret', part: 'reviewer' })
    expect((await assignments(ADMIN, { repo: 'acme/secret' })).find((a) => a.sub === created.client_id)).toMatchObject({ email: 'service:ci-dash', class: 'user' })
  })

  it('update to read only: the app client\'s scopes, and every part becomes reviewer, logged', async () => {
    const r = (await perform('services.update', { name: 'ci-dash', scopes: ['read'] }, ctx(ADMIN))).result as { service: Service & { projects: { part: string }[] } }
    expect(r.service.scopes).toEqual(['read'])
    expect(r.service.projects.every((p) => p.part === 'reviewer')).toBe(true)
    expect(cognito.clients.get(created.client_id)?.config).toEqual({ clientName: 'tr-svc-ci-dash', scopes: ['trace-external/read'] })
    await expect(perform('services.assign', { name: 'ci-dash', repo: 'acme/board', part: 'contributor' }, ctx(ADMIN))).rejects.toThrow(/only be a reviewer/)
    await perform('services.update', { name: 'ci-dash', scopes: ['read', 'write'] }, ctx(ADMIN))
    expect((await perform('services.assign', { name: 'ci-dash', repo: 'acme/board', part: 'contributor' }, ctx(ADMIN))).result).toMatchObject({ part: 'contributor' })
  })

  it('rotate gives a new secret once; retire removes the old (never the last)', async () => {
    const r = (await perform('services.rotate', { name: 'ci-dash' }, ctx(ADMIN))).result as { secret: string; secret_id: string; token_url: string }
    expect(r.secret).toMatch(/xyzzy/)
    expect(r.token_url).toBe(EXT.tokenUrl)
    await expect(perform('services.retire_secret', { name: 'ci-dash', secret_id: 'nope' }, ctx(ADMIN))).rejects.toThrow(/no secret/)
    expect((await perform('services.retire_secret', { name: 'ci-dash', secret_id: `${created.client_id}-s1` }, ctx(ADMIN))).result).toMatchObject({ removed: true })
    await expect(perform('services.retire_secret', { name: 'ci-dash', secret_id: r.secret_id }, ctx(ADMIN))).rejects.toThrow(/only secret/)
  })

  it('history: assignments and its own changes, newest first, in words, never a secret', async () => {
    const r = (await perform('services.history', { name: 'ci-dash' }, ctx(ADMIN))).result as { entries: { at: string; text: string; action: string }[] }
    expect(r.entries.length).toBeGreaterThan(4)
    expect(r.entries.every((e) => /^\d{4}-/.test(e.at) && e.text.length > 0)).toBe(true)
    const texts = r.entries.map((e) => e.text).join('\n')
    expect(texts).toContain('changed their part on acme/board from contributor to reviewer')
    expect(texts).toContain('connected it')
    expect(texts).toContain('added a new secret')
    expect(texts).not.toContain('xyzzy')
  })

  it('delete: the app client, then the record and its assignments; an app client already gone is fine', async () => {
    const other = (await perform('services.create', { name: 'gone-sys', scopes: ['read'], projects: [{ repo: 'acme/board' }] }, ctx(ADMIN))).result as { client_id: string }
    cognito.clients.delete(other.client_id)
    expect((await perform('services.delete', { name: 'gone-sys' }, ctx(ADMIN))).result).toMatchObject({ deleted: true, app_client: 'already gone' })
    expect(await getService(other.client_id)).toBeNull()
    expect((await assignments(ADMIN, { sub: other.client_id }))).toEqual([])
    expect((await perform('services.delete', { name: 'ci-dash' }, ctx(ADMIN))).result).toMatchObject({ deleted: true, app_client: 'deleted' })
    expect(cognito.clients.has(created.client_id)).toBe(false)
  })

  it('delete disables first: when the app client cannot be deleted, the system stays, disabled', async () => {
    const made = (await perform('services.create', { name: 'stuck-sys', scopes: ['read'] }, ctx(ADMIN))).result as { client_id: string }
    const real = cognito.deleteServiceClient.bind(cognito)
    cognito.deleteServiceClient = async () => { throw new Error('Cognito is down') }
    try {
      await expect(perform('services.delete', { name: 'stuck-sys' }, ctx(ADMIN))).rejects.toThrow(/down/)
    } finally {
      cognito.deleteServiceClient = real
    }
    expect(await getService(made.client_id)).toMatchObject({ disabled: true })
    expect((await perform('services.delete', { name: 'stuck-sys' }, ctx(ADMIN))).result).toMatchObject({ deleted: true, app_client: 'deleted' })
  })

  it('externalFromEnv: off without the external runtime ARN; addresses built from the ARNs', () => {
    expect(externalFromEnv({ AWS_REGION: 'us-east-1' })).toBeNull()
    const x = externalFromEnv({ AWS_REGION: 'us-east-1', TRACE_EXTERNAL_RUNTIME_ARN: 'arn:ext', TRACE_MCP_RUNTIME_ARN: 'arn:mcp', TRACE_TOKEN_URL: 'https://t', TRACE_PREFIX: 'tr' })
    expect(x).toMatchObject({ tokenUrl: 'https://t', resourceServer: 'trace-external', prefix: 'tr' })
    expect(x?.apiUrl).toContain(encodeURIComponent('arn:ext'))
    expect(x?.mcpUrl).toContain(encodeURIComponent('arn:mcp'))
  })
})

// ------------------------------------------------------------------ the policy

describe('what a connected system may do', () => {
  const both = svc(['read', 'write'])
  beforeAll(async () => {
    await assign(ADMIN, { sub: 'svc-p' }, 'acme/board', { part: 'contributor', class: 'user' })
    await assign(ADMIN, { sub: 'svc-r' }, 'acme/board', { part: 'reviewer', class: 'user' })
  })

  it('is never an admin, whatever its groups', () => {
    expect(classOf({ ...both, groups: ['trace-admins'] })).toBeNull()
    expect(who(both)).toBe('service:p')
  })

  it('every action not on the allow-list is refused, even with both scopes (new actions stay closed)', async () => {
    const closed = ACTION_NAMES.filter((a) => !Object.hasOwn(SERVICE_ACTIONS, a))
    expect(closed.length).toBeGreaterThan(30)
    for (const a of closed) {
      await expect(perform(a, { repo: 'acme/board' }, ctx(both)), a).rejects.toThrow(AccessDenied)
    }
    // and every allow-listed action is a real one
    for (const a of Object.keys(SERVICE_ACTIONS)) expect(ACTION_NAMES as string[]).toContain(a)
  })

  it('needs the write scope for write actions and write tools', async () => {
    const ro = svc(['read'])
    await expect(perform('task', { repo: 'acme/board', request: 'x' }, ctx(ro))).rejects.toThrow(/write scope/)
    await expect(perform('tool', { repo: 'acme/board', name: 'kb.sync', args: {} }, ctx(ro))).rejects.toThrow(/write scope/)
    expect((await perform('tool', { repo: 'acme/board', name: 'calc.echo', args: { x: 1 } }, ctx(ro))).result).toEqual({ ran: 'calc.echo' })
    expect((await perform('tool', { repo: 'acme/board', name: 'kb.sync', args: {} }, ctx(both))).result).toEqual({ ran: 'kb.sync' })
    const r = await perform('task', { repo: 'acme/board', request: 'x' }, ctx(both))
    expect(r.result).toMatchObject({ accepted: true })
    expect(started.at(-1)).toMatchObject({ requestedBy: 'service:p', requestedBySub: 'svc-p' })
  })

  it('never runs the shared library\'s or the parts search\'s tools, and is not shown them', async () => {
    for (const name of ['parts.search', 'datasheets.add']) {
      await expect(perform('tool', { repo: 'acme/board', name, args: {} }, ctx(both)), name).rejects.toThrow(/not open to connected systems/)
    }
    const listed = ((await perform('tools.list', { repo: 'acme/board' }, ctx(both))).result as { name: string }[]).map((t) => t.name)
    expect(listed).toEqual(expect.arrayContaining(['calc.echo', 'kb.sync']))
    expect(listed.filter((n) => n.startsWith('parts.') || n.startsWith('datasheets.'))).toEqual([])
    // a person still sees and runs them
    const person: Principal = { sub: 'admin-x', email: 'admin@example.com', groups: ['trace-admins'] }
    expect(((await perform('tools.list', { repo: 'acme/board' }, ctx(person))).result as { name: string }[]).map((t) => t.name)).toContain('parts.search')
    expect((await perform('tool', { repo: 'acme/board', name: 'parts.search', args: { q: 'x' } }, ctx(person))).result).toEqual({ ran: 'parts.search' })
  })

  it('may have at most three tasks queued or running on a project', async () => {
    const index = new JobIndexStore(bucketStore(PROJECTS_PREFIX), 'acme/board', { scratch })
    const at = Date.now() / 1000
    await index.update((db) => {
      putJob(db, 't1', { kind: 'task', title: 'a', requestedBySub: 'svc-p', state: 'running', startedAt: at, beatAt: at }, at)
      putJob(db, 't2', { kind: 'task', title: 'b', requestedBySub: 'svc-p', state: 'queued', queuedAt: at }, at)
      // not counted: finished, lost (no heartbeat for long), another system's, a person's
      putJob(db, 't3', { kind: 'task', title: 'c', requestedBySub: 'svc-p', state: 'succeeded', endedAt: at }, at)
      putJob(db, 't4', { kind: 'task', title: 'd', requestedBySub: 'svc-p', state: 'running', startedAt: at - 7200, beatAt: at - 7200 }, at)
      putJob(db, 't5', { kind: 'task', title: 'e', requestedBySub: 'svc-other', state: 'running', startedAt: at, beatAt: at }, at)
      return { result: null }
    })
    const before = started.length
    expect((await perform('task', { repo: 'acme/board', request: 'third' }, ctx(both))).result).toMatchObject({ accepted: true })
    await index.update((db) => { putJob(db, 't6', { kind: 'task', title: 'f', requestedBySub: 'svc-p', state: 'queued', queuedAt: at }, at); return { result: null } })
    await expect(perform('task', { repo: 'acme/board', request: 'fourth' }, ctx(both))).rejects.toThrow('This system already has 3 tasks running on acme/board. Wait for one to finish.')
    expect(started.length).toBe(before + 1)
    // a person is not capped
    expect((await perform('task', { repo: 'acme/board', request: 'mine' }, ctx(ADMIN))).result).toMatchObject({ accepted: true })
  })

  it('a reviewer system cannot write even with the write scope', async () => {
    const reviewer = svc(['read', 'write'], 'svc-r')
    await expect(perform('task', { repo: 'acme/board', request: 'x' }, ctx(reviewer))).rejects.toThrow(AccessDenied)
    await expect(require_(reviewer, 'acme/board', 'write')).rejects.toThrow(AccessDenied)
    expect((await perform('whoami', {}, ctx(reviewer))).result).toMatchObject({ kind: 'service', class: 'user', scopes: ['read', 'write'] })
  })

  it('job.control: only a job of a project it writes, and only one it started', async () => {
    await expect(perform('job.control', { id: 'not-ours', op: 'cancel' }, ctx(both))).rejects.toThrow(AccessDenied)
    await expect(perform('job.control', { id: 'job-1', op: 'cancel' }, ctx(svc(['read', 'write'], 'svc-r')))).rejects.toThrow(AccessDenied)
    await expect(perform('job.control', { id: 'job-1', op: 'cancel' }, ctx(both))).rejects.toThrow(/only the jobs it started/)
  })
})

// ------------------------------------------------------------------ the verifier

describe('a connected system\'s token', () => {
  const sys = (over: Partial<Service> = {}): Service => ({ client_id: 'c1', name: 'ci', description: '', scopes: ['read', 'write'], disabled: false, created_by: 'a', created_at: '', last_used: null, ...over })
  let current: Service | null = sys()
  let lookups = 0
  let t = Date.now()
  const v = new ServiceVerifier({
    verifier: new Verifier({ issuer: ISSUER, clientId: [], anyClient: true, fetchJwks: async () => jwks() }),
    lookup: async () => { lookups++; return current },
    now: () => t,
  })
  const fresh = (): void => { t += 31_000 }

  it('reads scopes from the scope claim', () => {
    expect(tokenScopes('trace-external/read trace-external/write other/x')).toEqual(['read', 'write'])
    expect(tokenScopes('aws.cognito.signin.user.admin')).toEqual([])
  })

  it('accepts a good one as a service principal, never an admin', async () => {
    const p = await v.principal(svcToken('c1', `${RS}/read ${RS}/write`))
    expect(p).toEqual({ sub: 'c1', email: null, groups: ['trace-users'], kind: 'service', name: 'ci', scopes: ['read', 'write'] })
    fresh()
    expect((await v.principal(svcToken('c1', `${RS}/read`))).groups).toEqual(['trace-guests'])
  })

  it('refuses a person\'s token (it has a username)', async () => {
    await expect(v.principal(svcToken('c1', `${RS}/read`, { username: 'someone' }))).rejects.toThrow(/person/)
  })
  it('refuses a token without the resource server\'s scope', async () => {
    await expect(v.principal(svcToken('c1', 'openid'))).rejects.toThrow(/scope/)
    await expect(v.principal(svcToken('c1', 'other/read'))).rejects.toThrow(/scope/)
  })
  it('refuses the wrong issuer', async () => {
    await expect(v.principal(svcToken('c1', `${RS}/read`, { iss: 'https://cognito-idp.us-east-1.amazonaws.com/other' }))).rejects.toThrow(/wrong issuer/)
  })
  it('refuses an unknown client and a disabled one; the lookup is cached 30 s', async () => {
    fresh(); current = null
    await expect(v.principal(svcToken('c1', `${RS}/read`))).rejects.toThrow(/not a connected system/)
    fresh(); current = sys({ disabled: true })
    await expect(v.principal(svcToken('c1', `${RS}/read`))).rejects.toThrow(/disabled/)
    fresh(); current = sys()
    const n = lookups
    await v.principal(svcToken('c1', `${RS}/read`))
    await v.principal(svcToken('c1', `${RS}/read`))
    expect(lookups).toBe(n + 1)
  })
  it('gives read with write: a token that asked for write alone still reads', async () => {
    fresh(); current = sys()
    const p = await v.principal(svcToken('c1', `${RS}/write`))
    expect(p.scopes).toEqual(['read', 'write'])
    expect(p.groups).toEqual(['trace-users'])
  })
  it('obeys scopes removed since the token was issued', async () => {
    fresh(); current = sys({ scopes: ['read'] })
    expect((await v.principal(svcToken('c1', `${RS}/read ${RS}/write`))).scopes).toEqual(['read'])
    await expect(v.principal(svcToken('c1', `${RS}/write`))).rejects.toThrow(/removed/)
  })
  it('a system\'s token does not pass the people\'s verifier', async () => {
    const people = new Verifier({ issuer: ISSUER, clientId: 'client-123', fetchJwks: async () => jwks() })
    await expect(people.verify(svcToken('c1', `${RS}/read`))).rejects.toThrow(/wrong client/)
  })
})

// ------------------------------------------------------------------ the external runtime end to end

describe('the external runtime', () => {
  let server: Server
  let url = ''
  const logs: Record<string, unknown>[] = []
  let clock = 0
  const principals: Record<string, Principal> = {
    good: { sub: 'svc-e', email: null, groups: ['trace-users'], kind: 'service', name: 'e2e', scopes: ['read', 'write'] },
    ro: { sub: 'svc-ro', email: null, groups: ['trace-guests'], kind: 'service', name: 'ro', scopes: ['read'] },
    shared: { sub: 'svc-shared', email: null, groups: ['trace-guests'], kind: 'service', name: 'sh', scopes: ['read'] },
  }
  const seenIds: string[] = []
  const sharedCalls: string[] = []
  const call = async (token: string | null, body: Record<string, unknown>) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    return { status: r.status, retry: r.headers.get('retry-after'), body: (await r.json()) as { ok: boolean; result?: unknown; error?: string } }
  }

  beforeAll(async () => {
    server = await listen({
      principal: async (t) => { const p = principals[t]; if (!p) throw new (await import('../../src/api/jwt.js')).AuthError('not accepted'); return p },
      deps: {
        ...deps(null),
        // a worker that fails unexpectedly, with a detail an outside system must not see
        jobs: async () => ({ repositoryOf: () => null, startJob: async () => { throw new Error('secret internal detail: s3://bucket/key') }, jobStatus: async () => [] }),
      },
      limiter: new RateLimiter(10, 20, () => clock), log: (l) => logs.push(l), runtime: 'external',
      shared: { take: async (id) => { sharedCalls.push(id); return id === 'svc-shared' ? { wait: 7, window: 'minute' as const } : null } },
      serviceSeen: async (id) => { seenIds.push(id) },
    }, 0, '127.0.0.1')
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invocations`
    await assign(ADMIN, { sub: 'svc-e' }, 'acme/board', { part: 'contributor', class: 'user' })
  })
  afterAll(() => { server.close() })

  it('answers /ping', async () => {
    expect(await (await fetch(url.replace('/invocations', '/ping'))).json()).toMatchObject({ status: 'Healthy' })
  })
  it('401 without an accepted token', async () => {
    expect((await call(null, { action: 'whoami' })).status).toBe(401)
    expect((await call('nope', { action: 'whoami' })).status).toBe(401)
  })
  it('ok, logged as service:<name>', async () => {
    const r = await call('good', { action: 'settings.get', repo: 'acme/board' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(logs.at(-1)).toMatchObject({ who: 'service:e2e', action: 'settings.get', outcome: 'ok' })
  })
  it('403 for an action closed to systems, a project it is not on, and write with only read', async () => {
    expect(await call('good', { action: 'users.list' })).toMatchObject({ status: 403, body: { ok: false, error: 'no access' } })
    expect(await call('good', { action: 'gate.sign', repo: 'acme/board', gate: 'g1' })).toMatchObject({ status: 403 })
    expect(await call('good', { action: 'settings.get', repo: 'acme/secret' })).toMatchObject({ status: 403 })
    expect(await call('ro', { action: 'task', repo: 'acme/board', request: 'x' })).toMatchObject({ status: 403 })
  })
  it('notes when a system called, never in the access store', async () => {
    await call('good', { action: 'whoami' })
    expect(seenIds).toContain('svc-e')
  })
  it('an unexpected error answers a reference only, with the detail in the log', async () => {
    const r = await call('good', { action: 'task', repo: 'acme/board', request: 'x' })
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toMatch(/^internal error \(ref [0-9a-f]{8}\)$/)
    expect(r.body.error).not.toContain('secret')
    const ref = /ref ([0-9a-f]{8})/.exec(r.body.error ?? '')?.[1]
    expect(logs.at(-1)).toMatchObject({ outcome: 'failed', ref, detail: 'secret internal detail: s3://bucket/key' })
  })
  it('copies project databases in a folder of each system\'s own, under /tmp, never the session storage', () => {
    expect(externalScratch()).not.toContain('/mnt/workspace')
    expect(scratchFor('/tmp/x', 'svc-a')).not.toBe(scratchFor('/tmp/x', 'svc-b'))
    expect(scratchFor('/tmp/x', 'svc-a').startsWith('/tmp/x/svc-')).toBe(true)
    expect(scratchFor('/tmp/x', '../../etc')).toMatch(/^\/tmp\/x\/svc-[0-9a-f]{16}$/)
  })
  it('429 with Retry-After over the shared limit, after the container\'s', async () => {
    const r = await call('shared', { action: 'whoami' })
    expect(r).toMatchObject({ status: 429, retry: '7' })
    expect(r.body.error).toMatch(/300 a minute/)
    expect(sharedCalls).toContain('svc-shared')
  })
  it('429 with Retry-After over the per-system limit, and the bucket refills', async () => {
    clock = 1_000_000
    const statuses: number[] = []
    for (let i = 0; i < 22; i++) statuses.push((await call('ro', { action: 'whoami' })).status)
    expect(statuses.filter((s) => s === 200)).toHaveLength(20)
    const last = await call('ro', { action: 'whoami' })
    expect(last.status).toBe(429)
    expect(Number(last.retry)).toBeGreaterThanOrEqual(1)
    // another system is not held up
    expect((await call('good', { action: 'whoami' })).status).toBe(200)
    clock += 1000
    expect((await call('ro', { action: 'whoami' })).status).toBe(200)
  })
})

// ------------------------------------------------------------------ the shared limit, against a fake DynamoDB

describe('the shared rate limit (DynamoDB)', () => {
  const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' })
  /** a fake UpdateItem: counters by key, the condition n < :limit */
  const fakeDynamo = () => {
    const n = new Map<string, number>()
    const bodies: Record<string, unknown>[] = []
    const fetch = (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      expect(init.headers['x-amz-target']).toBe('DynamoDB_20120810.UpdateItem')
      expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 .*\/dynamodb\/aws4_request/)
      const b = JSON.parse(init.body) as { Key: { k: { S: string } }; ExpressionAttributeValues: Record<string, { N: string }> }
      bodies.push(b as unknown as Record<string, unknown>)
      const k = b.Key.k.S
      const now = n.get(k) ?? 0
      if (now >= Number(b.ExpressionAttributeValues[':limit']?.N)) return new Response(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException' }), { status: 400 })
      n.set(k, now + 1)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    return { n, bodies, fetch }
  }

  it('lets 10 a second through, then answers wait 1 s; the next second starts again', async () => {
    const d = fakeDynamo()
    let t = 1_700_000_000_000
    const l = new SharedLimit({ table: 'tr-external-limits', region: 'us-east-1', credentials: creds, fetch: d.fetch, now: () => t })
    const r: (unknown)[] = []
    for (let i = 0; i < 11; i++) r.push(await l.take('c1'))
    expect(r.slice(0, 10).every((x) => x === null)).toBe(true)
    expect(r[10]).toEqual({ wait: 1, window: 'second' })
    // another system has its own counters
    expect(await l.take('c2')).toBeNull()
    t += 1000
    expect(await l.take('c1')).toBeNull()
    expect(d.bodies[0]).toMatchObject({ TableName: 'tr-external-limits', ConditionExpression: 'attribute_not_exists(n) OR n < :limit' })
  })

  it('holds 300 a minute across seconds, and says how long is left of the minute', async () => {
    const d = fakeDynamo()
    let t = 1_700_000_020_000 // 40 s into a minute
    const l = new SharedLimit({ table: 'x', region: 'us-east-1', perSecond: 1000, perMinute: 5, credentials: creds, fetch: d.fetch, now: () => t })
    for (let i = 0; i < 5; i++) expect(await l.take('c1')).toBeNull()
    expect(await l.take('c1')).toEqual({ wait: 20, window: 'minute' })
    t += 20_000
    expect(await l.take('c1')).toBeNull()
  })

  it('fails open when DynamoDB fails, and logs it once until it recovers', async () => {
    let up = false
    const logged: Record<string, unknown>[] = []
    const fetch = (async () => (up ? new Response('{}', { status: 200 }) : new Response(JSON.stringify({ __type: 'ResourceNotFoundException' }), { status: 400 }))) as unknown as typeof globalThis.fetch
    const l = new SharedLimit({ table: 'x', region: 'us-east-1', credentials: creds, fetch, log: (x) => logged.push(x) })
    expect(await l.take('c1')).toBeNull()
    expect(await l.take('c1')).toBeNull()
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.warning)).toMatch(/go ahead without the shared limit/)
    up = true
    expect(await l.take('c1')).toBeNull()
    expect(logged).toHaveLength(2)
  })
})
