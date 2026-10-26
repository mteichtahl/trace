import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, apiRuntimeName, projectHash, projectOutputs, stackName, workerRuntimeName } from '../../src/infra/props.js'
import { TraceStack } from '../../src/infra/stack.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const HA = projectHash(A)
const HB = projectHash(B)

const props = InfraPropsSchema.parse({
  account: '123456789012', region: 'us-east-1', repositories: [A, `${B}@develop`],
  model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com',
})

type Statement = { Sid?: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> }
const statementsOf = (t: Template, prefix: string): Statement[] => Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith(prefix))
  .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
const policyText = (t: Template, prefix: string): string => JSON.stringify(statementsOf(t, prefix))
const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])
/** IAM StringLike/ARN wildcard matching. */
const like = (pattern: string, v: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(v)

let t: Template
beforeAll(() => {
  const app = new App()
  t = Template.fromStack(new TraceStack(app, stackName(props.prefix), props))
}, 300_000)

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
    // one image for all of them
    expect(new Set(runtimes.map((r) => JSON.stringify(r.Properties.AgentRuntimeArtifact))).size).toBe(1)
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
      expect(env).toContain(`"${repo}",{"Fn::GetAtt":["Project${h}Runtime`)
    }
  })

  it("gives each project's worker role that project's prefixes, actors, namespaces, secret and job definition only", () => {
    const memoryArn = { 'Fn::GetAtt': [Match.stringLikeRegexp('^AgentMemory'), 'MemoryArn'] }
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
      // memory: its own actors and namespaces, on the one memory
      expect(s).toEqual(expect.arrayContaining([
        expect.objectContaining({ Sid: 'ProjectMemoryEvents', Action: ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents'], Condition: { StringLike: { 'bedrock-agentcore:actorId': c.actor } } }),
        expect.objectContaining({ Sid: 'ProjectMemoryRecords', Action: ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords'], Condition: { StringLike: { 'bedrock-agentcore:namespace': c.ns } } }),
      ]))
      for (const st of s.filter((x) => String(x.Sid).startsWith('ProjectMemory'))) expect(Match.objectLike({ Resource: memoryArn }).test(st).isSuccess).toBe(true)
      // its own secret only
      const secretReads = s.filter((x) => actionsOf(x).includes('secretsmanager:GetSecretValue'))
      expect(secretReads).toHaveLength(1)
      expect(JSON.stringify(secretReads[0]?.Resource)).toMatch(new RegExp(`^\\{"Ref":"Project${c.h}GithubToken`))
      // Batch: its own job definition on the shared queue, only tagged with its project
      const submit = s.find((x) => x.Sid === 'ProjectGpuSubmit')
      expect(JSON.stringify(submit?.Resource)).toContain(`job-definition/trace-gpu-${c.h}`)
      expect(JSON.stringify(submit?.Resource)).toMatch(/GpuQueue/)
      expect(submit?.Condition).toEqual({ StringEquals: { 'aws:RequestTag/trace:project': c.repo } })
      expect(s.find((x) => x.Sid === 'ProjectGpuTerminate')?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/trace:project': c.repo } })
      expect(s.find((x) => x.Sid === 'ProjectGpuTag')?.Condition?.StringEqualsIfExists).toEqual({ 'aws:ResourceTag/trace:project': c.repo })
      // telemetry: its own runtime's log group
      expect(text).toContain(`/aws/bedrock-agentcore/runtimes/trace_w_${c.h}-*`)
      expect(text).not.toContain('/aws/bedrock-agentcore/runtimes/*')
      expect(text).toContain('xray:PutTraceSegments')
      // never the other project's anything, nor people, nor the API's token
      for (const never of [c.other.repo, c.other.h, c.other.actor, 'cognito-idp', 'TraceMemoryRecordsRead']) expect(text).not.toContain(never)
      for (const never of ['DeleteEvent', 'DeleteMemoryRecord', 'BatchCreateMemoryRecords', 'CreateMemory', 'bedrock-agentcore:*', 'InvokeAgentRuntime']) expect(text).not.toContain(never)
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
      expect(text).not.toContain('/access/*')
      expect(text).not.toContain('/jobs/')
      expect(text).not.toContain('TraceMemory')
    }
    // no installation-wide actions role any more
    expect(Object.keys(t.findResources('AWS::IAM::Role')).some((id) => id.startsWith('ActionsRole'))).toBe(false)
  })

  it('lets the API invoke every project worker, read every project\'s memory records, and reach people', () => {
    const s = statementsOf(t, 'ApiRuntimeRole')
    const invoke = s.find((x) => x.Sid === 'InvokeProjectWorkers')
    expect(invoke?.Action).toBe('bedrock-agentcore:InvokeAgentRuntime')
    const [runtimes = ''] = invoke?.Resource as string[]
    expect(invoke?.Resource).toEqual(['arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_*', 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_*/runtime-endpoint/*'])
    // the pattern covers both workers' runtime ids (`<name>-<suffix>`), and not the API itself
    for (const h of [HA, HB]) expect(like(runtimes, `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_${h}-AbCdEf1234`)).toBe(true)
    expect(like(runtimes, 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_api-AbCdEf1234')).toBe(false)
    const text = JSON.stringify(s)
    expect(text).toContain('cognito-idp:AdminAddUserToGroup')
    expect(text).toContain('/access/*')
    expect(text).toContain('/central/*')
    expect(text).not.toMatch(/"Resource":"\*","Action":"cognito/)
    // memory: records of every project, read only; no events
    expect(s).toEqual(expect.arrayContaining([expect.objectContaining({
      Sid: 'TraceMemoryRecordsRead', Action: ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords'], Condition: { StringLike: { 'bedrock-agentcore:namespace': '/trace/*' } },
    })]))
    expect(text).not.toContain('CreateEvent')
    // no GPU, no project data, no project tokens
    for (const never of ['batch:', '/jobs/', '/projects/', `Project${HA}GithubToken`, `Project${HB}GithubToken`]) expect(text).not.toContain(never)
  })

  it('has a Cognito pool without self sign-up, the admin/user/guest groups, and the first admin', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }) })
    for (const g of ['trace-admins', 'trace-users', 'trace-guests']) t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: g })
    t.hasResourceProperties('AWS::Cognito::UserPoolUser', { Username: 'marc@example.com' })
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false, CallbackURLs: ['http://localhost:47821/callback', 'http://localhost:47822/callback'] })
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
    t.resourceCountIs('AWS::Batch::JobQueue', 1)
    t.resourceCountIs('AWS::Batch::ComputeEnvironment', 1)
    t.resourceCountIs('AWS::Batch::JobDefinition', 2)
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
    const t2 = Template.fromStack(new TraceStack(new App(), 'NoGpu', off))
    for (const r of ['AWS::Batch::ComputeEnvironment', 'AWS::Batch::JobQueue', 'AWS::Batch::JobDefinition', 'AWS::EC2::VPC']) t2.resourceCountIs(r, 0)
    t2.resourceCountIs('AWS::CloudFormation::CustomResource', 1)
    const json = JSON.stringify(t2.toJSON())
    expect(json).not.toContain('TRACE_GPU_QUEUE')
    expect(json).not.toContain('batch:SubmitJob')
    const outputs = Object.keys(t2.toJSON().Outputs as Record<string, unknown>)
    expect(outputs).not.toContain('GpuJobQueue')
    expect(outputs).not.toContain(projectOutputs(A).jobDefinition)
  }, 300_000)

  it('exports what the installer needs, per project by hash', () => {
    const outputs = Object.keys(t.toJSON().Outputs as Record<string, unknown>)
    for (const o of ['TraceHome', 'GithubSecretArn', 'ApiRuntimeArn', 'UserPoolId', 'UserPoolClientId', 'CognitoDomain', 'GpuJobQueue', 'MemoryId']) expect(outputs).toContain(o)
    for (const repo of [A, B]) for (const o of Object.values(projectOutputs(repo))) expect(outputs).toContain(o)
    for (const gone of ['AgentRuntimeArn', 'ActionsRoleArn', 'GpuJobDefinition']) expect(outputs).not.toContain(gone)
  })

  it('adds and removes a project\'s resources with the repository list', () => {
    const one = Template.fromStack(new TraceStack(new App(), 'One', InfraPropsSchema.parse({ ...props, repositories: [A] })))
    one.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2)
    one.resourceCountIs('AWS::Batch::JobDefinition', 1)
    expect(JSON.stringify(one.toJSON())).not.toContain(HB)
    // removing a project never takes data with it: the bucket and the memory are not the project's
    const bucket = Object.values(one.findResources('AWS::S3::Bucket') as Record<string, { DeletionPolicy?: string }>)[0]
    expect(bucket?.DeletionPolicy).toBe('Retain')
    // its token copy goes with it
    const secrets = Object.entries(one.findResources('AWS::SecretsManager::Secret') as Record<string, { DeletionPolicy?: string }>)
    expect(secrets.find(([id]) => id.startsWith(`Project${HA}`))?.[1].DeletionPolicy).toBe('Delete')
    expect(() => new TraceStack(new App(), 'Many', InfraPropsSchema.parse({ ...props, repositories: Array.from({ length: 61 }, (_, i) => `o/r${i}`) }))).toThrow()
  }, 300_000)

  it('has one AgentCore memory with the semantic, summary and preference strategies, namespaced by actor', () => {
    t.resourceCountIs('AWS::BedrockAgentCore::Memory', 1)
    t.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      Name: 'trace_memory',
      EventExpiryDuration: 30,
      MemoryStrategies: [
        { SemanticMemoryStrategy: Match.objectLike({ Name: 'trace_facts', NamespaceTemplates: ['/trace/{actorId}/facts/'] }) },
        { SummaryMemoryStrategy: Match.objectLike({ Name: 'trace_sessions', NamespaceTemplates: ['/trace/{actorId}/sessions/{sessionId}/'] }) },
        { UserPreferenceMemoryStrategy: Match.objectLike({ Name: 'trace_preferences', NamespaceTemplates: ['/trace/{actorId}/preferences/'] }) },
      ],
    })
    for (const name of [`trace_w_${HA}`, `trace_w_${HB}`, 'trace_api']) {
      t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { AgentRuntimeName: name, EnvironmentVariables: Match.objectLike({ TRACE_MEMORY_ID: { 'Fn::GetAtt': [Match.stringLikeRegexp('^AgentMemory'), 'MemoryId'] } }) })
    }
    const custom = Template.fromStack(new TraceStack(new App(), 'MemoryDays', InfraPropsSchema.parse({ ...props, memory: { eventExpiryDays: 90 } })))
    custom.hasResourceProperties('AWS::BedrockAgentCore::Memory', { EventExpiryDuration: 90 })
    expect(() => InfraPropsSchema.parse({ ...props, memory: { eventExpiryDays: 2 } })).toThrow()
  }, 300_000)

  it('creates none of the memory when memory.enabled is false', () => {
    const off = InfraPropsSchema.parse({ ...props, memory: { enabled: false } })
    const t2 = Template.fromStack(new TraceStack(new App(), 'NoMemory', off))
    t2.resourceCountIs('AWS::BedrockAgentCore::Memory', 0)
    const json = JSON.stringify(t2.toJSON())
    for (const s of ['TRACE_MEMORY_ID', 'TraceMemory', 'ProjectMemory', 'bedrock-agentcore:CreateEvent', 'RetrieveMemoryRecords']) expect(json).not.toContain(s)
    expect(Object.keys(t2.toJSON().Outputs as Record<string, unknown>)).not.toContain('MemoryId')
  }, 300_000)
})
