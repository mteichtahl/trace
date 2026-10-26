/**
 * The installer's AWS side before deploying: resolve credentials (a named profile — SSO included — or keys pasted
 * into the page), confirm the account, and check that the region has what trace needs: Bedrock AgentCore, an
 * Anthropic model the account can use, whether the GitHub OIDC provider already exists, whether CDK is bootstrapped,
 * and whether trace is already installed (an update rather than a first install). And around the deploy: which
 * projects the stack has and which of a project's fixed names are already taken in the account (a removed project's
 * retained memory, its delivery sources and destinations, its secret in its recovery window), the stack's outputs
 * with each nested project stack's, the GPU image build the deploy started, and how the CodeBuild runners reach
 * GitHub: the AWS CodeConnections connection (an authorized one reused, or the stack's own, waited on after the
 * deploy until a person authorizes it), or CodeBuild's GitHub source credential, the token imported with
 * ImportSourceCredentials. `npm run deploy:ci` (src/infra/ci-deploy.ts) uses the same connection helpers.
 *
 * The functions that call AWS around the deploy take their SDK clients as a parameter, so tests give them fakes.
 */
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock'
import { BedrockAgentCoreControlClient, ListAgentRuntimesCommand, ListMemoriesCommand } from '@aws-sdk/client-bedrock-agentcore-control'
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand, type Stack } from '@aws-sdk/client-cloudformation'
import { CloudWatchLogsClient, DescribeDeliveryDestinationsCommand, DescribeDeliverySourcesCommand } from '@aws-sdk/client-cloudwatch-logs'
import {
  BatchGetBuildsCommand, CodeBuildClient, DeleteSourceCredentialsCommand, ImportSourceCredentialsCommand, ListSourceCredentialsCommand, StartBuildCommand,
} from '@aws-sdk/client-codebuild'
import { CodeConnectionsClient, GetConnectionCommand, ListConnectionsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-codeconnections'
import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam'
import { DeleteSecretCommand, DescribeSecretCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-providers'
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader'
import type { AwsCredentialIdentity } from '@smithy/types'
import { CONNECTION_CREATED_OUTPUT, CONNECTION_OUTPUT, LAYOUT_OUTPUT, REPOSITORY_OUTPUT, connectionName, projectHash } from '../infra/props.js'
import type { Answers, Secrets } from './answers.js'

export async function profiles(): Promise<{ names: string[]; regions: Record<string, string> }> {
  try {
    const { configFile, credentialsFile } = await loadSharedConfigFiles()
    const names = [...new Set([...Object.keys(configFile), ...Object.keys(credentialsFile)])].sort()
    const regions = Object.fromEntries(names.map((n) => [n, configFile[n]?.region ?? ''] as const).filter(([, r]) => r))
    return { names, regions }
  } catch {
    return { names: [], regions: {} }
  }
}

/** Static credentials for the SDK clients and the CDK subprocess (resolved once; SSO and assume-role included). */
export async function credentials(aws: Pick<Answers['aws'], 'mode' | 'profile'>, s: Pick<Secrets, 'awsAccessKeyId' | 'awsSecretAccessKey' | 'awsSessionToken'>): Promise<AwsCredentialIdentity> {
  if (aws.mode === 'keys') {
    if (!s.awsAccessKeyId || !s.awsSecretAccessKey) throw new Error('enter the access key id and secret access key')
    return { accessKeyId: s.awsAccessKeyId, secretAccessKey: s.awsSecretAccessKey, ...(s.awsSessionToken ? { sessionToken: s.awsSessionToken } : {}) }
  }
  return fromIni({ profile: aws.profile })()
}

/** The environment for a CDK subprocess: the resolved credentials and the region, nothing else of ours. */
export function awsEnv(c: AwsCredentialIdentity, region: string): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: c.accessKeyId, AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
    ...(c.sessionToken ? { AWS_SESSION_TOKEN: c.sessionToken } : {}),
    AWS_REGION: region, AWS_DEFAULT_REGION: region,
  }
}

export interface AwsCheck {
  account: string
  arn: string
  region: string
  agentCore: { ok: boolean; reason: string }
  models: { id: string; name: string }[]
  oidcProvider: boolean
  /** the provider is the trace stack's own resource (an earlier deploy made it): it must stay in the stack, or
   * CloudFormation deletes it */
  oidcInStack?: boolean
  cdkBootstrapped: boolean
  /** the CDKToolkit stack's BootstrapVersion output (null when there is none) */
  cdkVersion?: number | null
  existing: { stack: string; status: string; outputs: Record<string, string> } | null
  warnings: string[]
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function checkAws(creds: AwsCredentialIdentity, region: string, stack: string): Promise<AwsCheck> {
  const cfg = { region, credentials: creds }
  const id = await new STSClient(cfg).send(new GetCallerIdentityCommand({}))
  const warnings: string[] = []
  let agentCore = { ok: true, reason: '' }
  try {
    await new BedrockAgentCoreControlClient(cfg).send(new ListAgentRuntimesCommand({ maxResults: 1 }))
  } catch (e) {
    agentCore = { ok: false, reason: msg(e) }
  }
  let models: AwsCheck['models'] = []
  try {
    const r = await new BedrockClient(cfg).send(new ListInferenceProfilesCommand({ maxResults: 100 }))
    models = (r.inferenceProfileSummaries ?? [])
      .filter((p) => /anthropic/i.test(p.inferenceProfileId ?? '') && p.status === 'ACTIVE')
      .map((p) => ({ id: p.inferenceProfileId ?? '', name: p.inferenceProfileName ?? p.inferenceProfileId ?? '' }))
      .sort((a, b) => b.id.localeCompare(a.id))
    if (!models.length) warnings.push(`No active Anthropic inference profile in ${region}: enable model access in the Bedrock console.`)
  } catch (e) {
    warnings.push(`Could not list Bedrock models: ${msg(e)}`)
  }
  let oidcProvider = false
  try {
    const r = await new IAMClient(cfg).send(new ListOpenIDConnectProvidersCommand({}))
    oidcProvider = (r.OpenIDConnectProviderList ?? []).some((p) => (p.Arn ?? '').endsWith('/token.actions.githubusercontent.com'))
  } catch (e) {
    warnings.push(`Could not read the account's OIDC providers: ${msg(e)}`)
  }
  const cfn = new CloudFormationClient(cfg)
  const describe = async (name: string): Promise<{ status: string; outputs: Record<string, string> } | null> => {
    try {
      const s = (await cfn.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]
      return s ? { status: s.StackStatus ?? '', outputs: Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? ''])) } : null
    } catch {
      return null
    }
  }
  const toolkit = await describe('CDKToolkit')
  const existing = await describe(stack)
  let oidcInStack = false
  if (existing) {
    try {
      oidcInStack = (await stackResources(cfn, stack)).some((r) => r.logicalId.startsWith('GithubOidc') && r.type !== 'AWS::CloudFormation::Stack')
    } catch (e) {
      warnings.push(`Could not list the stack's resources: ${msg(e)}`)
    }
  }
  return {
    account: id.Account ?? '', arn: id.Arn ?? '', region, agentCore, models, oidcProvider, oidcInStack,
    cdkBootstrapped: Boolean(toolkit && !toolkit.status.startsWith('DELETE')),
    cdkVersion: toolkit?.outputs.BootstrapVersion ? Number(toolkit.outputs.BootstrapVersion) : null,
    existing: existing ? { stack, ...existing } : null, warnings,
  }
}

type Cfn = Pick<CloudFormationClient, 'send'>

/** The SDK clients the deploy steps use (one place, so tests replace them with this module). */
export const cfnClient = (creds: AwsCredentialIdentity, region: string): CloudFormationClient => new CloudFormationClient({ region, credentials: creds })
export const codebuildClient = (creds: AwsCredentialIdentity, region: string): CodeBuildClient => new CodeBuildClient({ region, credentials: creds })

const outputsOf = (s: Stack): Record<string, string> => Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']))

/** Every resource of a stack, its logical id, type and physical id. ListStackResources, not DescribeStackResources:
 * that one returns only the first 100 resources, and the parent has more with many projects. */
export async function stackResources(cfn: Cfn, stack: string): Promise<{ logicalId: string; type: string; physicalId: string }[]> {
  const out: { logicalId: string; type: string; physicalId: string }[] = []
  let NextToken: string | undefined
  do {
    const r = await cfn.send(new ListStackResourcesCommand({ StackName: stack, ...(NextToken ? { NextToken } : {}) }))
    for (const x of r.StackResourceSummaries ?? []) out.push({ logicalId: x.LogicalResourceId ?? '', type: x.ResourceType ?? '', physicalId: x.PhysicalResourceId ?? '' })
    NextToken = r.NextToken
  } while (NextToken)
  return out
}

/** A project's nested stack's logical id in the parent: Project<hash>Stack… (src/infra/stack.ts). */
const NESTED_ID = /^Project([0-9a-f]{8})Stack/

/**
 * The stack's outputs. In the nested layout the parent carries none of a project's (Project<hash>RuntimeArn,
 * ActionsRoleArn, MemoryId, GithubSecretArn, …): they are read from each project's nested stack (DescribeStacks on its
 * physical id, found with ListStackResources on the parent), which is matched to its project by its logical id and
 * checked against its Repository output, and merged in under the names they have there. Only outputs named for that
 * project's hash are taken from it, so a nested stack can never supply another project's.
 */
export async function stackOutputs(creds: AwsCredentialIdentity, region: string, stack: string, cfn: Cfn = new CloudFormationClient({ region, credentials: creds })): Promise<Record<string, string>> {
  const s = (await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]
  if (!s) throw new Error(`stack ${stack} not found`)
  const out = outputsOf(s)
  if (out[LAYOUT_OUTPUT] !== 'nested') return out
  const nested = (await stackResources(cfn, stack)).filter((r) => r.type === 'AWS::CloudFormation::Stack' && NESTED_ID.test(r.logicalId) && r.physicalId)
  for (const r of nested) {
    const hash = NESTED_ID.exec(r.logicalId)?.[1] ?? ''
    const n = (await cfn.send(new DescribeStacksCommand({ StackName: r.physicalId }))).Stacks?.[0]
    if (!n) throw new Error(`the nested stack ${r.logicalId} (${r.physicalId}) was not found`)
    const own = outputsOf(n)
    const repo = own[REPOSITORY_OUTPUT]
    if (repo && projectHash(repo) !== hash) throw new Error(`the nested stack ${r.logicalId} says it is ${repo}'s, whose hash is not ${hash}`)
    for (const [k, v] of Object.entries(own)) if (k.startsWith(`Project${hash}`)) out[k] = v
  }
  return out
}

/** The hashes of the projects the stack has now (flat: Project<hash>… resources; nested: Project<hash>Stack…); none
 * when there is no stack. */
export async function deployedProjects(cfn: Cfn, stack: string): Promise<Set<string>> {
  try {
    const rs = await stackResources(cfn, stack)
    return new Set(rs.flatMap((r) => /^(?:Observability)?Project([0-9a-f]{8})/.exec(r.logicalId)?.[1] ?? []))
  } catch (e) {
    if (/does not exist/.test(msg(e))) return new Set()
    throw e
  }
}

/** The fixed names of one project, at one generation, that can outlive it in the account. */
export interface ProjectNames { memories: string[]; deliveries: string[]; secrets: string[] }

export interface NameClients {
  agentcore: Pick<BedrockAgentCoreControlClient, 'send'>
  logs: Pick<CloudWatchLogsClient, 'send'>
  secrets: Pick<SecretsManagerClient, 'send'>
}

export const nameClients = (creds: AwsCredentialIdentity, region: string): NameClients => ({
  agentcore: new BedrockAgentCoreControlClient({ region, credentials: creds }),
  logs: new CloudWatchLogsClient({ region, credentials: creds }),
  secrets: new SecretsManagerClient({ region, credentials: creds }),
})

/**
 * Which of these names are taken in the account and region: a memory (ListMemories: its id is `<name>-<10>`, in any
 * status, a deleting one too), a delivery source or destination (DescribeDeliverySources and
 * DescribeDeliveryDestinations), a secret (DescribeSecret, which also finds one scheduled for deletion: it holds its name
 * through its recovery window). The listings are read once and kept; the secrets are asked one by one.
 */
export function nameIndex(c: NameClients): { taken: (n: ProjectNames) => Promise<string[]> } {
  let memories: Promise<string[]> | null = null
  let deliveries: Promise<Set<string>> | null = null
  const secrets = new Map<string, Promise<boolean>>()
  const listMemories = async (): Promise<string[]> => {
    const ids: string[] = []
    let nextToken: string | undefined
    do {
      const r = await c.agentcore.send(new ListMemoriesCommand({ maxResults: 100, ...(nextToken ? { nextToken } : {}) }))
      for (const m of r.memories ?? []) if (m.id) ids.push(m.id)
      nextToken = r.nextToken
    } while (nextToken)
    return ids
  }
  const listDeliveries = async (): Promise<Set<string>> => {
    const names = new Set<string>()
    let nextToken: string | undefined
    do {
      const r = await c.logs.send(new DescribeDeliverySourcesCommand({ limit: 50, ...(nextToken ? { nextToken } : {}) }))
      for (const d of r.deliverySources ?? []) if (d.name) names.add(d.name)
      nextToken = r.nextToken
    } while (nextToken)
    do {
      const r = await c.logs.send(new DescribeDeliveryDestinationsCommand({ limit: 50, ...(nextToken ? { nextToken } : {}) }))
      for (const d of r.deliveryDestinations ?? []) if (d.name) names.add(d.name)
      nextToken = r.nextToken
    } while (nextToken)
    return names
  }
  const secretTaken = async (name: string): Promise<boolean> => {
    try {
      await c.secrets.send(new DescribeSecretCommand({ SecretId: name }))
      return true
    } catch (e) {
      if (e instanceof ResourceNotFoundException || (e as { name?: string }).name === 'ResourceNotFoundException') return false
      throw e
    }
  }
  return {
    taken: async (n) => {
      const out: string[] = []
      if (n.memories.length) {
        const ids = await (memories ??= listMemories())
        for (const name of n.memories) if (ids.some((id) => id.startsWith(`${name}-`))) out.push(name)
      }
      if (n.deliveries.length) {
        const names = await (deliveries ??= listDeliveries())
        for (const name of n.deliveries) if (names.has(name)) out.push(name)
      }
      for (const name of n.secrets) {
        if (!secrets.has(name)) secrets.set(name, secretTaken(name))
        if (await secrets.get(name)) out.push(name)
      }
      return out
    },
  }
}

const TERMINAL_FAILED = new Set(['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'])

/**
 * Wait for the GPU image build the deploy started (the stack does not wait for it: src/infra/gpu.ts), so the core is
 * up whatever happens to it. A build that failed before this run (an earlier deploy's: the same source does not
 * start another) is started again once, with the same image tag; a build this run's deploy started and that failed is
 * reported, not retried (the next installer run retries it). Returns whether the image is there, and what happened.
 */
export async function ensureGpuImage(
  codebuild: Pick<CodeBuildClient, 'send'>, o: { buildId: string; imageTag: string; startedAfter: Date; pollMs?: number; timeoutMs?: number; log?: (l: string) => void },
): Promise<{ ok: boolean; detail: string }> {
  const project = o.buildId.split(':')[0] ?? ''
  if (!project || !o.imageTag) return { ok: false, detail: `no GPU image build to wait for (${o.buildId || 'none'})` }
  const poll = o.pollMs ?? 30_000
  const deadline = Date.now() + (o.timeoutMs ?? 3 * 3600_000)
  let id = o.buildId
  let retried = false
  for (;;) {
    const b = (await codebuild.send(new BatchGetBuildsCommand({ ids: [id] }))).builds?.[0]
    const status = b?.buildStatus
    if (status === 'SUCCEEDED') return { ok: true, detail: `the GPU image ${o.imageTag} is built (${id})` }
    const before = !b?.startTime || b.startTime.getTime() < o.startedAfter.getTime()
    if (!b || (status && TERMINAL_FAILED.has(status))) {
      if (!retried && before) {
        const r = await codebuild.send(new StartBuildCommand({ projectName: project, environmentVariablesOverride: [{ name: 'IMAGE_TAG', value: o.imageTag }] }))
        if (!r.build?.id) throw new Error('CodeBuild started no build')
        o.log?.(`the GPU image build ${id} ${b ? status?.toLowerCase() : 'is gone'}: started it again (${r.build.id})`)
        id = r.build.id
        retried = true
        continue
      }
      const phase = b?.phases?.find((ph) => ph.phaseStatus && ph.phaseStatus !== 'SUCCEEDED')
      return { ok: false, detail: `the GPU image build ${id} ${status?.toLowerCase() ?? 'failed'}${phase ? ` in ${phase.phaseType}` : ''} (logs: ${b?.logs?.deepLink ?? 'the CodeBuild console'})` }
    }
    if (Date.now() > deadline) return { ok: false, detail: `the GPU image build ${id} is still running; run the installer again later to check it` }
    await new Promise((r) => setTimeout(r, poll))
  }
}

/**
 * Free these secret names for the nested deploy of the move to nested stacks: a secret the 'drain' deploy deleted may
 * still hold its name for its recovery window, and the nested stack creates one of the same name. Each is a copy of
 * a GitHub token that the installer writes again right after, so a secret scheduled for deletion is deleted now,
 * without recovery. A secret that is not scheduled for deletion is left alone and reported (the deploy would fail on
 * it). Returns what was done, one line per name.
 */
export async function freeSecretNames(creds: AwsCredentialIdentity, region: string, names: readonly string[]): Promise<string[]> {
  const sm = new SecretsManagerClient({ region, credentials: creds })
  const out: string[] = []
  for (const name of names) {
    try {
      const d = await sm.send(new DescribeSecretCommand({ SecretId: name }))
      if (!d.DeletedDate) throw new Error(`the secret ${name} still exists outside its scheduled deletion: the nested stack cannot create it (delete it, or keep layout flat)`)
      await sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }))
      out.push(`${name}: was scheduled for deletion; deleted now so the nested stack can create it`)
    } catch (e) {
      if (e instanceof ResourceNotFoundException) { out.push(`${name}: free`); continue }
      throw e
    }
  }
  return out
}

/**
 * The facts derive.ts needs that the answers leave open, and only those (src/installer/derive.ts resolveAnswers):
 * the account always (STS), the profile's region, the token's login and email, the region's models, the GPU and CPU
 * quotas, and whether the region has S3 Vectors. A fact that cannot be read is left out (its default applies).
 */
export async function liveFacts(creds: AwsCredentialIdentity, a: Answers, token: string): Promise<import('./derive.js').Facts> {
  const { liveDeps, QUOTAS } = await import('./preflight.js')
  const profileRegion = a.aws.mode === 'profile' ? (await profiles()).regions[a.aws.profile] ?? '' : ''
  const region = a.aws.region || profileRegion || 'us-east-1'
  const d = await liveDeps(creds, region, token)
  const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined)
  const [sts, info, email, models, gpuQuota, cpuQuota, s3vectors] = await Promise.all([
    d.sts(),
    a.github.login ? Promise.resolve(undefined) : quiet(d.token()),
    a.adminEmail ? Promise.resolve(undefined) : quiet(d.email()),
    a.agents.model ? Promise.resolve(undefined) : quiet(d.models()),
    a.agents.gpuEnabled === null ? quiet(d.quota(a.agents.gpuSpot ? QUOTAS.gpuSpot : QUOTAS.gpuOnDemand)) : Promise.resolve(undefined),
    a.agents.cpuEnabled === null ? quiet(d.quota(a.agents.cpuSpot ? QUOTAS.cpuSpot : QUOTAS.cpuOnDemand)) : Promise.resolve(undefined),
    a.agents.knowledgeBase === null ? quiet(d.s3vectors()) : Promise.resolve(undefined),
  ])
  return {
    account: sts.account, ...(profileRegion ? { profileRegion } : {}),
    ...(info ? { login: info.login } : {}), ...(email !== undefined ? { email } : {}), ...(models ? { models } : {}),
    ...(gpuQuota !== undefined ? { gpuQuota } : {}), ...(cpuQuota !== undefined ? { cpuQuota } : {}), ...(s3vectors !== undefined ? { s3vectors } : {}),
  }
}

/** The AWS CodeConnections side: the connection to GitHub through which CodeBuild runs every GitHub Actions job of the
 * onboarded repositories (src/infra/runner.ts). No GitHub token is stored for it: a person authorizes it once in the
 * AWS console, which installs (or picks) the AWS Connector for GitHub app on their account or organization. One
 * authorized connection serves every installation in the account and region, and trace's own CI: the tools reuse it
 * (resolveConnection), and a stack creates its own only when there is none. */
type Connections = Pick<CodeConnectionsClient, 'send'>

export const connectionsClient = (creds: AwsCredentialIdentity, region: string): CodeConnectionsClient => new CodeConnectionsClient({ region, credentials: creds })

export { connectionName }

/** The connection trace's own CI stack creates when it finds none to reuse (src/infra/ci-app.ts). */
export const CI_CONNECTION_NAME = connectionName('trace-ci')

/** Where a person authorizes a pending connection. */
export const connectionsConsoleUrl = (region: string): string => `https://${region}.console.aws.amazon.com/codesuite/settings/connections?region=${region}`

export interface GithubConnection { arn: string; name: string; status: string }

/** Every GitHub connection in the account and region (ListConnections, paged). */
export async function githubConnections(c: Connections): Promise<GithubConnection[]> {
  const out: GithubConnection[] = []
  let NextToken: string | undefined
  do {
    const r = await c.send(new ListConnectionsCommand({ ProviderTypeFilter: 'GitHub', MaxResults: 100, ...(NextToken ? { NextToken } : {}) }))
    for (const x of r.Connections ?? []) out.push({ arn: x.ConnectionArn ?? '', name: x.ConnectionName ?? '', status: x.ConnectionStatus ?? '' })
    NextToken = r.NextToken
  } while (NextToken)
  return out
}

/** One connection (GetConnection), or null when there is no such connection; refuses one that is not GitHub's. */
export async function getConnection(c: Connections, arn: string): Promise<GithubConnection | null> {
  let x
  try {
    x = (await c.send(new GetConnectionCommand({ ConnectionArn: arn }))).Connection
  } catch (e) {
    if ((e as { name?: string }).name === 'ResourceNotFoundException') return null
    throw e
  }
  if (!x) return null
  if (x.ProviderType && x.ProviderType !== 'GitHub') throw new Error(`the connection ${arn} is a ${x.ProviderType} connection, not a GitHub one`)
  return { arn: x.ConnectionArn ?? arn, name: x.ConnectionName ?? '', status: x.ConnectionStatus ?? '' }
}

/** Whether a connection carries the trace:installation tag (made by an installation's stack, or by an earlier installer). */
async function tracesOwn(c: Connections, arn: string): Promise<boolean> {
  try {
    const r = await c.send(new ListTagsForResourceCommand({ ResourceArn: arn }))
    return (r.Tags ?? []).some((t) => t.Key === 'trace:installation')
  } catch {
    return false
  }
}

/**
 * The authorized (AVAILABLE) GitHub connection to reuse, in this order: the names in `prefer` (the installer's:
 * `<prefix>-github`, then trace's own CI's `trace-ci-github`), any other tagged trace:installation, any other. Null
 * when none is AVAILABLE.
 */
export async function reusableConnection(c: Connections, prefer: readonly string[], all?: GithubConnection[]): Promise<GithubConnection | null> {
  const available = (all ?? await githubConnections(c)).filter((x) => x.status === 'AVAILABLE')
  for (const n of prefer) {
    const x = available.find((y) => y.name === n)
    if (x) return x
  }
  for (const x of available) if (await tracesOwn(c, x.arn)) return x
  return available[0] ?? null
}

/** Which connection a deploy uses, and whether the runners can be made with it now. */
export interface ConnectionChoice {
  /** what to give the stack as runners.connectionArn: unset when the stack uses (or creates) its own */
  pass?: string
  /** the connection's ARN when it is known before the deploy (unset: the stack is about to create it) */
  arn?: string
  name: string
  /** AVAILABLE: deploy with connectionReady true, once */
  ready: boolean
  /** what to tell the person */
  message: string
}

/**
 * The connection for a deploy, before it, with no connection ever created here (a stack creates its own):
 *   given        the answers' (deploy:ci: TRACE_CONNECTION_ARN or `-c connectionArn=`): it must exist and be GitHub's
 *   the stack's  the connection the deployed stack created (its CONNECTION_CREATED_OUTPUT), kept on every later run,
 *                authorized or not (a run that stopped waiting for it resumes with it); or the one it was given before,
 *                while that is still AVAILABLE
 *   reused       an AVAILABLE GitHub connection in the account and region (reusableConnection, in `prefer`'s order)
 *   pending      `<prefix>-github` left in the account not authorized (a deleted stack's, which it kept): given to the
 *                stack, which could not create another of that name
 *   new          none: the stack creates `<prefix>-github`
 * Ready is whether that connection is AVAILABLE now.
 */
export async function resolveConnection(c: Connections, o: { prefix: string; given?: string; deployed?: Record<string, string> | null; prefer?: readonly string[] }): Promise<ConnectionChoice> {
  const name = connectionName(o.prefix)
  const prefer = o.prefer ?? [name, CI_CONNECTION_NAME]
  const status = (x: GithubConnection): string => `${x.name || x.arn} (${x.arn})`
  const notReady = (x: GithubConnection, how: string): ConnectionChoice => {
    if (x.status === 'ERROR') throw new Error(`the GitHub connection ${status(x)} is in status ERROR: delete it in the AWS console (Developer Tools > Settings > Connections) and run again, or give the ARN of another connection`)
    return { arn: x.arn, name: x.name || x.arn, ready: false, message: `${how} ${status(x)} is not authorized yet (${x.status || 'status unknown'}): the deploy goes ahead without the build runners, and you authorize it once after the deploy.` }
  }
  if (o.given) {
    const x = await getConnection(c, o.given)
    if (!x) throw new Error(`the GitHub connection ${o.given} you gave does not exist in this account and region`)
    if (x.status === 'AVAILABLE') return { pass: x.arn, arn: x.arn, name: x.name, ready: true, message: `Using the GitHub connection ${status(x)} you gave, already authorized.` }
    return { pass: x.arn, ...notReady(x, 'The GitHub connection you gave,') }
  }
  const deployed = o.deployed?.[CONNECTION_OUTPUT]
  if (deployed) {
    const x = await getConnection(c, deployed)
    if (x && o.deployed?.[CONNECTION_CREATED_OUTPUT] === 'true') {
      if (x.status === 'AVAILABLE') return { arn: x.arn, name: x.name, ready: true, message: `Using the GitHub connection ${status(x)}, which this stack created, already authorized.` }
      return notReady(x, 'The GitHub connection this stack created,')
    }
    if (x?.status === 'AVAILABLE') return { pass: x.arn, arn: x.arn, name: x.name, ready: true, message: `Using the GitHub connection ${status(x)}, already authorized.` }
  }
  const all = await githubConnections(c)
  const reuse = await reusableConnection(c, prefer, all)
  if (reuse) return { pass: reuse.arn, arn: reuse.arn, name: reuse.name, ready: true, message: `Using the GitHub connection ${status(reuse)}, already authorized.` }
  const left = all.find((x) => x.name === name)
  if (left) return { pass: left.arn, ...notReady(left, 'The GitHub connection') }
  return { name, ready: false, message: `No authorized GitHub connection in this account and region: the deploy creates ${name}, without the build runners, and you authorize it once after the deploy.` }
}

/** HH:MM:SS on this machine's clock, as the person reads it. */
export const clockTime = (d: Date): string => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')

export interface ConnectionWait {
  region: string
  /** the onboarded repositories, which the AWS Connector for GitHub app must be allowed to reach */
  repos: readonly string[]
  /** each line to show: the instructions once, then when the next check is */
  report: (line: string) => void
  /** who is waiting, as the messages name it (default: the installer) */
  tool?: string
  pollMs?: number
  timeoutMs?: number
  /** a clock and a sleep, so tests need not wait */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const CONNECTION_POLL_MS = 15_000
export const CONNECTION_TIMEOUT_MS = 30 * 60_000

/** What to tell the person about the AWS Connector for GitHub app's repository access. */
export const connectorAccessNote = (repos: readonly string[]): string =>
  `The AWS Connector for GitHub app must be allowed to reach every onboarded repository (${repos.join(', ')}): a repository it cannot reach gets no runner, and its workflow jobs never start. Check it on GitHub under Settings > Applications > AWS Connector for GitHub > Configure (the organization's settings for an organization's repositories).`

/**
 * Wait until the connection is AVAILABLE: GetConnection every pollMs, telling the person what to do and when the next
 * check is. Gives up at the timeout (or on ERROR) with what to do next; running the tool again resumes, with the
 * same connection. A status of '' is read first.
 */
export async function waitForConnection(c: Connections, conn: { arn: string; name: string; status: string }, o: ConnectionWait): Promise<void> {
  const poll = o.pollMs ?? CONNECTION_POLL_MS
  const timeout = o.timeoutMs ?? CONNECTION_TIMEOUT_MS
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const tool = o.tool ?? 'the installer'
  const url = connectionsConsoleUrl(o.region)
  const deadline = now() + timeout
  const read = async (): Promise<string> => (await c.send(new GetConnectionCommand({ ConnectionArn: conn.arn }))).Connection?.ConnectionStatus ?? ''
  let status = conn.status || await read()
  let told = false
  for (;;) {
    if (status === 'AVAILABLE') return
    if (status === 'ERROR') throw new Error(`the GitHub connection ${conn.name} is in status ERROR: delete it at ${url} and run ${tool} again, or give the ARN of another connection`)
    if (!told) {
      o.report(`The GitHub connection ${conn.name} is waiting for a person to authorize it (once for this AWS account and region). Open ${url}, choose ${conn.name}, then "Update pending connection": that installs or picks the AWS Connector for GitHub app. Give the app access to ${o.repos.join(', ')}. ${tool.replace(/^the /, 'The ')} carries on by itself once it is authorized.`)
      told = true
    }
    if (now() + poll > deadline) {
      const minutes = Math.round(timeout / 60_000)
      throw new Error(`the GitHub connection ${conn.name} was still not authorized after ${minutes} minute${minutes === 1 ? '' : 's'}. Authorize it at ${url} ("Update pending connection"), then run ${tool} again: it resumes from here with the same connection`)
    }
    o.report(`Waiting for ${conn.name} to be authorized (status ${status || 'unknown'}): checking again at ${clockTime(new Date(now() + poll))}.`)
    await sleep(poll)
    status = await read()
  }
}

/**
 * The token side (runners.auth 'token', README "Where builds run"): CodeBuild's account-level GitHub source
 * credential, a personal access token imported with ImportSourceCredentials (serverType GITHUB, authType
 * PERSONAL_ACCESS_TOKEN). CodeBuild uses it, for every project without a Source.Auth of its own, to make the runner
 * project's GitHub webhook, register each job's just-in-time runner and fetch the source; CodeBuild keeps it itself,
 * so no job (and no role) can read it. Done by API, before the deploy, so the first deploy has the runners and nobody
 * opens the console. An account that already has a GitHub source credential keeps it (it may be another team's:
 * overwriting it would break their projects), unless trace imported it itself (`ours`), when it is refreshed.
 */
type CodeBuild = Pick<CodeBuildClient, 'send'>

export interface SourceCredential { state: 'imported' | 'refreshed' | 'existing'; detail: string }

export async function ensureSourceCredential(cb: CodeBuild, token: string, ours: boolean): Promise<SourceCredential> {
  const list = (await cb.send(new ListSourceCredentialsCommand({}))).sourceCredentialsInfos ?? []
  const github = list.find((c) => c.serverType === 'GITHUB')
  if (github && !ours) return { state: 'existing', detail: `CodeBuild already has a GitHub ${String(github.authType ?? 'credential').toLowerCase().replace(/_/g, ' ')} in this account and region; the runners use it, and trace leaves it alone` }
  await cb.send(new ImportSourceCredentialsCommand({ serverType: 'GITHUB', authType: 'PERSONAL_ACCESS_TOKEN', token, shouldOverwrite: true }))
  return github
    ? { state: 'refreshed', detail: 'CodeBuild\'s GitHub source credential (trace\'s) refreshed with the token' }
    : { state: 'imported', detail: 'the token imported as CodeBuild\'s GitHub source credential (this account and region): no console step' }
}

/** Remove CodeBuild's GitHub source credential (uninstall, when trace imported it). Whether there was one. */
export async function removeSourceCredential(cb: CodeBuild): Promise<boolean> {
  const list = (await cb.send(new ListSourceCredentialsCommand({}))).sourceCredentialsInfos ?? []
  const arn = list.find((x) => x.serverType === 'GITHUB')?.arn
  if (!arn) return false
  await cb.send(new DeleteSourceCredentialsCommand({ arn }))
  return true
}

/** How the runners reach GitHub for this deploy: the token (CodeBuild's source credential), or a connection. */
export type RunnerAuthChoice = { auth: 'token'; message: string } | { auth: 'connection'; connection: ConnectionChoice }

/**
 * The answers' runners.auth, made concrete before the deploy:
 *   token       the token
 *   connection  resolveConnection's choice, authorized or not (the installer waits for it after the deploy)
 *   auto        a connection given in the answers: as connection. Else resolveConnection's choice when it is
 *               authorized already (one this stack uses, or one reused from the account and region); else the token,
 *               so the first deploy has the runners with no console step
 */
export async function chooseRunnerAuth(
  mode: 'auto' | 'token' | 'connection',
  o: { prefix: string; given?: string; deployed: Record<string, string> | null },
  resolve: (o: { prefix: string; given?: string; deployed: Record<string, string> | null }) => Promise<ConnectionChoice>,
): Promise<RunnerAuthChoice> {
  const token = (why: string): RunnerAuthChoice => ({ auth: 'token', message: `${why}CodeBuild reaches GitHub with the GitHub token, as its GitHub source credential: the runners come with the first deploy, with no console step.` })
  if (mode === 'token') return token('')
  if (mode === 'connection' || o.given) return { auth: 'connection', connection: await resolve(o) }
  let c: ConnectionChoice
  try {
    c = await resolve({ prefix: o.prefix, deployed: o.deployed })
  } catch (e) {
    return token(`The GitHub connection can't be used (${e instanceof Error ? e.message : String(e)}). `)
  }
  return c.ready ? { auth: 'connection', connection: c } : token('No authorized GitHub connection in this account and region. ')
}
