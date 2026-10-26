import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, runtimeName, stackName } from '../../src/infra/props.js'
import { TraceStack } from '../../src/infra/stack.js'

const props = InfraPropsSchema.parse({
  account: '123456789012', region: 'us-east-1', repositories: ['mteichtahl/trace', 'pokeys-toolkit/potroller@develop'],
  model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com',
})

let t: Template
beforeAll(() => {
  const app = new App()
  t = Template.fromStack(new TraceStack(app, stackName(props.prefix), props))
}, 300_000)

describe('the trace stack', () => {
  it('names things from the prefix', () => {
    expect(stackName('trace')).toBe('TraceStack')
    expect(stackName('my-lab')).toBe('MyLabStack')
    expect(runtimeName('my-lab')).toBe('my_lab_agent')
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

  it('runs two AgentCore runtimes: the worker on IAM, the API behind Cognito', () => {
    t.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2)
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'trace_agent',
      EnvironmentVariables: Match.objectLike({ TRACE_AGENT_MODE: 'worker', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: props.model }),
      AuthorizerConfiguration: Match.absent(),
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 900, MaxLifetime: 28_800 },
    })
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'trace_api',
      EnvironmentVariables: Match.objectLike({ TRACE_AGENT_MODE: 'api' }),
      AuthorizerConfiguration: { CustomJWTAuthorizer: Match.objectLike({ DiscoveryUrl: Match.anyValue(), AllowedClients: Match.anyValue() }) },
      RequestHeaderConfiguration: { RequestHeaderAllowlist: ['Authorization'] },
    })
  })

  it("lets only the listed repositories' default branches assume the actions role, and only to invoke the worker", () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': ['repo:mteichtahl/trace:ref:refs/heads/main', 'repo:pokeys-toolkit/potroller:ref:refs/heads/develop'] },
        },
      })] },
    })
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).map((p) => JSON.stringify(p))
    const invoke = policies.filter((p) => p.includes('bedrock-agentcore:InvokeAgentRuntime'))
    expect(invoke).toHaveLength(1)
    expect(invoke[0]).toContain('AgentRuntime')
    expect(invoke[0]).not.toContain('ApiRuntime')
  })

  it('gives each runtime its own role: only the API reaches people (Cognito, the access store)', () => {
    const policies = Object.entries(t.findResources('AWS::IAM::Policy')).map(([id, p]) => [id, JSON.stringify(p)] as const)
    const worker = policies.filter(([id]) => id.startsWith('WorkerRuntimeRole')).map(([, p]) => p).join()
    const api = policies.filter(([id]) => id.startsWith('ApiRuntimeRole')).map(([, p]) => p).join()
    const actions = policies.filter(([id]) => id.startsWith('ActionsRole')).map(([, p]) => p).join()
    expect(worker).not.toContain('cognito-idp')
    expect(api).toContain('cognito-idp:AdminAddUserToGroup')
    expect(api).toContain('/access/*')
    for (const p of [worker, actions]) {
      expect(p).toContain('/central/*')
      expect(p).not.toContain('/access/*')
    }
    expect(api).not.toMatch(/"Resource":"\*","Action":"cognito/)
  })

  it('has a Cognito pool without self sign-up, the admin/user/guest groups, and the first admin', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }) })
    for (const g of ['trace-admins', 'trace-users', 'trace-guests']) t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: g })
    t.hasResourceProperties('AWS::Cognito::UserPoolUser', { Username: 'marc@example.com' })
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false, CallbackURLs: ['http://localhost:47821/callback', 'http://localhost:47822/callback'] })
  })

  it('keeps the GitHub token out of the template', () => {
    const json = JSON.stringify(t.toJSON())
    expect(json).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/)
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'trace/github-token' })
  })

  it('runs GPU jobs on a Batch queue of GPU instances that scales to zero', () => {
    t.hasResourceProperties('AWS::Batch::ComputeEnvironment', {
      Type: 'managed',
      ComputeResources: Match.objectLike({
        Type: 'EC2', MinvCpus: 0, MaxvCpus: 16, InstanceTypes: ['g6.xlarge', 'g5.xlarge', 'g4dn.xlarge'],
        Ec2Configuration: [{ ImageType: 'ECS_AL2023_NVIDIA' }],
      }),
    })
    t.hasResourceProperties('AWS::Batch::JobDefinition', {
      JobDefinitionName: 'trace-gpu',
      ContainerProperties: Match.objectLike({
        Command: ['node', '/app/dist/gpu/runner.js'],
        ResourceRequirements: Match.arrayWith([{ Type: 'GPU', Value: '1' }]),
      }),
    })
    t.resourceCountIs('AWS::Batch::JobQueue', 1)
    t.resourceCountIs('AWS::EC2::NatGateway', 0)
    t.hasResourceProperties('AWS::CodeBuild::Project', { Environment: Match.objectLike({ Type: 'LINUX_CONTAINER', PrivilegedMode: true }) })
    t.resourceCountIs('AWS::CloudFormation::CustomResource', 2) // the agent image and the GPU image
  })

  it('lets both runtimes submit GPU jobs and stage files under jobs/ only, and tells them where', () => {
    const policies = Object.entries(t.findResources('AWS::IAM::Policy')).map(([id, p]) => [id, JSON.stringify(p)] as const)
    for (const who of ['WorkerRuntimeRole', 'ApiRuntimeRole']) {
      const p = policies.filter(([id]) => id.startsWith(who)).map(([, x]) => x).join()
      for (const a of ['batch:SubmitJob', 'batch:DescribeJobs', 'batch:TerminateJob']) expect(p).toContain(a)
      expect(p).toContain('/jobs/*')
    }
    const job = policies.filter(([id]) => id.startsWith('GpuJobRole')).map(([, x]) => x).join()
    expect(job).toContain('/jobs/*')
    expect(job).not.toContain('/central/*')
    for (const mode of ['worker', 'api']) {
      t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
        EnvironmentVariables: Match.objectLike({ TRACE_AGENT_MODE: mode, TRACE_GPU_QUEUE: Match.anyValue(), TRACE_GPU_JOB_DEFINITION: 'trace-gpu', TRACE_GPU_BUCKET: Match.anyValue() }),
      })
    }
    const api = policies.filter(([id]) => id.startsWith('ApiRuntimeRole')).map(([, x]) => x).join()
    expect(api).toContain('cognito-idp:ListUsersInGroup')
  })

  it('creates none of the GPU side when gpu.enabled is false', () => {
    const off = InfraPropsSchema.parse({ ...props, gpu: { enabled: false } })
    const t2 = Template.fromStack(new TraceStack(new App(), 'NoGpu', off))
    for (const r of ['AWS::Batch::ComputeEnvironment', 'AWS::Batch::JobQueue', 'AWS::Batch::JobDefinition', 'AWS::EC2::VPC']) t2.resourceCountIs(r, 0)
    t2.resourceCountIs('AWS::CloudFormation::CustomResource', 1)
    expect(JSON.stringify(t2.toJSON())).not.toContain('TRACE_GPU_QUEUE')
    expect(Object.keys(t2.toJSON().Outputs as Record<string, unknown>)).not.toContain('GpuJobQueue')
  }, 300_000)

  it('exports what the installer needs', () => {
    const outputs = Object.keys(t.toJSON().Outputs as Record<string, unknown>)
    for (const o of ['TraceHome', 'GithubSecretArn', 'AgentRuntimeArn', 'ApiRuntimeArn', 'ActionsRoleArn', 'UserPoolId', 'UserPoolClientId', 'CognitoDomain', 'GpuJobQueue', 'GpuJobDefinition', 'MemoryId']) expect(outputs).toContain(o)
  })

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
    for (const mode of ['worker', 'api']) {
      t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', { EnvironmentVariables: Match.objectLike({ TRACE_AGENT_MODE: mode, TRACE_MEMORY_ID: { 'Fn::GetAtt': [Match.stringLikeRegexp('^AgentMemory'), 'MemoryId'] } }) })
    }
    const custom = Template.fromStack(new TraceStack(new App(), 'MemoryDays', InfraPropsSchema.parse({ ...props, memory: { eventExpiryDays: 90 } })))
    custom.hasResourceProperties('AWS::BedrockAgentCore::Memory', { EventExpiryDuration: 90 })
    expect(() => InfraPropsSchema.parse({ ...props, memory: { eventExpiryDays: 2 } })).toThrow()
  }, 300_000)

  it('lets both runtimes use the memory: events by trace actor, records under /trace/, nothing else', () => {
    const policies = Object.entries(t.findResources('AWS::IAM::Policy'))
    const statements = (who: string): Record<string, unknown>[] => policies.filter(([id]) => id.startsWith(who))
      .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement)
    const memoryArn = { 'Fn::GetAtt': [Match.stringLikeRegexp('^AgentMemory'), 'MemoryArn'] }
    for (const who of ['WorkerRuntimeRole', 'ApiRuntimeRole']) {
      const s = statements(who)
      expect(s).toEqual(expect.arrayContaining([
        expect.objectContaining({ Sid: 'TraceMemoryEvents', Action: ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents'], Condition: { StringLike: { 'bedrock-agentcore:actorId': ['?*/?*/?*'] } } }),
        expect.objectContaining({ Sid: 'TraceMemoryRecords', Action: ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords'], Condition: { StringLike: { 'bedrock-agentcore:namespace': '/trace/*' } } }),
      ]))
      for (const st of s.filter((x) => String(x.Sid).startsWith('TraceMemory'))) expect(Match.objectLike({ Resource: memoryArn }).test(st).isSuccess).toBe(true)
      const all = JSON.stringify(s)
      for (const never of ['DeleteEvent', 'DeleteMemoryRecord', 'BatchCreateMemoryRecords', 'CreateMemory', 'UpdateMemory', 'DeleteMemory', 'bedrock-agentcore:*']) expect(all).not.toContain(never)
    }
    expect(JSON.stringify(statements('ActionsRole'))).not.toContain('TraceMemory')
  })

  it('creates none of the memory when memory.enabled is false', () => {
    const off = InfraPropsSchema.parse({ ...props, memory: { enabled: false } })
    const t2 = Template.fromStack(new TraceStack(new App(), 'NoMemory', off))
    t2.resourceCountIs('AWS::BedrockAgentCore::Memory', 0)
    const json = JSON.stringify(t2.toJSON())
    for (const s of ['TRACE_MEMORY_ID', 'TraceMemory', 'bedrock-agentcore:CreateEvent', 'RetrieveMemoryRecords']) expect(json).not.toContain(s)
    expect(Object.keys(t2.toJSON().Outputs as Record<string, unknown>)).not.toContain('MemoryId')
  }, 300_000)
})
