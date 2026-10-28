/**
 * The light install: only AWS credentials and one GitHub token are required, everything else is derived
 * (src/installer/derive.ts) or found by the preflight (src/installer/preflight.ts) before anything is created, with
 * fake AWS and GitHub answers throughout.
 */
import { describe, expect, it } from 'vitest'
import { AnswersSchema, SecretsSchema } from '../../src/installer/answers.js'
import { changesSince, plan, timeline } from '../../src/installer/bootstrap.js'
import { geography, pickModel, resolveAnswers } from '../../src/installer/derive.js'
import { FixRequest } from '../../src/installer/fix.js'
import { type RepoAccess, type TokenInfo, accessNote } from '../../src/installer/github.js'
import { type PreflightDeps, type PreflightInput, QUOTAS, foundationModelOf, mapLimit, preflight } from '../../src/installer/preflight.js'

const TOKEN = ['github', 'pat', '11LIGHTLIGHTLIGHT0123456789'].join('_')

describe('the answers', () => {
  it('parse with nothing but the credentials and a token', () => {
    const a = AnswersSchema.parse({})
    expect(a.aws).toEqual({ mode: 'profile', profile: 'default', region: '', account: '' })
    expect(a.projects).toEqual([])
    expect(a.adminEmail).toBe('')
    expect(a.agents).toMatchObject({ prefix: 'trace', model: '', gpuEnabled: null, cpuEnabled: null, knowledgeBase: null, imageSource: 'prebuilt' })
    expect(a.runners).toMatchObject({ auth: 'auto', token: 'agent', connectionArn: '' })
    expect(SecretsSchema.parse({ githubToken: TOKEN }).integrations).toEqual({})
    // keys instead of a profile
    expect(AnswersSchema.parse({ aws: { mode: 'keys' } }).aws.mode).toBe('keys')
    // what is still refused
    expect(AnswersSchema.safeParse({ adminEmail: 'not an email' }).success).toBe(false)
    expect(AnswersSchema.safeParse({ aws: { region: 'mars' } }).success).toBe(false)
    expect(SecretsSchema.safeParse({}).success).toBe(false)
  })

  it('derive the account, region, login, email, model and the compute defaults from the facts', () => {
    const a = AnswersSchema.parse({})
    const r = resolveAnswers(a, {
      account: '123456789012', profileRegion: 'eu-west-1', login: 'marc', email: 'marc@example.com',
      models: [{ id: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'S45' }, { id: 'eu.anthropic.claude-sonnet-4-6', name: 'S46' }, { id: 'global.anthropic.claude-sonnet-4-6', name: 'G46' }, { id: 'eu.anthropic.claude-haiku-4-5', name: 'H' }],
      gpuQuota: 0, cpuQuota: 64, s3vectors: false,
    })
    expect(r.missing).toEqual([])
    expect(r.answers.aws).toMatchObject({ region: 'eu-west-1', account: '123456789012' })
    expect(r.answers.github.login).toBe('marc')
    expect(r.answers.adminEmail).toBe('marc@example.com')
    expect(r.answers.agents.model).toBe('eu.anthropic.claude-sonnet-4-6') // the newest Sonnet, the geography's before global
    expect(r.answers.agents).toMatchObject({ gpuEnabled: false, cpuEnabled: false, knowledgeBase: false })
    expect(r.derived.join('\n')).toMatch(/GPU jobs off \(the account may run 0 G and VT vCPUs; one job needs 4\)/)
    expect(r.derived.join('\n')).toMatch(/knowledge bases off \(Amazon S3 Vectors is not available in eu-west-1\)/)
    // given answers win over the facts
    const given = resolveAnswers(AnswersSchema.parse({ aws: { region: 'us-west-2' }, adminEmail: 'boss@example.com', agents: { model: 'us.anthropic.claude-opus-4-1', gpuEnabled: true } }), { account: '123456789012', gpuQuota: 0 })
    expect(given.answers.aws.region).toBe('us-west-2')
    expect(given.answers.adminEmail).toBe('boss@example.com')
    expect(given.answers.agents.model).toBe('us.anthropic.claude-opus-4-1')
    expect(given.answers.agents.gpuEnabled).toBe(true)
    // the defaults with nothing known: us-east-1, GPU on, a Sonnet 4.6 profile for the geography
    const bare = resolveAnswers(a, { account: '123456789012', email: 'x@example.com', login: 'x' })
    expect(bare.answers.aws.region).toBe('us-east-1')
    expect(bare.answers.agents).toMatchObject({ model: 'us.anthropic.claude-sonnet-4-6', gpuEnabled: true, cpuEnabled: true, knowledgeBase: true })
  })

  it('ask only for what cannot be derived, and stop on the wrong account', () => {
    const r = resolveAnswers(AnswersSchema.parse({}), { account: '123456789012', login: 'marc', email: null })
    expect(r.missing.join(' ')).toMatch(/first administrator's email.*user:email.*Email addresses: read/)
    const wrong = resolveAnswers(AnswersSchema.parse({ aws: { account: '111111111111' }, adminEmail: 'a@example.com' }), { account: '222222222222', login: 'x' })
    expect(wrong.missing.join(' ')).toMatch(/for account 222222222222, not 111111111111/)
  })

  it('publish from the owner\'s install, and find the published images, with no prework', () => {
    const base = { account: '123456789012', login: 'marc', email: 'marc@example.com' }
    const a = AnswersSchema.parse({})
    expect(a.agents.publishImages).toBeNull()
    // the token administers the source repository: this install publishes; the images it finds, it copies
    const owner = resolveAnswers(a, { ...base, sourceAdmin: true, publishedRegistry: 'public.ecr.aws/a1b2c3d4' })
    expect(owner.answers.agents).toMatchObject({ publishImages: true, imageRegistry: 'public.ecr.aws/a1b2c3d4' })
    expect(owner.derived.join(' ')).toMatch(/publishing trace's images from this account.*images copied from public\.ecr\.aws\/a1b2c3d4/)
    // anyone else: no publishing; nothing published yet: built here
    const other = resolveAnswers(a, { ...base, sourceAdmin: false, publishedRegistry: null })
    expect(other.answers.agents).toMatchObject({ publishImages: false, imageRegistry: '' })
    expect(other.derived.join(' ')).toMatch(/images built in this account/)
    // an answer wins either way
    const chosen = resolveAnswers(AnswersSchema.parse({ agents: { publishImages: false, imageRegistry: 'public.ecr.aws/mine' } }), { ...base, sourceAdmin: true, publishedRegistry: 'public.ecr.aws/a1b2c3d4' })
    expect(chosen.answers.agents).toMatchObject({ publishImages: false, imageRegistry: 'public.ecr.aws/mine' })
    expect(resolveAnswers(AnswersSchema.parse({ agents: { imageSource: 'build' } }), { ...base, publishedRegistry: 'public.ecr.aws/a1b2c3d4' }).answers.agents.imageRegistry).toBe('')
  })

  it('pick the model by geography', () => {
    expect(geography('ap-southeast-2')).toBe('apac')
    expect(geography('eu-central-1')).toBe('eu')
    expect(pickModel([], 'ap-southeast-2')).toBe('apac.anthropic.claude-sonnet-4-6')
    expect(pickModel([{ id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0' }, { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0' }], 'us-east-1')).toBe('us.anthropic.claude-sonnet-4-20250514-v1:0')
    expect(pickModel([{ id: 'us.anthropic.claude-opus-4-1-20250805-v1:0' }], 'us-east-1')).toBe('us.anthropic.claude-opus-4-1-20250805-v1:0')
    expect(foundationModelOf('global.anthropic.claude-sonnet-4-6')).toBe('anthropic.claude-sonnet-4-6')
  })
})

// ------------------------------------------------------------------ the preflight, against fakes

const info = (repos: string[] = ['marc/board', 'marc/fw'], kind: TokenInfo['kind'] = 'fine-grained'): TokenInfo => ({
  login: 'marc', name: null, kind, scopes: [], warnings: [], repos: repos.map((fullName) => ({ fullName, private: true, admin: true, push: true, defaultBranch: 'main' })),
})
const full = (repo: string): RepoAccess => ({ repo, visible: true, configure: true, administer: true, webhooks: true, missing: [] })

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps & { calls: string[] } {
  const calls: string[] = []
  const t = <T>(name: string, v: T) => async (): Promise<T> => { calls.push(name); return v }
  return {
    calls,
    sts: t('sts', { account: '123456789012', arn: 'arn:aws:iam::123456789012:user/marc' }),
    agentCore: t('agentCore', undefined),
    models: t('models', [{ id: 'us.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }]),
    modelAccess: async () => { calls.push('modelAccess'); return { status: 'AVAILABLE', useCase: true, detail: '' } },
    quota: async (code) => { calls.push(`quota ${code}`); return code === QUOTAS.gpuOnDemand ? 16 : 256 },
    vpcs: t('vpcs', { count: 1, quota: 5 }),
    s3vectors: t('s3vectors', true),
    cdk: t('cdk', { status: 'UPDATE_COMPLETE', version: 28 }),
    stack: async () => { calls.push('stack'); return null },
    oidcProvider: t('oidc', false),
    cognitoDomain: async () => null,
    leftovers: t('leftovers', []),
    sourceCredential: t('sourceCredential', null),
    connections: t('connections', []),
    token: t('token', info()),
    email: t('email', 'marc@example.com'),
    repo: async (r) => { calls.push(`repo ${r}`); return full(r) },
    source: t('source', { ok: true, canFix: false, detail: '' }),
    publishedRegistry: t('publishedRegistry', null),
    ...over,
  }
}
const IN: PreflightInput = { region: 'us-east-1', prefix: 'trace', model: '', gpuSpot: false, cpuSpot: false, cpuVcpus: 16, gpuEnabled: null, runnerAuth: 'auto', repos: ['marc/board'], create: [], hasAdminToken: false }

describe('the preflight', () => {
  it('checks everything at once and passes a ready account', async () => {
    const d = deps()
    const r = await preflight(IN, d)
    expect(r.ok).toBe(true)
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(r.facts).toMatchObject({ account: '123456789012', login: 'marc', email: 'marc@example.com', gpuQuota: 16, s3vectors: true, cdkBootstrapped: true })
    expect(d.calls).toEqual(expect.arrayContaining(['sts', 'agentCore', 'models', 'modelAccess', `quota ${QUOTAS.gpuOnDemand}`, `quota ${QUOTAS.cpuOnDemand}`, 's3vectors', 'cdk', 'stack', 'token', 'email', 'repo marc/board']))
    expect(r.checks.find((c) => c.id === 'bedrock.model')?.detail).toMatch(/us\.anthropic\.claude-sonnet-4-6: the account has access/)
  })

  it('says where the images come from, and that the owner\'s install publishes them', async () => {
    const owner = await preflight(IN, deps({ source: async () => ({ ok: true, canFix: false, admin: true, detail: '' }), publishedRegistry: async () => 'public.ecr.aws/a1b2c3d4' }))
    expect(owner.facts).toMatchObject({ sourceAdmin: true, publishedRegistry: 'public.ecr.aws/a1b2c3d4' })
    expect(owner.checks.find((c) => c.id === 'images.source')?.detail).toMatch(/copied from public\.ecr\.aws\/a1b2c3d4 by digest/)
    expect(owner.checks.find((c) => c.id === 'images.publish')?.detail).toMatch(/this install also publishes/)
    const other = await preflight(IN, deps())
    expect(other.facts).toMatchObject({ sourceAdmin: false, publishedRegistry: null })
    expect(other.checks.find((c) => c.id === 'images.source')?.detail).toMatch(/published no images yet: they are built/)
    expect(other.checks.some((c) => c.id === 'images.publish')).toBe(false)
    // neither is a reason to stop
    expect(owner.ok && other.ok).toBe(true)
  })

  it('offers to send Anthropic\'s use-case form, or to accept the agreement, and never blocks on model access', async () => {
    const form = await preflight(IN, deps({ modelAccess: async () => ({ status: 'NOT_AVAILABLE', useCase: false, detail: '' }) }))
    const c = form.checks.find((x) => x.id === 'bedrock.model')
    expect(c?.status).toBe('warn')
    expect(c?.action).toMatchObject({ id: 'bedrock-use-case', params: { model: 'anthropic.claude-sonnet-4-6' } })
    // done by API, so no console link to send anyone to
    expect(c?.link).toBeUndefined()
    expect(c?.fix).not.toMatch(/console/)
    expect(form.ok).toBe(true)
    const agree = await preflight(IN, deps({ modelAccess: async () => ({ status: 'NOT_AVAILABLE', useCase: true, detail: 'NOT_AUTHORIZED' }) }))
    expect(agree.checks.find((x) => x.id === 'bedrock.model')?.action?.id).toBe('bedrock-agreement')
    const pending = await preflight(IN, deps({ modelAccess: async () => ({ status: 'PENDING', useCase: true, detail: '' }) }))
    expect(pending.checks.find((x) => x.id === 'bedrock.model')?.detail).toMatch(/pending/)
  })

  it('turns GPU jobs off at a quota of 0 and offers the increase, by API', async () => {
    const r = await preflight(IN, deps({ quota: async (code) => (code === QUOTAS.gpuOnDemand ? 0 : 256) }))
    const g = r.checks.find((c) => c.id === 'gpu.quota')
    expect(g?.status).toBe('info')
    expect(g?.detail).toMatch(/may run 0 on-demand G and VT vCPUs.*left off/)
    expect(g?.action).toEqual({ id: 'quota-increase', label: 'Request 16 G and VT vCPUs', params: { code: QUOTAS.gpuOnDemand, value: 16, service: 'ec2' } })
    expect(g?.link).toBeUndefined()
    expect(r.facts.gpuQuota).toBe(0)
    expect(r.ok).toBe(true)
    // asked for on regardless: a warning, since jobs would wait forever
    expect((await preflight({ ...IN, gpuEnabled: true }, deps({ quota: async () => 0 }))).checks.find((c) => c.id === 'gpu.quota')?.status).toBe('warn')
    // Spot asks the Spot quota
    const spot = deps()
    await preflight({ ...IN, gpuSpot: true }, spot)
    expect(spot.calls).toContain(`quota ${QUOTAS.gpuSpot}`)
    // a full region's VPCs
    expect((await preflight(IN, deps({ vpcs: async () => ({ count: 5, quota: 5 }) }))).checks.find((c) => c.id === 'vpc.quota')?.action?.id).toBe('quota-increase')
  })

  it('has no console link on a ready account, and offers an API fix for a stuck rollback and a removed installation\'s sign-in domain', async () => {
    const ready = await preflight(IN, deps())
    expect(JSON.stringify(ready.checks)).not.toMatch(/console\.aws\.amazon\.com/)
    const stuck = await preflight(IN, deps({ stack: async () => ({ status: 'UPDATE_ROLLBACK_FAILED', outputs: {} }) }))
    expect(stuck.checks.find((c) => c.id === 'stack')).toMatchObject({ status: 'fail', action: { id: 'continue-rollback', params: { stack: 'TraceStack' } } })
    const domain = await preflight(IN, deps({ cognitoDomain: async () => ({ userPoolId: 'us-east-1_OLD' }) }))
    expect(domain.checks.find((c) => c.id === 'cognito.domain')).toMatchObject({ action: { id: 'delete-cognito-domain', params: { domain: 'trace-123456789012', userPoolId: 'us-east-1_OLD' } } })
    // another live installation's pool is never offered for deletion
    const live = await preflight(IN, deps({ cognitoDomain: async () => ({ userPoolId: 'us-east-1_OTHER' }), stack: async () => ({ status: 'UPDATE_COMPLETE', outputs: { UserPoolId: 'us-east-1_MINE' } }) }))
    expect(live.checks.find((c) => c.id === 'cognito.domain')?.action).toBeUndefined()
  })

  it('stops on what would fail the deploy, saying what to do', async () => {
    const r = await preflight(IN, deps({
      agentCore: async () => { throw new Error('getaddrinfo ENOTFOUND bedrock-agentcore-control.sa-east-1.amazonaws.com') },
      stack: async () => ({ status: 'ROLLBACK_COMPLETE', outputs: {} }),
      cdk: async () => ({ status: 'UPDATE_COMPLETE', version: 4 }),
    }))
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.id === 'aws.agentcore')).toMatchObject({ status: 'fail', link: 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html' })
    expect(r.checks.find((c) => c.id === 'stack')).toMatchObject({ status: 'fail', action: { id: 'delete-failed-stack', params: { stack: 'TraceStack' } } })
    expect(r.checks.find((c) => c.id === 'cdk.bootstrap')?.detail).toMatch(/version 4: the installer updates it/)
    expect(r.facts.cdkBootstrapped).toBe(false)
    // a removed installation's kept names, and a taken sign-in domain
    const left = await preflight(IN, deps({ leftovers: async () => ['the ECR repository trace-agent', 'the secret trace/github-token'], cognitoDomain: async () => ({ userPoolId: 'us-east-1_OLD' }) }))
    expect(left.checks.find((c) => c.id === 'leftovers')).toMatchObject({ status: 'fail', action: { id: 'clear-leftovers' } })
    expect(left.checks.find((c) => c.id === 'cognito.domain')?.detail).toMatch(/trace-123456789012 belongs to user pool us-east-1_OLD/)
    expect((await preflight({ ...IN, prefix: 'my-aws-lab' }, deps())).checks.find((c) => c.id === 'cognito.domain')?.status).toBe('fail')
  })

  it('names the exact permission a repository is missing, and what that costs', async () => {
    const noHooks: RepoAccess = { repo: 'marc/fw', visible: true, configure: true, administer: false, webhooks: false, missing: ['Administration: read and write', 'Webhooks: read and write'] }
    const noSecrets: RepoAccess = { repo: 'marc/board', visible: true, configure: false, administer: true, webhooks: true, missing: ['Secrets: read and write'] }
    expect(accessNote(noHooks)).toMatch(/lacks Administration: read and write, Webhooks: read and write: its settings and the "trace" ruleset are left alone; with the token as CodeBuild's GitHub credential its build runner can't be made .*so the deploy fails/)
    const r = await preflight({ ...IN, repos: ['marc/board', 'marc/fw'] }, deps({ repo: async (x) => (x === 'marc/fw' ? noHooks : noSecrets) }))
    // the token would be CodeBuild's credential (no connection, none in the account): its runner's webhook can't be made
    expect(r.checks.find((c) => c.id === 'github.repo:marc/fw')?.status).toBe('fail')
    // with an authorized GitHub connection, or a credential the account had already, the token makes no webhook
    const viaConnection = await preflight({ ...IN, repos: ['marc/fw'] }, deps({ repo: async () => noHooks, connections: async () => [{ name: 'trace-github', status: 'AVAILABLE' }] }))
    expect(viaConnection.checks.find((c) => c.id === 'github.repo:marc/fw')?.status).toBe('warn')
    expect(viaConnection.checks.find((c) => c.id === 'codebuild.github')?.detail).toMatch(/through the authorized GitHub connection trace-github: no token stored with CodeBuild, and no console step/)
    expect(viaConnection.facts.runnerConnection).toBe('trace-github')
    // every GitHub connection there, with its ARN and status, for the page to choose from
    const arn = 'arn:aws:codeconnections:us-east-1:123456789012:connection/00000000-0000-0000-0000-000000000001'
    const listed = await preflight({ ...IN, repos: ['marc/fw'] }, deps({ repo: async () => noHooks, connections: async () => [{ name: 'other-org', status: 'AVAILABLE', arn }, { name: 'trace-github', status: 'PENDING', arn: arn.replace(/1$/, '2') }] }))
    expect(listed.facts.githubConnections).toEqual([{ name: 'other-org', status: 'AVAILABLE', arn }, { name: 'trace-github', status: 'PENDING', arn: arn.replace(/1$/, '2') }])
    // automatic picks an authorized one, whoever's it is: which is why the page shows it and lets you choose
    expect(listed.facts.runnerConnection).toBe('other-org')
    expect(r.checks.find((c) => c.id === 'github.repo:marc/board')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Give the token Secrets: read and write on marc\/board \(or add an admin token under Advanced\)/) })
    // with an admin token the same gap only warns
    expect((await preflight({ ...IN, hasAdminToken: true }, deps({ repo: async () => noSecrets }))).checks.find((c) => c.id === 'github.repo:marc/board')?.status).toBe('warn')
    // a classic token without admin, and a new repository that exists already
    const classic = await preflight({ ...IN, create: ['marc/fw'] }, deps({ token: async () => info(['marc/fw'], 'classic') }))
    expect(classic.checks.find((c) => c.id === 'github.create:marc/fw')?.status).toBe('fail')
    // no email visible: asked for, not refused
    const noEmail = await preflight(IN, deps({ email: async () => null }))
    expect(noEmail.checks.find((c) => c.id === 'github.email')).toMatchObject({ status: 'warn', fix: expect.stringMatching(/Email addresses: read/) })
  })

  it('checks per-repository access a few at a time', async () => {
    let open = 0
    let most = 0
    const repos = Array.from({ length: 20 }, (_, i) => `marc/r${i}`)
    await preflight({ ...IN, repos }, deps({
      token: async () => info(repos),
      repo: async (r) => { open++; most = Math.max(most, open); await new Promise((x) => setTimeout(x, 5)); open--; return full(r) },
    }))
    expect(most).toBeLessThanOrEqual(6)
    expect(most).toBeGreaterThan(1)
    const order = await mapLimit([3, 1, 2], 2, async (n) => { await new Promise((x) => setTimeout(x, n * 3)); return n * 10 })
    expect(order).toEqual([30, 10, 20])
  })

  it('accepts only the fixes it knows, with their arguments', () => {
    expect(FixRequest.safeParse({ action: 'quota-increase', service: 'ec2', code: 'L-DB2E81BA', value: 16 }).success).toBe(true)
    expect(FixRequest.safeParse({ action: 'quota-increase', service: 'ec2', code: 'DROP TABLE', value: 16 }).success).toBe(false)
    expect(FixRequest.safeParse({ action: 'delete-failed-stack', stack: 'TraceStack' }).success).toBe(true)
    expect(FixRequest.safeParse({ action: 'bedrock-use-case', form: { companyName: 'x', companyWebsite: 'https://x', intendedUsers: '0', industryOption: 'Tech', useCases: 'agents' } }).success).toBe(true)
    expect(FixRequest.safeParse({ action: 'bedrock-use-case', form: { companyName: '' } }).success).toBe(false)
    expect(FixRequest.safeParse({ action: 'rm -rf' }).success).toBe(false)
  })
})

describe('the plan', () => {
  const a = resolveAnswers(AnswersSchema.parse({ projects: [{ repo: 'marc/board' }] }), { account: '123456789012', login: 'marc', email: 'marc@example.com', gpuQuota: 0 }).answers

  it('says how long it takes, and that trace is usable before the GPU image is made', () => {
    const fresh = timeline(a, null)
    expect(fresh.join('\n')).toMatch(/CDK bootstrap: about 2 minutes/)
    expect(fresh.join('\n')).toMatch(/about 15 minutes of CloudFormation/)
    expect(fresh.join('\n')).toMatch(/about 5 minutes to copy trace's published image/)
    expect(fresh.at(-1)).toMatch(/GPU and CPU jobs are off/)
    const gpu = timeline({ ...a, agents: { ...a.agents, gpuEnabled: true, imageSource: 'build' } }, null, { cdkBootstrapped: true })
    expect(gpu.join('\n')).not.toMatch(/bootstrap/)
    expect(gpu.at(-1)).toMatch(/then trace is ready to use; the GPU image builds in the background \(30–60 minutes the first time\)/)
    expect(timeline(a, { outputs: { Layout: 'nested' } })[0]).toMatch(/a few minutes when only settings or projects change/)
  })

  it('names the runners, integrations and new repositories, and on a re-run only what changed', () => {
    const steps = plan({ ...a, projects: [...a.projects, { repo: 'marc/new-board', branch: 'main', onboard: true, applySettings: true, memoryEventExpiryDays: null, generation: 0, create: { template: 'kicad', private: true } }] })
    expect(steps.find((s) => s.id === 'github')?.detail).toMatch(/import the agents' token as CodeBuild's GitHub source credential.*; create marc\/new-board first, as its runner needs the repository/)
    expect(steps.find((s) => s.id === 'deploy')?.detail).toMatch(/its own AWS CodeBuild runner project that runs every one of its GitHub Actions jobs/)
    expect(steps.find((s) => s.id === 'onboard')?.detail).toMatch(/open \(or refresh\) the onboarding PR in marc\/board; create marc\/new-board \(kicad\)/)
    expect(steps.find((s) => s.id === 'deploy')?.detail).toMatch(/no GPU or CPU jobs/)
    expect(steps.find((s) => s.id === 'integrations')?.detail).toMatch(/tracectl integrations set <name>/)
    // nothing to set up for a repository-less install
    const none = plan({ ...a, projects: [] })
    expect(none.find((s) => s.id === 'repos')?.detail).toMatch(/no repositories yet/)
    // a re-run lists the changes
    const next = { ...a, projects: [{ ...a.projects[0]!, repo: 'marc/fw' }], agents: { ...a.agents, idleMinutes: 30 } }
    expect(changesSince(a, next)).toEqual(['adds marc/fw', expect.stringMatching(/^removes marc\/board/), 'changes idleMinutes 15 → 30'])
    expect(changesSince(a, a)).toEqual([])
    expect(plan(next, { outputs: { Layout: 'nested' } }, a).find((s) => s.id === 'deploy')).toMatchObject({ title: 'Update TraceStack', detail: expect.stringMatching(/^This run adds marc\/fw; removes marc\/board/) })
    expect(plan(a, { outputs: { Layout: 'nested' } }, a).find((s) => s.id === 'deploy')?.detail).toMatch(/^No answer changed since the last run/)
  })
})
