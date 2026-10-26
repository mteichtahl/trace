/**
 * The preflight: everything installing depends on, checked at once and in parallel before anything is created, each
 * finding with what to do about it (src/installer/answers.ts Check). Read-only: what the installer can fix itself
 * (Anthropic's first-time-use form, the model agreement, a quota increase, a failed first stack, sharing trace's
 * actions, leftovers of an earlier installation) is offered as an action, run only when the person asks (fix below).
 *
 *   aws.credentials   STS: the account and identity
 *   aws.agentcore     Bedrock AgentCore in the region (ListAgentRuntimes)
 *   bedrock.model     the model: an active inference profile, and its access (GetFoundationModelAvailability; for
 *                     Anthropic, the first-time-use form, GetUseCaseForModelAccess)
 *   s3vectors         Amazon S3 Vectors in the region (the knowledge bases' vectors)
 *   gpu.quota         Service Quotas: G and VT instances (on-demand or Spot), standard instances for the CPU queue
 *   vpc.quota         the GPU side's VPC fits the region's VPC quota
 *   cdk.bootstrap     CDKToolkit: there, healthy, version 6 or later (else bootstrapped or updated first)
 *   stack             the trace stack: none (a new installation), updatable, or stuck (a failed first deploy)
 *   leftovers         names a removed installation kept (retainData) that a new stack would collide with
 *   cognito.domain    `<prefix>-<account>`: free, or this installation's
 *   github.token      the token: login, kind, scopes, and its email (the first administrator)
 *   github.source     trace's own repository: its actions are usable from the other repositories
 *   github.repo:<r>   per chosen repository: which permission is missing, and what that costs
 *   codebuild.github  how the CodeBuild runners will reach GitHub (README "Where builds run"): an authorized
 *                     CodeConnections connection, else CodeBuild's GitHub source credential (the token, imported)
 */
import type { AwsCredentialIdentity } from '@smithy/types'
import { SOURCE } from '../core/onboard.js'
import { stackName } from '../infra/props.js'
import type { Check, FixAction } from './answers.js'
import type { Facts } from './derive.js'
import { pickModel } from './derive.js'
import { type RepoAccess, type TokenInfo, accessNote } from './github.js'

export interface PreflightInput {
  region: string
  prefix: string
  /** the model chosen, or '' (derive) */
  model: string
  gpuSpot: boolean
  cpuSpot: boolean
  cpuVcpus: number
  /** whether GPU jobs are wanted (null: decide here) */
  gpuEnabled: boolean | null
  /** how the CodeBuild runners reach GitHub (answers runners.auth) */
  runnerAuth: 'auto' | 'token' | 'connection'
  repos: readonly string[]
  /** repositories to create (they must not exist yet) */
  create: readonly string[]
  hasAdminToken: boolean
}

export interface ModelAccess { status: 'AVAILABLE' | 'PENDING' | 'NOT_AVAILABLE' | 'ERROR' | 'UNKNOWN'; useCase: boolean | null; detail: string }
export interface StackState { status: string; outputs: Record<string, string> }

/** What the preflight asks AWS and GitHub (live: liveDeps; tests: fakes). Each may throw: that check then says so. */
export interface PreflightDeps {
  sts(): Promise<{ account: string; arn: string }>
  agentCore(): Promise<void>
  models(): Promise<{ id: string; name: string }[]>
  modelAccess(model: string): Promise<ModelAccess>
  /** Service Quotas ec2 value (applied, else the AWS default); null when unknown */
  quota(code: string): Promise<number | null>
  vpcs(): Promise<{ count: number; quota: number | null }>
  s3vectors(): Promise<boolean>
  cdk(): Promise<{ status: string; version: number | null } | null>
  stack(name: string): Promise<StackState | null>
  oidcProvider(): Promise<boolean>
  cognitoDomain(domain: string): Promise<{ userPoolId: string } | null>
  /** names of an earlier installation that a new stack would collide with */
  leftovers(prefix: string): Promise<string[]>
  sourceCredential(): Promise<string | null>
  /** the account and region's GitHub connections (CodeConnections) */
  connections(): Promise<{ name: string; status: string }[]>
  token(): Promise<TokenInfo>
  email(): Promise<string | null>
  repo(repo: string, kind: TokenInfo['kind']): Promise<RepoAccess>
  source(): Promise<{ ok: boolean; canFix: boolean; detail: string }>
}

export interface PreflightResult {
  checks: Check[]
  facts: Facts & { arn?: string; oidcProvider?: boolean; cdkBootstrapped?: boolean; cdkVersion?: number | null; existing?: StackState | null; sourceCredential?: string | null; runnerConnection?: string | null }
  token: TokenInfo | null
  repos: RepoAccess[]
  /** installing is refused while any check fails */
  ok: boolean
}

/** Service Quotas codes (ec2): vCPUs of running instances. */
export const QUOTAS = {
  gpuOnDemand: 'L-DB2E81BA', // Running On-Demand G and VT instances
  gpuSpot: 'L-3819A6DF', // All G and VT Spot Instance Requests
  cpuOnDemand: 'L-1216C47A', // Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances
  cpuSpot: 'L-34B43A08', // All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests
  vpcs: 'L-F678F1CE', // VPCs per Region (vpc)
} as const

/** The oldest CDK bootstrap version the deploy works with (nested templates and assets in the bootstrap bucket). */
export const CDK_BOOTSTRAP_MIN = 6

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const console_ = (region: string, path: string): string => `https://${region}.console.aws.amazon.com/${path}`

/** Run fn on each item, at most `limit` at once, keeping the order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** The foundation model behind an inference profile id (us.anthropic.claude-… → anthropic.claude-…). */
export const foundationModelOf = (id: string): string => id.replace(/^(global|us|eu|apac|ca|us-gov|jp|au)\./, '')

export async function preflight(input: PreflightInput, d: PreflightDeps): Promise<PreflightResult> {
  const { region, prefix } = input
  const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }))
  const stack = stackName(prefix)
  const gpuCode = input.gpuSpot ? QUOTAS.gpuSpot : QUOTAS.gpuOnDemand
  const cpuCode = input.cpuSpot ? QUOTAS.cpuSpot : QUOTAS.cpuOnDemand
  // everything that does not depend on another answer, at once
  const [sts, agentCore, models, gpuQuota, cpuQuota, vpcs, s3v, cdk, existing, oidc, leftovers, credential, conns, token, email, source] = await Promise.all([
    settle(d.sts()), settle(d.agentCore()), settle(d.models()), settle(d.quota(gpuCode)), settle(d.quota(cpuCode)), settle(d.vpcs()),
    settle(d.s3vectors()), settle(d.cdk()), settle(d.stack(stack)), settle(d.oidcProvider()), settle(d.leftovers(prefix)),
    settle(d.sourceCredential()), input.runnerAuth === 'token' ? Promise.resolve({ ok: true as const, v: [] }) : settle(d.connections()),
    settle(d.token()), settle(d.email()), settle(d.source()),
  ])
  const checks: Check[] = []
  const add = (c: Check): void => { checks.push(c) }
  const facts: PreflightResult['facts'] = {}

  // ------------------------------------------------------------------ AWS
  if (sts.ok) {
    facts.account = sts.v.account
    facts.arn = sts.v.arn
    add({ id: 'aws.credentials', status: 'ok', title: 'AWS credentials', detail: `${sts.v.arn} (account ${sts.v.account}, ${region})` })
  } else {
    add({ id: 'aws.credentials', status: 'fail', title: 'AWS credentials', detail: msg(sts.e), fix: 'Use a profile that works (`aws sts get-caller-identity --profile NAME`; for SSO run `aws sso login` first), or paste access keys.' })
  }
  if (agentCore.ok) add({ id: 'aws.agentcore', status: 'ok', title: 'Bedrock AgentCore', detail: `available in ${region}` })
  else {
    const denied = /AccessDenied|not authorized/i.test(msg(agentCore.e))
    add({
      id: 'aws.agentcore', status: 'fail', title: 'Bedrock AgentCore', detail: msg(agentCore.e),
      fix: denied ? 'These credentials may not use Bedrock AgentCore: use an administrator profile.' : `Bedrock AgentCore does not answer in ${region}: choose a region that has it.`,
      link: 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html',
    })
  }

  // the model: chosen, or the newest Sonnet the region offers; then whether the account may use it
  const modelList = models.ok ? models.v : []
  facts.models = modelList
  const model = input.model || pickModel(modelList, region)
  if (!models.ok) add({ id: 'bedrock.model', status: 'warn', title: 'Bedrock model', detail: `could not list the inference profiles: ${msg(models.e)}`, fix: `The agents use ${model}; check that it exists in ${region}.` })
  else {
    if (input.model && !modelList.some((m) => m.id === input.model)) add({ id: 'bedrock.profile', status: 'warn', title: 'Bedrock model', detail: `${input.model} is not an active Anthropic inference profile in ${region} (${modelList.length} are).`, fix: 'Choose one of the listed models under Advanced, or leave it empty for the newest Sonnet.' })
    const access = await d.modelAccess(foundationModelOf(model)).catch((e: unknown): ModelAccess => ({ status: 'UNKNOWN', useCase: null, detail: msg(e) }))
    const link = console_(region, `bedrock/home?region=${region}#/providers/anthropic`)
    if (access.status === 'AVAILABLE') add({ id: 'bedrock.model', status: 'ok', title: 'Bedrock model', detail: `${model}: the account has access` })
    else if (access.status === 'PENDING') add({ id: 'bedrock.model', status: 'warn', title: 'Bedrock model', detail: `${model}: access is being set up (Anthropic's agreement is pending; AWS emails when it is done).`, fix: 'Install now: the agents work once access is granted, usually within minutes.' })
    else if (access.useCase === false) {
      add({
        id: 'bedrock.model', status: 'warn', title: 'Bedrock model', detail: `${model}: Anthropic needs its one-time use-case form for this account (or its organisation's management account) before any Claude model can be used.`,
        fix: 'Submit it here (the installer sends it with PutUseCaseForModelAccess) or in the Bedrock console. Installing does not wait for it; the agents work once access is granted.',
        link, action: { id: 'bedrock-use-case', label: 'Fill in and submit the use-case form', params: { model: foundationModelOf(model) } },
      })
    } else if (access.status === 'NOT_AVAILABLE' || access.status === 'ERROR') {
      add({
        id: 'bedrock.model', status: 'warn', title: 'Bedrock model', detail: `${model}: no access yet (${access.detail || access.status.toLowerCase()}).`,
        fix: 'Accept the model\'s agreement (the installer can, with CreateFoundationModelAgreement; it needs aws-marketplace:Subscribe and a payment method on the account), or open the model in the Bedrock console playground once.',
        link, action: { id: 'bedrock-agreement', label: 'Accept the model agreement', params: { model: foundationModelOf(model) } },
      })
    } else add({ id: 'bedrock.model', status: 'info', title: 'Bedrock model', detail: `${model}: access could not be checked (${access.detail}). Access to most models is enabled on first use; Anthropic's also needs the first-time-use form.`, link })
  }

  // knowledge bases' vectors
  facts.s3vectors = s3v.ok ? s3v.v : null
  if (s3v.ok && !s3v.v) add({ id: 's3vectors', status: 'info', title: 'Knowledge bases', detail: `Amazon S3 Vectors is not available in ${region}: knowledge bases are left off.`, link: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-regions-quotas.html' })
  else if (s3v.ok) add({ id: 's3vectors', status: 'ok', title: 'Knowledge bases', detail: 'Amazon S3 Vectors is available' })

  // GPU and CPU compute
  facts.gpuQuota = gpuQuota.ok ? gpuQuota.v : null
  facts.cpuQuota = cpuQuota.ok ? cpuQuota.v : null
  const quotaLink = (code: string): string => console_(region, `servicequotas/home/services/ec2/quotas/${code}`)
  const wantGpu = input.gpuEnabled !== false
  if (wantGpu && gpuQuota.ok && gpuQuota.v !== null && gpuQuota.v < 4) {
    add({
      id: 'gpu.quota', status: input.gpuEnabled === true ? 'warn' : 'info', title: 'GPU jobs',
      detail: `The account may run ${gpuQuota.v} ${input.gpuSpot ? 'Spot' : 'on-demand'} G and VT vCPUs in ${region}; one GPU job (a g6/g5/g4dn.xlarge) needs 4. ${input.gpuEnabled === true ? 'GPU jobs would wait for capacity that never comes.' : 'GPU and CPU jobs are left off (renders, autorouting, openEMS, CFD run locally or not at all); everything else installs.'}`,
      fix: 'Request 16 vCPUs (four jobs at once). Increases are usually granted within a day; then turn GPU jobs on under Advanced and run the installer again.',
      link: quotaLink(gpuCode), action: { id: 'quota-increase', label: 'Request 16 G and VT vCPUs', params: { code: gpuCode, value: 16, service: 'ec2' } },
    })
  } else if (wantGpu && gpuQuota.ok && gpuQuota.v !== null) add({ id: 'gpu.quota', status: 'ok', title: 'GPU jobs', detail: `${gpuQuota.v} G and VT vCPUs allowed (${Math.floor(gpuQuota.v / 4)} jobs at once)` })
  else if (wantGpu && !gpuQuota.ok) add({ id: 'gpu.quota', status: 'info', title: 'GPU jobs', detail: `the G and VT quota could not be read (${msg(gpuQuota.e)}); GPU jobs stay on`, link: quotaLink(gpuCode) })
  if (wantGpu && cpuQuota.ok && cpuQuota.v !== null && cpuQuota.v < input.cpuVcpus) {
    add({
      id: 'cpu.quota', status: 'info', title: 'CPU jobs',
      detail: `The account may run ${cpuQuota.v} standard vCPUs in ${region}; a CPU job asks for ${input.cpuVcpus}. The CPU queue is left off.`,
      fix: `Request at least ${Math.max(64, input.cpuVcpus)} vCPUs, or lower "vCPUs per job" under Advanced.`,
      link: quotaLink(cpuCode), action: { id: 'quota-increase', label: `Request ${Math.max(64, input.cpuVcpus)} standard vCPUs`, params: { code: cpuCode, value: Math.max(64, input.cpuVcpus), service: 'ec2' } },
    })
  }
  const stackNow = existing.ok ? existing.v : null
  if (wantGpu && vpcs.ok && vpcs.v.quota !== null && vpcs.v.count >= vpcs.v.quota && !stackNow?.outputs.GpuJobQueue) {
    add({
      id: 'vpc.quota', status: 'warn', title: 'GPU network',
      detail: `${region} already has ${vpcs.v.count} of the ${vpcs.v.quota} VPCs it allows, and GPU jobs need one more (public subnets, no NAT gateway).`,
      fix: 'Request a higher VPC quota, delete an unused VPC, or turn GPU jobs off under Advanced.', link: console_(region, `servicequotas/home/services/vpc/quotas/${QUOTAS.vpcs}`),
      action: { id: 'quota-increase', label: `Request ${vpcs.v.quota + 5} VPCs`, params: { code: QUOTAS.vpcs, value: vpcs.v.quota + 5, service: 'vpc' } },
    })
  }

  // CDK
  if (cdk.ok) {
    const c = cdk.v
    facts.cdkBootstrapped = Boolean(c && !c.status.startsWith('DELETE') && !/FAILED|ROLLBACK_COMPLETE$/.test(c.status) && (c.version ?? 0) >= CDK_BOOTSTRAP_MIN)
    facts.cdkVersion = c?.version ?? null
    if (!c || c.status.startsWith('DELETE')) add({ id: 'cdk.bootstrap', status: 'info', title: 'CDK bootstrap', detail: `not bootstrapped in ${region}: the installer bootstraps it first (about 2 minutes)` })
    else if (/FAILED|ROLLBACK_COMPLETE$/.test(c.status) && !/UPDATE_ROLLBACK_COMPLETE$/.test(c.status)) add({ id: 'cdk.bootstrap', status: 'fail', title: 'CDK bootstrap', detail: `the CDKToolkit stack is ${c.status}`, fix: 'Delete the CDKToolkit stack in the CloudFormation console (its bucket first, if it is not empty), then check again.', link: console_(region, 'cloudformation/home') })
    else if ((c.version ?? 0) < CDK_BOOTSTRAP_MIN) add({ id: 'cdk.bootstrap', status: 'info', title: 'CDK bootstrap', detail: `bootstrap version ${c.version ?? 'unknown'}: the installer updates it to the current one first` })
    else add({ id: 'cdk.bootstrap', status: 'ok', title: 'CDK bootstrap', detail: `bootstrapped (version ${c.version})` })
  } else add({ id: 'cdk.bootstrap', status: 'info', title: 'CDK bootstrap', detail: `could not be read (${msg(cdk.e)}): the installer bootstraps if needed` })

  // the stack
  facts.existing = stackNow
  if (existing.ok && stackNow) {
    const st = stackNow.status
    if (st.endsWith('_IN_PROGRESS')) add({ id: 'stack', status: 'fail', title: stack, detail: `${stack} is ${st}: a deploy or delete is running`, fix: 'Wait for it to finish, then check again.', link: console_(region, 'cloudformation/home') })
    else if (st === 'ROLLBACK_COMPLETE' || st === 'ROLLBACK_FAILED') {
      add({ id: 'stack', status: 'fail', title: stack, detail: `${stack} is ${st}: its first deploy failed and CloudFormation cannot update it.`, fix: 'Delete it (nothing in it is in use) and install again.', action: { id: 'delete-failed-stack', label: `Delete ${stack}`, params: { stack } } })
    } else if (st === 'UPDATE_ROLLBACK_FAILED') add({ id: 'stack', status: 'fail', title: stack, detail: `${stack} is UPDATE_ROLLBACK_FAILED`, fix: 'Continue the rollback in the CloudFormation console ("Stack actions → Continue update rollback"), then check again.', link: console_(region, 'cloudformation/home') })
    else add({ id: 'stack', status: 'info', title: stack, detail: `trace is installed here (${st}): installing again updates it, and the plan shows only what changes` })
  } else if (existing.ok) add({ id: 'stack', status: 'info', title: stack, detail: 'a new installation' })
  if (leftovers.ok && leftovers.v.length && !stackNow) {
    add({
      id: 'leftovers', status: 'fail', title: 'An earlier installation', detail: `A removed installation with the prefix "${prefix}" kept ${leftovers.v.join(', ')} (keep data was on), and a new stack would collide with ${leftovers.v.length === 1 ? 'it' : 'them'}.`,
      fix: 'Delete them (the images and the copy of the GitHub token: nothing is lost that installing does not make again), or choose another prefix under Advanced.',
      action: { id: 'clear-leftovers', label: `Delete ${leftovers.v.length === 1 ? 'it' : `these ${leftovers.v.length}`}`, params: { prefix } },
    })
  }
  facts.oidcProvider = oidc.ok ? oidc.v : false

  // Cognito's domain prefix
  if (/aws|amazon|cognito/.test(prefix)) add({ id: 'cognito.domain', status: 'fail', title: 'Sign-in domain', detail: `Cognito domain prefixes may not contain "aws", "amazon" or "cognito", and the prefix "${prefix}" does.`, fix: 'Choose another prefix under Advanced.' })
  else if (facts.account) {
    const domain = `${prefix}-${facts.account}`
    const taken = await d.cognitoDomain(domain).catch(() => null)
    const ours = taken && stackNow?.outputs.UserPoolId === taken.userPoolId
    if (taken && !ours) add({ id: 'cognito.domain', status: 'fail', title: 'Sign-in domain', detail: `the Cognito domain ${domain} belongs to user pool ${taken.userPoolId}, not this installation's${stackNow ? '' : ' (a removed installation kept its user pool)'}.`, fix: 'Delete that domain (Cognito console → the pool → App integration → Domain), or choose another prefix under Advanced.', link: console_(region, 'cognito/v2/idp/user-pools') })
  }

  // how the CodeBuild runners will reach GitHub (every job runs on them: there is no GitHub-hosted fallback)
  const available = conns.ok ? conns.v.filter((c) => c.status === 'AVAILABLE') : []
  const reuse = available.find((c) => c.name === `${prefix}-github`) ?? available[0] ?? null
  facts.sourceCredential = credential.ok ? credential.v : null
  facts.runnerConnection = input.runnerAuth !== 'token' && reuse ? reuse.name : null
  /** whether the deploy will make the runners' webhooks with this token (so it must be allowed to) */
  let tokenMakesWebhooks = false
  if (facts.runnerConnection) add({ id: 'codebuild.github', status: 'info', title: 'Build runners', detail: `CodeBuild reaches GitHub through the authorized GitHub connection ${facts.runnerConnection}: no token stored with CodeBuild, and no console step` })
  else if (input.runnerAuth === 'connection') add({ id: 'codebuild.github', status: 'warn', title: 'Build runners', detail: `No authorized GitHub connection in this account and region: the stack creates ${prefix}-github, and after the first deploy you authorize it once in the AWS console (the installer shows the link and waits). Until then the repositories' jobs wait in the queue.`, fix: 'Or choose "the GitHub token" for the build runners under Advanced: no console step.', link: console_(region, 'codesuite/settings/connections') })
  else if (credential.ok && credential.v) add({ id: 'codebuild.github', status: 'info', title: 'Build runners', detail: `CodeBuild already has a GitHub ${credential.v.toLowerCase().replace(/_/g, ' ')} credential in this account and region: the runners use it, and trace leaves it alone. It must be able to make each repository's webhook, or the deploy fails.` })
  else if (credential.ok) {
    tokenMakesWebhooks = true
    add({ id: 'codebuild.github', status: 'info', title: 'Build runners', detail: 'the token becomes CodeBuild\'s GitHub source credential (no console step): each repository\'s jobs run on its own CodeBuild runner from the first deploy' })
  }

  // ------------------------------------------------------------------ GitHub
  let info: TokenInfo | null = null
  if (token.ok) {
    info = token.v
    facts.login = info.login
    facts.email = email.ok ? email.v : null
    add({ id: 'github.token', status: 'ok', title: 'GitHub token', detail: `${info.login}: a ${info.kind} token seeing ${info.repos.length} repositories${facts.email ? `; the first administrator is ${facts.email}` : ''}` })
    for (const w of info.warnings) add({ id: 'github.token', status: 'warn', title: 'GitHub token', detail: w })
    if (!facts.email) add({ id: 'github.email', status: 'warn', title: 'First administrator', detail: 'The token cannot see its account\'s email, which becomes the first administrator\'s sign-in.', fix: `Enter the email under Advanced, or give the token ${info.kind === 'classic' ? 'the `user:email` scope' : '"Email addresses: read" (an account permission)'}.` })
  } else add({ id: 'github.token', status: 'fail', title: 'GitHub token', detail: msg(token.e), fix: 'Paste a token that works: a fine-grained token (github.com/settings/personal-access-tokens) or a classic one with `repo` and `workflow`.' })
  if (source.ok && !source.v.ok) add({ id: 'github.source', status: 'warn', title: 'trace\'s actions', detail: source.v.detail, ...(source.v.canFix ? { action: { id: 'share-source' as FixAction, label: `Share ${SOURCE}'s actions` } } : {}) })
  const repos = info ? await mapLimit(input.repos, 6, (r) => d.repo(r, info?.kind ?? 'unknown').catch((e: unknown): RepoAccess => ({ repo: r, visible: false, configure: false, administer: false, webhooks: false, missing: [msg(e)] }))) : []
  for (const a of repos) {
    const note = accessNote(a)
    if (!note) { add({ id: `github.repo:${a.repo}`, status: 'ok', title: a.repo, detail: 'the token can configure it, apply its settings and give it a CodeBuild runner' }); continue }
    // with the token as CodeBuild's credential, the deploy makes the runner's webhook with it: without Administration
    // and Webhooks the deploy would fail
    const blocking = !a.visible || (!a.configure && !input.hasAdminToken) || (tokenMakesWebhooks && (!a.webhooks || !a.administer))
    add({ id: `github.repo:${a.repo}`, status: blocking ? 'fail' : 'warn', title: a.repo, detail: note, fix: blocking ? `Give the token ${a.missing.join(', ')} on ${a.repo} (or add an admin token under Advanced), or leave the repository out.` : `Give the token ${a.missing.join(', ')} on ${a.repo} and run the installer again to complete it.` })
  }
  for (const r of input.create) {
    if (info?.repos.some((x) => x.fullName.toLowerCase() === r.toLowerCase())) add({ id: `github.create:${r}`, status: 'fail', title: r, detail: `${r} exists already`, fix: 'Choose it from the list instead, or another name.' })
  }
  return { checks, facts, token: info, repos, ok: !checks.some((c) => c.status === 'fail') }
}

// ------------------------------------------------------------------ the live calls

export async function liveDeps(creds: AwsCredentialIdentity, region: string, token: string): Promise<PreflightDeps> {
  const cfg = { region, credentials: creds }
  const [{ STSClient, GetCallerIdentityCommand }, agentcore, bedrock, cfn, { IAMClient, ListOpenIDConnectProvidersCommand }, cognito, cb, sm, gh, signed] = await Promise.all([
    import('@aws-sdk/client-sts'), import('@aws-sdk/client-bedrock-agentcore-control'), import('@aws-sdk/client-bedrock'), import('@aws-sdk/client-cloudformation'),
    import('@aws-sdk/client-iam'), import('@aws-sdk/client-cognito-identity-provider'), import('@aws-sdk/client-codebuild'), import('@aws-sdk/client-secrets-manager'),
    import('./github.js'), import('./signed.js'),
  ])
  const call = signed.signedCaller(creds, region)
  const brc = new bedrock.BedrockClient(cfg)
  const cfnc = new cfn.CloudFormationClient(cfg)
  const describe = async (name: string): Promise<StackState | null> => {
    try {
      const s = (await cfnc.send(new cfn.DescribeStacksCommand({ StackName: name }))).Stacks?.[0]
      return s ? { status: s.StackStatus ?? '', outputs: Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? ''])) } : null
    } catch (e) {
      if (/does not exist/.test(msg(e))) return null
      throw e
    }
  }
  let tokenInfo: Promise<TokenInfo> | null = null
  return {
    sts: async () => { const r = await new STSClient(cfg).send(new GetCallerIdentityCommand({})); return { account: r.Account ?? '', arn: r.Arn ?? '' } },
    agentCore: async () => { await new agentcore.BedrockAgentCoreControlClient(cfg).send(new agentcore.ListAgentRuntimesCommand({ maxResults: 1 })) },
    models: async () => {
      const out: { id: string; name: string }[] = []
      let nextToken: string | undefined
      do {
        const r = await brc.send(new bedrock.ListInferenceProfilesCommand({ maxResults: 100, ...(nextToken ? { nextToken } : {}) }))
        for (const p of r.inferenceProfileSummaries ?? []) if (/anthropic/i.test(p.inferenceProfileId ?? '') && p.status === 'ACTIVE') out.push({ id: p.inferenceProfileId ?? '', name: p.inferenceProfileName ?? p.inferenceProfileId ?? '' })
        nextToken = r.nextToken
      } while (nextToken)
      return out.sort((a, b) => b.id.localeCompare(a.id))
    },
    modelAccess: async (model) => {
      const a = await brc.send(new bedrock.GetFoundationModelAvailabilityCommand({ modelId: model }))
      const status = (a.agreementAvailability?.status ?? 'UNKNOWN') as ModelAccess['status']
      let useCase: boolean | null = null
      if (/anthropic/.test(model) && status !== 'AVAILABLE') {
        try { await brc.send(new bedrock.GetUseCaseForModelAccessCommand({})); useCase = true } catch (e) { useCase = (e as { name?: string }).name === 'ResourceNotFoundException' ? false : null }
      }
      return { status, useCase, detail: a.agreementAvailability?.errorMessage ?? `${a.authorizationStatus ?? ''} ${a.entitlementAvailability ?? ''}`.trim() }
    },
    quota: async (code) => {
      const service = code === QUOTAS.vpcs ? 'vpc' : 'ec2'
      try {
        const r = await call(signed.serviceQuotas(region, 'GetServiceQuota', { ServiceCode: service, QuotaCode: code }))
        return Number((r.Quota as { Value?: number } | undefined)?.Value ?? NaN)
      } catch (e) {
        if (!(e instanceof signed.AwsCallError) || e.code !== 'NoSuchResourceException') throw e
        const r = await call(signed.serviceQuotas(region, 'GetAWSDefaultServiceQuota', { ServiceCode: service, QuotaCode: code }))
        return Number((r.Quota as { Value?: number } | undefined)?.Value ?? NaN)
      }
    },
    vpcs: async () => {
      const xml = await signed.ec2Query(creds, region, 'DescribeVpcs', { MaxResults: '1000' })
      const count = (xml.match(/<vpcId>/g) ?? []).length
      let quota: number | null = null
      try {
        const r = await call(signed.serviceQuotas(region, 'GetServiceQuota', { ServiceCode: 'vpc', QuotaCode: QUOTAS.vpcs }))
        quota = Number((r.Quota as { Value?: number } | undefined)?.Value ?? 5)
      } catch { quota = 5 }
      return { count, quota }
    },
    s3vectors: async () => {
      try {
        await call(signed.s3vectors(region, 'ListVectorBuckets', { maxResults: 1 }))
        return true
      } catch (e) {
        if (e instanceof signed.AwsCallError) return e.status === 403 // answered: the service is there
        return false // no such endpoint in this region
      }
    },
    cdk: async () => {
      const s = await describe('CDKToolkit')
      return s ? { status: s.status, version: s.outputs.BootstrapVersion ? Number(s.outputs.BootstrapVersion) : null } : null
    },
    stack: describe,
    oidcProvider: async () => ((await new IAMClient(cfg).send(new ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList ?? []).some((p) => (p.Arn ?? '').endsWith('/token.actions.githubusercontent.com')),
    cognitoDomain: async (domain) => {
      const r = await new cognito.CognitoIdentityProviderClient(cfg).send(new cognito.DescribeUserPoolDomainCommand({ Domain: domain }))
      return r.DomainDescription?.UserPoolId ? { userPoolId: r.DomainDescription.UserPoolId } : null
    },
    leftovers: async (prefix) => leftoverNames(prefix, { ecr: (o, b) => call(signed.ecr(region, o, b)), secrets: new sm.SecretsManagerClient(cfg) }),
    connections: async () => {
      const cc = await import('@aws-sdk/client-codeconnections')
      const client = new cc.CodeConnectionsClient(cfg)
      const out: { name: string; status: string }[] = []
      let NextToken: string | undefined
      do {
        const r = await client.send(new cc.ListConnectionsCommand({ ProviderTypeFilter: 'GitHub', MaxResults: 100, ...(NextToken ? { NextToken } : {}) }))
        for (const x of r.Connections ?? []) out.push({ name: x.ConnectionName ?? '', status: x.ConnectionStatus ?? '' })
        NextToken = r.NextToken
      } while (NextToken)
      return out
    },
    sourceCredential: async () => ((await new cb.CodeBuildClient(cfg).send(new cb.ListSourceCredentialsCommand({}))).sourceCredentialsInfos ?? []).find((c) => c.serverType === 'GITHUB')?.authType ?? null,
    token: () => (tokenInfo ??= gh.checkToken(token)),
    email: () => gh.tokenEmail(token),
    repo: (r, kind) => gh.repoAccess(token, r, kind),
    source: () => gh.sourceAccess(token, SOURCE),
  }
}

/** The names a removed installation with this prefix kept (retainData) that a new stack would make again and so
 * collide with: its image repositories and the API's GitHub token secret (RemovalPolicy RETAIN). */
export async function leftoverNames(prefix: string, c: { ecr: (op: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>; secrets: { send: (cmd: never) => Promise<unknown> } }): Promise<string[]> {
  const out: string[] = []
  const repos = [`${prefix}-agent`, `${prefix}-gpu`]
  await Promise.all(repos.map(async (name) => {
    try { await c.ecr('DescribeRepositories', { repositoryNames: [name] }); out.push(`the ECR repository ${name}`) } catch { /* not there */ }
  }))
  const sm = await import('@aws-sdk/client-secrets-manager')
  try {
    const d = await c.secrets.send(new sm.DescribeSecretCommand({ SecretId: `${prefix}/github-token` }) as never) as { DeletedDate?: Date }
    out.push(`the secret ${prefix}/github-token${d.DeletedDate ? ' (scheduled for deletion)' : ''}`)
  } catch { /* not there */ }
  return out.sort()
}
