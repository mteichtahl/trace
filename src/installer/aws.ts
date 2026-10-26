/**
 * The installer's AWS side before deploying: resolve credentials (a named profile — SSO included — or keys pasted
 * into the page), confirm the account, and check that the region has what trace needs: Bedrock AgentCore, an
 * Anthropic model the account can use, whether the GitHub OIDC provider already exists, whether CDK is bootstrapped,
 * and whether trace is already installed (an update rather than a first install).
 */
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock'
import { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } from '@aws-sdk/client-bedrock-agentcore-control'
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam'
import { DeleteSecretCommand, DescribeSecretCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-providers'
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader'
import type { AwsCredentialIdentity } from '@smithy/types'
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
  cdkBootstrapped: boolean
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
  return {
    account: id.Account ?? '', arn: id.Arn ?? '', region, agentCore, models, oidcProvider,
    cdkBootstrapped: Boolean(toolkit && !toolkit.status.startsWith('DELETE')),
    existing: existing ? { stack, ...existing } : null, warnings,
  }
}

export async function stackOutputs(creds: AwsCredentialIdentity, region: string, stack: string): Promise<Record<string, string>> {
  const s = (await new CloudFormationClient({ region, credentials: creds }).send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]
  if (!s) throw new Error(`stack ${stack} not found`)
  return Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']))
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
