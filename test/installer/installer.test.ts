import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sodium from 'libsodium-wrappers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.TRACE_CLIENT_DB = join(mkdtempSync(join(tmpdir(), 'trace-client-')), 'client.db')

const calls = vi.hoisted(() => ({
  secrets: [] as unknown[], cognito: [] as unknown[], variables: [] as string[], values: new Map<string, string>(), ghSecrets: [] as string[], ghSecretValues: new Map<string, string>(),
  onboard: [] as string[], users: new Map<string, Set<string>>(),
  /** what checkToken answers per token (default: the agents' account, seeing nothing) */
  tokens: new Map<string, { login: string; repos: string[] }>(),
  /** the stack checkAws finds already deployed (default: none) */
  existing: null as null | { stack: string; status: string; outputs: Record<string, string> },
  /** secret names freeSecretNames was asked to free */
  freed: [] as string[],
  /** the default names check (no hook): which projects the stack has, and the names taken in the account */
  deployed: new Set<string>(),
  taken: new Set<string>(),
  /** what the default connection resolver (no hook) was asked */
  connection: [] as { prefix: string; given?: string; deployed: Record<string, string> | null }[],
}))

vi.mock('../../src/installer/aws.js', () => ({
  credentials: async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key-value-1234' }),
  awsEnv: (_c: unknown, region: string) => ({ AWS_REGION: region }),
  checkAws: async () => ({ account: '123456789012', arn: 'arn:aws:iam::123456789012:user/marc', region: 'us-east-1', agentCore: { ok: true, reason: '' }, models: [], oidcProvider: false, cdkBootstrapped: false, existing: calls.existing, warnings: [] }),
  stackOutputs: async () => ({}),
  freeSecretNames: async (_c: unknown, _r: string, names: readonly string[]) => { calls.freed.push(...names); return names.map((n) => `${n}: free`) },
  profiles: async () => ({ names: ['default'], regions: { default: 'us-east-1' } }),
  cfnClient: () => ({}),
  codebuildClient: () => ({}),
  nameClients: () => ({}),
  deployedProjects: async () => calls.deployed,
  nameIndex: () => ({ taken: async (n: { memories: string[]; deliveries: string[]; secrets: string[] }) => [...n.memories, ...n.deliveries, ...n.secrets].filter((x) => calls.taken.has(x)) }),
  ensureGpuImage: async () => ({ ok: true, detail: 'the GPU image is built' }),
  connectionsClient: () => ({}),
  connectionName: (prefix: string) => `${prefix}-github`,
  connectionsConsoleUrl: (region: string) => `https://${region}.console.aws.amazon.com/codesuite/settings/connections?region=${region}`,
  connectorAccessNote: (repos: readonly string[]) => `The AWS Connector for GitHub app must be allowed to reach every onboarded repository (${repos.join(', ')})`,
  resolveConnection: async (_c: unknown, o: { prefix: string; given?: string; deployed: Record<string, string> | null }) => {
    calls.connection.push(o)
    const arn = o.given ?? CONNECTION
    return { pass: arn, arn, name: `${o.prefix}-github`, ready: true, message: `Using the GitHub connection ${o.prefix}-github (${arn}), already authorized.` }
  },
  waitForConnection: async () => { throw new Error('must not wait') },
}))
const CONNECTION = vi.hoisted(() => 'arn:aws:codeconnections:us-east-1:123456789012:connection/11111111-2222-3333-4444-555555555555')
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { async send(c: unknown) { calls.secrets.push(c) } },
  PutSecretValueCommand: class { constructor(readonly input: unknown) {} },
  GetSecretValueCommand: class { constructor(readonly input: unknown) {} },
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
  setVariable: async (_t: string, repo: string, name: string, value: string) => { calls.variables.push(`${repo}:${name}`); calls.values.set(`${repo}:${name}`, value); return 'created' },
  setSecret: async (_t: string, repo: string, name: string, value: string) => { calls.ghSecrets.push(`${repo}:${name}`); calls.ghSecretValues.set(`${repo}:${name}`, value) },
  checkToken: async (token: string) => {
    const t = calls.tokens.get(token) ?? { login: 'trace-agent', repos: [] }
    return { login: t.login, name: null, kind: 'fine-grained', scopes: [], repos: t.repos.map((fullName) => ({ fullName, private: true, admin: false, push: true, defaultBranch: 'main' })), warnings: [] }
  },
}))
vi.mock('../../src/core/onboard.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/onboard.js')>()),
  onboard: async (repo: string) => { calls.onboard.push(repo); return { pr: `https://github.com/${repo}/pull/1`, settings: [] } },
}))

const { AnswersSchema, SecretsSchema } = await import('../../src/installer/answers.js')
const { apply, infraInput, layoutDeploys, layoutOf, mergeLibraryKeys, plan, redact } = await import('../../src/installer/bootstrap.js')
const { InfraPropsSchema } = await import('../../src/infra/props.js')
const { projectOutputs, projectHash } = await import('../../src/infra/props.js')
const { createInstaller } = await import('../../src/installer/server.js')
const { waitWithTimer } = await import('../../src/core/wait.js')
const { seal, setVariable: realSetVariable, checkToken } = await vi.importActual<typeof import('../../src/installer/github.js')>('../../src/installer/github.js')
const { installation, answers: savedAnswers } = await import('../../src/core/client.js')
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
  TraceHome: '', GithubSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:trace/github-token',
  ApiRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_api-abc',
  UserPoolId: 'us-east-1_abc', UserPoolClientId: 'client123', CognitoDomain: 'https://trace-123456789012.auth.us-east-1.amazoncognito.com',
}
// each project's own outputs, named by its hash
for (const repo of ['mteichtahl/board', 'mteichtahl/fw']) {
  const o = projectOutputs(repo)
  OUTPUTS[o.runtimeArn] = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_${repo.split('/')[1]}-abc`
  OUTPUTS[o.roleArn] = `arn:aws:iam::123456789012:role/trace-gh-${repo.split('/')[1]}-us-east-1`
  OUTPUTS[o.secretArn] = `arn:aws:secretsmanager:us-east-1:123456789012:secret:trace/github-token/${repo}`
  OUTPUTS[o.memoryId] = `trace_m_${repo.split('/')[1]}-abcdefghij`
  OUTPUTS[o.runnerProject] = `trace-ci-${projectHash(repo)}`
}
const secretWrites = (): { SecretId: string; SecretString: string }[] => calls.secrets.map((c) => (c as { input: { SecretId: string; SecretString: string } }).input)

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
    expect(steps.map((s) => s.id)).toEqual(['check', 'cdk', 'deploy', 'connection', 'runners', 'token', 'repos', 'onboard', 'people', 'local', 'gpu'])
    expect(steps.find((s) => s.id === 'repos')?.detail).toContain('mteichtahl/fw')
    expect(steps.find((s) => s.id === 'deploy')?.detail).toMatch(/for each of the 2 repositories its own AgentCore worker runtime/)
  })

  it('passes each project\'s memory event expiry to the stack, and leaves the rest to the default', () => {
    const a = AnswersSchema.parse({ ...ANSWERS, projects: [{ repo: 'mteichtahl/board', memoryEventExpiryDays: 90 }, { repo: 'mteichtahl/fw' }] })
    const input = infraInput(a)
    expect(input.projectSettings).toEqual({ 'mteichtahl/board': { memoryEventExpiryDays: 90 } })
    expect(input.memory).toBeUndefined()
    const props = InfraPropsSchema.parse(input)
    expect(props.memory.eventExpiryDays).toBe(30)
    expect(infraInput(AnswersSchema.parse(ANSWERS)).projectSettings).toBeUndefined()
    expect(plan(a).find((s) => s.id === 'deploy')?.detail).toMatch(/each project its own AgentCore memory \(events kept 30 days; mteichtahl\/board 90 days, kept if the project or the stack is removed\)/)
    expect(AnswersSchema.safeParse({ ...ANSWERS, projects: [{ repo: 'mteichtahl/board', memoryEventExpiryDays: 2 }] }).success).toBe(false)
  })

  it('says what happens to an earlier version\'s installation-wide memory, and keeps it on the way out with retainData', () => {
    const existing = { outputs: { MemoryId: 'trace_memory-abcdefghij' } }
    const keep = AnswersSchema.parse(ANSWERS)
    expect(infraInput(keep, existing).memory).toEqual({ legacySharedMemory: true })
    expect(plan(keep, existing).find((s) => s.id === 'deploy')?.detail).toMatch(/trace_memory-abcdefghij.*not copied.*marked Retain.*orphan/)
    const drop = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, retainData: false } })
    expect(infraInput(drop, existing).memory).toBeUndefined()
    expect(plan(drop, existing).find((s) => s.id === 'deploy')?.detail).toMatch(/DELETES the old one/)
    // a fresh install, or one already past the change, says nothing of it
    const none: (null | { outputs: Record<string, string> })[] = [null, { outputs: {} }, { outputs: { LegacyMemoryId: 'trace_memory-abcdefghij' } }]
    for (const e of none) {
      expect(infraInput(keep, e).memory).toBeUndefined()
      expect(plan(keep, e).find((s) => s.id === 'deploy')?.detail).not.toMatch(/earlier version/)
    }
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
    // each project's own memory, from its Project<hash>MemoryId output
    expect(installation()?.memoryIds).toEqual({ 'mteichtahl/board': 'trace_m_board-abcdefghij', 'mteichtahl/fw': 'trace_m_fw-abcdefghij' })
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
    // each repository gets its own project's role and runtime
    for (const repo of ['mteichtahl/board', 'mteichtahl/fw']) {
      expect(calls.values.get(`${repo}:TRACE_AWS_ROLE`)).toBe(OUTPUTS[projectOutputs(repo).roleArn])
      expect(calls.values.get(`${repo}:TRACE_AGENT_RUNTIME_ARN`)).toBe(OUTPUTS[projectOutputs(repo).runtimeArn])
    }
    expect(calls.values.get('mteichtahl/board:TRACE_AWS_ROLE')).not.toBe(calls.values.get('mteichtahl/fw:TRACE_AWS_ROLE'))
    // the shared token into the API's secret and, with no project token given, into each project's
    expect(secretWrites().map((w) => w.SecretId).sort()).toEqual([OUTPUTS.GithubSecretArn, OUTPUTS[projectOutputs('mteichtahl/board').secretArn], OUTPUTS[projectOutputs('mteichtahl/fw').secretArn]].sort())
    expect(secretWrites().every((w) => w.SecretString === TOKEN)).toBe(true)
    // …and the summary says GitHub access is not isolated
    const done = JSON.parse(events.at(-1) ?? '{}') as { summary: string[] }
    expect(done.summary.join('\n')).toMatch(/GitHub access is not isolated between projects: mteichtahl\/board, mteichtahl\/fw use the shared agent token/)
  })

  it('stores each project\'s own token in its secret and TRACE_TOKEN, checks it, and warns when it reaches other projects', async () => {
    calls.secrets.length = 0
    calls.ghSecretValues.clear()
    const BOARD = ['github', 'pat', '11BOARDBOARDBOARD0123456789'].join('_')
    const FW = ['github', 'pat', '11FWFWFWFWFWFWFW0123456789'].join('_')
    calls.tokens.set(BOARD, { login: 'board-bot', repos: ['mteichtahl/board'] })
    calls.tokens.set(FW, { login: 'fw-bot', repos: ['mteichtahl/fw', 'mteichtahl/board'] })
    const events: string[] = []
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN, projectTokens: { 'mteichtahl/board': BOARD, 'MTEICHTAHL/fw': FW } }), (e) => events.push(JSON.stringify(e)), { cdk: async () => 0, outputs: async () => OUTPUTS })
    expect(ok).toBe(true)
    const byId = new Map(secretWrites().map((w) => [w.SecretId, w.SecretString]))
    expect(byId.get(OUTPUTS.GithubSecretArn ?? '')).toBe(TOKEN)
    expect(byId.get(OUTPUTS[projectOutputs('mteichtahl/board').secretArn] ?? '')).toBe(BOARD)
    expect(byId.get(OUTPUTS[projectOutputs('mteichtahl/fw').secretArn] ?? '')).toBe(FW)
    expect(calls.ghSecretValues.get('mteichtahl/board:TRACE_TOKEN')).toBe(BOARD)
    expect(calls.ghSecretValues.get('mteichtahl/fw:TRACE_TOKEN')).toBe(FW)
    expect(calls.values.get('mteichtahl/board:TRACE_AGENT_LOGIN')).toBe('board-bot')
    const text = events.join('\n')
    for (const t of [BOARD, FW, TOKEN]) expect(text).not.toContain(t)
    const summary = (JSON.parse(events.at(-1) ?? '{}') as { summary: string[] }).summary.join('\n')
    expect(summary).toMatch(/mteichtahl\/fw's own token can also reach mteichtahl\/board/)
    expect(summary).not.toMatch(/GitHub access is not isolated/)

    // a project token that cannot see its own repository stops the installation before anything is deployed
    const blind = ['github', 'pat', '11BLINDBLINDBLIND0123456789'].join('_')
    calls.tokens.set(blind, { login: 'blind', repos: ['someone/else'] })
    const cdk: string[][] = []
    const failed: { type: string; summary?: string[] }[] = []
    expect(await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN, projectTokens: { 'mteichtahl/fw': blind } }), (e) => failed.push(e as never), { cdk: async (a) => { cdk.push(a); return 0 }, outputs: async () => OUTPUTS })).toBe(false)
    expect(cdk).toEqual([])
    expect(failed.at(-1)?.summary?.join(' ')).toMatch(/mteichtahl\/fw's own token \(blind\) cannot see mteichtahl\/fw/)
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

  it('keeps an earlier version\'s installation-wide memory for one deploy, and says so', async () => {
    calls.existing = { stack: 'TraceStack', status: 'UPDATE_COMPLETE', outputs: { MemoryId: 'trace_memory-abcdefghij' } }
    try {
      const events: string[] = []
      const infra: string[] = []
      const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(JSON.stringify(e)), {
        cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(env.TRACE_INFRA ?? ''); return 0 }, outputs: async () => OUTPUTS,
      })
      expect(ok).toBe(true)
      expect(JSON.parse(infra[0] ?? '{}').memory).toEqual({ legacySharedMemory: true })
      const done = JSON.parse(events.at(-1) ?? '{}') as { summary: string[] }
      expect(done.summary.join('\n')).toMatch(/installation-wide memory of an earlier version \(trace_memory-abcdefghij\)/)
    } finally {
      calls.existing = null
    }
  })

  it('puts a new installation in nested stacks, keeps an earlier one flat, and moves it only when asked, in three deploys', async () => {
    const flatStack = { stack: 'TraceStack', status: 'UPDATE_COMPLETE', outputs: { TraceHome: 's3://b/central' } }
    expect(layoutOf(null)).toBe('nested')
    expect(layoutOf({ outputs: {} })).toBe('nested') // a first deploy that rolled back
    expect(layoutOf(flatStack)).toBe('flat')
    expect(layoutOf({ outputs: { TraceHome: 'x', Layout: 'nested' } })).toBe('nested')
    expect(layoutOf({ outputs: { TraceHome: 'x', Layout: 'flat' } })).toBe('flat')
    const keep = AnswersSchema.parse(ANSWERS)
    const move = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, migrateLayout: true } })
    expect(infraInput(keep).layout).toBe('nested')
    expect(infraInput(keep, flatStack).layout).toBe('flat')
    expect(infraInput(move, null).layout).toBe('nested')
    expect(layoutDeploys(move, null)).toHaveLength(1)
    expect(layoutDeploys(move, { outputs: { TraceHome: 'x', Layout: 'nested' } })).toHaveLength(1)
    expect(layoutDeploys(keep, flatStack).map((d) => d.layout)).toEqual(['flat'])
    expect(layoutDeploys(move, flatStack).map((d) => `${d.layout}:${d.layoutMigration ?? ''}`)).toEqual(['flat:release', 'flat:drain', 'nested:'])
    // without retainData the memories are Delete already: no release step
    const moveNoKeep = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, migrateLayout: true, retainData: false } })
    expect(layoutDeploys(moveNoKeep, flatStack).map((d) => `${d.layout}:${d.layoutMigration ?? ''}`)).toEqual(['flat:drain', 'nested:'])
    // every stage is a valid stack setting
    for (const d of layoutDeploys(move, flatStack)) expect(InfraPropsSchema.safeParse(infraInput(move, flatStack, d)).success).toBe(true)
    // the plan says which, and what the move costs
    const detail = (a: typeof keep, e: typeof flatStack | null): string => plan(a, e).find((x) => x.id === 'deploy')?.detail ?? ''
    expect(detail(keep, null)).toMatch(/one nested stack per project \(a new installation\)/)
    expect(detail(keep, flatStack)).toMatch(/layout flat.*about 20 projects.*"move to nested stacks"/)
    expect(detail(move, flatStack)).toMatch(/3 deploys.*DELETING each project's memory and every record in it.*offline/)

    // the move: release, drain, then nested, with the drained secrets' names freed just before the nested deploy
    calls.existing = flatStack
    calls.freed.length = 0
    try {
      const order: string[] = []
      const ok = await apply(move, SecretsSchema.parse({ githubToken: TOKEN }), () => undefined, {
        cdk: async (args, env) => { if (args[0] === 'deploy') { const i = JSON.parse(env.TRACE_INFRA ?? '{}'); order.push(`deploy ${i.layout}:${i.layoutMigration ?? ''}`) } return 0 },
        outputs: async () => OUTPUTS,
        freeSecrets: async (_c, _r, names) => { order.push(`free ${names.join(',')}`); return [] },
      })
      expect(ok).toBe(true)
      expect(order).toEqual(['deploy flat:release', 'deploy flat:drain', 'free trace/github-token/mteichtahl/board,trace/github-token/mteichtahl/fw', 'deploy nested:'])
      // no move asked: one flat deploy, nothing freed
      order.length = 0
      expect(await apply(keep, SecretsSchema.parse({ githubToken: TOKEN }), () => undefined, {
        cdk: async (args, env) => { if (args[0] === 'deploy') order.push(`deploy ${JSON.parse(env.TRACE_INFRA ?? '{}').layout}`); return 0 }, outputs: async () => OUTPUTS,
      })).toBe(true)
      expect(order).toEqual(['deploy flat'])
      expect(calls.freed).toEqual([])
    } finally {
      calls.existing = null
    }
  })

  it('writes each project\'s token into its secret by name when the parent does not carry its ARN (the nested layout)', async () => {
    calls.secrets.length = 0
    const nestedOutputs = Object.fromEntries(Object.entries(OUTPUTS).filter(([k]) => !k.endsWith('GithubSecretArn') || k === 'GithubSecretArn'))
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), () => undefined, { cdk: async () => 0, outputs: async () => nestedOutputs })
    expect(ok).toBe(true)
    expect(secretWrites().map((w) => w.SecretId).sort()).toEqual([OUTPUTS.GithubSecretArn, 'trace/github-token/mteichtahl/board', 'trace/github-token/mteichtahl/fw'].sort())
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
    expect(JSON.parse(planned.body).steps).toHaveLength(11)
  })

  it('checks a timer wait now on POST /api/check-now, with the key, JSON only and same-origin', async () => {
    let checks = 0
    let id = ''
    const waiting = waitWithTimer<number>({
      what: 'a test build', why: 'a test', intervalMs: 3_600_000,
      now: () => Date.now() - 10_000, // its last check is 10 s old: past check now's 2 s gap
      check: async () => (++checks >= 2 ? { done: true, value: checks } : { done: false, state: 'IN_PROGRESS' }),
      report: (n) => { id = n.id },
    })
    await vi.waitFor(() => expect(id).not.toBe(''))
    const body = JSON.stringify({ waitId: id })
    expect((await call('/api/check-now', { method: 'POST', body })).status).toBe(401)
    expect((await call('/api/check-now', { method: 'POST', key: 'wrong', body })).status).toBe(401)
    expect((await call(`/api/check-now?k=${key}`, { method: 'POST', body })).status).toBe(401)
    expect((await call('/api/check-now', { method: 'POST', key, body, type: 'text/plain' })).status).toBe(415)
    expect((await call('/api/check-now', { method: 'POST', key, body, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await call('/api/check-now', { method: 'POST', key, body, headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call('/api/check-now', { method: 'POST', key, body: '{"waitId":"../x"}' })).status).toBe(400)
    expect(checks).toBe(1)
    const r = await call('/api/check-now', { method: 'POST', key, body })
    expect(r).toEqual({ status: 200, body: '{"ok":true}' })
    expect(await waiting).toMatchObject({ done: true, value: 2 })
    // the wait has ended: nothing to wake
    expect(JSON.parse((await call('/api/check-now', { method: 'POST', key, body })).body)).toEqual({ ok: false })
  })
})

describe('adding a removed project again, its memory variable, the CPU queue and the GPU image', () => {
  const run = async (a: unknown, hooks: Parameters<typeof apply>[3] = {}): Promise<{ ok: boolean; infra: Record<string, unknown>[]; events: { type: string; line?: string; summary?: string[]; step?: { id: string; status: string; detail: string } }[] }> => {
    const infra: Record<string, unknown>[] = []
    const events: { type: string; line?: string; summary?: string[]; step?: { id: string; status: string; detail: string } }[] = []
    const ok = await apply(AnswersSchema.parse(a), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 }, outputs: async () => OUTPUTS, ...hooks,
    })
    return { ok, infra, events }
  }
  const board = projectHash('mteichtahl/board')

  it("gives a project the stack does not have the next free generation, says the old memory is orphaned, and saves it", async () => {
    const asked: string[][] = []
    // board is new to the stack, and its generation-0 memory (retained) and secret (in its recovery window) are taken,
    // and so is its generation-1 secret; fw is in the stack, so its names are its own whatever the account has
    const taken = new Set([`trace_m_${board}`, 'trace/github-token/mteichtahl/board', 'trace/github-token/mteichtahl/board@g1', `trace_m_${projectHash('mteichtahl/fw')}`])
    const r = await run(ANSWERS, {
      names: {
        deployed: async () => new Set([projectHash('mteichtahl/fw')]),
        taken: async (n) => { asked.push([...n.memories, ...n.deliveries, ...n.secrets]); return [...n.memories, ...n.deliveries, ...n.secrets].filter((x) => taken.has(x)) },
      },
    })
    expect(r.ok).toBe(true)
    // generation 0, then 1, then 2 (free); fw never asked
    expect(asked.map((x) => x.find((n) => n.startsWith('trace/github-token/')))).toEqual(['trace/github-token/mteichtahl/board', 'trace/github-token/mteichtahl/board@g1', 'trace/github-token/mteichtahl/board@g2'])
    expect(asked[0]).toEqual([`trace_m_${board}`, `trace-m-${board}-logs`, `trace-m-${board}-traces`, 'trace/github-token/mteichtahl/board'])
    expect(r.infra[0]?.projectSettings).toEqual({ 'mteichtahl/board': { generation: 2 } })
    expect(InfraPropsSchema.parse(r.infra[0]).projectSettings['mteichtahl/board']?.generation).toBe(2)
    // saved with the answers, so the next run starts there
    const saved = AnswersSchema.parse(savedAnswers().answers)
    expect(saved.projects.find((p) => p.repo === 'mteichtahl/board')?.generation).toBe(2)
    expect(saved.projects.find((p) => p.repo === 'mteichtahl/fw')?.generation).toBe(0)
    const summary = (r.events.at(-1)?.summary ?? []).join('\n')
    expect(summary).toMatch(/mteichtahl\/board \(generation 2;.*taken\).*The old memory is kept and orphaned.*the new one starts empty/)
    expect(r.events.find((e) => e.type === 'step' && e.step?.id === 'deploy' && e.step.status === 'pending' && /orphaned/.test(e.step.detail))).toBeDefined()
    // its token is written to the new secret's name when the stack gives no ARN for it
    calls.secrets.length = 0
    const noArns = Object.fromEntries(Object.entries(OUTPUTS).filter(([k]) => !k.endsWith('GithubSecretArn') || k === 'GithubSecretArn'))
    await run(saved, { outputs: async () => noArns, names: { deployed: async () => new Set([board, projectHash('mteichtahl/fw')]), taken: async () => ['anything'] } })
    expect(secretWrites().map((w) => w.SecretId)).toContain('trace/github-token/mteichtahl/board@g2')
  })

  it('leaves every generation alone when the names are free, and uses the account check by default', async () => {
    calls.deployed = new Set()
    calls.taken = new Set()
    const r = await run(ANSWERS)
    expect(r.ok).toBe(true)
    expect(r.infra[0]?.projectSettings).toBeUndefined()
    expect((r.events.at(-1)?.summary ?? []).join('\n')).not.toMatch(/orphaned/)
    // the default check: fw's generation-0 secret is taken in the account, and the stack has neither project
    calls.taken = new Set(['trace/github-token/mteichtahl/fw'])
    const r2 = await run(ANSWERS)
    expect(r2.infra[0]?.projectSettings).toEqual({ 'mteichtahl/fw': { generation: 1 } })
    calls.taken = new Set()
  })

  it('tells each repository its own memory (TRACE_MEMORY_ID) for the in-Actions fallback', async () => {
    calls.values.clear()
    await run(ANSWERS, { names: { deployed: async () => new Set(), taken: async () => [] } })
    for (const repo of ['mteichtahl/board', 'mteichtahl/fw']) expect(calls.values.get(`${repo}:TRACE_MEMORY_ID`)).toBe(OUTPUTS[projectOutputs(repo).memoryId])
    // memory off: no variable
    calls.values.clear()
    const off = { ...OUTPUTS }
    for (const repo of ['mteichtahl/board', 'mteichtahl/fw']) delete off[projectOutputs(repo).memoryId]
    await run(ANSWERS, { outputs: async () => off, names: { deployed: async () => new Set(), taken: async () => [] } })
    expect([...calls.values.keys()].filter((k) => k.endsWith(':TRACE_MEMORY_ID'))).toEqual([])
  })

  it('passes the CPU queue settings to the stack, and says in the plan when the layout has no room for it', () => {
    const a = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, cpuMaxVcpus: 128, cpuVcpus: 32, cpuMemoryMiB: 61_440, cpuSpot: true } })
    expect(infraInput(a).cpu).toEqual({ enabled: true, maxVcpus: 128, spot: true, vcpus: 32, memoryMiB: 61_440 })
    expect(InfraPropsSchema.parse(infraInput(a)).cpu).toMatchObject({ enabled: true, maxVcpus: 128, vcpus: 32, memoryMiB: 61_440, instanceTypes: ['c7i', 'c6i', 'm7i'] })
    const detail = (x: typeof a, e: { outputs: Record<string, string> } | null = null): string => plan(x, e).find((st) => st.id === 'deploy')?.detail ?? ''
    expect(detail(a)).toMatch(/a CPU queue for CPU-heavy remote jobs \(c7i\/c6i\/m7i, up to 128 vCPUs, Spot, 32 vCPUs and 60 GiB per job/)
    expect(detail(a, { outputs: { TraceHome: 'x', Layout: 'flat' } })).toMatch(/no CPU queue \(it needs one nested stack per project/)
    expect(detail(AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, cpuEnabled: false } }))).not.toMatch(/CPU queue/)
    expect(AnswersSchema.safeParse({ ...ANSWERS, agents: { ...ANSWERS.agents, cpuVcpus: 96 } }).success).toBe(false)
  })

  it('waits for the GPU image last, and reports a failed build without undoing the rest', async () => {
    const outputs = { ...OUTPUTS, GpuImageBuild: 'trace-gpu-image:1234', GpuImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/trace-gpu:abc123' }
    const seen: { buildId: string; imageTag: string }[] = []
    const order: string[] = []
    const r = await run(ANSWERS, {
      outputs: async () => outputs, names: { deployed: async () => new Set(), taken: async () => [] },
      gpuImage: async (o) => { seen.push({ buildId: o.buildId, imageTag: o.imageTag }); return { ok: false, detail: 'the GPU image build trace-gpu-image:1234 failed in BUILD' } },
    })
    for (const e of r.events) if (e.type === 'step' && e.step?.status === 'done') order.push(e.step.id)
    expect(seen).toEqual([{ buildId: 'trace-gpu-image:1234', imageTag: 'abc123' }])
    expect(r.ok).toBe(true)
    expect(order.at(-1)).toBe('local') // every other step is done before the GPU image is waited for
    expect(r.events.find((e) => e.type === 'step' && e.step?.id === 'gpu' && e.step.status === 'failed')?.step?.detail).toMatch(/failed in BUILD/)
    expect((r.events.at(-1)?.summary ?? []).join('\n')).toMatch(/GPU and CPU jobs cannot run until the GPU image is built.*run the installer again/)
    // each check of the wait reaches the page as a `wait` event: the notice, and its line
    const notice = { id: 'wait-abc123', what: 'the GPU image abc123 to build', source: 'timer' as const, startedAt: '2026-10-26T10:00:00.000Z', jobId: null, state: 'IN_PROGRESS',
      lastCheckedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 30_000).toISOString(), intervalMs: 30_000, checks: 1, why: 'the installer runs on your computer' }
    const w = await run(ANSWERS, {
      outputs: async () => outputs, names: { deployed: async () => new Set(), taken: async () => [] },
      gpuImage: async (o) => { o.report(notice); return { ok: true, detail: 'built' } },
    })
    const waitEvents = w.events.filter((e) => e.type === 'wait') as unknown as { step: string; wait: typeof notice; line: string }[]
    expect(waitEvents).toHaveLength(1)
    expect(waitEvents[0]).toMatchObject({ step: 'gpu', wait: notice })
    expect(waitEvents[0]?.line).toMatch(/^Waiting for the GPU image abc123 to build \(in progress\)\. Checked just now; next check in (30|29) seconds\.$/)
    const { EventSchema } = await import('../../src/installer/answers.js')
    expect(EventSchema.safeParse(waitEvents[0]).success).toBe(true)
    // GPU off: nothing to wait for
    const off = await run({ ...ANSWERS, agents: { ...ANSWERS.agents, gpuEnabled: false } }, { names: { deployed: async () => new Set(), taken: async () => [] }, gpuImage: async () => { throw new Error('not called') } })
    expect(off.ok).toBe(true)
    expect(off.events.find((e) => e.type === 'step' && e.step?.id === 'gpu' && e.step.status === 'skipped')).toBeDefined()
  })
})

describe('the library gateway', () => {
  const GW = { ...ANSWERS, agents: { ...ANSWERS.agents, libraryGateway: true } }
  const KEYS_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:trace/library-keys-AbCdEf'
  const MOUSER = ['mouser', 'key', '0123456789abcdef'].join('-')

  it('is off unless chosen, and asked of the stack when it is', () => {
    expect(infraInput(AnswersSchema.parse(ANSWERS)).gateway).toEqual({ enabled: false })
    expect(infraInput(AnswersSchema.parse(GW)).gateway).toEqual({ enabled: true })
    expect(plan(AnswersSchema.parse(GW)).find((x) => x.id === 'deploy')?.detail).toContain('the library gateway')
    expect(plan(AnswersSchema.parse(ANSWERS)).find((x) => x.id === 'deploy')?.detail).not.toContain('library gateway')
  })

  it('keeps stored keys a run leaves empty, and drops the placeholder CloudFormation made', () => {
    expect(mergeLibraryKeys({ unused: 'x1y2', MOUSER_API_KEY: 'old', NEXAR_CLIENT_ID: 'n' }, { MOUSER_API_KEY: 'new' })).toEqual({ MOUSER_API_KEY: 'new', NEXAR_CLIENT_ID: 'n' })
    expect(SecretsSchema.parse({ githubToken: TOKEN }).libraryKeys).toEqual({ MOUSER_API_KEY: '', DIGIKEY_CLIENT_ID: '', DIGIKEY_CLIENT_SECRET: '', NEXAR_CLIENT_ID: '', NEXAR_CLIENT_SECRET: '' })
    expect(SecretsSchema.safeParse({ githubToken: TOKEN, libraryKeys: { OTHER: 'x' } }).success).toBe(false)
  })

  it('writes the keys given into the gateway\'s secret, merged, and never shows them', async () => {
    calls.secrets.length = 0
    OUTPUTS.TraceHome = join(mkdtempSync(join(tmpdir(), 'trace-central-')), 'home')
    const events: string[] = []
    const ok = await apply(AnswersSchema.parse(GW), SecretsSchema.parse({ githubToken: TOKEN, libraryKeys: { MOUSER_API_KEY: MOUSER } }), (e) => events.push(JSON.stringify(e)), {
      cdk: async (args, env) => { if (args[0] === 'deploy') expect(JSON.parse(env.TRACE_INFRA ?? '{}').gateway).toEqual({ enabled: true }); expect(env.TRACE_INFRA).not.toContain(MOUSER); return 0 },
      outputs: async () => ({ ...OUTPUTS, LibraryKeysSecretArn: KEYS_ARN }),
      readSecret: async () => ({ unused: 'Ab12', NEXAR_CLIENT_ID: 'kept' }),
    })
    expect(ok).toBe(true)
    const w = secretWrites().find((x) => x.SecretId === KEYS_ARN)
    expect(JSON.parse(w?.SecretString ?? '{}')).toEqual({ NEXAR_CLIENT_ID: 'kept', MOUSER_API_KEY: MOUSER })
    expect(events.join('\n')).not.toContain(MOUSER)
    expect(events.join('\n')).toContain('distributor keys stored for the library gateway: MOUSER_API_KEY')
  })

  it('leaves the secret alone when no key is given', async () => {
    calls.secrets.length = 0
    OUTPUTS.TraceHome = join(mkdtempSync(join(tmpdir(), 'trace-central-')), 'home')
    const ok = await apply(AnswersSchema.parse(GW), SecretsSchema.parse({ githubToken: TOKEN }), () => undefined, {
      cdk: async () => 0, outputs: async () => ({ ...OUTPUTS, LibraryKeysSecretArn: KEYS_ARN }),
      readSecret: async () => { throw new Error('must not be read') },
    })
    expect(ok).toBe(true)
    expect(secretWrites().map((x) => x.SecretId)).not.toContain(KEYS_ARN)
  })
})

describe('the CodeBuild runners', () => {
  const quiet = { names: { deployed: async () => new Set<string>(), taken: async () => [] } }

  const URL = 'https://us-east-1.console.aws.amazon.com/codesuite/settings/connections?region=us-east-1'
  type Ev = { type: string; line?: string; summary?: string[]; step?: { id: string; status: string; detail: string } }
  const stepOf = (events: Ev[], id: string, status: string) => events.filter((e) => e.type === 'step' && e.step?.id === id && e.step.status === status).map((e) => e.step?.detail ?? '')
  /** a first install: no connection authorized, so the stack creates trace-github; `wait` stands in for the person */
  const pending = (order: string[], wait: () => Promise<void>) => ({
    resolve: async (o: { prefix: string; given?: string; deployed: Record<string, string> | null }) => {
      order.push(`resolve ${o.given ?? '-'} ${o.deployed ? 'deployed' : 'new'}`)
      return { name: 'trace-github', ready: false, message: 'No authorized GitHub connection in this account and region: the deploy creates trace-github, without the build runners, and you authorize it once after the deploy.' }
    },
    wait: async (conn: { arn: string; name: string; status: string }, o: { report: (l: string) => void; repos: readonly string[] }) => {
      order.push(`wait ${conn.arn} ${o.repos.join(',')}`)
      o.report(`The GitHub connection trace-github is waiting for a person to authorize it (once for this AWS account and region). Open ${URL}, …`)
      o.report('Waiting for trace-github to be authorized (status PENDING): checking again at 10:42:15.')
      await wait()
    },
  })
  /** the stack's outputs: before the runners exist, none of theirs */
  const withoutRunners = (): Record<string, string> => {
    const o: Record<string, string> = { ...OUTPUTS, GithubConnectionArn: CONNECTION, GithubConnectionCreated: 'true' }
    for (const repo of ['mteichtahl/board', 'mteichtahl/fw']) delete o[projectOutputs(repo).runnerProject]
    return o
  }

  it('takes the runner settings from the answers, and plans the connection after the deploy, then the runners', () => {
    const a = AnswersSchema.parse(ANSWERS)
    expect(a.runners).toEqual({ connectionArn: '', computeType: null, privileged: null })
    // nothing is needed up front: no connection ARN (the stack creates one), ready by default
    const props = InfraPropsSchema.parse(infraInput(a))
    expect(props.runners).toEqual({ connectionReady: true, computeType: 'BUILD_GENERAL1_LARGE', image: 'aws/codebuild/standard:7.0', privileged: false })
    const own = AnswersSchema.parse({ ...ANSWERS, runners: { connectionArn: CONNECTION, computeType: 'BUILD_GENERAL1_XLARGE', privileged: true } })
    expect(infraInput(own).runners).toEqual({ connectionArn: CONNECTION, computeType: 'BUILD_GENERAL1_XLARGE', privileged: true })
    // what apply chose wins: the connection to pass (none: the stack's own), and whether it is ready
    expect(infraInput(own, null, undefined, { connectionReady: false }).runners).toEqual({ connectionReady: false, computeType: 'BUILD_GENERAL1_XLARGE', privileged: true })
    expect(infraInput(a, null, undefined, { connectionArn: 'arn:found', connectionReady: true }).runners).toEqual({ connectionArn: 'arn:found', connectionReady: true })
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { connectionArn: 'not-an-arn' } }).success).toBe(false)
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { computeType: 'BUILD_GENERAL1_SMALL' } }).success).toBe(false)
    const steps = plan(a)
    const ids = steps.map((x) => x.id)
    expect(ids.indexOf('deploy')).toBeLessThan(ids.indexOf('connection'))
    expect(ids.indexOf('connection')).toBeLessThan(ids.indexOf('runners'))
    expect(ids.indexOf('runners')).toBeLessThan(ids.indexOf('repos'))
    const connection = steps.find((x) => x.id === 'connection')
    expect(connection?.title).toBe('Authorize the GitHub connection')
    expect(connection?.detail).toMatch(/only if the GitHub connection is not authorized yet.*once per AWS account and region.*https:\/\/us-east-1\.console\.aws\.amazon\.com\/codesuite\/settings\/connections\?region=us-east-1.*"Update pending connection".*AWS Connector for GitHub app.*mteichtahl\/board, mteichtahl\/fw/)
    expect(steps.find((x) => x.id === 'runners')?.title).toBe('Add the build runners')
    expect(steps.find((x) => x.id === 'runners')?.detail).toMatch(/only adds each repository's CodeBuild runner project and its GitHub webhook/)
    expect(steps.find((x) => x.id === 'deploy')?.detail).toMatch(/a GitHub connection already authorized in the account and region \(trace-github first\), else a new trace-github it creates/)
    expect(plan(own).find((x) => x.id === 'deploy')?.detail).toContain(`the GitHub connection ${CONNECTION}`)
    expect(steps.find((x) => x.id === 'deploy')?.detail).toMatch(/its own AWS CodeBuild runner project that runs every one of its GitHub Actions jobs \(BUILD_GENERAL1_LARGE; no job runs on GitHub's own runners\)/)
    expect(plan(own).find((x) => x.id === 'deploy')?.detail).toMatch(/BUILD_GENERAL1_XLARGE, Docker-in-Docker/)
    expect(steps.find((x) => x.id === 'repos')?.detail).toContain('TRACE_CODEBUILD_PROJECT (the CodeBuild runner project its workflows run on)')
    expect(JSON.stringify(steps)).not.toContain('TRACE_RUNNER')
  })

  it('on a first install deploys without the runners, waits for the person, deploys again with them, then sets the repositories', async () => {
    calls.variables.length = 0
    const order: string[] = []
    const infra: Record<string, unknown>[] = []
    const events: Ev[] = []
    let deployed = 0
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      ...quiet,
      connection: pending(order, async () => { order.push('authorized') }),
      cdk: async (args, env) => {
        order.push(args[0] ?? '')
        if (args[0] === 'deploy') { deployed++; infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')) }
        return 0
      },
      outputs: async () => { order.push('outputs'); return deployed < 2 ? withoutRunners() : OUTPUTS },
    })
    expect(ok).toBe(true)
    expect(order).toEqual(['resolve - new', 'bootstrap', 'deploy', 'outputs', `wait ${CONNECTION} mteichtahl/board,mteichtahl/fw`, 'authorized', 'deploy', 'outputs'])
    // no ARN either time (the stack's own connection), the runners only the second time
    expect(infra.map((x) => x.runners)).toEqual([{ connectionReady: false }, { connectionReady: true }])
    // the repositories after the runners exist, each with its own runner project
    expect(calls.values.get('mteichtahl/board:TRACE_CODEBUILD_PROJECT')).toBe(`trace-ci-${projectHash('mteichtahl/board')}`)
    // while it waits, the step itself says what to do and when the next check is
    expect(stepOf(events, 'connection', 'running').at(-1)).toMatch(/waiting for a person to authorize it.*checking again at 10:42:15/)
    expect(stepOf(events, 'connection', 'done')[0]).toBe(`trace-github is authorized (${CONNECTION})`)
    expect(stepOf(events, 'runners', 'running')[0]).toBe('deploying again: this only adds each repository\'s CodeBuild runner project and its GitHub webhook')
    expect(stepOf(events, 'runners', 'done')[0]).toBe('2 runner projects added')
    expect(stepOf(events, 'deploy', 'done')[0]).toMatch(/without the build runners until the GitHub connection is authorized/)
    expect(events.filter((e) => e.type === 'log').map((e) => e.line)).toContain('No authorized GitHub connection in this account and region: the deploy creates trace-github, without the build runners, and you authorize it once after the deploy.')
    // and the summary reminds them the app must reach every repository
    expect((events.at(-1)?.summary ?? []).join('\n')).toMatch(/AWS Connector for GitHub app must be allowed to reach every onboarded repository \(mteichtahl\/board, mteichtahl\/fw\)/)
  })

  it('deploys once, with the runners, when an authorized connection is reused, and says which', async () => {
    calls.connection.length = 0
    const order: string[] = []
    const infra: Record<string, unknown>[] = []
    const events: Ev[] = []
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      ...quiet,
      cdk: async (args, env) => { order.push(args[0] ?? ''); if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 },
      outputs: async () => OUTPUTS,
    })
    expect(ok).toBe(true)
    expect(order).toEqual(['bootstrap', 'deploy'])
    expect(calls.connection).toEqual([{ prefix: 'trace', deployed: null }])
    expect(infra.map((x) => x.runners)).toEqual([{ connectionArn: CONNECTION, connectionReady: true }])
    expect(stepOf(events, 'connection', 'skipped')[0]).toBe(`Using the GitHub connection trace-github (${CONNECTION}), already authorized.`)
    expect(stepOf(events, 'runners', 'skipped')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'log').map((e) => e.line)).toContain(`Using the GitHub connection trace-github (${CONNECTION}), already authorized.`)
  })

  it('stops before the second deploy when the connection is not authorized in time, and says re-running resumes', async () => {
    const order: string[] = []
    const events: Ev[] = []
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      ...quiet,
      connection: pending(order, async () => { throw new Error(`the GitHub connection trace-github was still not authorized after 30 minutes. Authorize it at ${URL} ("Update pending connection"), then run the installer again: it resumes from here with the same connection`) }),
      cdk: async (args) => { order.push(args[0] ?? ''); return 0 },
      outputs: async () => withoutRunners(),
    })
    expect(ok).toBe(false)
    expect(order.filter((x) => x === 'deploy')).toHaveLength(1)
    expect(stepOf(events, 'connection', 'failed')[0]).toMatch(/still not authorized after 30 minutes.*run the installer again: it resumes/)
    expect(events.at(-1)?.summary?.[0]).toMatch(/^Stopped at "Authorize the GitHub connection"/)
    // nor the repositories: they get their runner only once it exists
    expect(stepOf(events, 'repos', 'running')).toEqual([])
  })

  it('on a re-run reads the deployed stack for its connection, and uses the connection the answers give', async () => {
    calls.connection.length = 0
    calls.existing = { stack: 'TraceStack', status: 'UPDATE_COMPLETE', outputs: { Layout: 'nested', GithubConnectionArn: CONNECTION, GithubConnectionCreated: 'true' } }
    try {
      const given = 'arn:aws:codeconnections:us-east-1:123456789012:connection/99999999-8888-7777-6666-555555555555'
      const infra: Record<string, unknown>[] = []
      const ok = await apply(AnswersSchema.parse({ ...ANSWERS, runners: { connectionArn: given, privileged: true } }), SecretsSchema.parse({ githubToken: TOKEN }), () => undefined, {
        ...quiet, cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 }, outputs: async () => OUTPUTS,
      })
      expect(ok).toBe(true)
      expect(calls.connection).toEqual([{ prefix: 'trace', given, deployed: { Layout: 'nested', GithubConnectionArn: CONNECTION, GithubConnectionCreated: 'true' } }])
      expect(infra.map((x) => x.runners)).toEqual([{ connectionArn: given, connectionReady: true, privileged: true }])
    } finally {
      calls.existing = null
    }
  })

  it("sets each repository's TRACE_CODEBUILD_PROJECT to its own project's runner output, and no TRACE_RUNNER", async () => {
    calls.values.clear()
    expect(await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), () => undefined, { ...quiet, cdk: async () => 0, outputs: async () => OUTPUTS })).toBe(true)
    for (const repo of ['mteichtahl/board', 'mteichtahl/fw']) expect(calls.values.get(`${repo}:TRACE_CODEBUILD_PROJECT`)).toBe(`trace-ci-${projectHash(repo)}`)
    expect(calls.values.get('mteichtahl/board:TRACE_CODEBUILD_PROJECT')).not.toBe(calls.values.get('mteichtahl/fw:TRACE_CODEBUILD_PROJECT'))
    expect([...calls.values.keys()].filter((k) => k.endsWith(':TRACE_RUNNER'))).toEqual([])
    // a stack without the output (a runner project missing) stops at the repositories, naming it
    const without = { ...OUTPUTS }
    delete without[projectOutputs('mteichtahl/fw').runnerProject]
    const events: { type: string; summary?: string[] }[] = []
    expect(await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), { ...quiet, cdk: async () => 0, outputs: async () => without })).toBe(false)
    expect(events.at(-1)?.summary?.[0]).toBe(`Stopped at "Configure the repositories": the stack has no output ${projectOutputs('mteichtahl/fw').runnerProject}`)
  })
})

describe('the sample project', () => {
  const quiet = { names: { deployed: async () => new Set<string>(), taken: async () => [] } }
  const SAMPLE = 'trace-agent/trace-sample'
  type Ev = { type: string; line?: string; summary?: string[]; step?: { id: string; status: string; detail: string } }
  const withSampleOutputs = (): Record<string, string> => {
    const o = { ...OUTPUTS }
    const p = projectOutputs(SAMPLE)
    o[p.runtimeArn] = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_sample-abc'
    o[p.roleArn] = 'arn:aws:iam::123456789012:role/trace-gh-sample-us-east-1'
    o[p.secretArn] = `arn:aws:secretsmanager:us-east-1:123456789012:secret:trace/github-token/${SAMPLE}`
    o[p.memoryId] = 'trace_m_sample-abcdefghij'
    o[p.runnerProject] = `trace-ci-${projectHash(SAMPLE)}`
    return o
  }

  it('is off by default, needs no other repository when on, and is named after the token\'s account', async () => {
    const { sampleRepo, withSample } = await import('../../src/installer/sample.js')
    expect(AnswersSchema.parse(ANSWERS).sample).toEqual({ enabled: false, repo: '', private: true, tour: true })
    const none = { ...ANSWERS, projects: [], people: [] }
    expect(AnswersSchema.safeParse(none).success).toBe(false)
    const only = AnswersSchema.parse({ ...none, github: { login: 'trace-agent' }, sample: { enabled: true } })
    expect(sampleRepo(only)).toBe(SAMPLE)
    expect(withSample(only).projects).toEqual([{ repo: SAMPLE, branch: 'main', onboard: true, applySettings: true, memoryEventExpiryDays: null, generation: 0 }])
    // without the token's account and with no name it cannot be placed
    expect(AnswersSchema.safeParse({ ...none, sample: { enabled: true } }).success).toBe(false)
    expect(sampleRepo(AnswersSchema.parse({ ...none, sample: { enabled: true, repo: 'acme/demo' } }))).toBe('acme/demo')
    // people may be assigned to it; listed again from an earlier run it is not doubled
    expect(AnswersSchema.safeParse({ ...only, people: [{ email: 'dev@example.com', projects: [SAMPLE] }] }).success).toBe(true)
    const again = AnswersSchema.parse({ ...only, projects: [{ repo: SAMPLE, branch: 'trunk' }] })
    expect(withSample(again).projects.map((p) => `${p.repo}@${p.branch}`)).toEqual([`${SAMPLE}@trunk`])
    expect(AnswersSchema.safeParse({ ...ANSWERS, sample: { enabled: true, repo: 'not a repo' } }).success).toBe(false)
  })

  it('plans the sample before the deploy and its tour last, and deploys it as a project', () => {
    const a = AnswersSchema.parse({ ...ANSWERS, github: { login: 'trace-agent' }, sample: { enabled: true } })
    const steps = plan(a)
    const ids = steps.map((x) => x.id)
    expect(ids[1]).toBe('sample')
    expect(ids.at(-1)).toBe('tour')
    expect(steps.find((x) => x.id === 'sample')?.detail).toMatch(/trace-agent\/trace-sample \(private; created if it does not exist.*every agent and every simulation/)
    expect(steps.find((x) => x.id === 'onboard')?.detail).toMatch(/open the onboarding PR in mteichtahl\/board; put trace-agent\/trace-sample under trace straight away/)
    expect(steps.find((x) => x.id === 'tour')?.detail).toMatch(/open \d+ tasks in trace-agent\/trace-sample, each labelled for the agent that takes it/)
    expect(InfraPropsSchema.parse(infraInput(a)).repositories).not.toContain(`${SAMPLE}@main`)
    expect(plan(AnswersSchema.parse({ ...ANSWERS, github: { login: 'x' }, sample: { enabled: true, tour: false } })).map((x) => x.id)).not.toContain('tour')
    expect(plan(AnswersSchema.parse(ANSWERS)).map((x) => x.id)).not.toContain('sample')
  })

  it('creates and fills the repository before the deploy, onboards it straight onto its branch, and starts the tour last', async () => {
    calls.onboard.length = 0
    calls.variables.length = 0
    const order: string[] = []
    const infra: Record<string, unknown>[] = []
    const events: Ev[] = []
    const a = AnswersSchema.parse({ ...ANSWERS, github: { login: 'trace-agent' }, sample: { enabled: true }, people: [{ email: 'dev@example.com', projects: [SAMPLE] }] })
    const ok = await apply(a, SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      ...quiet,
      cdk: async (args, env) => { order.push(args[0] ?? ''); if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 },
      outputs: async () => withSampleOutputs(),
      sample: {
        ensure: async (token, repo, o) => { order.push(`ensure ${repo} ${o.private ? 'private' : 'public'}`); expect(token).toBe(TOKEN); return { created: true, defaultBranch: 'trunk', url: `https://github.com/${repo}` } },
        push: async (_t, repo, branch) => { order.push(`push ${repo}@${branch}`); return 'abcdef1234' },
        onboard: async (_t, repo, branch) => { order.push(`onboard ${repo}@${branch}`); return { url: `https://github.com/${repo}`, commit: '1234567abc', settings: ['created the labels'] } },
        tour: async (_t, repo, o) => { order.push(`tour ${repo} gpu=${o.gpu}`); return { url: `https://github.com/${repo}/issues`, opened: 12, existing: 0, skipped: [], lines: [] } },
      },
    })
    expect(ok).toBe(true)
    expect(order).toEqual(['ensure trace-agent/trace-sample private', 'push trace-agent/trace-sample@trunk', 'bootstrap', 'deploy', 'onboard trace-agent/trace-sample@trunk', 'tour trace-agent/trace-sample gpu=true'])
    // deployed with its actual default branch, configured like any project, and not given the held onboarding PR
    expect(infra[0]?.repositories).toContain(`${SAMPLE}@trunk`)
    expect(calls.variables).toContain(`${SAMPLE}:TRACE_AGENT_RUNTIME_ARN`)
    expect(calls.variables).toContain(`${SAMPLE}:TRACE_CODEBUILD_PROJECT`)
    expect(calls.onboard).toEqual(['mteichtahl/board'])
    const done = events.at(-1)
    expect(done?.summary?.join('\n')).toMatch(/sample's tour has started: every agent and every simulation has a task in https:\/\/github.com\/trace-agent\/trace-sample\/issues/)
    expect(events.find((e) => e.type === 'step' && e.step?.id === 'tour' && e.step.status === 'done')?.step?.detail).toMatch(/^12 tasks opened/)
  })

  it('leaves GPU and CPU tasks out of the tour when GPU jobs are off, and stops before the deploy when the repository cannot be made', async () => {
    const order: string[] = []
    const events: Ev[] = []
    const a = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, gpuEnabled: false }, github: { login: 'trace-agent' }, sample: { enabled: true } })
    const fake = {
      ensure: async () => { throw new Error('could not create trace-agent/trace-sample: the token cannot create repositories in its account') },
      push: async () => null, onboard: async () => ({ url: '', commit: null, settings: [] }), tour: async () => ({ url: '', opened: 0, existing: 0, skipped: [], lines: [] }),
    }
    const ok = await apply(a, SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), { ...quiet, sample: fake, cdk: async (args) => { order.push(args[0] ?? ''); return 0 }, outputs: async () => withSampleOutputs() })
    expect(ok).toBe(false)
    expect(order).toEqual([])
    expect(events.at(-1)?.summary?.[0]).toMatch(/Stopped at "Create the sample project": could not create/)
    expect(plan(a).find((x) => x.id === 'tour')?.detail).toMatch(/left out because GPU jobs are off/)
  })
})

describe('the sample\'s GitHub calls', () => {
  it('creates the repository in the token\'s account when it does not exist, and commits files in one commit', async () => {
    const { ensureRepo, commitFiles } = await vi.importActual<typeof import('../../src/installer/github.js')>('../../src/installer/github.js')
    const seen: string[] = []
    const bodies: unknown[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      const m = init?.method ?? 'GET'
      seen.push(`${m} ${url.replace('https://api.github.com', '')}`)
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
      if (m === 'GET' && url.endsWith('/repos/marc/trace-sample')) return json({ message: 'Not Found' }, 404)
      if (url.endsWith('/user')) return json({ login: 'marc', type: 'User' })
      if (m === 'POST' && url.endsWith('/user/repos')) return json({ full_name: 'marc/trace-sample', private: true, default_branch: 'main', html_url: 'https://github.com/marc/trace-sample' }, 201)
      if (url.includes('/git/ref/heads/main')) return json({ object: { sha: 'p1' } })
      if (url.includes('/git/commits/p1')) return json({ sha: 'p1', tree: { sha: 't0' } })
      if (url.endsWith('/git/blobs')) return json({ sha: `b${bodies.length}` }, 201)
      if (url.endsWith('/git/trees')) return json({ sha: 't1' }, 201)
      if (url.endsWith('/git/commits')) return json({ sha: 'c1' }, 201)
      if (m === 'PATCH') return json({ object: { sha: 'c1' } })
      return json({ message: 'unexpected' }, 500)
    }) as typeof fetch
    expect(await ensureRepo('t', 'marc/trace-sample', { private: true }, fake)).toEqual({ created: true, defaultBranch: 'main', url: 'https://github.com/marc/trace-sample', private: true })
    expect(bodies[0]).toEqual({ name: 'trace-sample', private: true, auto_init: true })
    expect(await commitFiles('t', 'marc/trace-sample', 'main', [{ path: 'a.txt', content: 'hi' }, { path: 'run.sh', content: 'x', executable: true }], 'msg', fake)).toBe('c1')
    expect(seen.filter((x) => x.includes('/git/'))).toEqual([
      'GET /repos/marc/trace-sample/git/ref/heads/main', 'GET /repos/marc/trace-sample/git/commits/p1',
      'POST /repos/marc/trace-sample/git/blobs', 'POST /repos/marc/trace-sample/git/blobs', 'POST /repos/marc/trace-sample/git/trees',
      'POST /repos/marc/trace-sample/git/commits', 'PATCH /repos/marc/trace-sample/git/refs/heads/main',
    ])
    const tree = bodies.find((b) => (b as { base_tree?: string }).base_tree) as { tree: { path: string; mode: string }[] }
    expect(tree.tree.map((e) => `${e.path} ${e.mode}`)).toEqual(['a.txt 100644', 'run.sh 100755'])
  })

  it('says how to fix a token that may not create repositories', async () => {
    const { ensureRepo } = await vi.importActual<typeof import('../../src/installer/github.js')>('../../src/installer/github.js')
    const fake = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/repos/')) return new Response('{"message":"Not Found"}', { status: 404 })
      if (url.endsWith('/user')) return new Response('{"login":"marc","type":"User"}', { status: 200 })
      return new Response('{"message":"Resource not accessible by personal access token"}', { status: 403 })
    }) as typeof fetch
    await expect(ensureRepo('t', 'acme/trace-sample', {}, fake)).rejects.toThrow(/cannot create repositories in acme.*Administration: read and write.*Create acme\/trace-sample yourself/)
  })
})
