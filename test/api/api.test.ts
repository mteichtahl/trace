import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type ActionDeps, perform, WRITE_TOOLS } from '../../src/api/actions.js'
import { AuthError, Verifier } from '../../src/api/jwt.js'
import { listen } from '../../src/api/server.js'
import { assign, assignments } from '../../src/core/access.js'
import { readSettings } from '../../src/core/config.js'
import { Registry, defineTool } from '../../src/core/registry.js'
import { toolRunner } from '../../src/agents/runtime/tool.js'
import type { ToolJob } from '../../src/agents/runtime/schemas.js'
import { openProject } from '../../src/core/store.js'
import { CLIENT_ID, FakeCognito, FakeGitHub, ISSUER, KID, accessToken, jwks, otherKeys, sign, verifier } from './fixtures.js'

const ADMIN = { sub: 'admin-1', email: 'admin@example.com', groups: ['trace-admins'] }

// ------------------------------------------------------------------ JWT

describe('access token verification', () => {
  const v = verifier()
  const now = Math.floor(Date.now() / 1000)
  const base = { sub: 'u1', iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: now + 600, iat: now }

  it('accepts a good token', async () => {
    const c = await v.verify(sign({ ...base, 'cognito:groups': ['trace-users'] }))
    expect(c.sub).toBe('u1')
    expect(c['cognito:groups']).toEqual(['trace-users'])
  })
  it('rejects the wrong issuer', async () => {
    await expect(v.verify(sign({ ...base, iss: 'https://cognito-idp.us-east-1.amazonaws.com/other' }))).rejects.toThrow(/wrong issuer/)
  })
  it('rejects the wrong client', async () => {
    await expect(v.verify(sign({ ...base, client_id: 'someone-else' }))).rejects.toThrow(/wrong client/)
  })
  it('accepts the CLI\'s and the web app\'s clients when given both, and no other', async () => {
    const both = new Verifier({ issuer: ISSUER, clientId: [CLIENT_ID, 'web-client'], fetchJwks: async () => jwks() })
    expect((await both.verify(sign({ ...base, client_id: 'web-client' }))).sub).toBe('u1')
    expect((await both.verify(sign(base))).sub).toBe('u1')
    await expect(both.verify(sign({ ...base, client_id: 'someone-else' }))).rejects.toThrow(/wrong client/)
  })
  it('rejects an id token used as an access token', async () => {
    const { client_id: _c, ...rest } = base
    await expect(v.verify(sign({ ...rest, token_use: 'id', aud: CLIENT_ID }))).rejects.toThrow(/not an access token/)
  })
  it('rejects an expired token (beyond the 60 s leeway) and accepts one inside it', async () => {
    await expect(v.verify(sign({ ...base, exp: now - 61 }))).rejects.toThrow(/expired/)
    await expect(v.verify(sign({ ...base, exp: now - 30 }))).resolves.toBeTruthy()
    await expect(v.verify(sign({ ...base, nbf: now + 120 }))).rejects.toThrow(/not yet valid/)
  })
  it('rejects a bad signature, an unknown key, and alg none', async () => {
    await expect(v.verify(sign(base, { key: otherKeys.privateKey }))).rejects.toThrow(/bad signature/)
    const t = sign(base).split('.')
    await expect(v.verify(`${t[0]}.${Buffer.from(JSON.stringify({ ...base, sub: 'evil' })).toString('base64url')}.${t[2]}`)).rejects.toThrow(/bad signature/)
    await expect(v.verify(sign(base, { kid: 'nope' }))).rejects.toThrow(/unknown signing key/)
    await expect(v.verify(sign(base, { alg: 'none' }))).rejects.toThrow(AuthError)
    await expect(v.verify('not-a-jwt')).rejects.toThrow(/malformed/)
  })
  it('caches the JWKS', async () => {
    let n = 0
    const v2 = new Verifier({ issuer: ISSUER, clientId: CLIENT_ID, fetchJwks: async (url) => { n++; expect(url).toBe(`${ISSUER}/.well-known/jwks.json`); return jwks() } })
    await v2.verify(sign(base)); await v2.verify(sign(base))
    expect(n).toBe(1)
    void KID
  })
})

// ------------------------------------------------------------------ the server and the authorisation matrix

const github = new FakeGitHub(['acme/board', 'acme/secret'])
const cognito = new FakeCognito()
const started: unknown[] = []
const statusCalls: string[] = []
const scratch = mkdtempSync(join(tmpdir(), 'trace-api-test-'))
let toolCalls: string[] = []
const tools = new Registry([
  defineTool({ name: 'calc.echo', description: 'echo', input: z.object({ x: z.number() }), run: (a) => { toolCalls.push('calc.echo'); return { x: a.x, cwd: process.cwd() } } }),
  defineTool({ name: 'datasheets.add', description: 'writes the shared library', input: z.object({ mpn: z.string() }), run: () => { toolCalls.push('datasheets.add'); return { ok: true } } }),
  defineTool({ name: 'hil.zap', description: 'hardware', hardware: true, input: z.object({}), run: () => { toolCalls.push('hil.zap'); return {} } }),
])
const deps: ActionDeps = {
  github: async () => github,
  cognito: () => cognito,
  jobs: async () => ({
    repositoryOf: (id) => (id === 'job-1' || id === 'job-gone' ? 'acme/board' : id === 'job-secret' ? 'acme/secret' : null),
    startJob: async (p) => { started.push(p); return { accepted: true, jobId: 'job-1' } },
    jobStatus: async (id) => (statusCalls.push(id ?? ''), id === 'job-1' ? [{ id: 'job-1', kind: 'task', repository: 'acme/board', state: 'running' }] : []),
    // the project's worker runtime: what it was asked (forwarded), and its tool runner on a clone of its own
    runTool: async (p) => { forwarded.push(p); return worker(p as ToolJob) },
  }),
  tools: () => tools,
  scratch,
}
const forwarded: unknown[] = []
const clones: string[] = []
const worker = toolRunner({
  registry: () => tools,
  checkout: async () => { const dir = mkdtempSync(join(scratch, 'clone-')); clones.push(dir); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) } },
})

let server: Server
let url = ''
const logs: Record<string, unknown>[] = []

async function call(token: string | null, body: Record<string, unknown>): Promise<{ status: number; body: { ok: boolean; result?: unknown; error?: string } }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as { ok: boolean; result?: unknown; error?: string } }
}

const guest = accessToken('guest-1', ['trace-guests'])
const user = accessToken('user-1', ['trace-users'])
const nobody = accessToken('nobody-1', [])
const admin = accessToken('admin-1', ['trace-admins'])

beforeAll(async () => {
  server = await listen({ verifier: verifier(), deps, log: (l) => logs.push(l) }, 0, '127.0.0.1')
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invocations`
  cognito.add('guest-1@example.com', 'guest-1', 'trace-guests')
  cognito.add('user-1@example.com', 'user-1', 'trace-users')
  await assign(ADMIN, { sub: 'guest-1', email: 'guest-1@example.com' }, 'acme/board')
  await assign(ADMIN, { sub: 'user-1', email: 'user-1@example.com' }, 'acme/board')
})
afterAll(() => { server.close(); rmSync(scratch, { recursive: true, force: true }) })
beforeEach(() => { toolCalls = []; github.calls = []; started.length = 0; forwarded.length = 0; clones.length = 0 })

describe('the API server', () => {
  it('answers /ping', async () => {
    const r = await fetch(url.replace('/invocations', '/ping'))
    expect(await r.json()).toMatchObject({ status: 'Healthy' })
  })

  it('401s a missing or invalid token, and never logs the token', async () => {
    expect((await call(null, { action: 'whoami' })).status).toBe(401)
    expect((await call('garbage', { action: 'whoami' })).status).toBe(401)
    const bad = sign({ sub: 'x', iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: 1 })
    expect((await call(bad, { action: 'whoami' })).status).toBe(401)
    expect(JSON.stringify(logs)).not.toContain(user)
    expect(JSON.stringify(logs)).not.toContain('Bearer')
  })

  it('whoami and projects', async () => {
    const r = await call(user, { action: 'whoami' })
    expect(r).toMatchObject({ status: 200, body: { ok: true, result: { sub: 'user-1', email: 'user-1@example.com', class: 'user' } } })
    expect((await call(guest, { action: 'projects' })).body.result).toEqual([{ repo: 'acme/board', role: 'read', part: 'reviewer' }])
    expect((await call(user, { action: 'projects' })).body.result).toEqual([{ repo: 'acme/board', role: 'write', part: 'contributor' }])
    expect((await call(nobody, { action: 'projects' })).body.result).toEqual([])
  })

  it('logs who, action, repo and outcome', async () => {
    await call(guest, { action: 'settings.get', repo: 'acme/board' })
    expect(logs.at(-1)).toMatchObject({ who: 'guest-1@example.com', action: 'settings.get', repo: 'acme/board', outcome: 'ok' })
  })

  it('a guest can read but not write', async () => {
    expect((await call(guest, { action: 'settings.get', repo: 'acme/board' })).body.ok).toBe(true)
    for (const body of [
      { action: 'settings.set', repo: 'acme/board', key: 'prs.auto_merge', value: false },
      { action: 'task', repo: 'acme/board', request: 'fix it' },
      { action: 'tool', repo: 'acme/board', name: 'datasheets.add', args: { mpn: 'X' } },
    ]) {
      expect(await call(guest, body)).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
    }
    expect(github.calls.filter((c) => c.startsWith('createBranch') || c.startsWith('putFile'))).toEqual([])
    expect(started).toEqual([])
    expect(toolCalls).toEqual([])
  })

  it('a guest can run a read-only tool, but never a hardware one', async () => {
    const r = await call(guest, { action: 'tool', repo: 'acme/board', name: 'calc.echo', args: { x: 2 } })
    expect(r.body).toMatchObject({ ok: true, result: { x: 2 } })
    // forwarded to the project's worker runtime, which ran it in its clone (never in the API's own process tree)
    expect(forwarded).toEqual([{ kind: 'tool', repository: 'acme/board', name: 'calc.echo', args: { x: 2 } }])
    expect((r.body.result as { cwd: string }).cwd).toBe(join(realpathSync(scratch), basename(clones[0]!)))
    expect(process.cwd()).not.toBe(clones[0])
    expect((await call(guest, { action: 'tool', repo: 'acme/board', name: 'hil.zap', args: {} })).body).toMatchObject({ ok: false, error: 'no tool hil.zap' })
    expect(forwarded).toHaveLength(1)
    const list = (await call(guest, { action: 'tools.list', repo: 'acme/board' })).body.result as { name: string; needs: string }[]
    expect(list.map((t) => t.name)).toEqual(['calc.echo', 'datasheets.add'])
    expect(list.find((t) => t.name === 'datasheets.add')?.needs).toBe('write')
    expect(WRITE_TOOLS.has('datasheets.add')).toBe(true)
  })

  it('refuses tool paths outside the clone', async () => {
    const r = await call(user, { action: 'tool', repo: 'acme/board', name: 'calc.echo', args: { x: 1, path: '../../etc/passwd' } })
    expect(r.body).toMatchObject({ ok: false, error: 'path: must be a path inside the repository' })
    expect((await call(user, { action: 'tool', repo: 'acme/board', name: 'calc.echo', args: { x: 1, library: '/elsewhere' } })).body.ok).toBe(false)
    expect(toolCalls).toEqual([])
    // refused before the worker is asked
    expect(forwarded).toEqual([])
  })

  it('checks access before a tool call is forwarded, and needs write for a write tool', async () => {
    expect((await call(guest, { action: 'tool', repo: 'acme/secret', name: 'calc.echo', args: { x: 1 } })).status).toBe(403)
    expect((await call(guest, { action: 'tool', repo: 'acme/board', name: 'datasheets.add', args: { mpn: 'X' } })).status).toBe(403)
    expect(forwarded).toEqual([])
    expect((await call(user, { action: 'tool', repo: 'acme/board', name: 'datasheets.add', args: { mpn: 'X' } })).body.ok).toBe(true)
    expect(forwarded).toHaveLength(1)
  })

  it('a user can write on an assigned project', async () => {
    const r = await call(user, { action: 'task', repo: 'acme/board', request: 'add a test point' })
    expect(r.body).toMatchObject({ ok: true, result: { jobId: 'job-1' } })
    expect(started).toEqual([{ kind: 'task', repository: 'acme/board', request: 'add a test point', requestedBy: 'user-1@example.com', requestedBySub: 'user-1' }])
    expect((await call(user, { action: 'job', id: 'job-1' })).body.ok).toBe(true)
  })

  it('a task names a specialist or leaves it to the router; the worker cannot be asked for directly', async () => {
    started.length = 0
    const r = await call(user, { action: 'task', repo: 'acme/board', request: 'check crosstalk on USB', agent: 'emc' })
    expect(r.body).toMatchObject({ ok: true, result: { jobId: 'job-1' } })
    expect(started).toEqual([{ kind: 'task', repository: 'acme/board', request: 'check crosstalk on USB', requestedBy: 'user-1@example.com', requestedBySub: 'user-1', agent: 'emc' }])
    // no agent: forwarded as is, and the project's runtime routes it (src/agents/router.ts)
    await call(user, { action: 'task', repo: 'acme/board', request: 'close timing' })
    expect(started[1]).not.toHaveProperty('agent')
    for (const agent of ['worker', 'ci-doctor', 'nobody']) {
      const bad = await call(user, { action: 'task', repo: 'acme/board', request: 'push to main', agent })
      expect(bad.body.ok).toBe(false)
    }
    expect(started).toHaveLength(2)
    // a guest still may not start one
    expect((await call(guest, { action: 'task', repo: 'acme/board', request: 'x', agent: 'verify' })).body.ok).toBe(false)
    started.length = 0
  })

  it('unassigned and nonexistent projects get the identical answer, before GitHub is touched', async () => {
    for (const who of [user, guest, nobody]) {
      const a = await call(who, { action: 'status', repo: 'acme/secret' })
      const b = await call(who, { action: 'status', repo: 'acme/does-not-exist' })
      expect(a).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
      expect(b).toEqual(a)
    }
    expect(github.calls).toEqual([])
    // a job on someone else's project, and a job that does not exist, look the same too
    const outsider = accessToken('user-2', ['trace-users'])
    statusCalls.length = 0
    expect(await call(outsider, { action: 'job', id: 'job-1' })).toEqual(await call(outsider, { action: 'job', id: 'job-nope' }))
    expect(await call(user, { action: 'job', id: 'job-secret' })).toEqual(await call(user, { action: 'job', id: 'job-nope' }))
    // the project is read from the id and checked before the worker is asked
    expect(statusCalls).toEqual([])
    expect(await call(user, { action: 'job', id: 'job-gone' })).toEqual(await call(user, { action: 'job', id: 'job-nope' }))
  })

  it('a person in no group can do nothing', async () => {
    expect((await call(nobody, { action: 'settings.get', repo: 'acme/board' })).status).toBe(403)
  })

  it('only an admin can manage people', async () => {
    for (const who of [user, guest, nobody]) {
      for (const body of [
        { action: 'users.list' }, { action: 'users.invite', email: 'new@example.com' }, { action: 'users.class', who: 'guest-1@example.com', class: 'admin' },
        { action: 'assign', who: 'user-1@example.com', repo: 'acme/secret' }, { action: 'unassign', who: 'guest-1@example.com', repo: 'acme/board' },
        { action: 'assignments' },
      ]) expect(await call(who, body)).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
    }
    expect(cognito.calls).toEqual([])
  })

  it('an admin can invite, change class, assign and unassign', async () => {
    const inv = await call(admin, { action: 'users.invite', email: 'new@example.com', class: 'guest' })
    expect(inv.body).toMatchObject({ ok: true, result: { sub: 'sub-new@example.com', class: 'guest' } })
    expect(cognito.calls).toEqual(['create new@example.com', 'add new@example.com trace-guests'])

    const cls = await call(admin, { action: 'users.class', who: 'new@example.com', class: 'user' })
    expect(cls.body.ok).toBe(true)
    expect([...(cognito.groups.get('new@example.com') ?? [])]).toEqual(['trace-users'])

    expect((await call(admin, { action: 'assign', who: 'new@example.com', repo: 'Acme/Secret' })).body.ok).toBe(true)
    expect((await assignments(ADMIN, { repo: 'acme/secret' })).map((a) => a.sub)).toEqual(['sub-new@example.com'])
    const list = (await call(admin, { action: 'users.list' })).body.result as { email: string; class: string; projects: string[] }[]
    expect(list.find((u) => u.email === 'new@example.com')).toMatchObject({ class: 'user', projects: ['acme/secret'] })

    const un = await call(admin, { action: 'unassign', who: 'sub-new@example.com', repo: 'acme/secret' })
    expect(un.body).toMatchObject({ ok: true, result: { removed: true } })
    expect(await assignments(ADMIN, { repo: 'acme/secret' })).toEqual([])
    expect((await call(admin, { action: 'assign', who: 'ghost@example.com', repo: 'acme/secret' })).body).toMatchObject({ ok: false, error: 'no such person: ghost@example.com' })
  })

  it('answers ok:false for an unknown action or bad arguments', async () => {
    expect((await call(user, { action: 'rm -rf' })).body).toMatchObject({ ok: false, error: expect.stringMatching(/unknown action/) })
    expect((await call(user, { action: 'status', repo: 'not a repo' })).body.ok).toBe(false)
  })
})

// ------------------------------------------------------------------ settings against a fake GitHub

describe('settings', () => {
  const put = (): void => {
    const dir = mkdtempSync(join(scratch, 'src-'))
    mkdirSync(join(dir, '.git'))
    const db = openProject(dir)
    db.prepare('INSERT INTO settings VALUES (?,?,?,?)').run('prs.merge_method', JSON.stringify('squash'), 0, 'x')
    db.close()
    github.files.set('acme/board:main:.trace/project.db', readFileSync(join(dir, '.trace', 'project.db')))
    rmSync(dir, { recursive: true, force: true })
  }

  it('settings.get reads .trace/project.db from the default branch and resolves it', async () => {
    put()
    const r = await perform('settings.get', { repo: 'acme/board' }, { principal: { sub: 'guest-1', email: null, groups: ['trace-guests'] }, deps })
    const res = r.result as { set: Record<string, unknown>; config: { prs: { merge_method: string; auto_merge: boolean } }; errors: string[] }
    expect(res.set).toEqual({ 'prs.merge_method': 'squash' })
    expect(res.config.prs).toMatchObject({ merge_method: 'squash', auto_merge: true })
    expect(res.errors).toEqual([])
    expect(github.calls).toContain('rawFile acme/board main .trace/project.db')
  })

  it('settings.get with no database gives the defaults; settings.set then creates one', async () => {
    github.files.clear()
    const r = await perform('settings.get', { repo: 'acme/board' }, { principal: ADMIN, deps })
    expect((r.result as { set: object }).set).toEqual({})
    const s = await perform('settings.set', { repo: 'acme/board', key: 'deploy.environment', value: 'lab' }, { principal: ADMIN, deps })
    const branch = (s.result as { branch: string }).branch
    expect(github.calls).toContain(`putFile acme/board ${branch} .trace/project.db new`)
  })

  it('settings.set commits on a trace/settings- branch, never main', async () => {
    put()
    const r = await perform('settings.set', { repo: 'acme/board', key: 'prs.auto_merge', value: false }, { principal: { sub: 'user-1', email: 'user-1@example.com', groups: ['trace-users'] }, deps })
    const res = r.result as { branch: string }
    expect(res.branch).toMatch(/^trace\/settings-prs-auto-merge-/)
    expect(github.calls).toContain(`putFile acme/board ${res.branch} .trace/project.db blob-sha`)
    expect(github.calls.some((c) => c.startsWith('putFile acme/board main'))).toBe(false)
    const bytes = github.files.get(`acme/board:${res.branch}:.trace/project.db`)
    expect(bytes).toBeTruthy()
    const dir = mkdtempSync(join(scratch, 'chk-'))
    mkdirSync(join(dir, '.trace')); writeFileSync(join(dir, '.trace', 'project.db'), bytes!)
    expect(readSettings(join(dir, '.trace', 'project.db'))).toEqual({ 'prs.merge_method': 'squash', 'prs.auto_merge': false })
    await expect(perform('settings.set', { repo: 'acme/board', key: 'prs.nonsense', value: 1 }, { principal: ADMIN, deps })).rejects.toThrow(/unknown setting/)
  })
})
