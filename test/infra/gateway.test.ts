/**
 * The library gateway in the stack (gateway.enabled, src/infra/gateway.ts): one gateway with IAM inbound auth and a
 * Lambda target for the library tools; the Lambda's and the gateway's roles reach nothing per project; each worker
 * may invoke that gateway and is told its URL. Off by default.
 */
import { Match, type Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { LIBRARY_TOOLS, LOCAL_INPUTS } from '../../src/core/gateway.js'
import { InfraPropsSchema, LIBRARY_GATEWAY_OUTPUT, LIBRARY_KEYS_OUTPUT, projectHash, stackName, workerRuntimeName } from '../../src/infra/props.js'
import { gatewayName } from '../../src/infra/gateway.js'
import { RUNNERS, type Synth, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, B], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource?: unknown; Condition?: unknown }
const statements = (t: Template, prefix: string): Statement[] => Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith(prefix))
  .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])

let on: Synth
beforeAll(() => {
  on = synth(InfraPropsSchema.parse({ ...base, gateway: { enabled: true } }), stackName('trace'))
}, 300_000)

describe('the library gateway', () => {
  it('is off unless asked for', () => {
    expect(InfraPropsSchema.parse(base).gateway).toEqual({ enabled: false })
  })

  it('needs a prefix that makes a valid gateway name', () => {
    expect(InfraPropsSchema.safeParse({ ...base, prefix: 'ab-', gateway: { enabled: true } }).success).toBe(false)
    expect(InfraPropsSchema.safeParse({ ...base, prefix: 'a--b', gateway: { enabled: true } }).success).toBe(false)
    expect(InfraPropsSchema.safeParse({ ...base, prefix: 'ab-', gateway: { enabled: false } }).success).toBe(true)
    expect(InfraPropsSchema.safeParse({ ...base, prefix: 'my-lab', gateway: { enabled: true } }).success).toBe(true)
  })

  it('is one gateway with IAM inbound auth over MCP, run by its own role', () => {
    on.parent.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1)
    on.parent.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      Name: gatewayName('trace'), AuthorizerType: 'AWS_IAM', ProtocolType: 'MCP', RoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^LibraryGatewayRole'), 'Arn'] },
    })
    expect(gatewayName('trace')).toMatch(/^([0-9a-zA-Z][-]?){1,48}$/)
  })

  it('has one Lambda target, called with the gateway\'s role, listing exactly the library tools without local inputs', () => {
    const targets = Object.values(on.parent.findResources('AWS::BedrockAgentCore::GatewayTarget')) as { Properties: Record<string, unknown> }[]
    expect(targets).toHaveLength(1)
    const p = targets[0]?.Properties as {
      Name: string; CredentialProviderConfigurations: unknown[]
      TargetConfiguration: { Mcp: { Lambda: { LambdaArn: unknown; ToolSchema: { InlinePayload: { Name: string; InputSchema: { Properties?: Record<string, unknown> } }[] } } } }
    }
    expect(p.Name).toBe('library')
    expect(p.CredentialProviderConfigurations).toEqual([{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }])
    const tools = p.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload
    expect(tools.map((t) => t.Name).sort()).toEqual(Object.keys(LIBRARY_TOOLS).map((n) => n.replaceAll('.', '_')).sort())
    for (const t of tools) for (const k of LOCAL_INPUTS) expect(t.InputSchema.Properties ?? {}).not.toHaveProperty(k)
    expect(JSON.stringify(p.TargetConfiguration.Mcp.Lambda.LambdaArn)).toMatch(/LibraryFunction/)
  })

  it('gives the gateway\'s role nothing but invoking the Lambda', () => {
    const st = statements(on.parent, 'LibraryGatewayRole')
    expect(st.length).toBeGreaterThan(0)
    expect(new Set(st.flatMap(actions))).toEqual(new Set(['lambda:InvokeFunction']))
  })

  it('lets the Lambda reach the central store (conditional writes) and the keys, and nothing per project', () => {
    const st = statements(on.parent, 'LibraryFunctionRole')
    const text = JSON.stringify(st)
    expect(text).toContain('/central/*')
    for (const p of ['projects/', 'jobs/', 'access/', 'prompts/']) expect(text).not.toContain(p)
    const puts = st.filter((s) => actions(s).includes('s3:PutObject'))
    expect(puts.length).toBeGreaterThan(0)
    for (const s of puts) expect(JSON.stringify(s.Condition)).toMatch(/s3:if-(none-)?match/)
    expect(st.flatMap(actions)).not.toContain('s3:DeleteObject')
    expect(st.flatMap(actions)).toEqual(expect.arrayContaining(['secretsmanager:GetSecretValue']))
    expect(st.flatMap(actions).some((a) => a.startsWith('bedrock') || a.startsWith('batch:'))).toBe(false)
  })

  it('runs the Lambda on Node 22 arm64 with TRACE_HOME and the keys secret, writing only under /tmp', () => {
    on.parent.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'trace-library', Runtime: 'nodejs22.x', Architectures: ['arm64'], Handler: 'index.handler', Timeout: 600,
      Environment: { Variables: Match.objectLike({ TRACE_HOME: Match.anyValue(), TRACE_LIBRARY_KEYS_SECRET_ARN: Match.anyValue(), HOME: '/tmp', XDG_CACHE_HOME: '/tmp/cache' }) },
    })
    on.parent.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'trace/library-keys' })
  })

  it('lets each worker invoke that gateway, and only it, and tells it the URL', () => {
    for (const r of [A, B]) {
      const n = nestedOf(on, r)
      const st = statements(n, `Project${projectHash(r)}RuntimeRole`).filter((s) => s.Sid === 'LibraryGateway')
      expect(st).toHaveLength(1)
      expect(actions(st[0] as Statement)).toEqual(['bedrock-agentcore:InvokeGateway'])
      expect(JSON.stringify(st[0]?.Resource)).not.toContain('*')
      const runtime = Object.values(n.findResources('AWS::BedrockAgentCore::Runtime') as Record<string, { Properties: { AgentRuntimeName: string; EnvironmentVariables: Record<string, unknown> } }>)
        .find((x) => x.Properties.AgentRuntimeName === workerRuntimeName('trace', r))
      expect(runtime?.Properties.EnvironmentVariables).toHaveProperty('TRACE_GATEWAY_URL')
      // the GitHub Actions fallback runs every tool in-process: its role is not given the gateway
      expect(JSON.stringify(statements(n, `Project${projectHash(r)}ActionsRole`))).not.toContain('InvokeGateway')
    }
  })

  it('keeps the optional integrations\' keys from the agents: only the Lambda may read them', () => {
    const lambda = statements(on.parent, 'LibraryFunctionRole').filter((x) => x.Sid === 'IntegrationsRead')
    expect(lambda).toHaveLength(1)
    expect(JSON.stringify(lambda[0]?.Resource)).toMatch(/:secret:trace\/integrations\/\*/)
    on.parent.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ TRACE_INTEGRATIONS_PREFIX: 'trace/integrations/' }) } })
    for (const r of [A, B]) {
      const n = nestedOf(on, r)
      expect(JSON.stringify(statements(n, `Project${projectHash(r)}RuntimeRole`))).not.toContain('integrations')
      expect(JSON.stringify(n.toJSON())).not.toContain('TRACE_INTEGRATIONS_PREFIX')
    }
  })

  it('outputs the gateway URL and the keys secret', () => {
    on.parent.hasOutput(LIBRARY_GATEWAY_OUTPUT, {})
    on.parent.hasOutput(LIBRARY_KEYS_OUTPUT, {})
  })
})

describe('without the gateway', () => {
  let off: Synth
  beforeAll(() => {
    off = synth(InfraPropsSchema.parse({ ...base, repositories: [A] }), 'NoGateway')
  }, 300_000)

  it('has no gateway, no library Lambda, and workers that are told no gateway', () => {
    off.all.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0)
    off.all.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 0)
    expect(JSON.stringify(off.all.toJSON())).not.toContain('TRACE_GATEWAY_URL')
    expect(JSON.stringify(off.all.toJSON())).not.toContain('InvokeGateway')
  })

  it('lets each worker read the optional integrations itself, and is told where they are', () => {
    const n = nestedOf(off, A)
    const st = statements(n, `Project${projectHash(A)}RuntimeRole`).filter((x) => x.Sid === 'IntegrationsRead')
    expect(st).toHaveLength(1)
    expect(actions(st[0] as Statement)).toEqual(['secretsmanager:GetSecretValue'])
    const runtime = Object.values(n.findResources('AWS::BedrockAgentCore::Runtime') as Record<string, { Properties: { EnvironmentVariables: Record<string, unknown> } }>)[0]
    expect(runtime?.Properties.EnvironmentVariables.TRACE_INTEGRATIONS_PREFIX).toBe('trace/integrations/')
    // the API may write them for admins, never read them
    const api = statements(off.parent, 'ApiRuntimeRole').filter((x) => x.Sid === 'ManageIntegrations')
    expect(api).toHaveLength(1)
    expect(actions(api[0] as Statement)).not.toContain('secretsmanager:GetSecretValue')
    expect(actions(api[0] as Statement)).toEqual(expect.arrayContaining(['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret']))
  })

  it('copies or caches the images (the parent holds only the image builds: each project\'s CI runner is in its nested stack)', () => {
    const builds = Object.values(off.parent.findResources('AWS::CodeBuild::Project') as Record<string, { Properties: { Name: string; Environment: { EnvironmentVariables: { Name: string; Value: string }[] }; Cache?: { Type: string; Modes: string[] }; Source: { BuildSpec: string } } }>)
    expect(builds.map((b) => b.Properties.Name).sort()).toEqual(['trace-agent-image', 'trace-gpu-image'])
    for (const b of builds) {
      const pre = b.Properties.Environment.EnvironmentVariables.find((v) => v.Name === 'PREBUILT_IMAGE')?.Value ?? ''
      expect(pre).toMatch(new RegExp(`^public\\.ecr\\.aws/mteichtahl/trace-${b.Properties.Name.split('-')[1]}:v\\d+\\.\\d+\\.\\d+-[0-9a-f]{16}$`))
      expect(b.Properties.Cache).toEqual({ Type: 'LOCAL', Modes: ['LOCAL_DOCKER_LAYER_CACHE'] })
      expect(b.Properties.Source.BuildSpec).toContain('--cache-from')
    }
  })
})
