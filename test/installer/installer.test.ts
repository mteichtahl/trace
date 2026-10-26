import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sodium from 'libsodium-wrappers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.TRACE_CLIENT_DB = join(mkdtempSync(join(tmpdir(), 'trace-client-')), 'client.db')

const calls = vi.hoisted(() => ({ secrets: [] as unknown[], cognito: [] as unknown[], variables: [] as string[], ghSecrets: [] as string[], onboard: [] as string[], users: new Map<string, Set<string>>() }))

vi.mock('../../src/installer/aws.js', () => ({
  credentials: async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key-value-1234' }),
  awsEnv: (_c: unknown, region: string) => ({ AWS_REGION: region }),
  checkAws: async () => ({ account: '123456789012', arn: 'arn:aws:iam::123456789012:user/marc', region: 'us-east-1', agentCore: { ok: true, reason: '' }, models: [], oidcProvider: false, cdkBootstrapped: false, existing: null, warnings: [] }),
  stackOutputs: async () => ({}),
  profiles: async () => ({ names: ['default'], regions: { default: 'us-east-1' } }),
}))
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { async send(c: unknown) { calls.secrets.push(c) } },
  PutSecretValueCommand: class { constructor(readonly input: unknown) {} },
}))
vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class UserNotFoundException extends Error {}
  return {
    UserNotFoundException,
    CognitoIdentityProviderClient: class {
      async send(c: { kind: string; input: { Username?: string; GroupName?: string } }) {
        calls.cognito.push(c)
        const u = c.input.Username ?? ''
        const groups = calls.users.get(u)
        if (c.kind === 'get') {
          if (!groups) throw new UserNotFoundException('no')
          return { UserAttributes: [{ Name: 'sub', Value: `sub-${u}` }] }
        }
        if (c.kind === 'create') { calls.users.set(u, new Set()); return { User: { Attributes: [{ Name: 'sub', Value: `sub-${u}` }] } } }
        if (c.kind === 'group') groups?.add(c.input.GroupName ?? '')
        if (c.kind === 'ungroup') groups?.delete(c.input.GroupName ?? '')
        if (c.kind === 'groups') return { Groups: [...(groups ?? [])].map((GroupName) => ({ GroupName })) }
        return {}
      }
    },
    AdminGetUserCommand: class { kind = 'get'; constructor(readonly input: unknown) {} },
    AdminCreateUserCommand: class { kind = 'create'; constructor(readonly input: unknown) {} },
    AdminAddUserToGroupCommand: class { kind = 'group'; constructor(readonly input: unknown) {} },
    AdminRemoveUserFromGroupCommand: class { kind = 'ungroup'; constructor(readonly input: unknown) {} },
    AdminListGroupsForUserCommand: class { kind = 'groups'; constructor(readonly input: unknown) {} },
  }
})
vi.mock('../../src/installer/github.js', async (orig) => ({
  ...(await orig<typeof import('../../src/installer/github.js')>()),
  setVariable: async (_t: string, repo: string, name: string) => { calls.variables.push(`${repo}:${name}`); return 'created' },
  setSecret: async (_t: string, repo: string, name: string) => { calls.ghSecrets.push(`${repo}:${name}`) },
  checkToken: async () => ({ login: 'trace-agent', name: null, kind: 'fine-grained', scopes: [], repos: [], warnings: [] }),
}))
vi.mock('../../src/core/onboard.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/onboard.js')>()),
  onboard: async (repo: string) => { calls.onboard.push(repo); return { pr: `https://github.com/${repo}/pull/1`, settings: [] } },
}))

const { AnswersSchema, SecretsSchema } = await import('../../src/installer/answers.js')
const { apply, plan, redact } = await import('../../src/installer/bootstrap.js')
const { createInstaller } = await import('../../src/installer/server.js')
const { seal, setVariable: realSetVariable, checkToken } = await vi.importActual<typeof import('../../src/installer/github.js')>('../../src/installer/github.js')
const { installation } = await import('../../src/core/client.js')
const { assignments, require_, projectsFor } = await import('../../src/core/access.js')

const ANSWERS = {
  aws: { mode: 'profile', profile: 'default', region: 'us-east-1', account: '123456789012' },
  agents: { model: 'us.anthropic.claude-sonnet-4-6' },
  projects: [{ repo: 'mteichtahl/board', onboard: true }, { repo: 'mteichtahl/fw', onboard: false }],
  adminEmail: 'marc@example.com',
  people: [
    { email: 'dev@example.com', class: 'user', projects: ['mteichtahl/board'] },
    { email: 'visitor@example.com', class: 'guest', projects: ['mteichtahl/fw'] },
    { email: 'boss@example.com', class: 'admin' },
  ],
}
// Built at runtime so no token-shaped literal sits in the source.
const TOKEN = ['github', 'pat', '11FAKEFAKEFAKE0123456789'].join('_')

const OUTPUTS: Record<string, string> = {
  TraceHome: '', GithubSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:trace/github-token', AgentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_agent-abc',
  ApiRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_api-abc', ActionsRoleArn: 'arn:aws:iam::123456789012:role/trace-github-actions-us-east-1',
  UserPoolId: 'us-east-1_abc', UserPoolClientId: 'client123', CognitoDomain: 'https://trace-123456789012.auth.us-east-1.amazoncognito.com',
}

describe('answers', () => {
  it('requires assignments to name a project being installed, and no repository or person twice', () => {
    expect(AnswersSchema.safeParse(ANSWERS).success).toBe(true)
    expect(AnswersSchema.safeParse({ ...ANSWERS, people: [{ email: 'x@example.com', projects: ['other/repo'] }] }).success).toBe(false)
    expect(AnswersSchema.safeParse({ ...ANSWERS, people: [{ email: 'x@example.com' }, { email: 'X@example.com' }] }).success).toBe(false)
    expect(AnswersSchema.safeParse({ ...ANSWERS, people: [{ email: 'x@example.com', class: 'owner' }] }).success).toBe(false)
    expect(AnswersSchema.safeParse({ ...ANSWERS, projects: [{ repo: 'a/b' }, { repo: 'a/b' }], people: [] }).success).toBe(false)
  })

  it('plans every step, naming the account, region and repositories', () => {
    const steps = plan(AnswersSchema.parse(ANSWERS))
    expect(steps.map((s) => s.id)).toEqual(['check', 'cdk', 'deploy', 'token', 'repos', 'onboard', 'people', 'local'])
    expect(steps.find((s) => s.id === 'repos')?.detail).toContain('mteichtahl/fw')
  })

  it('redacts tokens and keys from log lines', () => {
    const s = SecretsSchema.parse({ githubToken: TOKEN, awsSecretAccessKey: 'abcdEFGH1234secret' })
    expect(redact(`pushing with ${TOKEN} and abcdEFGH1234secret and ghp_${'x'.repeat(36)}`, s)).not.toMatch(/github_pat_11|abcdEFGH1234secret|ghp_x{20}/)
  })
})

describe('github', () => {
  it('seals secrets so only the repository key opens them', async () => {
    await sodium.ready
    const kp = sodium.crypto_box_keypair()
    const sealed = await seal(sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL), 'top secret')
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey)
    expect(sodium.to_string(opened)).toBe('top secret')
  })

  it('creates a variable that does not exist yet, and reads token scopes', async () => {
    const seen: string[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`)
      if (init?.method === 'PATCH') return new Response('{"message":"Not Found"}', { status: 404 })
      if (url.endsWith('/user')) return new Response('{"login":"marc","name":"Marc","type":"User"}', { status: 200, headers: { 'x-oauth-scopes': 'repo, workflow' } })
      if (url.includes('/user/repos')) return new Response('[{"full_name":"mteichtahl/board","private":true,"permissions":{"admin":true,"push":true}}]', { status: 200 })
      return new Response('', { status: 201 })
    }) as typeof fetch
    expect(await realSetVariable('t', 'o/r', 'TRACE_HOME', 's3://b/c', fake)).toBe('created')
    expect(seen.slice(-2)).toEqual(['PATCH https://api.github.com/repos/o/r/actions/variables/TRACE_HOME', 'POST https://api.github.com/repos/o/r/actions/variables'])
    const info = await checkToken('ghp_' + 'a'.repeat(36), fake)
    expect(info).toMatchObject({ login: 'marc', kind: 'classic', scopes: ['repo', 'workflow'] })
    expect(info.repos[0]).toMatchObject({ fullName: 'mteichtahl/board', admin: true })
  })
})

describe('installing', () => {
  it('runs every step, writes secrets only to their destinations, and records people and grants', async () => {
    OUTPUTS.TraceHome = join(mkdtempSync(join(tmpdir(), 'trace-central-')), 'home')
    const events: string[] = []
    const cdk: string[][] = []
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(JSON.stringify(e)), {
      cdk: async (args, env) => { cdk.push(args); expect(env.TRACE_INFRA).toContain('mteichtahl/board'); expect(env.TRACE_INFRA).not.toContain(TOKEN); return 0 },
      outputs: async () => OUTPUTS,
    })
    expect(events.at(-1)).toContain('"ok":true')
    expect(ok).toBe(true)
    expect(cdk.map((a) => a[0])).toEqual(['bootstrap', 'deploy'])
    expect(JSON.stringify(calls.secrets)).toContain(TOKEN) // into Secrets Manager…
    expect(events.join('\n')).not.toContain(TOKEN)          // …and never to the page
    expect(calls.variables).toContain('mteichtahl/fw:TRACE_AGENT_RUNTIME_ARN')
    expect(calls.ghSecrets).toEqual(['mteichtahl/board:TRACE_TOKEN', 'mteichtahl/fw:TRACE_TOKEN'])
    expect(calls.onboard).toEqual(['mteichtahl/board'])
    expect(installation()?.apiRuntimeArn).toBe(OUTPUTS.ApiRuntimeArn)
    process.env.TRACE_HOME = OUTPUTS.TraceHome
    const all = await assignments({ sub: 'x', email: null, groups: ['trace-admins'] })
    expect(all.map((g) => `${g.email}:${g.class}:${g.repo}`).sort()).toEqual(['dev@example.com:user:mteichtahl/board', 'visitor@example.com:guest:mteichtahl/fw'])
    const groups = JSON.stringify(calls.cognito)
    for (const g of ['trace-admins', 'trace-users', 'trace-guests']) expect(groups).toContain(g)
    // What those assignments mean once each person signs in with their group in the token:
    const dev = { sub: 'sub-dev@example.com', email: 'dev@example.com', groups: ['trace-users'] }
    const visitor = { sub: 'sub-visitor@example.com', email: 'visitor@example.com', groups: ['trace-guests'] }
    expect(await require_(dev, 'mteichtahl/board', 'write')).toBe('write')
    await expect(require_(dev, 'mteichtahl/fw', 'read')).rejects.toThrow(/no read access/)
    expect(await require_(visitor, 'mteichtahl/fw', 'read')).toBe('read')
    await expect(require_(visitor, 'mteichtahl/fw', 'write')).rejects.toThrow(/no write access/)
    expect(await projectsFor(visitor)).toEqual([{ repo: 'mteichtahl/fw', role: 'read' }])
    expect(calls.variables).toContain('mteichtahl/board:TRACE_AGENT_LOGIN')
  })

  it('a second run takes away what the answers no longer list', async () => {
    // dev moves from user on board to guest on fw; visitor is dropped from the list entirely.
    const again = { ...ANSWERS, people: [{ email: 'dev@example.com', class: 'guest', projects: ['mteichtahl/fw'] }, { email: 'boss@example.com', class: 'admin' }] }
    const events: string[] = []
    const ok = await apply(AnswersSchema.parse(again), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(JSON.stringify(e)), { cdk: async () => 0, outputs: async () => OUTPUTS })
    expect(ok).toBe(true)
    expect([...(calls.users.get('dev@example.com') ?? [])]).toEqual(['trace-guests'])
    const all = await assignments({ sub: 'x', email: null, groups: ['trace-admins'] })
    expect(all.map((g) => `${g.email}:${g.class}:${g.repo}`).sort()).toEqual(['dev@example.com:guest:mteichtahl/fw', 'visitor@example.com:guest:mteichtahl/fw'])
    expect(events.join('\n')).toMatch(/still assigned: visitor@example.com/)
  })

  it('stops at the failing step and says how to continue', async () => {
    const events: { type: string; ok?: boolean; summary?: string[]; step?: { id: string; status: string } }[] = []
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), { cdk: async (args) => (args[0] === 'deploy' ? 1 : 0) })
    expect(ok).toBe(false)
    expect(events.some((e) => e.type === 'step' && e.step?.id === 'deploy' && e.step.status === 'failed')).toBe(true)
    expect(events.at(-1)?.summary?.join(' ')).toMatch(/run the installer again/)
  })
})

describe('the local server', () => {
  let base = ''
  let key = ''
  let close: () => void = () => undefined
  beforeAll(async () => {
    const i = createInstaller({ uiScript: '/* ui */' })
    key = i.key
    await new Promise<void>((r) => i.server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(i.server.address() as AddressInfo).port}`
    close = () => i.server.close()
  })
  afterAll(() => close())

  const call = (path: string, opts: { method?: string; key?: string; host?: string; body?: string; type?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolveP, reject) => {
      const u = new URL(base + path)
      const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: {
        host: opts.host ?? `localhost:${u.port}`, ...(opts.key ? { 'x-trace-key': opts.key } : {}), ...(opts.body ? { 'content-type': opts.type ?? 'application/json' } : {}), ...opts.headers,
      } }, (res) => { let b = ''; res.on('data', (d: Buffer) => { b += d.toString() }); res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: b })) })
      req.on('error', reject)
      if (opts.body) req.write(opts.body)
      req.end()
    })

  it('refuses other hosts, and anything without the key', async () => {
    expect((await call('/api/env', { key, host: 'evil.example' })).status).toBe(421)
    expect((await call('/api/env')).status).toBe(401)
    expect((await call('/')).status).toBe(401)
    expect((await call(`/?k=wrong`)).status).toBe(401)
  })

  it('takes the key in the URL only for the page and the event stream, and refuses cross-site requests', async () => {
    expect((await call(`/api/env?k=${key}`)).status).toBe(401)
    expect((await call('/api/env', { key, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await call('/api/env', { key, headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call('/api/github/check', { key, method: 'POST', body: JSON.stringify({ token: 'x'.repeat(30), repos: ['../../user'] }) })).status).toBe(400)
  })

  it('serves the page with a strict policy, and the API with the key', async () => {
    const pg = await call(`/?k=${key}`)
    expect(pg.status).toBe(200)
    expect(pg.body).toContain('Install trace')
    const env = await call('/api/env', { key })
    expect(env.status).toBe(200)
    expect(JSON.parse(env.body)).toHaveProperty('profiles')
    expect((await call('/api/plan', { method: 'POST', key, body: '{"answers":{}}' })).status).toBe(400)
    expect((await call('/api/plan', { method: 'POST', key, body: 'x', type: 'text/plain' })).status).toBe(415)
    const planned = await call('/api/plan', { method: 'POST', key, body: JSON.stringify({ answers: ANSWERS }) })
    expect(JSON.parse(planned.body).steps).toHaveLength(8)
  })
})
