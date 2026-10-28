/**
 * External access (external.enabled; docs/external-access.md): other systems and AI agents reach trace with their own
 * keys, as connected systems. Made only with the setting on; with it off none of this is in the stack.
 *
 *   scopes        a resource server on the people's user pool, `trace-external`, with the scopes `read` and `write`.
 *                 Each connected system is an app client of the pool (client credentials, a secret), created by the
 *                 API at run time when an admin adds the system, with one or both scopes
 *   external      the AgentCore runtime `<prefix>_external`: the agent image in `external` mode, which runs the API
 *                 server for connected systems (the people's API code, its checks, and the systems' allow-list). It
 *                 runs with the API's own role. Its authorizer takes any token of the pool that carries one of the
 *                 scopes: no allowed clients, because the systems' clients are made after the deploy and AgentCore
 *                 requires every check it is given to pass
 *   mcp           the AgentCore runtime `<prefix>_mcp`: the same image in `mcp` mode, an MCP server that forwards each
 *                 tool call to the external runtime with the caller's own token. Same authorizer. Its own role, which
 *                 may pull the image and write its logs, metrics and spans, and nothing else
 *   API role      may create, change, describe and delete the pool's app clients and their secrets (the connected
 *                 systems' keys), and write the external runtime's logs (it runs that runtime too)
 *
 * The addresses (externalUrl, mcpUrl) are AgentCore's data-plane invocation URLs, made in the template from each
 * runtime's ARN with ':' and '/' encoded, as encodeURIComponent encodes them (src/api/runtime-url.ts).
 */
import { CfnOutput, Fn, Stack } from 'aws-cdk-lib'
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import type * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import { EXTERNAL_OUTPUTS, EXTERNAL_RESOURCE_SERVER, externalRuntimeName, mcpRuntimeName } from './props.js'

/** The scopes a connected system's token must carry one of (`trace-external/read`, `trace-external/write`). */
export const EXTERNAL_ALLOWED_SCOPES = [`${EXTERNAL_RESOURCE_SERVER}/read`, `${EXTERNAL_RESOURCE_SERVER}/write`] as const

/** What the API role may do with the pool's app clients: the connected systems' keys (services.*, admins only). */
export const CONNECTED_SYSTEM_CLIENT_ACTIONS = [
  'cognito-idp:CreateUserPoolClient', 'cognito-idp:UpdateUserPoolClient', 'cognito-idp:DeleteUserPoolClient',
  'cognito-idp:AddUserPoolClientSecret', 'cognito-idp:DeleteUserPoolClientSecret', 'cognito-idp:ListUserPoolClientSecrets',
] as const

/**
 * A runtime's data-plane invocation URL, from its ARN as a CloudFormation value:
 * https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<URL-encoded ARN>/invocations?qualifier=DEFAULT. A runtime
 * ARN has letters, digits, '-', '_', ':' and '/', of which encodeURIComponent changes only ':' and '/'.
 */
export function runtimeInvocationUrl(region: string, arn: string): string {
  const encoded = Fn.join('%2F', Fn.split('/', Fn.join('%3A', Fn.split(':', arn))))
  return Fn.join('', [`https://bedrock-agentcore.${region}.amazonaws.com/runtimes/`, encoded, '/invocations?qualifier=DEFAULT'])
}

export interface ExternalAccessProps {
  prefix: string
  region: string
  account: string
  /** the people's user pool and its sign-in domain (the token address is the domain's /oauth2/token) */
  pool: cognito.IUserPool
  tokenUrl: string
  /** the pool's OpenID discovery URL, as the API runtime's authorizer has it */
  discoveryUrl: string
  /** the agent image: its repository (the MCP role pulls from it) and its URI */
  images: ecr.IRepository
  imageUri: string
  /** the API's role: the external runtime runs with it */
  apiRole: iam.Role
  /** the API runtime's environment: the external runtime's is the same, in `external` mode */
  apiEnvironment: Readonly<Record<string, string>>
  /** the API runtime's session limits and file system */
  lifecycle: CfnRuntime.LifecycleConfigurationProperty
  filesystems: CfnRuntime.FilesystemConfigurationProperty[]
  tags: Record<string, string>
}

export class ExternalAccess extends Construct {
  readonly resourceServer: cognito.UserPoolResourceServer
  readonly external: CfnRuntime
  readonly mcp: CfnRuntime
  readonly mcpRole: iam.Role
  readonly externalName: string
  readonly mcpName: string
  /** the two runtimes' invocation URLs */
  readonly externalUrl: string
  readonly mcpUrl: string

  constructor(scope: Construct, id: string, p: ExternalAccessProps) {
    super(scope, id)
    const { partition } = Stack.of(this)
    this.externalName = externalRuntimeName(p.prefix)
    this.mcpName = mcpRuntimeName(p.prefix)

    // ------------------------------------------------------------------ the scopes connected systems are given
    this.resourceServer = new cognito.UserPoolResourceServer(this, 'Scopes', {
      userPool: p.pool,
      identifier: EXTERNAL_RESOURCE_SERVER,
      userPoolResourceServerName: `${p.prefix}-external`,
      scopes: [
        new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'read the projects the system is on' }),
        new cognito.ResourceServerScope({ scopeName: 'write', scopeDescription: 'start work and change settings on the projects the system contributes to' }),
      ],
    })
    // any token of the pool with one of the scopes; which system it is, and whether it is still enabled, the runtime
    // checks itself on every call. No allowedClients: the systems' clients are made at run time
    const authorizerConfiguration = { customJwtAuthorizer: { discoveryUrl: p.discoveryUrl, allowedScopes: [...EXTERNAL_ALLOWED_SCOPES] } }

    // ------------------------------------------------------------------ the API role: the systems' keys, and the external runtime's logs
    p.apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'ManageConnectedSystemClients', actions: [...CONNECTED_SYSTEM_CLIENT_ACTIONS], resources: [p.pool.userPoolArn] }))
    const externalLogs = `arn:${partition}:logs:${p.region}:${p.account}:log-group:/aws/bedrock-agentcore/runtimes/${this.externalName}-*`
    p.apiRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ExternalRuntimeLogs', actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], resources: [externalLogs, `${externalLogs}:log-stream:*`],
    }))

    // ------------------------------------------------------------------ the external API: the people's API code, for systems
    this.external = new CfnRuntime(this, 'ExternalRuntime', {
      agentRuntimeName: this.externalName,
      description: 'trace: the API for connected systems, behind their scoped tokens and per-project grants',
      agentRuntimeArtifact: { containerConfiguration: { containerUri: p.imageUri } },
      roleArn: p.apiRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      authorizerConfiguration,
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      lifecycleConfiguration: p.lifecycle,
      filesystemConfigurations: p.filesystems,
      environmentVariables: { ...p.apiEnvironment, TRACE_AGENT_MODE: 'external' },
      tags: p.tags,
    })
    this.external.node.addDependency(p.apiRole)
    this.externalUrl = runtimeInvocationUrl(p.region, this.external.attrAgentRuntimeArn)

    // ------------------------------------------------------------------ the MCP endpoint: its own role, logs and spans only
    this.mcpRole = new iam.Role(this, 'McpRuntimeRole', {
      roleName: `${p.prefix}-agent-mcp-${p.region}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': p.account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock-agentcore:${p.region}:${p.account}:*` },
        },
      }),
      description: 'Run by the trace MCP endpoint on Bedrock AgentCore: pulls its image and writes its logs and spans, nothing else',
    })
    p.images.grantPull(this.mcpRole)
    this.mcpRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }))
    const mcpLogs = `arn:${partition}:logs:${p.region}:${p.account}:log-group:/aws/bedrock-agentcore/runtimes/${this.mcpName}-*`
    this.mcpRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], resources: [mcpLogs, `${mcpLogs}:log-stream:*`],
    }))
    this.mcpRole.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [`arn:${partition}:logs:${p.region}:${p.account}:log-group:*`] }))
    this.mcpRole.addToPolicy(new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'], resources: ['*'] }))
    this.mcpRole.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } }))

    this.mcp = new CfnRuntime(this, 'McpRuntime', {
      agentRuntimeName: this.mcpName,
      description: 'trace: the MCP endpoint for connected systems; forwards each tool call to the external API with the caller\'s token',
      agentRuntimeArtifact: { containerConfiguration: { containerUri: p.imageUri } },
      roleArn: this.mcpRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'MCP',
      authorizerConfiguration,
      // the caller's token, which it forwards
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      lifecycleConfiguration: p.lifecycle,
      environmentVariables: {
        AWS_REGION: p.region,
        TRACE_AGENT_MODE: 'mcp',
        TRACE_PREFIX: p.prefix,
        // where it forwards each tool call (src/api/runtime-url.ts makes the address from it)
        TRACE_EXTERNAL_RUNTIME_ARN: this.external.attrAgentRuntimeArn,
        TRACE_EXTERNAL_RESOURCE_SERVER: EXTERNAL_RESOURCE_SERVER,
        // for MCP clients that get their own token: the issuer and the token address
        TRACE_COGNITO_ISSUER: `https://cognito-idp.${p.region}.amazonaws.com/${p.pool.userPoolId}`,
        TRACE_TOKEN_URL: p.tokenUrl,
      },
      tags: p.tags,
    })
    this.mcp.node.addDependency(this.mcpRole)
    this.mcpUrl = runtimeInvocationUrl(p.region, this.mcp.attrAgentRuntimeArn)
  }

  /** The stack's outputs: the two addresses, the token address and the resource server. */
  addOutputs(stack: Stack, tokenUrl: string): void {
    new CfnOutput(stack, EXTERNAL_OUTPUTS.apiUrl, { value: this.externalUrl, description: 'External access: the API connected systems call (POST, with a bearer token)' })
    new CfnOutput(stack, EXTERNAL_OUTPUTS.mcpUrl, { value: this.mcpUrl, description: 'External access: the MCP endpoint for AI agents and MCP clients (streamable HTTP, with a bearer token)' })
    new CfnOutput(stack, EXTERNAL_OUTPUTS.tokenUrl, { value: tokenUrl, description: 'External access: where connected systems get a token (OAuth client credentials)' })
    new CfnOutput(stack, EXTERNAL_OUTPUTS.resourceServer, { value: this.resourceServer.userPoolResourceServerId, description: 'External access: the resource server connected systems\' scopes belong to (<id>/read, <id>/write)' })
  }
}
