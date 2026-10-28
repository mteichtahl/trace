/**
 * External access in the stack (external.enabled, src/infra/external.ts): the `trace-external` scopes on the pool,
 * the external API and MCP runtimes behind them, the external runtime's own role (the systems' part of the API's
 * grants: no Cognito, no order watch), the MCP runtime's own role (logs and spans only), the shared rate-limit table,
 * the API role's grant on the connected systems' app clients, the environment each runtime is told, and the outputs.
 * Off by default, and then the template is what it was without the feature.
 */
import { Match, type Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { CONNECTED_SYSTEM_CLIENT_ACTIONS, EXTERNAL_ALLOWED_SCOPES } from '../../src/infra/external.js'
import { EXTERNAL_OUTPUTS, InfraPropsSchema, apiRuntimeName, externalRuntimeName, mcpRuntimeName, stackName } from '../../src/infra/props.js'
import { RUNNERS, type Synth, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, B], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource?: unknown; Condition?: unknown }
type Res = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
type Tpl = { Resources: Record<string, Res>; Outputs?: Record<string, { Value: unknown }> }
const json = (t: Template): Tpl => t.toJSON() as Tpl
const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])
/** every statement of the policies (inline and managed) attached to the role whose logical id starts with `role` */
const roleStatements = (t: Tpl, role: string): Statement[] => Object.values(t.Resources)
  .filter((r) => (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') && JSON.stringify(r.Properties.Roles ?? []).includes(`"${role}`))
  .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
const runtimeNamed = (t: Tpl, name: string): [string, Res] => {
  const e = Object.entries(t.Resources).find(([, r]) => r.Type === 'AWS::BedrockAgentCore::Runtime' && r.Properties.AgentRuntimeName === name)
  if (!e) throw new Error(`no runtime ${name}`)
  return e
}
/** the logical id a value refers to (Ref or Fn::GetAtt) */
const target = (v: unknown): string | undefined => {
  const o = v as { Ref?: string; 'Fn::GetAtt'?: [string, string] }
  return o.Ref ?? o['Fn::GetAtt']?.[0]
}
/** the asset hashes (the source and the nested templates) change with any edit of the repository: not the feature's */
const sameApartFromAssets = (t: unknown): string => JSON.stringify(t).replace(/[0-9a-f]{64}/g, 'HASH')

let off: Synth
let on: Synth
let onFlat: Synth
let onQuiet: Synth
beforeAll(() => {
  off = synth(InfraPropsSchema.parse(base), stackName('trace'))
  on = synth(InfraPropsSchema.parse({ ...base, external: { enabled: true } }), stackName('trace'))
  onFlat = synth(InfraPropsSchema.parse({ ...base, layout: 'flat', external: { enabled: true } }), 'FlatExternal')
  onQuiet = synth(InfraPropsSchema.parse({ ...base, external: { enabled: true }, observability: { enabled: false }, web: { enabled: false } }), 'QuietExternal')
}, 600_000)

describe('external access: the setting', () => {
  it('is off unless asked for', () => {
    expect(InfraPropsSchema.parse(base).external).toEqual({ enabled: false })
    expect(InfraPropsSchema.safeParse({ ...base, external: { enabled: true, other: 1 } }).success).toBe(false)
  })

  it('names its runtimes from the prefix, as the API\'s is, and refuses a prefix that makes a name AgentCore refuses', () => {
    expect(externalRuntimeName('my-lab')).toBe('my_lab_external')
    expect(mcpRuntimeName('my-lab')).toBe('my_lab_mcp')
    expect(apiRuntimeName('my-lab')).toBe('my_lab_api')
    // the longest prefix (21 characters) still makes names within 48
    const long = `a${'b'.repeat(20)}`
    expect(InfraPropsSchema.safeParse({ ...base, prefix: long, external: { enabled: true } }).success).toBe(true)
    expect(externalRuntimeName(long)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
  })
})

describe('external access: off', () => {
  it('leaves the template as it is without the feature: no scopes, no runtimes, no grant, no outputs, no environment', () => {
    const p = json(off.parent)
    const types = Object.values(p.Resources).map((r) => r.Type)
    expect(types.filter((t) => t === 'AWS::BedrockAgentCore::Runtime')).toHaveLength(1)
    expect(types).not.toContain('AWS::Cognito::UserPoolResourceServer')
    for (const o of [...Object.values(EXTERNAL_OUTPUTS), 'ExternalLogGroup', 'McpLogGroup']) expect(p.Outputs ?? {}).not.toHaveProperty(o)
    expect(JSON.stringify(p)).not.toMatch(/TRACE_EXTERNAL|TRACE_MCP|TRACE_TOKEN_URL|CreateUserPoolClient|trace-external/)
  })

  it('differs from the template with it on only by what it adds, and by the API runtime, its role and the dashboard', () => {
    const before = json(off.parent)
    const after = json(on.parent)
    const added = Object.keys(after.Resources).filter((k) => !(k in before.Resources)).sort()
    expect(Object.keys(before.Resources).filter((k) => !(k in after.Resources))).toEqual([])
    expect(added.map((k) => after.Resources[k]?.Type).sort()).toEqual([
      'AWS::BedrockAgentCore::Runtime', 'AWS::BedrockAgentCore::Runtime', 'AWS::Cognito::UserPoolResourceServer', 'AWS::DynamoDB::Table',
      'AWS::IAM::Policy', 'AWS::IAM::Policy', 'AWS::IAM::Role', 'AWS::IAM::Role',
    ])
    const changed = Object.keys(before.Resources).filter((k) => sameApartFromAssets(before.Resources[k]) !== sameApartFromAssets(after.Resources[k]))
    expect(changed.map((k) => k.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual(['ApiRuntime', 'ApiRuntimeRoleOverflowPolicy1', 'ObservabilityDashboard'])
    expect(Object.keys(after.Outputs ?? {}).filter((k) => !(k in (before.Outputs ?? {}))).sort()).toEqual(
      [...Object.values(EXTERNAL_OUTPUTS), 'ExternalLogGroup', 'McpLogGroup'].sort(),
    )
    // and nothing else of the parent's outputs changes
    for (const [k, v] of Object.entries(before.Outputs ?? {})) expect(sameApartFromAssets(after.Outputs?.[k]), k).toBe(sameApartFromAssets(v))
  })
})

describe('external access: on', () => {
  it('adds the trace-external resource server to the people\'s pool, with read and write', () => {
    on.parent.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'trace-external',
      UserPoolId: { Ref: Match.stringLikeRegexp('^Users') },
      Scopes: [
        { ScopeName: 'read', ScopeDescription: 'read the projects the system is on' },
        { ScopeName: 'write', ScopeDescription: 'start work and change settings on the projects the system contributes to' },
      ],
    })
    expect(EXTERNAL_ALLOWED_SCOPES).toEqual(['trace-external/read', 'trace-external/write'])
  })

  it('runs the external API with the API\'s image, session limits and file system, its own role, over HTTP, authorized by scope alone', () => {
    const p = json(on.parent)
    const [, api] = runtimeNamed(p, apiRuntimeName('trace'))
    const [, ext] = runtimeNamed(p, externalRuntimeName('trace'))
    for (const k of ['AgentRuntimeArtifact', 'NetworkConfiguration', 'LifecycleConfiguration', 'FilesystemConfigurations', 'RequestHeaderConfiguration', 'Tags']) {
      expect(ext.Properties[k], k).toEqual(api.Properties[k])
    }
    expect(target(ext.Properties.RoleArn)).toMatch(/^ExternalExternalRuntimeRole/)
    expect(ext.Properties.RoleArn).not.toEqual(api.Properties.RoleArn)
    expect(ext.Properties.ProtocolConfiguration).toBe('HTTP')
    const auth = (ext.Properties.AuthorizerConfiguration as { CustomJWTAuthorizer: Record<string, unknown> }).CustomJWTAuthorizer
    expect(auth.AllowedScopes).toEqual(['trace-external/read', 'trace-external/write'])
    expect(auth).not.toHaveProperty('AllowedClients')
    expect(auth).not.toHaveProperty('AllowedAudience')
    expect(auth.DiscoveryUrl).toEqual((api.Properties.AuthorizerConfiguration as { CustomJWTAuthorizer: Record<string, unknown> }).CustomJWTAuthorizer.DiscoveryUrl)
    // the people's runtime keeps exactly its two clients and no scopes
    const people = (api.Properties.AuthorizerConfiguration as { CustomJWTAuthorizer: Record<string, unknown> }).CustomJWTAuthorizer
    expect(people.AllowedClients).toHaveLength(2)
    expect(people).not.toHaveProperty('AllowedScopes')
  })

  it('tells the external API the API\'s environment in external mode, with the token address and the resource server, never its own ARN', () => {
    const p = json(on.parent)
    const [, api] = runtimeNamed(p, apiRuntimeName('trace'))
    const [extId, ext] = runtimeNamed(p, externalRuntimeName('trace'))
    const [mcpId] = runtimeNamed(p, mcpRuntimeName('trace'))
    const env = ext.Properties.EnvironmentVariables as Record<string, unknown>
    const apiEnv = api.Properties.EnvironmentVariables as Record<string, unknown>
    expect(env.TRACE_AGENT_MODE).toBe('external')
    expect(env.TRACE_EXTERNAL_RESOURCE_SERVER).toBe('trace-external')
    expect(env.TRACE_PREFIX).toBe('trace')
    expect(JSON.stringify(env.TRACE_TOKEN_URL)).toMatch(/UsersDomain.*\/oauth2\/token/)
    for (const [k, v] of Object.entries(apiEnv)) {
      if (k === 'TRACE_AGENT_MODE' || k === 'TRACE_EXTERNAL_RUNTIME_ARN' || k === 'TRACE_MCP_RUNTIME_ARN') continue
      expect(env[k], k).toEqual(v)
    }
    // the shared rate limit's table, and only the external runtime is told it
    expect(target(env.TRACE_RATE_TABLE)).toMatch(/^ExternalLimits/)
    expect(apiEnv).not.toHaveProperty('TRACE_RATE_TABLE')
    expect(env).not.toHaveProperty('TRACE_EXTERNAL_RUNTIME_ARN')
    expect(env).not.toHaveProperty('TRACE_MCP_RUNTIME_ARN')
    expect(JSON.stringify(env)).not.toContain(extId)
    expect(JSON.stringify(env)).not.toContain(mcpId)
  })

  it('tells the people\'s API both runtimes, the token address and the resource server', () => {
    const p = json(on.parent)
    const [, api] = runtimeNamed(p, apiRuntimeName('trace'))
    const [extId] = runtimeNamed(p, externalRuntimeName('trace'))
    const [mcpId] = runtimeNamed(p, mcpRuntimeName('trace'))
    const env = api.Properties.EnvironmentVariables as Record<string, unknown>
    expect(env.TRACE_AGENT_MODE).toBe('api')
    expect(env.TRACE_EXTERNAL_RUNTIME_ARN).toEqual({ 'Fn::GetAtt': [extId, 'AgentRuntimeArn'] })
    expect(env.TRACE_MCP_RUNTIME_ARN).toEqual({ 'Fn::GetAtt': [mcpId, 'AgentRuntimeArn'] })
    expect(env.TRACE_EXTERNAL_RESOURCE_SERVER).toBe('trace-external')
    expect(env.TRACE_PREFIX).toBe('trace')
    expect(env.TRACE_TOKEN_URL).toEqual((runtimeNamed(p, externalRuntimeName('trace'))[1].Properties.EnvironmentVariables as Record<string, unknown>).TRACE_TOKEN_URL)
  })

  it('runs the MCP endpoint on the MCP protocol, with the same authorizer, its own role, and the external runtime to forward to', () => {
    const p = json(on.parent)
    const [, ext] = runtimeNamed(p, externalRuntimeName('trace'))
    const [extId] = runtimeNamed(p, externalRuntimeName('trace'))
    const [, mcp] = runtimeNamed(p, mcpRuntimeName('trace'))
    expect(mcp.Properties.ProtocolConfiguration).toBe('MCP')
    expect(mcp.Properties.AuthorizerConfiguration).toEqual(ext.Properties.AuthorizerConfiguration)
    expect(mcp.Properties.AgentRuntimeArtifact).toEqual(ext.Properties.AgentRuntimeArtifact)
    expect(target(mcp.Properties.RoleArn)).toMatch(/^ExternalMcpRuntimeRole/)
    expect(mcp.Properties.RoleArn).not.toEqual(ext.Properties.RoleArn)
    const env = mcp.Properties.EnvironmentVariables as Record<string, unknown>
    expect(env).toMatchObject({ TRACE_AGENT_MODE: 'mcp', AWS_REGION: 'us-east-1', TRACE_EXTERNAL_RESOURCE_SERVER: 'trace-external', AGENT_OBSERVABILITY_ENABLED: 'true' })
    expect(env.TRACE_EXTERNAL_RUNTIME_ARN).toEqual({ 'Fn::GetAtt': [extId, 'AgentRuntimeArn'] })
    // nothing of the data or the people: no bucket, no GitHub secret, no pool clients
    for (const k of ['TRACE_HOME', 'TRACE_GITHUB_SECRET_ARN', 'TRACE_WORKER_RUNTIMES', 'TRACE_COGNITO_CLIENT_ID']) expect(env).not.toHaveProperty(k)
    // with observability off, the same quiet settings as every runtime
    const [, quiet] = runtimeNamed(json(onQuiet.parent), mcpRuntimeName('trace'))
    expect(quiet.Properties.EnvironmentVariables).toMatchObject({ DISABLE_ADOT_OBSERVABILITY: 'true', OTEL_SDK_DISABLED: 'true' })
  })

  it('gives the MCP role its image, logs, metrics and spans, and nothing of Cognito, S3, Bedrock or invoking AgentCore', () => {
    const p = json(on.parent)
    const role = Object.keys(p.Resources).find((k) => k.startsWith('ExternalMcpRuntimeRole') && p.Resources[k]?.Type === 'AWS::IAM::Role') ?? ''
    const sts = roleStatements(p, role)
    expect(sts.length).toBeGreaterThan(0)
    const all = sts.flatMap(actions)
    for (const a of all) expect(a, a).toMatch(/^(ecr|logs|xray|cloudwatch):/)
    expect(all).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(cognito-idp|s3|bedrock|bedrock-agentcore|secretsmanager|lambda|sts):/)]))
    expect(all).toEqual(expect.arrayContaining(['ecr:BatchGetImage', 'ecr:GetAuthorizationToken', 'logs:PutLogEvents', 'xray:PutTraceSegments', 'cloudwatch:PutMetricData', 'logs:PutResourcePolicy']))
    // its log writes are its own runtime's log group only
    for (const s of sts.filter((x) => actions(x).includes('logs:PutLogEvents'))) expect(JSON.stringify(s.Resource)).toMatch(/runtimes\/trace_mcp-\*/)
    // and no other role of the stack is it
    const trust = (p.Resources[role]?.Properties.AssumeRolePolicyDocument as { Statement: { Principal: unknown }[] }).Statement
    expect(JSON.stringify(trust)).toContain('bedrock-agentcore.amazonaws.com')
  })

  it('lets the API role manage the pool\'s app clients and their secrets, on that pool only, in one statement', () => {
    const p = json(on.parent)
    const role = Object.keys(p.Resources).find((k) => /^ApiRuntimeRole[0-9A-F]{8}$/.test(k)) ?? ''
    const sts = roleStatements(p, role)
    const grant = sts.filter((s) => s.Sid === 'ManageConnectedSystemClients')
    expect(grant).toHaveLength(1)
    expect(actions(grant[0] as Statement).sort()).toEqual([...CONNECTED_SYSTEM_CLIENT_ACTIONS].sort())
    expect(grant[0]?.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Users[0-9A-F]{8}$/), 'Arn'] })
    // no other statement of it names the client actions
    for (const s of sts.filter((x) => x.Sid !== 'ManageConnectedSystemClients')) for (const a of CONNECTED_SYSTEM_CLIENT_ACTIONS) expect(actions(s)).not.toContain(a)
    // and it does not run the external runtime: none of that runtime's logs
    expect(JSON.stringify(sts)).not.toContain('runtimes/trace_external-*')
    // off: none of it
    const offRole = Object.keys(json(off.parent).Resources).find((k) => /^ApiRuntimeRole[0-9A-F]{8}$/.test(k)) ?? ''
    expect(roleStatements(json(off.parent), offRole).flatMap(actions)).not.toContain('cognito-idp:CreateUserPoolClient')
  })

  it('gives the external runtime its own role: what the systems\' actions need, no Cognito, no order watch, nothing only people use', () => {
    const p = json(on.parent)
    const role = Object.keys(p.Resources).find((k) => /^ExternalExternalRuntimeRole[0-9A-F]{8}$/.test(k) && p.Resources[k]?.Type === 'AWS::IAM::Role') ?? ''
    expect(p.Resources[role]?.Properties.RoleName).toBe('trace-agent-external-us-east-1')
    const sts = roleStatements(p, role)
    const all = sts.flatMap(actions)
    // no Cognito at all (not the admin actions, not the app clients), no order watch, integrations or dictation
    expect(all.filter((a) => a.startsWith('cognito-idp:'))).toEqual([])
    for (const a of ['lambda:InvokeFunction', 'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret', 'transcribe:GetVocabulary', 's3:DeleteObject']) expect(all, a).not.toContain(a)
    const text = JSON.stringify(sts)
    for (const x of ['order-watch', 'integrations', '/central/*', '/prompts/*', '/chats/*', 'pending-projects', 'actuals']) expect(text, x).not.toContain(x)
    // what the systems' actions need: the GitHub token, invoking the workers, memory records, knowledge bases, the stores
    expect(all).toEqual(expect.arrayContaining(['secretsmanager:GetSecretValue', 'bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:RetrieveMemoryRecords', 's3:GetObject', 'dynamodb:UpdateItem']))
    // writes: the journey record (conditional), when each system was last seen, and the rate-limit table; nothing else
    const puts = sts.filter((s) => actions(s).includes('s3:PutObject')).map((s) => JSON.stringify(s.Resource))
    expect(puts.every((r) => r.includes('/projects/*/journey/*') || r.includes('/access/services-seen/*'))).toBe(true)
    expect(puts.some((r) => r.includes('/access/services-seen/*'))).toBe(true)
    // the access store itself is read only
    expect(sts.filter((s) => actions(s).includes('s3:PutObject')).map((s) => JSON.stringify(s.Resource)).join()).not.toMatch(/\/access\/\*/)
    const ddb = sts.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')))
    expect(ddb).toHaveLength(1)
    expect(actions(ddb[0] as Statement)).toEqual(['dynamodb:UpdateItem'])
    expect(target(ddb[0]?.Resource)).toMatch(/^ExternalLimits/)
    // and the people's API role may not touch the table
    const apiRole = Object.keys(p.Resources).find((k) => /^ApiRuntimeRole[0-9A-F]{8}$/.test(k)) ?? ''
    expect(roleStatements(p, apiRole).flatMap(actions).filter((a) => a.startsWith('dynamodb:'))).toEqual([])
  })

  it('keeps the people\'s API role as it is without the feature, plus the app clients\' grant', () => {
    const roleOf = (t: Tpl): string => Object.keys(t.Resources).find((k) => /^ApiRuntimeRole[0-9A-F]{8}$/.test(k)) ?? ''
    const norm = (t: Tpl): string[] => roleStatements(t, roleOf(t)).map((s) => sameApartFromAssets(s)).sort()
    const withIt = norm(json(on.parent)).filter((s) => !s.includes('ManageConnectedSystemClients'))
    expect(withIt).toEqual(norm(json(off.parent)))
  })

  it('makes the rate-limit table on demand, with a TTL, and only with the setting', () => {
    on.parent.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'trace-external-limits', BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'k', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    })
    expect(Object.values(json(off.parent).Resources).filter((r) => r.Type === 'AWS::DynamoDB::Table')).toEqual([])
  })

  it('outputs the two addresses (encoded ARNs), the token address and the resource server', () => {
    const p = json(on.parent)
    const [extId] = runtimeNamed(p, externalRuntimeName('trace'))
    const [mcpId] = runtimeNamed(p, mcpRuntimeName('trace'))
    const url = (id: string): unknown => ({
      'Fn::Join': ['', [
        'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/',
        { 'Fn::Join': ['%2F', { 'Fn::Split': ['/', { 'Fn::Join': ['%3A', { 'Fn::Split': [':', { 'Fn::GetAtt': [id, 'AgentRuntimeArn'] }] }] }] }] },
        '/invocations?qualifier=DEFAULT',
      ]],
    })
    expect(p.Outputs?.[EXTERNAL_OUTPUTS.apiUrl]?.Value).toEqual(url(extId))
    expect(p.Outputs?.[EXTERNAL_OUTPUTS.mcpUrl]?.Value).toEqual(url(mcpId))
    expect(JSON.stringify(p.Outputs?.[EXTERNAL_OUTPUTS.tokenUrl]?.Value)).toMatch(/UsersDomain.*\.auth\.us-east-1\.amazoncognito\.com\/oauth2\/token/)
    expect(target(p.Outputs?.[EXTERNAL_OUTPUTS.resourceServer]?.Value)).toMatch(/^ExternalScopes/)
    // what that encoding makes of a real ARN is what encodeURIComponent makes of it (src/api/runtime-url.ts)
    const arn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_external-AbC12_dEf3'
    expect(arn.split(':').join('%3A').split('/').join('%2F')).toBe(encodeURIComponent(arn))
  })

  it('joins both runtimes to the dashboard and the log group outputs, as the API', () => {
    const p = json(on.parent)
    expect(p.Outputs).toHaveProperty('ExternalLogGroup')
    expect(p.Outputs).toHaveProperty('McpLogGroup')
    const body = JSON.stringify(Object.values(p.Resources).find((r) => r.Type === 'AWS::CloudWatch::Dashboard')?.Properties.DashboardBody)
    for (const n of ['trace_api', 'trace_external', 'trace_mcp']) expect(body).toContain(n)
    // each role that runs a runtime may let X-Ray deliver its spans to that runtime's log group
    for (const [role, name] of [[/^ApiRuntimeRole[0-9A-F]{8}$/, 'trace_api'], [/^ExternalExternalRuntimeRole[0-9A-F]{8}$/, 'trace_external']] as const) {
      const id = Object.keys(p.Resources).find((k) => role.test(k)) ?? ''
      const spans = roleStatements(p, id).filter((s) => actions(s).includes('logs:PutResourcePolicy'))
      expect(spans.map((s) => s.Sid)).toEqual(['AgentCoreSpanDestination'])
      expect(JSON.stringify(spans[0]?.Resource)).toContain(`runtimes/${name}-*`)
    }
  })

  it('works in the flat layout too, within CloudFormation\'s quotas', () => {
    const p = json(onFlat.parent)
    expect(Object.values(p.Resources).filter((r) => r.Type === 'AWS::BedrockAgentCore::Runtime')).toHaveLength(5)
    for (const o of Object.values(EXTERNAL_OUTPUTS)) expect(p.Outputs).toHaveProperty(o)
  })
})
