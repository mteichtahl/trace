import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, runtimeName, stackName } from '../../src/infra/props.js'
import { TraceStack } from '../../src/infra/stack.js'

const props = InfraPropsSchema.parse({
  account: '123456789012', region: 'us-east-1', repositories: ['mteichtahl/trace', 'pokeys-toolkit/potroller'],
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
    t.resourceCountIs('AWS::CloudFormation::CustomResource', 1)
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

  it('lets only the listed repositories assume the actions role, and only to invoke the worker', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': ['repo:mteichtahl/trace:*', 'repo:pokeys-toolkit/potroller:*'] },
        },
      })] },
    })
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).map((p) => JSON.stringify(p))
    const invoke = policies.filter((p) => p.includes('bedrock-agentcore:InvokeAgentRuntime'))
    expect(invoke).toHaveLength(1)
    expect(invoke[0]).toContain('AgentRuntime')
    expect(invoke[0]).not.toContain('ApiRuntime')
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

  it('exports what the installer needs', () => {
    const outputs = Object.keys(t.toJSON().Outputs as Record<string, unknown>)
    for (const o of ['TraceHome', 'GithubSecretArn', 'AgentRuntimeArn', 'ApiRuntimeArn', 'ActionsRoleArn', 'UserPoolId', 'UserPoolClientId', 'CognitoDomain']) expect(outputs).toContain(o)
  })
})
