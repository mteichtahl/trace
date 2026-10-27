import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, apiRuntimeName, memoryName, projectHash, projectOutputs, projectSettings, stackName, workerRuntimeName } from '../../src/infra/props.js'
import { ENV_VALUE_MAX, TraceStack, checkRuntimeEnv, idListLength } from '../../src/infra/stack.js'
import { RUNNERS, type Synth, nestedOf, nestedResourceId, parentRef, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const HA = projectHash(A)
const HB = projectHash(B)

const props = InfraPropsSchema.parse({
  account: '123456789012', region: 'us-east-1', repositories: [A, `${B}@develop`],
  model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS,
})

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> }
// a role's inline policy and, once CDK splits a long one, its overflow managed policies (RoleOverflowPolicy<n>)
const statementsOf = (t: Template, prefix: string): Statement[] => Object.entries({ ...t.findResources('AWS::IAM::Policy'), ...t.findResources('AWS::IAM::ManagedPolicy') }).filter(([id]) => id.startsWith(prefix))
  .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
const policyText = (t: Template, prefix: string): string => JSON.stringify(statementsOf(t, prefix))
const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])

/** The object paths a statement's resources name in the central bucket ("/projects/x/y/*"), from their Fn::Join tails. */
const objectPaths = (st: Statement): string[] => {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v && typeof v === 'object') {
      const j = (v as Record<string, unknown>)['Fn::Join'] as [string, unknown[]] | undefined
      if (j) { const tail = j[1].at(-1); if (typeof tail === 'string' && tail.startsWith('/')) out.push(tail); return }
      Object.values(v).forEach(walk)
    }
  }
  walk(st.Resource)
  return out
}
const glob = (pattern: string, path: string): boolean => new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(path)
/**
 * IAM, for one conditional put of the agents' facts (projects/<repo>/journey-agent/facts.db, with If-Match): some
 * statement allows s3:PutObject on it, and no Deny applies to it (a Deny whose condition needs both conditional headers
 * absent does not apply to a conditional put).
 */
function agentFactsWritable(s: Statement[], repo: string): boolean {
  const key = `/projects/${repo}/journey-agent/facts.db`
  const covers = (st: Statement): boolean => actionsOf(st).some((a) => a === 's3:PutObject' || a === 's3:*') && objectPaths(st).some((p) => glob(p, key))
  const conditionalOnly = (st: Statement): boolean => JSON.stringify(st.Condition?.Null) === JSON.stringify({ 's3:if-match': 'true', 's3:if-none-match': 'true' })
  const allowed = s.some((st) => st.Effect !== 'Deny' && covers(st))
  const denied = s.some((st) => st.Effect === 'Deny' && covers(st) && !conditionalOnly(st))
  // the same put without the headers is denied
  const unconditionalDenied = s.some((st) => st.Effect === 'Deny' && covers(st))
  return allowed && !denied && unconditionalDenied
}

let t: Template
let syn: Synth
beforeAll(() => {
  syn = synth(props, stackName(props.prefix))
  t = syn.all
}, 300_000)

/** The logical id of a project's memory in `t`. */
const memoryIdOf = (h: string): string => {
  const ids = Object.keys(t.findResources('AWS::BedrockAgentCore::Memory')).filter((id) => id.startsWith(`Project${h}Memory`))
  expect(ids).toHaveLength(1)
  return ids[0] ?? ''
}
const runtimeEnv = (tpl: Template, name: string): Record<string, unknown> => {
  const r = Object.values(tpl.findResources('AWS::BedrockAgentCore::Runtime') as Record<string, { Properties: Record<string, unknown> }>).find((x) => x.Properties.AgentRuntimeName === name)
  return (r?.Properties.EnvironmentVariables ?? {}) as Record<string, unknown>
}

describe('the trace stack', () => {
  it('names things from the prefix and the project', () => {
    expect(stackName('trace')).toBe('TraceStack')
    expect(stackName('my-lab')).toBe('MyLabStack')
    expect(apiRuntimeName('my-lab')).toBe('my_lab_api')
    expect(workerRuntimeName('my-lab', 'Owner/Repo')).toMatch(/^my_lab_w_[0-9a-f]{8}$/)
    expect(workerRuntimeName('my-lab', 'Owner/Repo')).toBe(workerRuntimeName('my-lab', 'owner/repo'))
    // AgentCore's agentRuntimeName pattern, at the longest prefix
    expect(workerRuntimeName('a'.repeat(21), A)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
    // CloudFormation output names: alphanumeric
    for (const v of Object.values(projectOutputs(A))) expect(v).toMatch(/^[A-Za-z0-9]{1,255}$/)
    expect(() => InfraPropsSchema.parse({ ...props, repositories: [A, `${A.toUpperCase()}@dev`] })).toThrow(/twice/)
  })

  it('has a private, versioned, TLS-only central bucket', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    })
    t.hasResourceProperties('AWS::S3::BucketPolicy', { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) } })
  })

  it('builds the agent image on arm64 with CodeBuild and waits for it', () => {
    t.hasResourceProperties('AWS::CodeBuild::Project', { Environment: Match.objectLike({ Type: 'ARM_CONTAINER', PrivilegedMode: true }) })
  })

  it('runs one worker runtime per project, each with its own role, on IAM, and the API behind Cognito', () => {
    t.resourceCountIs('AWS::BedrockAgentCore::Runtime', 3)
    const runtimes = Object.values(t.findResources('AWS::BedrockAgentCore::Runtime')) as { Properties: Record<string, unknown> }[]
    const workers = runtimes.filter((r) => String(r.Properties.AgentRuntimeName).startsWith('trace_w_'))
    expect(workers.map((r) => r.Properties.AgentRuntimeName).sort()).toEqual([`trace_w_${HA}`, `trace_w_${HB}`].sort())
    expect(new Set(workers.map((r) => JSON.stringify(r.Properties.RoleArn))).size).toBe(2)
    // one image for all of them: the API's, and each nested stack's parameter of it
    const api0 = runtimes.find((r) => r.Properties.AgentRuntimeName === 'trace_api')
    const imageUri = (api0?.Properties.AgentRuntimeArtifact as { ContainerConfiguration: { ContainerUri: unknown } }).ContainerConfiguration.ContainerUri
    expect(imageUri).toEqual({ 'Fn::GetAtt': ['AgentImage', 'ImageUri'] })
    for (const w of workers) {
      const uri = (w.Properties.AgentRuntimeArtifact as { ContainerConfiguration: { ContainerUri: { Ref: string } } }).ContainerConfiguration.ContainerUri
      const h = String(w.Properties.AgentRuntimeName).slice('trace_w_'.length)
      const params = (syn.parent.toJSON().Resources as Record<string, { Properties: { Parameters: Record<string, unknown> } }>)[nestedResourceId(syn, h)]?.Properties.Parameters
      expect(params?.[uri.Ref]).toEqual(imageUri)
    }
    for (const [repo, h] of [[A, HA], [B, HB]] as const) {
      t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
        AgentRuntimeName: `trace_w_${h}`,
        RoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp(`^Project${h}RuntimeRole`), 'Arn'] },
        EnvironmentVariables: Match.objectLike({
          TRACE_AGENT_MODE: 'worker', TRACE_PROJECT: repo, CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: props.model,
          TRACE_GITHUB_SECRET_ARN: { Ref: Match.stringLikeRegexp(`^Project${h}GithubToken`) },
        }),
        Tags: { 'trace:project': repo, 'trace:installation': 'trace' },
        AuthorizerConfiguration: Match.absent(),
        LifecycleConfiguration: { IdleRuntimeSessionTimeout: 900, MaxLifetime: 28_800 },
      })
    }
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'trace_api',
      EnvironmentVariables: Match.objectLike({ TRACE_AGENT_MODE: 'api', TRACE_AWS_ACCOUNT: '123456789012' }),
      AuthorizerConfiguration: { CustomJWTAuthorizer: Match.objectLike({ DiscoveryUrl: Match.anyValue(), AllowedClients: Match.anyValue() }) },
      RequestHeaderConfiguration: { RequestHeaderAllowlist: ['Authorization'] },
    })
    // the API runs no model, and is told every worker as owner/repo=<runtime id>
    const api = runtimes.find((r) => r.Properties.AgentRuntimeName === 'trace_api')
    const env = JSON.stringify(api?.Properties.EnvironmentVariables)
    expect(env).not.toMatch(/ANTHROPIC_MODEL|CLAUDE_CODE_USE_BEDROCK|TRACE_GPU_/)
    expect(policyText(t, 'ApiRuntimeRole')).not.toContain('bedrock:InvokeModel')
    for (const [repo, h] of [[A, HA], [B, HB]] as const) {
      // from the project's nested stack's output of its runtime's id
      expect(env).toContain(`"${repo}",${JSON.stringify(parentRef(syn, h, `Project${h}Runtime`, 'AgentRuntimeId'))}`)
    }
  })

  it("gives each project's worker role that project's prefixes, actors, namespaces, secret and job definition only", () => {
    const cases = [
      { repo: A, h: HA, actor: 'mteichtahl/trace/*', ns: '/trace/mteichtahl/trace/*', other: { repo: B, h: HB, actor: 'pokeys-toolkit/potroller' } },
      { repo: B, h: HB, actor: 'pokeys-toolkit/potroller/*', ns: '/trace/pokeys-toolkit/potroller/*', other: { repo: A, h: HA, actor: 'mteichtahl/trace' } },
    ]
    for (const c of cases) {
      const s = statementsOf(t, `Project${c.h}RuntimeRole`)
      const text = JSON.stringify(s)
      // S3: projects/<slug>/* and jobs/<slug>/* read/write; central/* read and conditional writes only; never access/*
      expect(text).toContain(`/projects/${c.repo}/*`)
      expect(text).toContain(`/jobs/${c.repo}/*`)
      expect(text).toContain('/central/*')
      expect(text).not.toContain('/access/*')
      const centralPuts = s.filter((x) => actionsOf(x).includes('s3:PutObject') && JSON.stringify(x.Resource).includes('/central/*'))
      expect(centralPuts.map((x) => Object.keys(x.Condition?.Null ?? {})[0]).sort()).toEqual(['s3:if-match', 's3:if-none-match'])
      expect(s.filter((x) => actionsOf(x).includes('s3:DeleteObject')).map((x) => JSON.stringify(x.Resource)).join()).not.toContain('/central/')
      const list = s.find((x) => actionsOf(x).includes('s3:ListBucket'))
      expect([...(list?.Condition?.StringLike?.['s3:prefix'] as string[])].sort()).toEqual(['central/*', `jobs/${c.repo}/*`, `projects/${c.repo}/*`])
      // which memory records are inactive (projects/<slug>/memory-state): read through projects/<slug>/*, never written
      const deny = s.filter((x) => x.Sid === 'MemoryStateReadOnly')
      expect(deny).toHaveLength(1)
      expect(deny[0]).toMatchObject({ Effect: 'Deny', Action: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'] })
      expect(JSON.stringify(deny[0]?.Resource)).toContain(`/projects/${c.repo}/memory-state/*`)
      // what people decided and said (projects/<slug>/journey, /chats): read through projects/<slug>/*, never written
      const people = s.find((x) => x.Sid === 'PeopleRecordsReadOnly')
      expect(people).toMatchObject({ Effect: 'Deny', Action: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'] })
      expect(JSON.stringify(people?.Resource)).toContain(`/projects/${c.repo}/journey/*`)
      expect(JSON.stringify(people?.Resource)).toContain(`/projects/${c.repo}/chats/*`)
      // what the agents contribute to the journey (projects/<slug>/journey-agent): written through projects/<slug>/*,
      // which the people-records deny does not cover (journey/* is not journey-agent/*), but only with a conditional
      // put, and never deleted
      expect(JSON.stringify(people?.Resource)).not.toContain('journey-agent')
      expect(agentFactsWritable(s, c.repo)).toBe(true)
      // (the check sees a deny that would cover it: a people-records deny on journey* instead of journey/*)
      expect(agentFactsWritable([...s, { Effect: 'Deny', Action: ['s3:PutObject'], Resource: { 'Fn::Join': ['', ['arn', `/projects/${c.repo}/journey*`]] } }], c.repo)).toBe(false)
      expect(s.find((x) => x.Sid === 'AgentFactsConditional')).toMatchObject({
        Effect: 'Deny', Action: 's3:PutObject', Condition: { Null: { 's3:if-match': 'true', 's3:if-none-match': 'true' } },
      })
      expect(JSON.stringify(s.find((x) => x.Sid === 'AgentFactsConditional')?.Resource)).toContain(`/projects/${c.repo}/journey-agent/*`)
      expect(s.find((x) => x.Sid === 'AgentFactsNoDelete')).toMatchObject({ Effect: 'Deny', Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'] })
      expect(s.filter((x) => x.Effect === 'Deny')).toHaveLength(4)
      // the installation's prompt overrides (prompts/*): read and listed, never written
      expect(s.some((x) => actionsOf(x).includes('s3:GetObject') && JSON.stringify(x.Resource).includes('/prompts/*'))).toBe(true)
      expect(s.filter((x) => actionsOf(x).includes('s3:ListBucket')).flatMap((x) => x.Condition?.StringLike?.['s3:prefix'] as string[])).toContain('prompts/*')
      expect(s.filter((x) => actionsOf(x).some((a) => a === 's3:PutObject' || a === 's3:DeleteObject')).map((x) => JSON.stringify(x.Resource)).join()).not.toContain('/prompts/')
      // memory: its own memory only, and on it still only its own actors and namespaces
      const memoryArn = { 'Fn::GetAtt': [Match.stringLikeRegexp(`^Project${c.h}Memory`), 'MemoryArn'] }
      expect(s).toEqual(expect.arrayContaining([
        expect.objectContaining({ Sid: 'ProjectMemoryEvents', Action: ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents'], Condition: { StringLike: { 'bedrock-agentcore:actorId': c.actor } } }),
        expect.objectContaining({ Sid: 'ProjectMemoryRecords', Action: ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords'], Condition: { StringLike: { 'bedrock-agentcore:namespace': c.ns } } }),
      ]))
      const memoryStatements = s.filter((x) => String(x.Sid).startsWith('ProjectMemory'))
      expect(memoryStatements).toHaveLength(2)
      for (const st of memoryStatements) expect(Match.objectLike({ Resource: memoryArn }).test(st).isSuccess).toBe(true)
      // and no other statement names any memory
      expect(s.filter((x) => JSON.stringify(x).includes('MemoryArn'))).toHaveLength(2)
      // its own secret only, and (no library gateway) the installation's optional integrations
      const secretReads = s.filter((x) => actionsOf(x).includes('secretsmanager:GetSecretValue') && x.Sid !== 'IntegrationsRead')
      expect(secretReads).toHaveLength(1)
      expect(JSON.stringify(secretReads[0]?.Resource)).toMatch(new RegExp(`^\\{"Ref":"Project${c.h}GithubToken`))
      const integrations = s.filter((x) => x.Sid === 'IntegrationsRead')
      expect(integrations).toHaveLength(1)
      expect(actionsOf(integrations[0] as Statement)).toEqual(['secretsmanager:GetSecretValue'])
      expect(JSON.stringify(integrations[0]?.Resource)).toMatch(/:secret:trace\/integrations\/\*/)
      // Batch: its own job definition on the shared queue, only tagged with its project
      const submit = s.find((x) => x.Sid === 'ProjectGpuSubmit')
      expect(JSON.stringify(submit?.Resource)).toContain(`job-definition/trace-gpu-${c.h}`)
      expect(JSON.stringify(submit?.Resource)).toMatch(/GpuQueue/)
      expect(submit?.Condition).toEqual({ StringEquals: { 'aws:RequestTag/trace:project': c.repo } })
      expect(s.find((x) => x.Sid === 'ProjectGpuTerminate')?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/trace:project': c.repo } })
      expect(s.find((x) => x.Sid === 'ProjectGpuTag')?.Condition?.StringEqualsIfExists).toEqual({ 'aws:ResourceTag/trace:project': c.repo })
      // waiting on its jobs' events: its own wait queues by name, and its own topic, with those queues as the only endpoint
      const ownTopic = new RegExp(`^\\{"Ref":"Project${c.h}JobEvents[0-9A-F]{8}"\\}$`)
      const waitQueues = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:sqs:us-east-1:123456789012:trace-${c.h}-wait-*`]] }
      const queues = s.find((x) => x.Sid === 'ProjectGpuWaitQueues')
      expect(queues?.Action).toEqual(['sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:SetQueueAttributes', 'sqs:TagQueue'])
      expect(queues?.Resource).toEqual(waitQueues)
      // ListQueues has no resource-level permission: a statement of its own, nothing else with it
      expect(s.find((x) => x.Sid === 'ProjectGpuWaitListQueues')).toMatchObject({ Action: 'sqs:ListQueues', Resource: '*' })
      expect(s.filter((x) => actionsOf(x).some((a) => a.startsWith('sqs:')))).toHaveLength(2)
      const listSubs = s.find((x) => x.Sid === 'ProjectGpuWaitListSubscriptions')
      expect(listSubs?.Action).toBe('sns:ListSubscriptionsByTopic')
      expect(JSON.stringify(listSubs?.Resource)).toMatch(ownTopic)
      const sub = s.find((x) => x.Sid === 'ProjectGpuWaitSubscribe')
      expect(sub?.Action).toBe('sns:Subscribe')
      expect(JSON.stringify(sub?.Resource)).toMatch(ownTopic)
      expect(sub?.Condition).toEqual({ StringEquals: { 'sns:Protocol': 'sqs' }, StringLike: { 'sns:Endpoint': waitQueues } })
      const unsub = s.find((x) => x.Sid === 'ProjectGpuWaitUnsubscribe')
      expect(unsub?.Action).toBe('sns:Unsubscribe')
      const topicRef = { Ref: expect.stringMatching(new RegExp(`^Project${c.h}JobEvents`)) }
      expect(unsub?.Resource).toEqual([topicRef, { 'Fn::Join': ['', [topicRef, ':*']] }])
      // no statement names any other project's topic
      expect(text).not.toMatch(new RegExp(`Project${c.other.h}JobEvents`))
      expect(text).not.toContain(`${c.other.h}-batch-events`)
      expect(s.filter((x) => actionsOf(x).some((a) => a.startsWith('sns:')))).toHaveLength(3)
      // telemetry: its own runtime's log group
      expect(text).toContain(`/aws/bedrock-agentcore/runtimes/trace_w_${c.h}-*`)
      expect(text).not.toContain('/aws/bedrock-agentcore/runtimes/*')
      expect(text).toContain('xray:PutTraceSegments')
      // never the other project's anything, nor people, nor the API's token
      for (const never of [c.other.repo, c.other.h, c.other.actor, 'cognito-idp', 'TraceMemoryRecordsRead']) expect(text).not.toContain(never)
      for (const never of ['DeleteEvent', 'DeleteMemoryRecord', 'BatchCreateMemoryRecords', 'BatchUpdateMemoryRecords', 'GetMemoryRecord', 'CreateMemory', 'bedrock-agentcore:*', 'InvokeAgentRuntime']) expect(text).not.toContain(never)
    }
  })

  it("lets only each repository's default branch assume its own OIDC role, and only to invoke its own worker", () => {
    for (const [h, sub, repo] of [[HA, 'repo:mteichtahl/trace:ref:refs/heads/main', A], [HB, 'repo:pokeys-toolkit/potroller:ref:refs/heads/develop', B]] as const) {
      const roles = Object.entries(t.findResources('AWS::IAM::Role')).filter(([id]) => id.startsWith(`Project${h}ActionsRole`))
      expect(roles).toHaveLength(1)
      expect(roles[0]?.[1]).toMatchObject({ Properties: { RoleName: `trace-gh-${h}-us-east-1`, AssumeRolePolicyDocument: { Statement: [expect.objectContaining({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' }, StringLike: { 'token.actions.githubusercontent.com:sub': sub } },
      })] } } })
      const s = statementsOf(t, `Project${h}ActionsRole`)
      const invoke = s.filter((x) => actionsOf(x).includes('bedrock-agentcore:InvokeAgentRuntime'))
      expect(invoke).toHaveLength(1)
      expect(JSON.stringify(invoke[0]?.Resource)).toContain(`Project${h}Runtime`)
      const text = JSON.stringify(s)
      expect(text).not.toContain(h === HA ? HB : HA)
      expect(text).not.toContain(h === HA ? B : A)
      expect(text).toContain(`/projects/${repo}/*`)
      // the workflows cannot change which memory records are inactive either
      expect(s.find((x) => x.Sid === 'MemoryStateReadOnly')).toMatchObject({ Effect: 'Deny', Action: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'] })
      expect(JSON.stringify(s.find((x) => x.Sid === 'MemoryStateReadOnly')?.Resource)).toContain(`/projects/${repo}/memory-state/*`)
      // nor the journey record or the chats
      expect(s.find((x) => x.Sid === 'PeopleRecordsReadOnly')).toMatchObject({ Effect: 'Deny' })
      expect(JSON.stringify(s.find((x) => x.Sid === 'PeopleRecordsReadOnly')?.Resource)).toContain(`/projects/${repo}/journey/*`)
      // but they write the agents' facts (the worker.runner = actions fallback), conditionally, as the worker does
      expect(agentFactsWritable(s, repo)).toBe(true)
      expect(s.find((x) => x.Sid === 'AgentFactsConditional')).toMatchObject({ Effect: 'Deny', Condition: { Null: { 's3:if-match': 'true', 's3:if-none-match': 'true' } } })
      expect(text).not.toContain('/access/*')
      // the workflows read the installation's prompt overrides, and cannot write them
      expect(s.some((x) => actionsOf(x).includes('s3:GetObject') && JSON.stringify(x.Resource).includes('/prompts/*'))).toBe(true)
      expect(s.filter((x) => actionsOf(x).includes('s3:PutObject')).map((x) => JSON.stringify(x.Resource)).join()).not.toContain('/prompts/')
      expect(text).not.toContain('/jobs/')
      expect(text).not.toContain('TraceMemory')
      // memory: the worker's own grants, for the worker.runner = actions fallback: its own memory, actors, namespaces
      const ns = `/trace/${repo}/*`
      const mem = s.filter((x) => String(x.Sid).startsWith('ProjectMemory'))
      expect(mem.map((x) => [x.Sid, x.Condition])).toEqual([
        ['ProjectMemoryEvents', { StringLike: { 'bedrock-agentcore:actorId': `${repo}/*` } }],
        ['ProjectMemoryRecords', { StringLike: { 'bedrock-agentcore:namespace': ns } }],
      ])
      for (const st of mem) expect(st.Resource).toEqual({ 'Fn::GetAtt': [memoryIdOf(h), 'MemoryArn'] })
      expect(s.filter((x) => JSON.stringify(x).includes('MemoryArn'))).toHaveLength(2)
      for (const never of ['DeleteEvent', 'DeleteMemoryRecord', 'BatchCreateMemoryRecords', 'GetMemoryRecord', 'CreateMemory', 'bedrock-agentcore:*']) expect(text).not.toContain(never)
    }
    // no installation-wide actions role any more
    expect(Object.keys(t.findResources('AWS::IAM::Role')).some((id) => id.startsWith('ActionsRole'))).toBe(false)
  })

  it('lets the API invoke every project worker, read every project\'s memory records, and reach people', () => {
    const s = statementsOf(t, 'ApiRuntimeRole')
    // each worker by its exact ARN (no name pattern another installation's runtimes could match), and on the runtime
    // also by this installation's tag; the endpoints (DEFAULT, untagged by the stack) by their runtime's exact ARN
    const invoke = s.find((x) => x.Sid === 'InvokeProjectWorkers')
    const arns = [HA, HB].map((h) => parentRef(syn, h, `Project${h}Runtime`, 'AgentRuntimeArn'))
    expect(invoke).toMatchObject({ Action: 'bedrock-agentcore:InvokeAgentRuntime', Resource: arns, Condition: { StringEquals: { 'aws:ResourceTag/trace:installation': 'trace' } } })
    const endpoints = s.find((x) => x.Sid === 'InvokeProjectWorkerEndpoints')
    expect(endpoints).toMatchObject({ Action: 'bedrock-agentcore:InvokeAgentRuntime', Resource: arns.map((a) => ({ 'Fn::Join': ['', [a, '/runtime-endpoint/*']] })) })
    expect(endpoints?.Condition).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('trace_w_*')
    expect(s.filter((x) => actionsOf(x).includes('bedrock-agentcore:InvokeAgentRuntime'))).toHaveLength(2)
    // and every runtime carries the tag (the API's own too)
    for (const r of Object.values(t.findResources('AWS::BedrockAgentCore::Runtime') as Record<string, { Properties: { Tags?: Record<string, string> } }>)) expect(r.Properties.Tags?.['trace:installation']).toBe('trace')
    const text = JSON.stringify(s)
    expect(text).toContain('cognito-idp:AdminAddUserToGroup')
    // users.class and removal from a person's last project end their sessions
    expect(text).toContain('cognito-idp:AdminUserGlobalSignOut')
    expect(text).toContain('/access/*')
    expect(text).toContain('/central/*')
    expect(text).not.toMatch(/"Resource":"\*","Action":"cognito/)
    // memory: records of every project's memory, read only (GetMemoryRecord to verify one before marking it inactive); no events, no record writes
    const read = s.find((x) => x.Sid === 'TraceMemoryRecordsRead')
    expect(read).toMatchObject({ Action: ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:GetMemoryRecord'], Condition: { StringLike: { 'bedrock-agentcore:namespace': '/trace/*' } } })
    for (const never of ['BatchUpdateMemoryRecords', 'BatchCreateMemoryRecords', 'DeleteMemoryRecord']) expect(text).not.toContain(never)
    // which records are inactive: projects/*/memory-state/* only — read, and conditional puts; no deletes, nothing else of projects/
    const MS = 'projects/*/memory-state/*'
    const msPuts = s.filter((x) => actionsOf(x).includes('s3:PutObject') && JSON.stringify(x.Resource).includes(`/${MS}`))
    expect(msPuts.map((x) => Object.keys(x.Condition?.Null ?? {})[0]).sort()).toEqual(['s3:if-match', 's3:if-none-match'])
    expect(s.some((x) => actionsOf(x).includes('s3:GetObject') && JSON.stringify(x.Resource).includes(`/${MS}`))).toBe(true)
    expect(s.filter((x) => actionsOf(x).includes('s3:DeleteObject')).map((x) => JSON.stringify(x.Resource)).join()).not.toContain('memory-state')
    expect(s.filter((x) => actionsOf(x).includes('s3:ListBucket')).flatMap((x) => x.Condition?.StringLike?.['s3:prefix'] as string[]).sort()).toEqual(['central/*', 'installation/pending-projects/*', 'projects/*/chats/*', 'projects/*/journey-agent/*', 'projects/*/journey/*', MS, 'prompts/*'])
    // the agents' facts (projects/*/journey-agent/*): read, never written or deleted by the API
    const AF = 'projects/*/journey-agent/*'
    expect(s.some((x) => actionsOf(x).includes('s3:GetObject') && JSON.stringify(x.Resource).includes(`/${AF}`))).toBe(true)
    expect(s.filter((x) => actionsOf(x).some((a) => a === 's3:PutObject' || a === 's3:DeleteObject')).map((x) => JSON.stringify(x.Resource)).join()).not.toContain('journey-agent')
    // the installation's prompt overrides (prompts.set, admins): read, and conditional puts only; no deletes
    const promptPuts = s.filter((x) => actionsOf(x).includes('s3:PutObject') && JSON.stringify(x.Resource).includes('/prompts/*'))
    expect(promptPuts.map((x) => Object.keys(x.Condition?.Null ?? {})[0]).sort()).toEqual(['s3:if-match', 's3:if-none-match'])
    expect(s.filter((x) => actionsOf(x).includes('s3:DeleteObject')).map((x) => JSON.stringify(x.Resource)).join()).not.toContain('/prompts/')
    expect(read?.Resource).toEqual(expect.arrayContaining([HA, HB].map((h) => parentRef(syn, h, memoryIdOf(h), 'MemoryArn'))))
    expect(read?.Resource).toHaveLength(2)
    expect(text).not.toContain('CreateEvent')
    // no GPU, no project data, no project tokens (but each project's chats, kept outside its repository, and the projects
    // waiting to be created: conditional writes, as above)
    const rest = text.replaceAll('/projects/*/chats/*', '').replaceAll('projects/*/chats/*', '').replaceAll('/projects/*/journey/*', '').replaceAll('projects/*/journey/*', '')
      .replaceAll('/projects/*/journey-agent/*', '').replaceAll('projects/*/journey-agent/*', '').replaceAll('pending-projects/*', '')
    for (const never of ['batch:', '/jobs/', '/projects/', `Project${HA}GithubToken`, `Project${HB}GithubToken`]) expect(rest.replaceAll(MS, '')).not.toContain(never)
    expect(rest.replaceAll(MS, '')).not.toContain('projects/')
  })

  it('has a Cognito pool without self sign-up, the admin/user/guest groups, and the first admin', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }) })
    for (const g of ['trace-admins', 'trace-users', 'trace-guests']) t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: g })
    t.hasResourceProperties('AWS::Cognito::UserPoolUser', { Username: 'marc@example.com' })
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false, CallbackURLs: ['http://localhost:47821/callback', 'http://localhost:47822/callback'] })
    // identity is the sub; an email change waits for verification, and the clients may write nothing else
    t.hasResourceProperties('AWS::Cognito::UserPool', { UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] } })
    for (const c of Object.values(t.findResources('AWS::Cognito::UserPoolClient') as Record<string, { Properties: { WriteAttributes?: string[] } }>)) expect(c.Properties.WriteAttributes).toEqual(['email'])
    // the invitation points at the app's /invite page, where the temporary password is entered (no secret in a link)
    const pool = Object.values(t.findResources('AWS::Cognito::UserPool') as Record<string, { Properties: { AdminCreateUserConfig: { InviteMessageTemplate: { EmailMessage: unknown } } } }>)[0]!
    const body = JSON.stringify(pool.Properties.AdminCreateUserConfig.InviteMessageTemplate.EmailMessage)
    expect(body).toContain('/invite and enter this email address and the temporary password')
    expect(body).toContain('{####}')
  })

  it('keeps the GitHub tokens out of the template: the API\'s shared secret, and one per project', () => {
    const json = JSON.stringify(t.toJSON())
    expect(json).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/)
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'trace/github-token' })
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: `trace/github-token/${A}` })
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: `trace/github-token/${B}` })
    expect(policyText(t, 'ApiRuntimeRole')).toMatch(/"Ref":"GithubToken/)
  })

  it('runs GPU jobs on one Batch queue of GPU instances that scales to zero, with one job definition per project', () => {
    t.hasResourceProperties('AWS::Batch::ComputeEnvironment', {
      Type: 'managed',
      ComputeResources: Match.objectLike({
        Type: 'EC2', MinvCpus: 0, MaxvCpus: 16, InstanceTypes: ['g6.xlarge', 'g5.xlarge', 'g4dn.xlarge'],
        Ec2Configuration: [{ ImageType: 'ECS_AL2023_NVIDIA' }],
      }),
    })
    // the GPU queue and environment, and the CPU ones beside them (test/infra/projects.test.ts)
    t.resourceCountIs('AWS::Batch::JobQueue', 2)
    t.resourceCountIs('AWS::Batch::ComputeEnvironment', 2)
    t.resourceCountIs('AWS::Batch::JobDefinition', 4)
    t.hasResourceProperties('AWS::Batch::JobQueue', { JobQueueName: 'trace-gpu' })
    for (const [repo, h] of [[A, HA], [B, HB]] as const) {
      t.hasResourceProperties('AWS::Batch::JobDefinition', {
        JobDefinitionName: `trace-gpu-${h}`,
        ContainerProperties: Match.objectLike({
          Command: ['node', '/app/dist/gpu/runner.js'],
          ResourceRequirements: Match.arrayWith([{ Type: 'GPU', Value: '1' }]),
          JobRoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp(`^Project${h}GpuJobRole`), 'Arn'] },
          Environment: Match.arrayWith([{ Name: 'TRACE_PROJECT', Value: repo }]),
        }),
      })
      // the job role: that project's jobs/ prefix only
      const job = policyText(t, `Project${h}GpuJobRole`)
      expect(job).toContain(`/jobs/${repo}/*`)
      expect(job).not.toContain(h === HA ? B : A)
      expect(job).not.toContain('/central/*')
    }
    t.resourceCountIs('AWS::EC2::NatGateway', 0)
    t.hasResourceProperties('AWS::CodeBuild::Project', { Environment: Match.objectLike({ Type: 'LINUX_CONTAINER', PrivilegedMode: true }) })
    t.resourceCountIs('AWS::CloudFormation::CustomResource', 2) // the agent image and the GPU image
  })

  it("sends each project its own jobs' state changes, on its own topic that only its own rule may publish to", () => {
    // none in the parent: each project's are in its nested stack
    syn.parent.resourceCountIs('AWS::SNS::Topic', 0)
    syn.parent.resourceCountIs('AWS::Events::Rule', 0)
    t.resourceCountIs('AWS::SNS::Topic', 2)
    // each project's two rules: its Batch jobs' state changes and its journey record's writes (journey.ask's wait)
    t.resourceCountIs('AWS::Events::Rule', 4)
    t.resourceCountIs('AWS::SNS::TopicPolicy', 2)
    for (const [repo, h, oh] of [[A, HA, HB], [B, HB, HA]] as const) {
      const n = nestedOf(syn, repo)
      n.hasResourceProperties('AWS::SNS::Topic', { TopicName: `trace-${h}-batch-events`, Tags: [{ Key: 'trace:project', Value: repo }] })
      const all = Object.entries(n.findResources('AWS::Events::Rule')) as [string, { Properties: { Name: string; EventPattern: Record<string, unknown>; Targets: { Arn: unknown }[] } }][]
      expect(all).toHaveLength(2)
      const rules = all.filter(([id]) => id.startsWith(`Project${h}JobEventsRule`))
      expect(rules).toHaveLength(1)
      const [ruleId, rule] = rules[0] as (typeof rules)[number]
      expect(rule.Properties.Name).toBe(`trace-${h}-batch-events`)
      expect(rule.Properties.EventPattern).toMatchObject({ source: ['aws.batch'], 'detail-type': ['Batch Job State Change'] })
      expect(Object.keys(rule.Properties.EventPattern).sort()).toEqual(['detail', 'detail-type', 'source'])
      const detail = rule.Properties.EventPattern.detail as { jobQueue: unknown[]; jobDefinition: unknown[] }
      expect(Object.keys(detail).sort()).toEqual(['jobDefinition', 'jobQueue'])
      // the stack's two queues (the nested stack's parameters of them)
      expect(detail.jobQueue).toHaveLength(2)
      for (const q of detail.jobQueue) expect(q).toEqual({ Ref: expect.stringMatching(/Queue/) })
      // only its own definitions, GPU and CPU, by ARN prefix without the revision
      const defs = JSON.stringify(detail.jobDefinition)
      expect(detail.jobDefinition).toHaveLength(2)
      for (const d of [`trace-gpu-${h}:`, `trace-cpu-${h}:`]) expect(defs).toContain(`:job-definition/${d}`)
      expect(defs).not.toContain(oh)
      for (const d of detail.jobDefinition) expect(Object.keys(d as object)).toEqual(['prefix'])
      expect(rule.Properties.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(new RegExp(`^Project${h}JobEvents`)) } })])
      // its topic: published to by EventBridge for its own rule only
      const policies = Object.values(n.findResources('AWS::SNS::TopicPolicy')) as { Properties: { Topics: unknown[]; PolicyDocument: { Statement: Statement[] } } }[]
      expect(policies).toHaveLength(1)
      expect(policies[0]?.Properties.Topics).toEqual([{ Ref: expect.stringMatching(new RegExp(`^Project${h}JobEvents`)) }])
      const allow = policies[0]?.Properties.PolicyDocument.Statement.filter((x) => x.Effect === 'Allow') ?? []
      const [journeyId, journeyRule] = all.find(([id]) => id.startsWith(`Project${h}JourneyEventsRule`)) ?? []
      expect(allow).toEqual([
        expect.objectContaining({ Principal: { Service: 'events.amazonaws.com' }, Action: 'sns:Publish', Condition: { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': [ruleId, 'Arn'] } } } }),
        expect.objectContaining({ Principal: { Service: 'events.amazonaws.com' }, Action: 'sns:Publish', Condition: { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': [journeyId, 'Arn'] } } } }),
      ])
      // its journey record's and its job index's writes: the bucket's Object Created events of those two keys, to its own topic
      expect(journeyRule?.Properties.Name).toBe(`trace-${h}-journey-events`)
      expect(journeyRule?.Properties.EventPattern).toEqual({
        source: ['aws.s3'], 'detail-type': ['Object Created'],
        detail: { bucket: { name: [expect.anything()] }, object: { key: [`projects/${repo}/journey/journey.db`, `projects/${repo}/journey-agent/jobs.db`] } },
      })
      expect(journeyRule?.Properties.Targets).toEqual([expect.objectContaining({ Arn: { Ref: expect.stringMatching(new RegExp(`^Project${h}JobEvents`)) } })])
      expect(ruleId).toMatch(new RegExp(`^Project${h}JobEventsRule`))
      // its worker is told its own topic
      n.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { EnvironmentVariables: Match.objectLike({ TRACE_BATCH_EVENTS_TOPIC: { Ref: Match.stringLikeRegexp(`^Project${h}JobEvents`) } }) })
    }
    // no role anywhere names a project's topic but that project's own worker role
    for (const [id, p] of Object.entries(t.findResources('AWS::IAM::Policy'))) {
      const body = JSON.stringify(p)
      for (const h of [HA, HB]) if (body.includes(`Project${h}JobEvents`)) expect(id, `${id} names ${h}'s topic`).toMatch(new RegExp(`^Project${h}RuntimeRole`))
    }
  })

  it('tells each worker its queue, job definition and bucket', () => {
    for (const h of [HA, HB]) {
      t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
        AgentRuntimeName: `trace_w_${h}`,
        EnvironmentVariables: Match.objectLike({ TRACE_GPU_QUEUE: Match.anyValue(), TRACE_GPU_JOB_DEFINITION: `trace-gpu-${h}`, TRACE_GPU_BUCKET: Match.anyValue() }),
      })
    }
  })

  it('creates none of the GPU side when gpu.enabled is false', () => {
    const off = InfraPropsSchema.parse({ ...props, gpu: { enabled: false } })
    const t2 = synth(off, 'NoGpu').all
    for (const r of ['AWS::Batch::ComputeEnvironment', 'AWS::Batch::JobQueue', 'AWS::Batch::JobDefinition', 'AWS::EC2::VPC']) t2.resourceCountIs(r, 0)
    t2.resourceCountIs('AWS::CloudFormation::CustomResource', 1)
    // each project keeps its events topic for its journey record's writes (journey.ask's wait), with no Batch rule
    t2.resourceCountIs('AWS::SNS::Topic', 2)
    const rules = Object.values(t2.findResources('AWS::Events::Rule')) as { Properties: { EventPattern: { source: string[] } } }[]
    expect(rules.map((r) => r.Properties.EventPattern.source)).toEqual([['aws.s3'], ['aws.s3']])
    const json = JSON.stringify(t2.toJSON())
    expect(json).not.toContain('TRACE_GPU_QUEUE')
    expect(json).not.toContain('batch:SubmitJob')
    expect(json).not.toContain('aws.batch')
    const outputs = Object.keys(t2.toJSON().Outputs as Record<string, unknown>)
    expect(outputs).not.toContain('GpuJobQueue')
    expect(outputs).not.toContain(projectOutputs(A).jobDefinition)
  }, 300_000)

  it('exports what the installer needs, per project by hash', () => {
    const parentOutputs = syn.parent.toJSON().Outputs as Record<string, { Value: unknown }>
    const outputs = Object.keys(parentOutputs)
    for (const o of ['TraceHome', 'GithubSecretArn', 'ApiRuntimeArn', 'UserPoolId', 'UserPoolClientId', 'CognitoDomain', 'GpuJobQueue', 'Layout']) expect(outputs).toContain(o)
    expect(parentOutputs.Layout?.Value).toBe('nested')
    for (const o of ['CpuJobQueue', 'GpuImageBuild']) expect(outputs).toContain(o)
    // the parent carries none of a project's outputs: the installer reads them from its nested stack, which has them
    // all under the names they always had, and the repository it is the project of
    for (const [repo, h] of [[A, HA], [B, HB]] as const) {
      const o = projectOutputs(repo)
      for (const k of Object.values(o)) expect(outputs).not.toContain(k)
      const own = nestedOf(syn, repo).toJSON().Outputs as Record<string, { Value: unknown }>
      for (const k of [...Object.values(o), `Project${h}LogGroup`, `Project${h}MemoryLogGroup`, 'Repository']) expect(Object.keys(own)).toContain(k)
      expect(own.Repository?.Value).toBe(repo)
      expect(own[o.runtimeArn]?.Value).toEqual({ 'Fn::GetAtt': [Object.keys(nestedOf(syn, repo).findResources('AWS::BedrockAgentCore::Runtime'))[0], 'AgentRuntimeArn'] })
    }
    expect(outputs.filter((k) => /^Project[0-9a-f]{8}/.test(k))).toEqual([])
    // the installation-wide memory is gone: each project has its own (Project<hash>MemoryId)
    for (const gone of ['AgentRuntimeArn', 'ActionsRoleArn', 'GpuJobDefinition', 'MemoryId', 'LegacyMemoryId']) expect(outputs).not.toContain(gone)
    expect((nestedOf(syn, A).toJSON().Outputs as Record<string, { Value: unknown }>)[projectOutputs(A).memoryId]?.Value).toEqual({ 'Fn::GetAtt': [memoryIdOf(HA), 'MemoryId'] })
  })

  it('adds and removes a project\'s resources with the repository list', () => {
    const one = synth(InfraPropsSchema.parse({ ...props, repositories: [A] }), 'One').all
    one.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2)
    one.resourceCountIs('AWS::Batch::JobDefinition', 2) // its GPU and CPU ones
    expect(JSON.stringify(one.toJSON())).not.toContain(HB)
    // removing a project never takes data with it (retainData, the default): the bucket is not the project's, and its
    // memory is kept in the account (Retain applies on removal from the template as on stack deletion)
    const bucket = Object.values(one.findResources('AWS::S3::Bucket') as Record<string, { DeletionPolicy?: string }>)[0]
    expect(bucket?.DeletionPolicy).toBe('Retain')
    one.resourceCountIs('AWS::BedrockAgentCore::Memory', 1)
    for (const m of Object.values(t.findResources('AWS::BedrockAgentCore::Memory') as Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>)) {
      expect(m).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' })
    }
    // its token copy goes with it
    const secrets = Object.entries(one.findResources('AWS::SecretsManager::Secret') as Record<string, { DeletionPolicy?: string }>)
    expect(secrets.find(([id]) => id.startsWith(`Project${HA}`))?.[1].DeletionPolicy).toBe('Delete')
    expect(() => new TraceStack(new App(), 'Many', InfraPropsSchema.parse({ ...props, repositories: Array.from({ length: 61 }, (_, i) => `o/r${i}`) }))).toThrow()
  }, 300_000)

  it('has one AgentCore memory per project, each with the semantic, summary and preference strategies, namespaced by actor', () => {
    t.resourceCountIs('AWS::BedrockAgentCore::Memory', 2)
    for (const [repo, h] of [[A, HA], [B, HB]] as const) {
      expect(memoryName('trace', repo)).toBe(`trace_m_${h}`)
      t.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
        Name: `trace_m_${h}`,
        EventExpiryDuration: 30,
        MemoryStrategies: [
          { SemanticMemoryStrategy: Match.objectLike({ Name: 'trace_facts', NamespaceTemplates: ['/trace/{actorId}/facts/'] }) },
          { SummaryMemoryStrategy: Match.objectLike({ Name: 'trace_sessions', NamespaceTemplates: ['/trace/{actorId}/sessions/{sessionId}/'] }) },
          { UserPreferenceMemoryStrategy: Match.objectLike({ Name: 'trace_preferences', NamespaceTemplates: ['/trace/{actorId}/preferences/'] }) },
        ],
        Tags: { 'trace:project': repo, 'trace:installation': 'trace' },
      })
      // each worker is told its own memory
      t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { AgentRuntimeName: `trace_w_${h}`, EnvironmentVariables: Match.objectLike({ TRACE_MEMORY_ID: { 'Fn::GetAtt': [memoryIdOf(h), 'MemoryId'] } }) })
    }
    // CfnMemory's Name pattern, at the longest prefix
    expect(memoryName('a'.repeat(21), A)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
    // the API is told every project's memory as owner/repo=<memory id>, and none as its own
    const api = JSON.stringify(runtimeEnv(t, 'trace_api'))
    expect(api).not.toContain('"TRACE_MEMORY_ID"')
    for (const [repo, h] of [[A, HA], [B, HB]] as const) expect(api).toContain(`"${repo}",${JSON.stringify(parentRef(syn, h, memoryIdOf(h), 'MemoryId'))}`)
    expect(api).toContain('TRACE_PROJECT_MEMORIES')
    // the installation-wide memory is gone
    expect(Object.keys(t.findResources('AWS::BedrockAgentCore::Memory')).some((id) => id.startsWith('AgentMemory'))).toBe(false)
    expect(JSON.stringify(t.toJSON())).not.toContain('trace_memory')
  })

  it('lets one project keep its memory events longer, defaulting from memory.eventExpiryDays', () => {
    const cfg = InfraPropsSchema.parse({ ...props, memory: { eventExpiryDays: 90 }, projectSettings: { [B.toUpperCase()]: { memoryEventExpiryDays: 7 } } })
    expect(projectSettings(cfg, A).memoryEventExpiryDays).toBe(90)
    expect(projectSettings(cfg, B).memoryEventExpiryDays).toBe(7)
    const custom = synth(cfg, 'MemoryDays').all
    custom.hasResourceProperties('AWS::BedrockAgentCore::Memory', { Name: `trace_m_${HA}`, EventExpiryDuration: 90 })
    custom.hasResourceProperties('AWS::BedrockAgentCore::Memory', { Name: `trace_m_${HB}`, EventExpiryDuration: 7 })
    expect(() => InfraPropsSchema.parse({ ...props, memory: { eventExpiryDays: 2 } })).toThrow()
    expect(() => InfraPropsSchema.parse({ ...props, projectSettings: { [A]: { memoryEventExpiryDays: 366 } } })).toThrow()
    expect(() => InfraPropsSchema.parse({ ...props, projectSettings: { 'other/repo': { memoryEventExpiryDays: 10 } } })).toThrow(/not one of the repositories/)
    expect(() => InfraPropsSchema.parse({ ...props, projectSettings: { [A]: {}, [A.toUpperCase()]: {} } })).toThrow(/twice/)
  }, 300_000)

  it('deletes each project\'s memory, its log group and its log delivery with the stack or the project when retainData is false', () => {
    const t2 = synth(InfraPropsSchema.parse({ ...props, retainData: false }), 'NoRetain').all
    const kinds = ['AWS::BedrockAgentCore::Memory', 'AWS::Logs::DeliverySource', 'AWS::Logs::DeliveryDestination', 'AWS::Logs::Delivery']
    for (const [tpl, policy] of [[t, 'Retain'], [t2, 'Delete']] as const) {
      for (const kind of kinds) {
        const rs = Object.values(tpl.findResources(kind) as Record<string, { DeletionPolicy?: string }>)
        expect(rs.length, kind).toBe(kind === 'AWS::BedrockAgentCore::Memory' ? 2 : 4)
        for (const r of rs) expect(r.DeletionPolicy ?? 'Delete', kind).toBe(policy)
      }
      const groups = Object.entries(tpl.findResources('AWS::Logs::LogGroup') as Record<string, { DeletionPolicy?: string }>).filter(([id]) => /MemoryLogs/.test(id))
      expect(groups).toHaveLength(2)
      for (const [, g] of groups) expect(g.DeletionPolicy).toBe(policy)
    }
  }, 300_000)

  it('keeps the installation-wide memory of earlier versions, unused and Retain, when asked to on the way out', () => {
    const t2 = synth(InfraPropsSchema.parse({ ...props, memory: { legacySharedMemory: true } }), 'Legacy').all
    const legacy = Object.entries(t2.findResources('AWS::BedrockAgentCore::Memory') as Record<string, { DeletionPolicy?: string; Properties: { Name: string } }>).filter(([id]) => id.startsWith('AgentMemory'))
    expect(legacy).toHaveLength(1)
    // the same construct path (AgentMemory/Memory, so the same logical id) and name as before: CloudFormation updates
    // it in place rather than replacing it
    expect(legacy[0]?.[0]).toBe('AgentMemoryF0943253')
    expect(legacy[0]?.[1]).toMatchObject({ DeletionPolicy: 'Retain', Properties: { Name: 'trace_memory' } })
    const id = legacy[0]?.[0] ?? ''
    // nothing uses it: no runtime is told it and no role may reach it
    const json = JSON.stringify({ ...t2.toJSON(), Outputs: {} })
    expect(json).not.toContain(`{"Fn::GetAtt":["${id}"`)
    expect(json).not.toContain(`{"Ref":"${id}"}`)
    expect(Object.keys(t2.toJSON().Outputs as Record<string, unknown>)).toContain('LegacyMemoryId')
  }, 300_000)

  it('refuses a runtime environment AgentCore would refuse: more than 50 entries, or a value over 5000 characters', () => {
    expect(() => checkRuntimeEnv('x', Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`K${i}`, 'v'])), 1)).not.toThrow()
    expect(() => checkRuntimeEnv('x', Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`K${i}`, 'v'])), 2)).toThrow(/51 environment variables/)
    expect(() => checkRuntimeEnv('x', { K: 'v'.repeat(ENV_VALUE_MAX + 1) }, 0)).toThrow(/5001 characters/)
    // `owner/repo=<name>-<10>` separated by spaces
    expect(idListLength([{ slug: 'a/b', name: 'trace_m_12345678' }, { slug: 'c/d', name: 'trace_m_abcdef12' }])).toBe('a/b=trace_m_12345678-0123456789 c/d=trace_m_abcdef12-0123456789'.length)
    // 60 long repository names would overflow the lists: refused when the stack is built
    const long = Array.from({ length: 60 }, (_, i) => `${'o'.repeat(39)}/${'r'.repeat(50)}${i}`)
    expect(() => new TraceStack(new App(), 'Long', InfraPropsSchema.parse({ ...props, repositories: long }))).toThrow(/characters \(AgentCore allows 5000\)/)
  }, 300_000)

  it('creates none of the memory when memory.enabled is false', () => {
    const off = InfraPropsSchema.parse({ ...props, memory: { enabled: false } })
    const t2 = synth(off, 'NoMemory').all
    t2.resourceCountIs('AWS::BedrockAgentCore::Memory', 0)
    const json = JSON.stringify(t2.toJSON())
    for (const s of ['TRACE_MEMORY_ID', 'TRACE_PROJECT_MEMORIES', 'TraceMemory', 'ProjectMemory', 'bedrock-agentcore:CreateEvent', 'RetrieveMemoryRecords']) expect(json).not.toContain(s)
    const outputs = Object.keys(t2.toJSON().Outputs as Record<string, unknown>)
    for (const o of ['MemoryId', projectOutputs(A).memoryId, projectOutputs(B).memoryId]) expect(outputs).not.toContain(o)
  }, 300_000)
})
