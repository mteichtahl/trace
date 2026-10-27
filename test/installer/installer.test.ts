import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sodium from 'libsodium-wrappers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.TRACE_CLIENT_DB = join(mkdtempSync(join(tmpdir(), 'trace-client-')), 'client.db')
// the repository this trace came from, whatever the checkout's remote (src/installer/source.ts reads it first)
process.env.TRACE_SOURCE = 'mteichtahl/trace'

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
  /** CodeBuild's GitHub source credential: what it was asked (token prefix:ours) */
  credential: [] as string[],
  /** GitHub's OIDC provider in the account, and whether it is the stack's own */
  oidc: { provider: false, inStack: false },
  /** what the default connection resolver (no hook) was asked */
  connection: [] as { prefix: string; given?: string; deployed: Record<string, string> | null }[],
  /** repository variables the installer removed (repo:NAME), and which ones existed to remove */
  deleted: [] as string[], existingVars: new Set<string>(),
  /** what was written to S3 (the installation record): bucket, key and text */
  s3: [] as { Bucket: string; Key: string; Body: string }[],
}))
vi.mock('@aws-sdk/client-s3', async (orig) => ({
  ...(await orig<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class { async send(c: { input: { Bucket: string; Key: string; Body: string } }) { calls.s3.push(c.input); return {} } },
}))

vi.mock('../../src/installer/aws.js', async (orig) => { const real = await orig<typeof import('../../src/installer/aws.js')>(); return {
  credentials: async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key-value-1234' }),
  awsEnv: (_c: unknown, region: string) => ({ AWS_REGION: region }),
  checkAws: async () => ({ account: '123456789012', arn: 'arn:aws:iam::123456789012:user/marc', region: 'us-east-1', agentCore: { ok: true, reason: '' }, models: [], oidcProvider: calls.oidc.provider, oidcInStack: calls.oidc.inStack, cdkBootstrapped: false, existing: calls.existing, warnings: [] }),
  stackOutputs: async () => ({}),
  freeSecretNames: async (_c: unknown, _r: string, names: readonly string[]) => { calls.freed.push(...names); return names.map((n) => `${n}: free`) },
  profiles: async () => ({ names: ['default'], regions: { default: 'us-east-1' } }),
  cfnClient: () => ({}),
  codebuildClient: () => ({}),
  nameClients: () => ({}),
  deployedProjects: async () => calls.deployed,
  nameIndex: () => ({ taken: async (n: { memories: string[]; deliveries: string[]; secrets: string[] }) => [...n.memories, ...n.deliveries, ...n.secrets].filter((x) => calls.taken.has(x)) }),
  ensureGpuImage: async () => ({ ok: true, detail: 'the GPU image is built' }),
  liveFacts: async () => ({ account: '123456789012' }),
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
  chooseRunnerAuth: real.chooseRunnerAuth,
  ensureSourceCredential: async (_cb: unknown, token: string, ours: boolean) => { calls.credential.push(`${token.slice(0, 6)}:${ours}`); return { state: 'imported', detail: 'the token imported as CodeBuild\'s GitHub source credential' } },
} })
vi.mock('../../src/installer/onboard-api.js', async (orig) => ({
  ...(await orig<typeof import('../../src/installer/onboard-api.js')>()),
  onboardViaApi: async (repo: string) => { calls.onboard.push(repo); return { repo, state: 'opened', pr: `https://github.com/${repo}/pull/1`, settings: [], notes: [] } },
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
  createRepo: async (_t: string, slug: string) => ({ fullName: slug, defaultBranch: 'main', created: true }),
  deleteVariable: async (_t: string, repo: string, name: string) => { calls.deleted.push(`${repo}:${name}`); return calls.existingVars.has(`${repo}:${name}`) },
  // the token can configure every repository unless a test says otherwise (only reached without a `self` hook)
  canConfigure: async () => ({ ok: true, reason: '' }),
  repositoryDefaultBranch: async () => 'main',
  checkToken: async (token: string) => {
    const t = calls.tokens.get(token) ?? { login: 'trace-agent', repos: [] }
    return { login: t.login, name: null, kind: 'fine-grained', scopes: [], repos: t.repos.map((fullName) => ({ fullName, private: true, admin: false, push: true, defaultBranch: 'main' })), warnings: [] }
  },
}))

const { AnswersSchema, SecretsSchema } = await import('../../src/installer/answers.js')
const { GITHUB_RUNNERS_NOTE, apply, buildRepositories, earlierRepositories, infraInput, layoutDeploys, layoutOf, mergeLibraryKeys, plan, redact, resolveSelfBuild } = await import('../../src/installer/bootstrap.js')
const { InfraPropsSchema } = await import('../../src/infra/props.js')
const { ciRunnerOutput, projectOutputs, projectHash } = await import('../../src/infra/props.js')
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
const CERT = 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000'

const OUTPUTS: Record<string, string> = {
  TraceHome: '', GithubSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:trace/github-token',
  ApiRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_api-abc',
  UserPoolId: 'us-east-1_abc', UserPoolClientId: 'client123', CognitoDomain: 'https://trace-123456789012.auth.us-east-1.amazoncognito.com',
  WebUrl: 'https://d111111abcdef8.cloudfront.net', WebDistributionId: 'E1ABCDEF', WebClientId: 'web123',
  CentralBucket: 'trace-central-bucket', SelfUpdateRoleArn: 'arn:aws:iam::123456789012:role/trace-self-update',
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
// trace's own repository, built on AWS too by default: its runner project is a parent output
OUTPUTS[ciRunnerOutput('mteichtahl/trace')] = `trace-ci-${projectHash('mteichtahl/trace')}`
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
    expect(steps.map((s) => s.id)).toEqual(['check', 'cdk', 'github', 'deploy', 'connection', 'runners', 'token', 'integrations', 'repos', 'onboard', 'people', 'web', 'local', 'release', 'gpu'])
    expect(steps.find((s) => s.id === 'repos')?.detail).toContain('mteichtahl/fw')
    expect(steps.find((s) => s.id === 'deploy')?.detail).toMatch(/for each of the 2 repositories its own AgentCore worker runtime/)
  })

  it('installs the web app by default, keeping the install at two inputs, with an optional custom domain and email codes', () => {
    const a = AnswersSchema.parse(ANSWERS)
    expect(infraInput(a).web).toEqual({ enabled: true })
    expect(plan(a).find((s) => s.id === 'web')).toMatchObject({ title: 'Web app: the address people sign in at' })
    expect(plan(a).find((s) => s.id === 'deploy')?.detail).toMatch(/the web app at CloudFront's own address/)
    const custom = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, webDomain: 'trace.example.com', webCertificateArn: CERT, webEmailFrom: 'trace@example.com' } })
    expect(infraInput(custom).web).toEqual({ enabled: true, domainName: 'trace.example.com', certificateArn: CERT, sesFrom: 'trace@example.com' })
    expect(plan(custom).find((s) => s.id === 'web')?.detail).toContain('https://trace.example.com')
    expect(plan(custom).find((s) => s.id === 'deploy')?.detail).toMatch(/a code by email \(from trace@example.com, through SES\)/)
    expect(AnswersSchema.safeParse({ ...ANSWERS, agents: { ...ANSWERS.agents, webDomain: 'trace.example.com' } }).success).toBe(false)
    const off = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, webEnabled: false } })
    expect(infraInput(off).web).toEqual({ enabled: false })
    expect(plan(off).map((s) => s.id)).not.toContain('web')
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
    // a variable is removed; one that is not there is no error
    const { deleteVariable } = await vi.importActual<typeof import('../../src/installer/github.js')>('../../src/installer/github.js')
    const del = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`)
      return url.endsWith('/GONE') ? new Response('{"message":"Not Found"}', { status: 404 }) : new Response(null, { status: 204 })
    }) as typeof fetch
    expect(await deleteVariable('t', 'o/r', 'TRACE_CODEBUILD_PROJECT', del)).toBe(true)
    expect(seen.at(-1)).toBe('DELETE https://api.github.com/repos/o/r/actions/variables/TRACE_CODEBUILD_PROJECT')
    expect(await deleteVariable('t', 'o/r', 'GONE', del)).toBe(false)
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
    expect(await projectsFor(visitor)).toEqual([{ repo: 'mteichtahl/fw', role: 'read', part: 'reviewer' }])
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
    // no account yet (the checks have not passed): a plain answer, not a schema error
    const early = await call('/api/plan', { method: 'POST', key, body: '{"answers":{}}' })
    expect(early.status).toBe(409)
    expect(JSON.parse(early.body).error).toMatch(/checks have to pass first/)
    expect((await call('/api/plan', { method: 'POST', key, body: '{"answers":[]}' })).status).toBe(400)
    expect((await call('/api/plan', { method: 'POST', key, body: 'x', type: 'text/plain' })).status).toBe(415)
    const planned = await call('/api/plan', { method: 'POST', key, body: JSON.stringify({ answers: ANSWERS }) })
    expect(JSON.parse(planned.body).steps).toHaveLength(15)
    expect(JSON.parse(planned.body).timeline.join(' ')).toMatch(/about 15 minutes of CloudFormation/)
  })

  it('streams what each check is doing, then the result, when the page asks for progress', async () => {
    const i = createInstaller({
      uiScript: '', traceRepository: () => null,
      preflight: async (_in, t, onProgress) => {
        if (t.startsWith('bad')) throw new Error('GitHub refused the token')
        onProgress?.({ id: 'sts', label: 'Confirming which AWS account the credentials belong to', state: 'running' })
        onProgress?.({ id: 'sts', label: 'Confirming which AWS account the credentials belong to', state: 'done' })
        return { checks: [], facts: { account: '123456789012' }, token: null, repos: [], ok: true }
      },
    })
    await new Promise<void>((r) => i.server.listen(0, '127.0.0.1', () => r()))
    const port = (i.server.address() as AddressInfo).port
    const post = (body: unknown): Promise<string> => new Promise((resolveP, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/preflight', method: 'POST', headers: { host: `localhost:${port}`, 'x-trace-key': i.key, 'content-type': 'application/json', accept: 'application/x-ndjson' } },
        (res) => { let b = ''; res.on('data', (d: Buffer) => { b += d.toString() }); res.on('end', () => resolveP(b)) })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
    try {
      const lines = (await post({ aws: { mode: 'keys' }, secrets: { awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'x' }, token: TOKEN })).trim().split('\n').map((l) => JSON.parse(l) as { type: string; id?: string; state?: string; result?: { facts: { account: string } } })
      expect(lines.filter((l) => l.type === 'progress').map((l) => `${l.id}:${l.state}`)).toEqual(['credentials:running', 'credentials:done', 'sts:running', 'sts:done'])
      expect(lines.at(-1)?.result?.facts.account).toBe('123456789012')
      // a check that can't run at all: said in plain words, as the stream's last line
      const bad = (await post({ aws: { mode: 'keys' }, secrets: { awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'x' }, token: `bad${TOKEN}` })).trim().split('\n').map((l) => JSON.parse(l) as { type: string; error?: string })
      expect(bad.at(-1)).toMatchObject({ type: 'error' })
      expect(bad.at(-1)?.error).toBe('GitHub refused the token')
    } finally {
      i.server.close()
    }
  })

  it("says on the GitHub check which repository trace came from and whether the token can configure it", async () => {
    const r = await call('/api/github/check', { key, method: 'POST', body: JSON.stringify({ token: TOKEN, repos: ['mteichtahl/board'] }) })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).self).toEqual({ repo: 'mteichtahl/trace', ok: true, reason: '' })
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
    // the web app's address: its step, the page's Open trace (ready and done), and the summary
    expect(r.events.find((e) => e.type === 'step' && e.step?.id === 'web' && e.step.status === 'done')?.step?.detail).toBe('https://d111111abcdef8.cloudfront.net')
    for (const kind of ['ready', 'done']) expect((r.events.find((e) => e.type === kind) as { url?: string } | undefined)?.url).toBe('https://d111111abcdef8.cloudfront.net')
    expect(r.events.at(-1)?.summary?.[0]).toMatch(/Open trace: https:\/\/d111111abcdef8\.cloudfront\.net$/)
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

  it('stores the keys given as the installation\'s integration (<prefix>/integrations/<name>), checked, never shown', async () => {
    calls.secrets.length = 0
    OUTPUTS.TraceHome = join(mkdtempSync(join(tmpdir(), 'trace-central-')), 'home')
    const events: string[] = []
    const stored: { name: string; values: Record<string, unknown> }[] = []
    const ok = await apply(AnswersSchema.parse(GW), SecretsSchema.parse({ githubToken: TOKEN, libraryKeys: { MOUSER_API_KEY: MOUSER } }), (e) => events.push(JSON.stringify(e)), {
      cdk: async (args, env) => { if (args[0] === 'deploy') expect(JSON.parse(env.TRACE_INFRA ?? '{}').gateway).toEqual({ enabled: true }); expect(env.TRACE_INFRA).not.toContain(MOUSER); return 0 },
      outputs: async () => ({ ...OUTPUTS, LibraryKeysSecretArn: KEYS_ARN }),
      integrations: { set: async (name, values) => { stored.push({ name, values }); return `trace/integrations/${name}` } },
      checkIntegration: async () => ({ ok: true, detail: 'Mouser accepted the key' }),
    })
    expect(ok).toBe(true)
    expect(stored).toEqual([{ name: 'mouser', values: { MOUSER_API_KEY: MOUSER } }])
    expect(secretWrites().map((x) => x.SecretId)).not.toContain(KEYS_ARN)
    expect(events.join('\n')).not.toContain(MOUSER)
    expect(events.join('\n')).toContain('mouser: stored in trace/integrations/mouser')
  })

  it('stores nothing, and says how to add one later, when no key is given', async () => {
    calls.secrets.length = 0
    OUTPUTS.TraceHome = join(mkdtempSync(join(tmpdir(), 'trace-central-')), 'home')
    const events: { type: string; summary?: string[]; step?: { id: string; status: string; detail: string } }[] = []
    const ok = await apply(AnswersSchema.parse(GW), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      cdk: async () => 0, outputs: async () => ({ ...OUTPUTS, LibraryKeysSecretArn: KEYS_ARN }),
      integrations: { set: async () => { throw new Error('must not be stored') } },
    })
    expect(ok).toBe(true)
    expect(secretWrites().map((x) => x.SecretId)).not.toContain(KEYS_ARN)
    expect(events.find((e) => e.step?.id === 'integrations' && e.step.status === 'skipped')?.step?.detail).toMatch(/tracectl integrations set <name>/)
    expect(events.at(-1)?.summary?.join(' ')).toMatch(/tracectl integrations set nexar/)
  })
})

describe('the light install', () => {
  const quiet = { names: { deployed: async () => new Set<string>(), taken: async () => [] } }
  const run = async (a: unknown, s: Record<string, unknown> = {}, hooks: Parameters<typeof apply>[3] = {}): Promise<{ ok: boolean; events: { type: string; line?: string; summary?: string[]; step?: { id: string; status: string; detail: string } }[] }> => {
    OUTPUTS.TraceHome = join(mkdtempSync(join(tmpdir(), 'trace-central-')), 'home')
    const events: { type: string; line?: string; summary?: string[]; step?: { id: string; status: string; detail: string } }[] = []
    const ok = await apply(AnswersSchema.parse(a), SecretsSchema.parse({ githubToken: TOKEN, ...s }), (e) => events.push(e as never), { cdk: async () => 0, outputs: async () => OUTPUTS, ...quiet, ...hooks })
    return { ok, events }
  }

  it('installs from the credentials and a token alone: account, email and model derived, no repositories needed', async () => {
    const infra: Record<string, unknown>[] = []
    const r = await run({}, {}, {
      facts: async () => ({ account: '123456789012', login: 'marc', email: 'marc@example.com', models: [{ id: 'us.anthropic.claude-sonnet-4-6', name: 'S' }], gpuQuota: 0 }),
      cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 },
      // no trace repository found either: nothing at all to build
      self: { source: () => null, canConfigure: async () => ({ ok: true, reason: '' }) },
    })
    expect(r.ok).toBe(true)
    expect(infra[0]).toMatchObject({ account: '123456789012', region: 'us-east-1', adminEmail: 'marc@example.com', model: 'us.anthropic.claude-sonnet-4-6', repositories: [], gpu: { enabled: false } })
    expect(r.events.filter((e) => e.type === 'log' && e.line?.startsWith('derived:')).map((e) => e.line)).toEqual(expect.arrayContaining(['derived: account 123456789012 (the credentials\')', 'derived: first administrator marc@example.com (the token\'s primary email)']))
    expect(r.events.find((e) => e.step?.id === 'repos' && e.step.status === 'skipped')).toBeDefined()
    expect(r.events.at(-1)?.summary?.join(' ')).toMatch(/No repositories yet: run `tracectl install` again/)
    // the decision from the quota is not saved as an answer: the next run decides again
    expect(AnswersSchema.parse(savedAnswers().answers).agents.gpuEnabled).toBeNull()
    // and without an email visible to the token, it stops before anything is created and says what to give
    const cdk: string[][] = []
    const stopped = await run({}, {}, { facts: async () => ({ account: '123456789012', login: 'marc', email: null }), cdk: async (a) => { cdk.push(a); return 0 } })
    expect(stopped.ok).toBe(false)
    expect(cdk).toEqual([])
    expect(stopped.events.at(-1)?.summary?.join(' ')).toMatch(/first administrator's email/)
  })

  it('with no authorized GitHub connection, imports the token as CodeBuild\'s source credential first and deploys once, with the runners', async () => {
    calls.values.clear()
    calls.credential.length = 0
    const order: string[] = []
    const infra: Record<string, unknown>[] = []
    const none = {
      resolve: async () => { order.push('resolve'); return { name: 'trace-github', ready: false, message: 'No authorized GitHub connection in this account and region: …' } },
      wait: async () => { throw new Error('must not wait') },
    }
    const r = await run(ANSWERS, {}, {
      connection: none,
      sourceCredential: async (token, ours) => { order.push(`credential ${token.slice(0, 6)} ${ours}`); return { state: 'imported', detail: 'the token imported as CodeBuild\'s GitHub source credential' } },
      cdk: async (args, env) => { order.push(args[0] ?? ''); if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 },
    })
    expect(r.ok).toBe(true)
    // the credential before the deploy that makes the runners' webhooks with it, and one deploy
    expect(order).toEqual(['resolve', 'bootstrap', `credential ${TOKEN.slice(0, 6)} false`, 'deploy'])
    expect(infra.map((x) => x.runners)).toEqual([{ auth: 'token' }])
    expect(InfraPropsSchema.parse(infra[0]).runners).toMatchObject({ auth: 'token', connectionReady: true })
    expect(calls.values.get('mteichtahl/board:TRACE_CODEBUILD_PROJECT')).toBe(`trace-ci-${projectHash('mteichtahl/board')}`)
    const step = (id: string, status: string) => r.events.find((e) => e.step?.id === id && e.step.status === status)?.step?.detail
    expect(step('github', 'done')).toMatch(/GitHub token, as its GitHub source credential: the runners come with the first deploy, with no console step/)
    expect(step('connection', 'skipped')).toMatch(/with the token: no connection to authorize/)
    expect(step('runners', 'skipped')).toBe('added with the deploy')
    // no connection, so no word about the connector app
    expect(r.events.at(-1)?.summary?.join('\n')).not.toMatch(/AWS Connector for GitHub/)
  })

  it('uses the token whatever connection there is when told to, refreshes a credential trace imported, and leaves another alone', async () => {
    calls.credential.length = 0
    calls.connection.length = 0
    const infra: Record<string, unknown>[] = []
    const cdk = async (args: string[], env: Record<string, string>): Promise<number> => { if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 }
    const r = await run({ ...ANSWERS, runners: { auth: 'token', token: 'admin' } }, { githubAdminToken: 'ghp_admin_token_value_123456' }, { cdk })
    expect(r.ok).toBe(true)
    expect(calls.connection).toEqual([])
    // the admin token, as Advanced chose
    expect(calls.credential).toEqual([expect.stringMatching(/^ghp_ad:/)])
    expect(infra.at(-1)?.runners).toEqual({ auth: 'token' })
    expect(savedAnswers().runnerCredential).toBe('imported')
    // the next run refreshes the one it imported
    await run({ ...ANSWERS, runners: { auth: 'token' } }, {}, { cdk })
    expect(calls.credential.at(-1)).toBe(`${TOKEN.slice(0, 6)}:true`)
    // a connection named in the answers is refused with the token
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { auth: 'token', connectionArn: CONNECTION } }).success).toBe(false)
    expect(() => InfraPropsSchema.parse({ ...InfraPropsSchema.parse(infraInput(AnswersSchema.parse(ANSWERS))), runners: { auth: 'token', connectionArn: CONNECTION } })).toThrow(/auth 'connection'/)
  })

  it('creates a new project\'s repository before the deploy (its runner\'s webhook needs it), then scaffolds it', async () => {
    calls.onboard.length = 0
    const created: string[] = []
    const o = projectOutputs('mteichtahl/new-board')
    const r = await run({ ...ANSWERS, projects: [{ repo: 'mteichtahl/new-board', create: { template: 'kicad' } }], people: [] }, {}, {
      outputs: async () => ({ ...OUTPUTS, [o.runtimeArn]: 'arn:rt/new', [o.roleArn]: 'arn:role/new', [o.secretArn]: 'arn:secret/new', [o.memoryId]: 'm-new', [o.runnerProject]: 'trace-ci-new' }),
      createRepo: async (_t, slug) => { created.push(slug); return { fullName: slug, defaultBranch: 'main', created: true } },
      cdk: async (args) => { if (args[0] === 'deploy') created.push('deploy'); return 0 },
    })
    expect(r.ok).toBe(true)
    expect(created).toEqual(['mteichtahl/new-board', 'deploy'])
    expect(calls.onboard).toEqual(['mteichtahl/new-board'])
  })

  it('says trace is ready before it waits for the GPU image, and reports incomplete integration keys', async () => {
    const order: string[] = []
    const r = await run({ ...ANSWERS, agents: { ...ANSWERS.agents, gpuEnabled: true } }, { integrations: { nexar: { NEXAR_CLIENT_ID: 'only-the-id' } } }, {
      outputs: async () => ({ ...OUTPUTS, GpuImageBuild: 'trace-gpu-image:1', GpuImageUri: 'x/trace-gpu:abc' }),
      gpuImage: async () => { order.push('gpu'); return { ok: true, detail: 'built' } },
    })
    expect(r.ok).toBe(true)
    expect(order).toEqual(['gpu'])
    expect(r.events.findIndex((e) => e.type === 'ready')).toBeLessThan(r.events.findIndex((e) => e.step?.id === 'gpu' && e.step.status === 'running'))
    expect(r.events.at(-1)?.summary?.join('\n')).toMatch(/Nexar \(Octopart\): NEXAR_CLIENT_SECRET missing, so it was not stored/)
  })

  it('keeps GitHub\'s OIDC provider in the stack that made it, and uses one made elsewhere', async () => {
    const want = async (oidc: { provider: boolean; inStack: boolean }): Promise<boolean> => {
      calls.oidc = oidc
      let made = false
      await run(ANSWERS, {}, { cdk: async (args, env) => { if (args[0] === 'deploy') made = JSON.parse(env.TRACE_INFRA ?? '{}').createOidcProvider; return 0 } })
      return made
    }
    try {
      expect(await want({ provider: false, inStack: false })).toBe(true)
      expect(await want({ provider: true, inStack: false })).toBe(false)
      // the provider exists because the stack made it: dropping it from the stack would delete it
      expect(await want({ provider: true, inStack: true })).toBe(true)
    } finally {
      calls.oidc = { provider: false, inStack: false }
    }
  })

  it('sets several repositories up at once, a few at a time', async () => {
    const repos = Array.from({ length: 10 }, (_, i) => `mteichtahl/r${i}`)
    let open = 0
    let most = 0
    const outputs: Record<string, string> = { ...OUTPUTS }
    for (const repo of repos) {
      const o = projectOutputs(repo)
      Object.assign(outputs, { [o.runtimeArn]: `arn:rt/${repo}`, [o.roleArn]: `arn:role/${repo}`, [o.secretArn]: `arn:secret/${repo}`, [o.memoryId]: `m-${repo}`, [o.runnerProject]: `trace-ci-${projectHash(repo)}` })
    }
    const r = await run({ ...ANSWERS, projects: repos.map((repo) => ({ repo, onboard: true })), people: [] }, {}, {
      outputs: async () => outputs,
      onboard: async (repo) => { open++; most = Math.max(most, open); await new Promise((x) => setTimeout(x, 5)); open--; return { repo, state: 'opened', pr: null, settings: [], notes: [] } },
    })
    expect(r.ok).toBe(true)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(3)
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
    delete o[ciRunnerOutput('mteichtahl/trace')]
    return o
  }

  it('takes the runner settings from the answers, and plans the connection after the deploy, then the runners', () => {
    const a = AnswersSchema.parse(ANSWERS)
    expect(a.runners).toEqual({ auth: 'auto', token: 'agent', buildTrace: true, traceRepository: '', traceBranch: '', selfUpdate: true, ciRepositories: [], connectionArn: '', computeType: null, privileged: null })
    // nothing is needed up front: no connection ARN (the stack creates one), ready by default
    const props = InfraPropsSchema.parse(infraInput(a))
    expect(props.runners).toEqual({ auth: 'connection', connectionReady: true, computeType: 'BUILD_GENERAL1_LARGE', image: 'aws/codebuild/standard:7.0', privileged: false, ciPrivileged: false })
    // the token: no connection, whatever apply would otherwise pass
    expect(infraInput(a, null, undefined, { auth: 'token' }).runners).toEqual({ auth: 'token' })
    expect(infraInput(AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'token' } })).runners).toEqual({ auth: 'token' })
    const own = AnswersSchema.parse({ ...ANSWERS, runners: { connectionArn: CONNECTION, computeType: 'BUILD_GENERAL1_XLARGE', privileged: true } })
    expect(infraInput(own).runners).toEqual({ connectionArn: CONNECTION, computeType: 'BUILD_GENERAL1_XLARGE', privileged: true })
    // what apply chose wins: the connection to pass (none: the stack's own), and whether it is ready
    expect(infraInput(own, null, undefined, { connectionReady: false }).runners).toEqual({ connectionReady: false, computeType: 'BUILD_GENERAL1_XLARGE', privileged: true })
    expect(infraInput(a, null, undefined, { connectionArn: 'arn:found', connectionReady: true }).runners).toEqual({ connectionArn: 'arn:found', connectionReady: true })
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { connectionArn: 'not-an-arn' } }).success).toBe(false)
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { computeType: 'BUILD_GENERAL1_SMALL' } }).success).toBe(false)
    const steps = plan(a)
    const ids = steps.map((x) => x.id)
    expect(ids.indexOf('github')).toBeLessThan(ids.indexOf('deploy'))
    expect(ids.indexOf('deploy')).toBeLessThan(ids.indexOf('connection'))
    expect(ids.indexOf('connection')).toBeLessThan(ids.indexOf('runners'))
    expect(ids.indexOf('runners')).toBeLessThan(ids.indexOf('repos'))
    const connection = plan(AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'connection' } })).find((x) => x.id === 'connection')
    expect(steps.find((x) => x.id === 'connection')?.detail).toMatch(/^nothing to authorize/)
    expect(connection?.title).toBe('Authorize the GitHub connection')
    expect(connection?.detail).toMatch(/only if the build runners use a GitHub connection that is not authorized yet.*once per AWS account and region.*https:\/\/us-east-1\.console\.aws\.amazon\.com\/codesuite\/settings\/connections\?region=us-east-1.*"Update pending connection".*AWS Connector for GitHub app.*mteichtahl\/board, mteichtahl\/fw/)
    expect(steps.find((x) => x.id === 'runners')?.title).toBe('Add the build runners')
    expect(steps.find((x) => x.id === 'runners')?.detail).toMatch(/only adds each repository's CodeBuild runner project and its GitHub webhook/)
    // automatic: an authorized connection, else the token; a connection by choice: else a new trace-github
    expect(steps.find((x) => x.id === 'deploy')?.detail).toMatch(/a GitHub connection already authorized in the account and region \(trace-github first\), else with the GitHub token, imported as CodeBuild's GitHub source credential \(no console step\)/)
    expect(steps.find((x) => x.id === 'github')?.detail).toMatch(/use a GitHub connection already authorized .* else import the agents' token as CodeBuild's GitHub source credential/)
    expect(plan(AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'connection' } })).find((x) => x.id === 'deploy')?.detail).toMatch(/\(trace-github first\), else a new trace-github it creates, authorized once in the console/)
    expect(plan(AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'token' } })).find((x) => x.id === 'deploy')?.detail).toMatch(/reaching GitHub with the GitHub token/)
    expect(plan(own).find((x) => x.id === 'deploy')?.detail).toContain(`the GitHub connection ${CONNECTION}`)
    expect(steps.find((x) => x.id === 'deploy')?.detail).toMatch(/its own AWS CodeBuild runner project that runs every one of its GitHub Actions jobs \(BUILD_GENERAL1_LARGE; its jobs run on GitHub's own runners until it exists\)/)
    expect(steps.find((x) => x.id === 'runners')?.detail).toMatch(/Until the build runners are added, workflows run on GitHub's runners\.$/)
    expect(plan(own).find((x) => x.id === 'deploy')?.detail).toMatch(/BUILD_GENERAL1_XLARGE, Docker-in-Docker/)
    expect(steps.find((x) => x.id === 'repos')?.detail).toContain('TRACE_CODEBUILD_PROJECT (the CodeBuild runner project its workflows run on)')
    expect(steps.find((x) => x.id === 'repos')?.detail).toMatch(/TRACE_CODEBUILD_PROJECT is set only once the repository's runner exists, and removed where it does not, so its workflows run on GitHub's runners until then$/)
    expect(JSON.stringify(steps)).not.toContain('TRACE_RUNNER')
  })

  it('on a first install deploys without the runners, waits for the person, deploys again with them, then sets the repositories', async () => {
    calls.variables.length = 0
    const order: string[] = []
    const infra: Record<string, unknown>[] = []
    const events: Ev[] = []
    let deployed = 0
    const ok = await apply(AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'connection' } }), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
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
    expect(order).toEqual(['resolve - new', 'bootstrap', 'deploy', 'outputs', `wait ${CONNECTION} mteichtahl/board,mteichtahl/fw,mteichtahl/trace`, 'authorized', 'deploy', 'outputs'])
    // no ARN either time (the stack's own connection), the runners only the second time
    expect(infra.map((x) => x.runners)).toEqual([{ connectionReady: false }, { connectionReady: true }])
    // the repositories after the runners exist, each with its own runner project
    expect(calls.values.get('mteichtahl/board:TRACE_CODEBUILD_PROJECT')).toBe(`trace-ci-${projectHash('mteichtahl/board')}`)
    // while it waits, the step itself says what to do and when the next check is
    expect(stepOf(events, 'connection', 'running').at(-1)).toMatch(/waiting for a person to authorize it.*checking again at 10:42:15/)
    expect(stepOf(events, 'connection', 'done')[0]).toBe(`trace-github is authorized (${CONNECTION})`)
    expect(stepOf(events, 'runners', 'running')[0]).toBe('deploying again: this only adds each repository\'s CodeBuild runner project and its GitHub webhook')
    expect(stepOf(events, 'runners', 'done')[0]).toBe('3 runner projects added')
    expect(stepOf(events, 'deploy', 'done')[0]).toMatch(/without the build runners until the GitHub connection is authorized\. Until the build runners are added, workflows run on GitHub's runners\./)
    // trace's own repository too, from its own output, once its runner exists
    expect(calls.values.get('mteichtahl/trace:TRACE_CODEBUILD_PROJECT')).toBe(`trace-ci-${projectHash('mteichtahl/trace')}`)
    expect(events.filter((e) => e.type === 'log').map((e) => e.line)).toContain('No authorized GitHub connection in this account and region: the deploy creates trace-github, without the build runners, and you authorize it once after the deploy.')
    // and the summary reminds them the app must reach every repository
    expect((events.at(-1)?.summary ?? []).join('\n')).toMatch(/AWS Connector for GitHub app must be allowed to reach every onboarded repository \(mteichtahl\/board, mteichtahl\/fw, mteichtahl\/trace\)/)
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

  it('when the connection is not authorized in time, installs the rest without the runners, and removes TRACE_CODEBUILD_PROJECT so the jobs run on GitHub', async () => {
    const order: string[] = []
    const events: Ev[] = []
    calls.values.clear()
    calls.deleted.length = 0
    // an earlier run had set it in board (a runner since deleted, say): it must go, or board's jobs would wait
    calls.existingVars = new Set(['mteichtahl/board:TRACE_CODEBUILD_PROJECT'])
    try {
      const ok = await apply(AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'connection' } }), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
        ...quiet,
        connection: pending(order, async () => { throw new Error(`the GitHub connection trace-github was still not authorized after 30 minutes. Authorize it at ${URL} ("Update pending connection"), then run the installer again: it resumes from here with the same connection`) }),
        cdk: async (args) => { order.push(args[0] ?? ''); return 0 },
        outputs: async () => withoutRunners(),
      })
      expect(ok).toBe(true)
      // one deploy: no runners without the connection
      expect(order.filter((x) => x === 'deploy')).toHaveLength(1)
      expect(stepOf(events, 'connection', 'failed')[0]).toMatch(/still not authorized after 30 minutes.*run the installer again: it resumes.*Until the build runners are added, workflows run on GitHub's runners\.$/)
      expect(stepOf(events, 'runners', 'skipped')[0]).toBe(`not added: the GitHub connection is not authorized yet. ${GITHUB_RUNNERS_NOTE}`)
      // the repositories are configured all the same, without the variable, which is removed wherever it is set
      for (const repo of ['mteichtahl/board', 'mteichtahl/fw', 'mteichtahl/trace']) {
        expect(calls.values.has(`${repo}:TRACE_CODEBUILD_PROJECT`)).toBe(false)
        expect(calls.deleted).toContain(`${repo}:TRACE_CODEBUILD_PROJECT`)
      }
      expect(calls.values.get('mteichtahl/board:TRACE_AWS_ROLE')).toBe(OUTPUTS[projectOutputs('mteichtahl/board').roleArn])
      const logs = events.filter((e) => e.type === 'log').map((e) => e.line)
      expect(logs).toContain("mteichtahl/board: TRACE_CODEBUILD_PROJECT removed (no build runner yet: its workflows run on GitHub's runners)")
      expect(logs.filter((l) => /TRACE_CODEBUILD_PROJECT removed/.test(l ?? ''))).toHaveLength(1) // only where there was one
      expect(stepOf(events, 'repos', 'done')[0]).toBe("Until the build runners are added, workflows run on GitHub's runners.")
      const summary = (events.at(-1)?.summary ?? []).join('\n')
      expect(summary).toMatch(/The build runners are not added yet: the GitHub connection trace-github is not authorized\. Until the build runners are added, workflows run on GitHub's runners\. Authorize it at .*then run the installer again/)
    } finally {
      calls.existingVars = new Set()
    }
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
    // (the other repository, set up alongside, may still log after it)
    expect(events.find((e) => e.type === 'done')?.summary?.[0]).toBe(`Stopped at "Configure the repositories": the stack has no output ${projectOutputs('mteichtahl/fw').runnerProject}`)
  })
})

describe('no console step on the default path', () => {
  const CONSOLE = /console\.aws\.amazon\.com|AWS console|in the console/i
  const quiet = { names: { deployed: async () => new Set<string>(), taken: async () => [] } }

  it('plans nothing for a person to do in the AWS console, with or without publishing the images', () => {
    for (const a of [ANSWERS, { ...ANSWERS, agents: { ...ANSWERS.agents, publishImages: true } }, { ...ANSWERS, runners: { auth: 'token' } }]) {
      for (const st of plan(AnswersSchema.parse(a))) expect(`${st.title}: ${st.detail}`, st.id).not.toMatch(CONSOLE)
    }
    // only the connection path, chosen under Advanced, has one
    expect(plan(AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'connection' } })).find((x) => x.id === 'connection')?.detail).toMatch(CONSOLE)
  })

  it('installs, and sets publishing up, without any console link in the steps, the log or the summary', async () => {
    const none = { resolve: async () => ({ name: 'trace-github', ready: false, message: 'No authorized GitHub connection in this account and region: …' }), wait: async () => { throw new Error('must not wait') } }
    const lines: string[] = []
    const released: string[] = []
    const ok = await apply(AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, publishImages: true } }), SecretsSchema.parse({ githubToken: TOKEN }), (e) => {
      const x = e as { type: string; line?: string; summary?: string[]; step?: { detail: string } }
      lines.push(x.line ?? x.step?.detail ?? (x.summary ?? []).join('\n'))
    }, {
      ...quiet, connection: none, cdk: async () => 0, outputs: async () => OUTPUTS,
      sourceCredential: async () => ({ state: 'imported', detail: 'the token imported as CodeBuild\'s GitHub source credential' }),
      release: async (o) => { released.push(`${o.account} ${o.repository}`); return { registry: 'public.ecr.aws/a1b2c3d4', roleArn: 'arn:role', images: ['public.ecr.aws/a1b2c3d4/trace-agent'], gallery: ['https://gallery.ecr.aws/a1b2c3d4/trace-agent'], dispatched: true } },
    })
    expect(ok).toBe(true)
    expect(released).toEqual(['123456789012 mteichtahl/trace'])
    expect(lines.join('\n')).not.toMatch(CONSOLE)
    expect(lines.join('\n')).toMatch(/trace's images publish to public\.ecr\.aws\/a1b2c3d4/)
  })

  it('gives trace\'s own build runner Docker only when this installation publishes', () => {
    const on = InfraPropsSchema.parse(infraInput(AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, publishImages: true } })))
    expect(on.runners).toMatchObject({ ciPrivileged: true, privileged: false })
    expect(InfraPropsSchema.parse(infraInput(AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, publishImages: false } }))).runners.ciPrivileged).toBe(false)
  })

  it('publishes from the owner\'s install with nothing asked or set beforehand, and from no one else\'s', async () => {
    for (const sourceAdmin of [true, false]) {
      const events: { type: string; summary?: string[]; step?: { id: string; status: string } }[] = []
      const released: string[] = []
      const a = AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, publishImages: null } })
      const ok = await apply(a, SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
        ...quiet, cdk: async () => 0, outputs: async () => OUTPUTS,
        facts: async () => ({ account: '123456789012', login: 'marc', email: 'marc@example.com', sourceAdmin, publishedRegistry: null }),
        release: async (o) => { released.push(o.account); return { registry: 'public.ecr.aws/a1b2c3d4', roleArn: 'arn:role', images: [], gallery: [], dispatched: true } },
      })
      expect(ok).toBe(true)
      expect(released).toEqual(sourceAdmin ? ['123456789012'] : [])
      expect(events.filter((e) => e.step?.id === 'release').at(-1)?.step?.status).toBe(sourceAdmin ? 'done' : 'skipped')
    }
  })

  it('reports a failed publishing setup without failing the install', async () => {
    const events: { type: string; summary?: string[]; step?: { id: string; status: string } }[] = []
    const ok = await apply(AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, publishImages: true } }), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      ...quiet, cdk: async () => 0, outputs: async () => OUTPUTS, release: async () => { throw new Error('cdk deploy TraceRelease exited 1') },
    })
    expect(ok).toBe(true)
    expect(events.find((e) => e.step?.id === 'release' && e.step.status === 'failed')).toBeDefined()
    expect(events.at(-1)?.summary?.join('\n')).toMatch(/Publishing trace's images is not set up: cdk deploy TraceRelease exited 1.*tracectl release setup/)
  })
})

describe('the sample project', () => {
  const quiet = { names: { deployed: async () => new Set<string>(), taken: async () => [] } }
  const SAMPLE = 'trace-agent/trace-sample'
  type Ev = { type: string; line?: string; summary?: string[]; step?: { id: string; status: string; detail: string } }
  const outputsFor = (repos: string[]): Record<string, string> => {
    const out = { ...OUTPUTS }
    for (const repo of repos) {
      const o = projectOutputs(repo)
      Object.assign(out, { [o.runtimeArn]: `arn:rt/${repo}`, [o.roleArn]: `arn:role/${repo}`, [o.secretArn]: `arn:secret/${repo}`, [o.memoryId]: `m-${projectHash(repo)}`, [o.runnerProject]: `trace-ci-${projectHash(repo)}` })
    }
    return out
  }
  const run = async (a: unknown, hooks: Parameters<typeof apply>[3] = {}): Promise<{ ok: boolean; events: Ev[] }> => {
    OUTPUTS.TraceHome = join(mkdtempSync(join(tmpdir(), 'trace-central-')), 'home')
    const events: Ev[] = []
    const ok = await apply(AnswersSchema.parse(a), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), { cdk: async () => 0, outputs: async () => outputsFor(['mteichtahl/board', 'mteichtahl/fw', SAMPLE]), ...quiet, ...hooks })
    return { ok, events }
  }

  it('is off by default, and when on is one more new repository, named after the token\'s account', async () => {
    const { sampleRepo, withSample } = await import('../../src/installer/sample.js')
    expect(AnswersSchema.parse(ANSWERS).sample).toEqual({ enabled: false, repo: '', private: true, tour: true })
    const only = AnswersSchema.parse({ ...ANSWERS, projects: [], people: [], github: { login: 'trace-agent' }, sample: { enabled: true, private: false } })
    expect(sampleRepo(only)).toBe(SAMPLE)
    expect(withSample(only).projects).toEqual([{ repo: SAMPLE, branch: 'main', onboard: true, applySettings: true, memoryEventExpiryDays: null, generation: 0, create: { template: 'sample', private: false } }])
    expect(sampleRepo(AnswersSchema.parse({ ...ANSWERS, sample: { enabled: true, repo: 'acme/demo' } }))).toBe('acme/demo')
    // the login may still be to derive: the answers are valid, and the name waits for it
    expect(AnswersSchema.safeParse({ ...ANSWERS, sample: { enabled: true } }).success).toBe(true)
    // people may be assigned to it; listed already (an earlier run created it) it is not doubled
    expect(AnswersSchema.safeParse({ ...only, people: [{ email: 'dev@example.com', projects: [SAMPLE] }] }).success).toBe(true)
    const again = AnswersSchema.parse({ ...only, projects: [{ repo: SAMPLE, branch: 'trunk' }] })
    expect(withSample(again).projects.map((p) => `${p.repo}@${p.branch}:${p.create ? 'new' : 'existing'}`)).toEqual([`${SAMPLE}@trunk:existing`])
    expect(AnswersSchema.safeParse({ ...ANSWERS, sample: { enabled: true, repo: 'not a repo' } }).success).toBe(false)
  })

  it('plans it with the new repositories, and its tour last', () => {
    const a = AnswersSchema.parse({ ...ANSWERS, github: { login: 'trace-agent' }, sample: { enabled: true } })
    const steps = plan(a)
    expect(steps.at(-1)?.id).toBe('tour')
    expect(steps.find((x) => x.id === 'github')?.detail).toContain(`create ${SAMPLE} first`)
    expect(steps.find((x) => x.id === 'onboard')?.detail).toContain(`create ${SAMPLE} (sample)`)
    expect(steps.find((x) => x.id === 'tour')?.detail).toMatch(/open \d+ tasks in trace-agent\/trace-sample, each labelled for the agent that takes it/)
    expect(plan(AnswersSchema.parse({ ...ANSWERS, github: { login: 'x' }, sample: { enabled: true, tour: false } })).map((x) => x.id)).not.toContain('tour')
    expect(plan(AnswersSchema.parse(ANSWERS)).map((x) => x.id)).not.toContain('tour')
    expect(plan(AnswersSchema.parse({ ...ANSWERS, agents: { ...ANSWERS.agents, gpuEnabled: false }, github: { login: 'x' }, sample: { enabled: true } })).find((x) => x.id === 'tour')?.detail).toMatch(/left out because GPU jobs are off/)
  })

  it('creates it before the deploy, onboards it from the sample template, and opens the tour after the GPU image', async () => {
    const order: string[] = []
    const onboarded: { repo: string; create: unknown }[] = []
    const r = await run({ ...ANSWERS, agents: { ...ANSWERS.agents, gpuEnabled: true }, github: { login: 'trace-agent' }, sample: { enabled: true }, people: [{ email: 'dev@example.com', projects: [SAMPLE] }] }, {
      createRepo: async (_t, slug, o) => { order.push(`create ${slug} ${o.private ? 'private' : 'public'}`); return { fullName: slug, defaultBranch: 'main', created: true } },
      cdk: async (args) => { if (args[0] === 'deploy') order.push('deploy'); return 0 },
      outputs: async () => ({ ...outputsFor(['mteichtahl/board', 'mteichtahl/fw', SAMPLE]), GpuImageBuild: 'trace-gpu-image:1', GpuImageUri: 'x/trace-gpu:abc' }),
      onboard: async (repo, o) => { onboarded.push({ repo, create: o.create ?? null }); return { repo, state: o.create ? 'created' : 'opened', pr: o.create ? null : `https://github.com/${repo}/pull/1`, settings: [], notes: o.create ? ['19 requirements'] : [] } },
      gpuImage: async () => { order.push('gpu'); return { ok: true, detail: 'built' } },
      tour: async (_t, repo, o) => { order.push(`tour ${repo} gpu=${o.gpu}`); return { url: `https://github.com/${repo}/issues`, opened: 20, existing: 0, skipped: [], lines: [] } },
    })
    expect(r.ok).toBe(true)
    expect(order).toEqual([`create ${SAMPLE} private`, 'deploy', 'gpu', `tour ${SAMPLE} gpu=true`])
    expect(onboarded.find((x) => x.repo === SAMPLE)?.create).toEqual({ template: 'sample', private: true })
    expect(calls.variables).toContain(`${SAMPLE}:TRACE_AGENT_RUNTIME_ARN`)
    expect(r.events.some((e) => e.type === 'log' && e.line === `${SAMPLE}: 19 requirements`)).toBe(true)
    const summary = r.events.at(-1)?.summary?.join('\n') ?? ''
    expect(summary).toMatch(/Created the sample project, trace-agent\/trace-sample, under trace/)
    expect(summary).toMatch(/sample's tour has started: every agent and every simulation has a task in https:\/\/github.com\/trace-agent\/trace-sample\/issues/)
    // once onboarded it is saved as an existing repository, so the next run does not create it again
    const saved = AnswersSchema.parse(savedAnswers().answers)
    expect(saved.projects.find((p) => p.repo === SAMPLE)?.create).toBeNull()
    expect(saved.sample).toMatchObject({ enabled: true, tour: true })
  })

  it('names the sample after the login derived at install, and reports a tour that could not start without failing the install', async () => {
    const created: string[] = []
    const r = await run({ ...ANSWERS, projects: [], people: [], agents: { ...ANSWERS.agents, gpuEnabled: false }, sample: { enabled: true } }, {
      facts: async () => ({ account: '123456789012', login: 'trace-agent', email: 'marc@example.com', models: [{ id: 'us.anthropic.claude-sonnet-4-6', name: 'S' }], gpuQuota: 0 }),
      createRepo: async (_t, slug) => { created.push(slug); return { fullName: slug, defaultBranch: 'main', created: true } },
      tour: async () => { throw new Error('POST /repos/trace-agent/trace-sample/issues: 403 Resource not accessible') },
    })
    expect(r.ok).toBe(true)
    expect(created).toEqual([SAMPLE])
    expect(r.events.find((e) => e.step?.id === 'tour' && e.step.status === 'failed')?.step?.detail).toMatch(/403/)
    expect(r.events.at(-1)?.summary?.join('\n')).toMatch(/The sample's tour did not start: .*run the installer again to open its tasks/)
  })
})

describe("trace's own repository", () => {
  const quiet = { names: { deployed: async () => new Set<string>(), taken: async () => [] } }
  const TRACE = 'mteichtahl/trace'
  const yes = async () => ({ ok: true, reason: '' })
  const no = async () => ({ ok: false, reason: 'GET /repos/mteichtahl/trace/actions/secrets/public-key: 403 Resource not accessible' })

  it('is built on AWS by default when the token can configure it, and not when it cannot, is off, unknown or a project', async () => {
    const a = AnswersSchema.parse(ANSWERS)
    const on = await resolveSelfBuild(a, TOKEN, { source: () => TRACE, canConfigure: yes })
    expect(on.answers.runners.traceRepository).toBe(TRACE)
    expect(on.note).toBe(`Building trace's own repository (${TRACE}) on AWS too: a build runner for it alone.`)
    expect(buildRepositories(on.answers)).toEqual([TRACE])
    expect(infraInput(on.answers).ciRepositories).toEqual([TRACE])
    expect(InfraPropsSchema.parse(infraInput(on.answers)).ciRepositories).toEqual([TRACE])

    const cannot = await resolveSelfBuild(a, TOKEN, { source: () => TRACE, canConfigure: no })
    expect(cannot.answers.runners.traceRepository).toBe('')
    expect(cannot.note).toMatch(/^trace's own repository \(mteichtahl\/trace\) stays on GitHub's runners: the token cannot set its variables \(.*403/)
    expect(infraInput(cannot.answers).ciRepositories).toBeUndefined()

    const off = AnswersSchema.parse({ ...ANSWERS, runners: { buildTrace: false, traceRepository: TRACE } })
    const offR = await resolveSelfBuild(off, TOKEN, { source: () => { throw new Error('not asked') }, canConfigure: no })
    expect(offR).toEqual({ answers: { ...off, runners: { ...off.runners, traceRepository: '' } }, note: null })
    expect(buildRepositories(off)).toEqual([]) // off wins over a repository saved earlier

    const unknown = await resolveSelfBuild(a, TOKEN, { source: () => null, canConfigure: yes })
    expect(unknown.answers.runners.traceRepository).toBe('')
    expect(unknown.note).toMatch(/could not tell which GitHub repository/)

    const project = AnswersSchema.parse({ ...ANSWERS, projects: [...ANSWERS.projects, { repo: 'MTeichtahl/Trace' }] })
    const p = await resolveSelfBuild(project, TOKEN, { source: () => TRACE, canConfigure: yes })
    expect(p.answers.runners.traceRepository).toBe('')
    expect(p.note).toMatch(/is one of the projects: it builds on its own runner/)
    expect(buildRepositories({ ...project, runners: { ...project.runners, traceRepository: TRACE } })).toEqual([])
  })

  it('says so in the plan, in plain words; adds other build-only repositories; refuses a project or a repeat among them', () => {
    const a = AnswersSchema.parse({ ...ANSWERS, runners: { auth: 'connection', traceRepository: TRACE } })
    const deploy = plan(a).find((x) => x.id === 'deploy')?.detail ?? ''
    expect(deploy).toMatch(/ Build trace's own repository on AWS too \(mteichtahl\/trace\): a build runner for it alone, nothing else\. Keep this installation up to date: /)
    expect(plan(a).find((x) => x.id === 'repos')?.detail).toMatch(/; TRACE_CODEBUILD_PROJECT alone in mteichtahl\/trace; TRACE_UPDATE_ROLE, TRACE_AWS_REGION and TRACE_STACK in mteichtahl\/trace \(its ci workflow keeps this installation up to date\)\./)
    expect(plan(a).find((x) => x.id === 'connection')?.detail).toMatch(/Give that app access to mteichtahl\/board, mteichtahl\/fw, mteichtahl\/trace$/)
    const none = AnswersSchema.parse({ ...ANSWERS, runners: { buildTrace: false, traceRepository: TRACE } })
    expect(plan(none).find((x) => x.id === 'deploy')?.detail).not.toMatch(/trace's own repository/)
    const more = AnswersSchema.parse({ ...ANSWERS, runners: { traceRepository: TRACE, ciRepositories: ['mteichtahl/tools', 'MTEICHTAHL/trace'] } })
    expect(buildRepositories(more)).toEqual([TRACE, 'mteichtahl/tools'])
    expect(plan(more).find((x) => x.id === 'deploy')?.detail).toMatch(/Build mteichtahl\/tools on AWS too, without agents: a build runner each, nothing else\. Keep/)
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { ciRepositories: ['mteichtahl/board'] } }).success).toBe(false)
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { ciRepositories: ['a/b', 'A/b'] } }).success).toBe(false)
    expect(AnswersSchema.safeParse({ ...ANSWERS, runners: { traceRepository: 'not a repo' } }).success).toBe(false)
  })

  it('sets its TRACE_CODEBUILD_PROJECT from its own output once the runners exist, and nothing else of a project', async () => {
    calls.values.clear()
    calls.ghSecrets.length = 0
    const infra: Record<string, unknown>[] = []
    const events: { type: string; line?: string }[] = []
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      ...quiet, self: { source: () => TRACE, canConfigure: yes },
      cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 }, outputs: async () => OUTPUTS,
    })
    expect(ok).toBe(true)
    expect(infra[0]?.ciRepositories).toEqual([TRACE])
    expect(calls.values.get(`${TRACE}:TRACE_CODEBUILD_PROJECT`)).toBe(`trace-ci-${projectHash(TRACE)}`)
    // its runner, and (keeping the installation up to date, on by default) the self-update job's variables: nothing of a project
    expect([...calls.values.keys()].filter((k) => k.startsWith(`${TRACE}:`)).sort()).toEqual([`${TRACE}:TRACE_AWS_REGION`, `${TRACE}:TRACE_CODEBUILD_PROJECT`, `${TRACE}:TRACE_STACK`, `${TRACE}:TRACE_UPDATE_ROLE`])
    expect(calls.ghSecrets.filter((k) => k.startsWith(`${TRACE}:`))).toEqual([])
    expect(events.filter((e) => e.type === 'log').map((e) => e.line)).toContain(`Building trace's own repository (${TRACE}) on AWS too: a build runner for it alone.`)
    // saved with the answers, so the page shows it next time
    expect(AnswersSchema.parse(savedAnswers().answers).runners.traceRepository).toBe(TRACE)

    // turned off: no runner for it, and its variable is removed so its jobs go back to GitHub's runners
    calls.values.clear()
    calls.deleted.length = 0
    infra.length = 0
    const off = await apply(AnswersSchema.parse({ ...ANSWERS, runners: { buildTrace: false } }), SecretsSchema.parse({ githubToken: TOKEN }), () => undefined, {
      ...quiet, self: { source: () => TRACE, canConfigure: yes },
      cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 }, outputs: async () => OUTPUTS,
    })
    expect(off).toBe(true)
    expect(infra[0]?.ciRepositories).toBeUndefined()
    expect(calls.values.has(`${TRACE}:TRACE_CODEBUILD_PROJECT`)).toBe(false)
    // and the self-update role goes with it (selfUpdate needs trace's own repository built), so its variable goes too
    expect(calls.deleted.sort()).toEqual([`${TRACE}:TRACE_CODEBUILD_PROJECT`, `${TRACE}:TRACE_UPDATE_ROLE`])
  })

  it('reads which repositories an earlier run built from its saved answers', () => {
    expect(earlierRepositories(undefined)).toEqual([])
    expect(earlierRepositories({ nonsense: true })).toEqual([])
    expect(earlierRepositories({ ...ANSWERS, runners: { traceRepository: TRACE } })).toEqual(['mteichtahl/board', 'mteichtahl/fw', TRACE])
  })
})

describe('keeping the installation up to date', () => {
  const quiet = { names: { deployed: async () => new Set<string>(), taken: async () => [] } }
  const TRACE = 'mteichtahl/trace'
  const yes = async () => ({ ok: true, reason: '' })
  const ADMIN = ['ghp', 'ADMINFAKEFAKEFAKE0123456789'].join('_')
  const OWN = ['github', 'pat', '22OWNFAKEFAKE0123456789'].join('_')
  const KEY = 'secret-key-value-1234'

  it('saves exactly the settings it deployed with, and never a token or key, in installation/props.json', async () => {
    calls.values.clear()
    calls.tokens.set(OWN, { login: 'board-bot', repos: ['mteichtahl/board'] })
    const saved: { bucket: string; key: string; text: string }[] = []
    const infra: string[] = []
    const ok = await apply(AnswersSchema.parse(ANSWERS), SecretsSchema.parse({
      githubToken: TOKEN, githubAdminToken: ADMIN, projectTokens: { 'mteichtahl/board': OWN }, awsAccessKeyId: 'AKIAEXAMPLE', awsSecretAccessKey: KEY,
      libraryKeys: { MOUSER_API_KEY: 'mouser-key-0123456789' }, integrations: { nexar: { NEXAR_CLIENT_ID: 'nexar-id-0123456789', NEXAR_CLIENT_SECRET: 'nexar-secret-0123456789' } },
    }), () => undefined, {
      ...quiet, self: { source: () => TRACE, canConfigure: yes, branch: async () => 'trunk' },
      cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(env.TRACE_INFRA ?? ''); return 0 }, outputs: async () => OUTPUTS,
      saveRecord: async (_c, _r, bucket, key, text) => { saved.push({ bucket, key, text }) },
      integrations: { set: async (name) => `trace/integrations/${name}` }, checkIntegration: async () => ({ ok: true, detail: 'accepted' }),
    })
    expect(ok).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.bucket).toBe('trace-central-bucket')
    expect(saved[0]?.key).toBe('installation/props.json')
    const record = JSON.parse(saved[0]?.text ?? '{}') as { props: Record<string, unknown>; stack: string; region: string; runnerAuth: string; traceRepository: string; traceBranch: string; connectionArn: string }
    // exactly what the deploy was given
    expect(record.props).toEqual(JSON.parse(infra.at(-1) ?? '{}'))
    expect(record).toMatchObject({ stack: 'TraceStack', region: 'us-east-1', runnerAuth: 'auto', traceRepository: TRACE, traceBranch: 'trunk', connectionArn: '' })
    expect(record.props.selfUpdate).toEqual({ repository: TRACE, branch: 'trunk' })
    for (const v of [TOKEN, ADMIN, OWN, KEY, 'AKIAEXAMPLE', 'mouser-key-0123456789', 'nexar-id-0123456789', 'nexar-secret-0123456789']) expect(saved[0]?.text).not.toContain(v)
    // the repository's variables for the update job
    expect(calls.values.get(`${TRACE}:TRACE_UPDATE_ROLE`)).toBe(OUTPUTS.SelfUpdateRoleArn)
    expect(calls.values.get(`${TRACE}:TRACE_AWS_REGION`)).toBe('us-east-1')
    expect(calls.values.get(`${TRACE}:TRACE_STACK`)).toBe('TraceStack')
  })

  it('refuses to save a record a secret would be in', async () => {
    const { checkNoSecrets, installationRecord } = await import('../../src/installer/record.js')
    const s = SecretsSchema.parse({ githubToken: TOKEN })
    const r = installationRecord({ stack: 'TraceStack', region: 'us-east-1', props: infraInput(AnswersSchema.parse(ANSWERS)), runnerAuth: 'auto', connectionArn: '', traceRepository: '', traceBranch: '' })
    expect(() => checkNoSecrets(JSON.stringify(r), s)).not.toThrow()
    expect(() => checkNoSecrets(JSON.stringify({ ...r, props: { ...r.props, model: TOKEN } }), s)).toThrow(/token or key/)
    expect(() => checkNoSecrets(JSON.stringify({ ...r, note: ['ghp', 'abcdefghijklmnop'].join('_') }), s)).toThrow(/token or key/)
  })

  it('asks the stack for the role only while trace\'s own repository is built and the option is on, and plans it in plain words', () => {
    const on = AnswersSchema.parse({ ...ANSWERS, runners: { traceRepository: TRACE, traceBranch: 'main' } })
    expect(infraInput(on).selfUpdate).toEqual({ repository: TRACE, branch: 'main' })
    expect(plan(on).find((x) => x.id === 'deploy')?.detail).toMatch(/Keep this installation up to date: when mteichtahl\/trace's main branch changes and its tests pass, its ci workflow deploys this stack again .* only that workflow on main can use, so whoever can merge to main there can change this installation\.$/)
    const optedOut = AnswersSchema.parse({ ...ANSWERS, runners: { traceRepository: TRACE, selfUpdate: false } })
    expect(infraInput(optedOut).selfUpdate).toBeUndefined()
    expect(plan(optedOut).find((x) => x.id === 'deploy')?.detail).not.toMatch(/up to date/)
    expect(plan(optedOut).find((x) => x.id === 'repos')?.detail).not.toMatch(/TRACE_UPDATE_ROLE/)
    const notBuilt = AnswersSchema.parse({ ...ANSWERS, runners: { buildTrace: false, traceRepository: TRACE } })
    expect(infraInput(notBuilt).selfUpdate).toBeUndefined()
  })

  it('opted out: no role asked for, no variables set, and the earlier TRACE_UPDATE_ROLE removed', async () => {
    calls.values.clear()
    calls.deleted.length = 0
    calls.existingVars.add(`${TRACE}:TRACE_UPDATE_ROLE`)
    const infra: Record<string, unknown>[] = []
    const events: { type: string; line?: string }[] = []
    const ok = await apply(AnswersSchema.parse({ ...ANSWERS, runners: { selfUpdate: false } }), SecretsSchema.parse({ githubToken: TOKEN }), (e) => events.push(e as never), {
      ...quiet, self: { source: () => TRACE, canConfigure: yes },
      cdk: async (args, env) => { if (args[0] === 'deploy') infra.push(JSON.parse(env.TRACE_INFRA ?? '{}')); return 0 }, outputs: async () => OUTPUTS,
      saveRecord: async () => undefined,
    })
    calls.existingVars.delete(`${TRACE}:TRACE_UPDATE_ROLE`)
    expect(ok).toBe(true)
    expect(infra[0]?.selfUpdate).toBeUndefined()
    expect(infra[0]?.ciRepositories).toEqual([TRACE])
    expect([...calls.values.keys()].filter((k) => k.startsWith(`${TRACE}:`))).toEqual([`${TRACE}:TRACE_CODEBUILD_PROJECT`])
    expect(calls.deleted).toContain(`${TRACE}:TRACE_UPDATE_ROLE`)
    expect(events.filter((e) => e.type === 'log').map((e) => e.line)).toContain(`${TRACE}: TRACE_UPDATE_ROLE removed (this installation no longer updates itself from it)`)
  })
})

