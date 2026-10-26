/**
 * Installing trace into an AWS account, step by step. Every step is safe to run again: a second installation
 * updates what the first made.
 *
 *   1 check      the credentials still resolve to the confirmed account
 *   2 connection the AWS CodeConnections connection to GitHub the CodeBuild runners use (every GitHub Actions job runs on
 *                AWS CodeBuild, never on a GitHub-hosted runner): the one the answers give, else `<prefix>-github`,
 *                reused or created; a new one waits, with the console link and the time of the next check, until a
 *                person authorizes it once (it installs the AWS Connector for GitHub app)
 *   3 cdk        bootstrap CDK in the account/region if it isn't
 *   4 deploy     `cdk deploy` the trace stack (the agent image builds in CodeBuild: the first deploy takes a while), in
 *                the layout the installation has (a new one: nested; an earlier one: flat), or, when asked to move a
 *                flat one to nested, three deploys in a row (release, drain, nested: see layoutDeploys). Before it, a
 *                project the stack does not have yet whose fixed names are taken in the account (a removed copy's
 *                retained memory, delivery sources or destinations, or secret in its recovery window) gets the next
 *                generation of names, saved with the answers (chooseGenerations)
 *   5 token      write the GitHub tokens into Secrets Manager: the shared one (the API's), and each project's own
 *                (its own token when one was given, else a copy of the shared one)
 *   6 repos      each repository's Actions variables (its own role, runtime, memory and CodeBuild runner project, from
 *                its project's outputs, which are its nested stack's in the nested layout; region, TRACE_HOME) and its
 *                TRACE_TOKEN secret
 *   7 onboard    the onboarding PR in each repository that asked for it, and its repository settings
 *   8 people     invite each person to Cognito, put them in their class's group (admin, user, guest), and record
 *                the projects they are assigned to
 *   9 local      save the installation on this machine so `trace login` and `trace remote …` work
 *  10 gpu        wait for the GPU image build the deploy started (the stack does not wait for it, so a broken GPU
 *                image never rolls back the core) and start it again if an earlier one failed; a failure here is
 *                reported, and everything else stays installed
 *
 * Secrets never leave memory except to their destination (Secrets Manager, GitHub's sealed-box API).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient, UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider'
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { AwsCredentialIdentity } from '@smithy/types'
import { type Principal, GROUPS, assign, assignments, setClass, unassign } from '../core/access.js'
import { saveAnswers, saveInstallation } from '../core/client.js'
import { onboard, register } from '../core/onboard.js'
import { RUNNER_VARIABLE } from '../core/project.js'
import {
  GPU_IMAGE_BUILD_OUTPUT, type InfraInput, type InfraProps, InfraPropsSchema, LAYOUT_OUTPUT, LEGACY_MEMORY_OUTPUT, LIBRARY_KEYS_OUTPUT, cpuEnabled, githubSecretName,
  kbOutputs, memoryDeliveryName, memoryName, projectHash, projectOutputs, stackName,
} from '../infra/props.js'
import { REPO_ROOT } from '../infra/stack.js'
import type { Answers, InstallEvent, Secrets, Step } from './answers.js'
import {
  type ConnectionWait, type GithubConnection, type ProjectNames, awsEnv, cfnClient, checkAws, codebuildClient, connectionName, connectionsClient,
  connectionsConsoleUrl, connectorAccessNote, credentials, deployedProjects, ensureConnection, ensureGpuImage, freeSecretNames, nameClients, nameIndex,
  stackOutputs,
} from './aws.js'
import { type TokenInfo, checkToken, setSecret, setVariable } from './github.js'

/** What the installer knows of the stack already in the account (checkAws), when there is one. */
export interface Existing { outputs: Record<string, string> }

/**
 * An installation from before memory was per project: it has the installation-wide memory (its MemoryId output).
 * The next deploy removes that memory; with retainData it is first kept, Retain, for one deploy (so the one after
 * leaves it in the account), and without retainData it is deleted with its records.
 */
export const sharedMemoryOf = (existing: Existing | null | undefined): string | null => existing?.outputs[LEGACY_MEMORY_OUTPUT] || null

/**
 * The layout of the stack already in the account: its Layout output, or flat for a stack from before there was one
 * (every installation then had its projects in the one stack). No stack, or one without outputs (a first deploy that
 * rolled back): nested.
 */
export function layoutOf(existing: Existing | null | undefined): 'flat' | 'nested' {
  const o = existing?.outputs ?? {}
  if (o[LAYOUT_OUTPUT] === 'flat' || o[LAYOUT_OUTPUT] === 'nested') return o[LAYOUT_OUTPUT]
  return Object.keys(o).length ? 'flat' : 'nested'
}

/** One deploy of the install: its stack settings' layout part, and what it is for. */
export interface LayoutDeploy { layout: 'flat' | 'nested'; layoutMigration?: 'release' | 'drain'; why: string }

/**
 * The deploys this install makes. Normally one, in the installation's own layout. Moving a flat installation to
 * nested (agents.migrateLayout) takes three, because CloudFormation creates a moved resource before it deletes the
 * old one and every project resource has a fixed name (runtime, roles, secret, memory, delivery sources):
 *
 *   release  (only with retainData) the same stack, each project's memory and log delivery now marked Delete
 *   drain    every project out of the stack: CloudFormation deletes them, the memories and their records with them
 *            (each memory's log group stays, with retainData), and the projects are offline until the next deploy
 *   nested   every project again, each in its own nested stack, empty memory; then the repositories' variables
 */
export function layoutDeploys(a: Answers, existing?: Existing | null): LayoutDeploy[] {
  const now = layoutOf(existing)
  if (now === 'nested') return [{ layout: 'nested', why: existing ? 'one nested stack per project' : 'one nested stack per project (a new installation)' }]
  if (!a.agents.migrateLayout) return [{ layout: 'flat', why: 'every project in the one stack, as this installation has them' }]
  return [
    ...(a.agents.retainData ? [{ layout: 'flat' as const, layoutMigration: 'release' as const, why: 'mark each project\'s memory and log delivery Delete' }] : []),
    { layout: 'flat', layoutMigration: 'drain', why: 'remove every project from the stack (their memories and records are deleted)' },
    { layout: 'nested', why: 'every project again, each in its own nested stack' },
  ]
}

/** Said in the plan, and the summary, about the layout. */
export function layoutNote(a: Answers, existing?: Existing | null): string | null {
  if (layoutOf(existing) !== 'flat') return null
  if (!a.agents.migrateLayout) {
    return 'This installation keeps every project in the one stack (layout flat), which holds about 20 projects. New installations put each project in its own nested stack, which holds 60; '
      + 'moving this one is a choice ("move to nested stacks") because it deletes every project\'s memory records.'
  }
  return 'Moving to one nested stack per project, in three deploys: '
    + `${a.agents.retainData ? 'the first marks each project\'s memory and log delivery Delete, ' : ''}the next removes every project from the stack, DELETING each project's memory and every record in it (each memory's log group ${a.agents.retainData ? 'stays in the account' : 'goes too'}), and the last creates every project again in its own nested stack, with an empty memory. `
    + 'AgentCore cannot copy memory records, and CloudFormation cannot move these resources (they have fixed names) into a nested stack in place. '
    + 'The projects are offline from the second deploy until the repositories\' variables are rewritten; workflows that run in between fail: re-run them.'
}

/** Stands in for the GitHub connection in the plan, before the installer has found or created the real one (never
 * deployed: apply passes the real ARN). */
export const plannedConnectionArn = (a: Answers): string => `arn:aws:codeconnections:${a.aws.region}:${a.aws.account}:connection/00000000-0000-0000-0000-000000000000`

/** The stack's settings from the answers (and, for the legacy memory's way out and the layout, what is deployed already).
 * `connectionArn`: the GitHub connection the runners use (apply's, found or created); else the answers', else a
 * stand-in for planning. */
export function infraInput(a: Answers, existing?: Existing | null, deploy?: LayoutDeploy, connectionArn?: string): InfraInput {
  const own = a.projects.filter((p) => p.memoryEventExpiryDays !== null || p.generation > 0)
  const d: LayoutDeploy = deploy ?? layoutDeploys(a, existing).at(-1) ?? { layout: 'nested', why: '' }
  return {
    prefix: a.agents.prefix,
    layout: d.layout,
    ...(d.layoutMigration ? { layoutMigration: d.layoutMigration } : {}),
    account: a.aws.account,
    region: a.aws.region,
    repositories: a.projects.map((p) => `${p.repo}@${p.branch}`),
    createOidcProvider: a.agents.createOidcProvider,
    model: a.agents.model,
    ...(a.agents.centralBucketName ? { centralBucketName: a.agents.centralBucketName } : {}),
    maxLifetimeSeconds: Math.round(a.agents.maxLifetimeHours * 3600),
    idleTimeoutSeconds: Math.round(a.agents.idleMinutes * 60),
    retainData: a.agents.retainData,
    gpu: { enabled: a.agents.gpuEnabled, maxVcpus: a.agents.gpuMaxVcpus, spot: a.agents.gpuSpot },
    cpu: { enabled: a.agents.cpuEnabled, maxVcpus: a.agents.cpuMaxVcpus, spot: a.agents.cpuSpot, vcpus: a.agents.cpuVcpus, memoryMiB: a.agents.cpuMemoryMiB },
    knowledgeBase: { enabled: a.agents.knowledgeBase },
    gateway: { enabled: a.agents.libraryGateway },
    runners: {
      connectionArn: connectionArn || a.runners.connectionArn || plannedConnectionArn(a),
      ...(a.runners.computeType !== null ? { computeType: a.runners.computeType } : {}),
      ...(a.runners.privileged !== null ? { privileged: a.runners.privileged } : {}),
    },
    observability: {
      enabled: a.agents.observability, transactionSearch: a.agents.transactionSearch, dashboard: a.agents.dashboard,
      ...(a.agents.samplingPercent !== null ? { samplingPercent: a.agents.samplingPercent } : {}),
    },
    ...(a.agents.retainData && sharedMemoryOf(existing) ? { memory: { legacySharedMemory: true } } : {}),
    ...(own.length ? {
      projectSettings: Object.fromEntries(own.map((p) => [p.repo, {
        ...(p.memoryEventExpiryDays !== null ? { memoryEventExpiryDays: p.memoryEventExpiryDays } : {}), ...(p.generation > 0 ? { generation: p.generation } : {}),
      }])),
    } : {}),
    adminEmail: a.adminEmail,
  }
}

/** Said in the plan, and the summary, when the installation-wide memory of an earlier version is about to go. */
export function sharedMemoryNote(a: Answers, existing?: Existing | null): string | null {
  const id = sharedMemoryOf(existing)
  if (!id) return null
  return a.agents.retainData
    ? `This installation has the installation-wide memory of an earlier version (${id}). Each project now gets its own, empty memory; the old one's records are not copied (AgentCore has no way to copy extracted records). With "keep data" on, this deploy keeps the old memory in the stack, unused and marked Retain, and the next installer run leaves it in the account as an orphan: delete it there when you no longer need it.`
    : `This installation has the installation-wide memory of an earlier version (${id}). Each project now gets its own, empty memory, and this deploy DELETES the old one with every record in it (AgentCore has no way to copy extracted records). Turn "keep data" on first to keep it.`
}

/** The names of one project, at one generation, that can outlive it in the account (and so block adding it again). */
export function projectNames(props: Pick<InfraProps, 'prefix' | 'memory' | 'observability'>, repo: string, generation: number): ProjectNames {
  return {
    memories: props.memory.enabled ? [memoryName(props.prefix, repo, generation)] : [],
    deliveries: props.memory.enabled && props.observability.enabled
      ? (['logs', 'traces'] as const).map((k) => memoryDeliveryName(props.prefix, repo, k, generation)) : [],
    secrets: [githubSecretName(props.prefix, repo, generation)],
  }
}

/** A project whose generation the installer raised, and the names that were taken. */
export interface GenerationChange { repo: string; from: number; to: number; taken: string[] }

/**
 * Before deploying: for each project the stack does not have yet (`deployed`: the hashes it has), find the first
 * generation, from its saved one up, whose names are all free in the account (`taken`, src/installer/aws.ts nameIndex).
 * A project the stack has keeps its generation whatever: its names are its own. Returns the answers with the new
 * generations, and what changed.
 */
export async function chooseGenerations(a: Answers, props: Pick<InfraProps, 'prefix' | 'memory' | 'observability'>, deployed: ReadonlySet<string>, taken: (n: ProjectNames) => Promise<string[]>): Promise<{ answers: Answers; changed: GenerationChange[] }> {
  const changed: GenerationChange[] = []
  const projects: Answers['projects'] = []
  for (const p of a.projects) {
    if (deployed.has(projectHash(p.repo))) { projects.push(p); continue }
    let generation = p.generation
    const seen: string[] = []
    for (;;) {
      const t = await taken(projectNames(props, p.repo, generation))
      if (!t.length) break
      seen.push(...t)
      if (generation >= 99) throw new Error(`${p.repo}: every generation of its names up to 99 is taken in the account (${t.join(', ')})`)
      generation += 1
    }
    if (generation !== p.generation) changed.push({ repo: p.repo, from: p.generation, to: generation, taken: seen })
    projects.push({ ...p, generation })
  }
  return { answers: { ...a, projects }, changed }
}

/** Said in the plan, the log and the summary when a project is added again under new names. */
export function generationNote(changed: readonly GenerationChange[]): string | null {
  if (!changed.length) return null
  const what = changed.map((c) => `${c.repo} (generation ${c.to}; ${c.taken.join(', ')} ${c.taken.length === 1 ? 'is' : 'are'} taken)`).join(', ')
  return `Added again after being removed: ${what}. Its earlier memory, log delivery or token secret still holds its names in the account, so it gets new ones. `
    + 'The old memory is kept and orphaned, with its records (delete it in the AgentCore console when you no longer need it); the new one starts empty. A secret in its recovery window is deleted by Secrets Manager when the window ends.'
}

/** Said in the plan about the projects already at a generation above 0 (from an earlier run). */
function generationsPlan(a: Answers): string {
  const at = a.projects.filter((p) => p.generation > 0)
  return at.length ? `; ${at.map((p) => `${p.repo} at generation ${p.generation} (its earlier memory stays in the account, orphaned)`).join(', ')}` : ''
}

/** The CPU queue part of the deploy step's description. */
function cpuPlan(props: InfraProps): string {
  if (!props.cpu.enabled || !props.gpu.enabled) return ''
  if (!cpuEnabled(props)) return ', no CPU queue (it needs one nested stack per project: a flat stack has no room for its job definitions)'
  return `, and a CPU queue for CPU-heavy remote jobs (${props.cpu.instanceTypes.join('/')}, up to ${props.cpu.maxVcpus} vCPUs${props.cpu.spot ? ', Spot' : ''}, ${props.cpu.vcpus} vCPUs and ${Math.round(props.cpu.memoryMiB / 1024)} GiB per job, the same image)`
}

/** The knowledge base part of the deploy step's description. */
export function kbPlan(props: InfraProps): string {
  if (!props.knowledgeBase.enabled) return ''
  if (props.layout !== 'nested' || props.layoutMigration) return '; no knowledge bases (they need one nested stack per project: a flat stack has no room for theirs)'
  const kb = props.knowledgeBase
  return `; each project its own Bedrock knowledge base (${kb.embeddingModel}, ${kb.dimensions} dimensions, ${kb.chunking.strategy} chunks of ${kb.chunking.maxTokens} tokens; vectors in one S3 vector bucket, an index per project${props.retainData ? ', kept if the project or the stack is removed' : ''}), synced on every push to the default branch`
}

/** The observability part of the deploy step's description. */
export function observabilityPlan(o: InfraProps['observability'], prefix: string): string {
  if (!o.enabled) return '; observability off'
  const parts = ['OpenTelemetry (ADOT) traces and metrics to CloudWatch GenAI Observability']
  if (o.transactionSearch) parts.push(`CloudWatch Transaction Search turned on if it is off (account-wide, never turned off${o.samplingPercent !== undefined ? `; X-Ray indexing set to ${o.samplingPercent}%` : ''})`)
  if (o.dashboard) parts.push(`the ${prefix}-agents dashboard`)
  return `, ${parts.join(', ')}`
}

/** The agent token a project's worker and workflows use: its own when one was given, else the shared one. */
export const projectToken = (s: Secrets, repo: string): string => s.projectTokens[repo.toLowerCase()] ?? s.githubToken

/** Said in the summary when any project shares the token: GitHub access is then not isolated between projects. */
export function sharedTokenWarning(a: Answers, s: Secrets): string | null {
  const shared = a.projects.filter((p) => !s.projectTokens[p.repo.toLowerCase()]).map((p) => p.repo)
  if (!shared.length || a.projects.length < 2) return null
  return `GitHub access is not isolated between projects: ${shared.join(', ')} use${shared.length === 1 ? 's' : ''} the shared agent token, so that project's agent can reach every repository the token can. `
    + 'AWS resources are isolated per project either way; for GitHub, give each project its own fine-grained token limited to that repository and run the installer again.'
}

/**
 * Check each project's own token: it must reach its repository, and should reach none of the other projects'
 * (a warning, not a failure). Returns the warnings, and each token's login (its project's TRACE_AGENT_LOGIN).
 */
export async function checkProjectTokens(a: Answers, s: Secrets, check: (token: string) => Promise<TokenInfo> = checkToken): Promise<{ warnings: string[]; logins: Map<string, string> }> {
  const warnings: string[] = []
  const logins = new Map<string, string>()
  const all = a.projects.map((p) => p.repo.toLowerCase())
  for (const [repo, token] of Object.entries(s.projectTokens)) {
    if (!all.includes(repo)) throw new Error(`a token was given for ${repo}, which is not one of the projects being installed`)
    const info = await check(token)
    const seen = new Set(info.repos.map((r) => r.fullName.toLowerCase()))
    if (!seen.has(repo)) throw new Error(`${repo}'s own token (${info.login}) cannot see ${repo}`)
    const others = all.filter((r) => r !== repo && seen.has(r))
    if (others.length) warnings.push(`${repo}'s own token can also reach ${others.join(', ')}: limit it to ${repo} alone, or its agent is not isolated from ${others.length === 1 ? 'that project' : 'those projects'} on GitHub.`)
    for (const w of info.warnings) warnings.push(`${repo}'s token: ${w}`)
    logins.set(repo, info.login)
  }
  return { warnings, logins }
}

/** The memory part of the deploy step's description. */
function memoryPlan(a: Answers, props: InfraProps, existing?: Existing | null): string {
  if (!props.memory.enabled) return ''
  const own = a.projects.filter((p) => p.memoryEventExpiryDays !== null).map((p) => `${p.repo} ${p.memoryEventExpiryDays} days`)
  const text = `; each project its own AgentCore memory (events kept ${props.memory.eventExpiryDays} days${own.length ? `; ${own.join(', ')}` : ''}${props.retainData ? ', kept if the project or the stack is removed' : ', deleted with the project'})`
  const note = sharedMemoryNote(a, existing)
  return note ? `${text}. ${note}` : text
}

/** The layout part of the deploy step's description. */
function layoutPlan(a: Answers, existing?: Existing | null): string {
  const deploys = layoutDeploys(a, existing)
  const what = deploys.length === 1 ? `; ${deploys[0]?.why}` : `; ${deploys.length} deploys: ${deploys.map((d, i) => `${i + 1}) ${d.why}`).join(', ')}`
  const note = layoutNote(a, existing)
  return note ? `${what}. ${note}` : what
}

/** The connection step's description. */
function connectionPlan(a: Answers): string {
  const which = a.runners.connectionArn
    ? `use the GitHub connection ${a.runners.connectionArn}`
    : `use the GitHub connection ${connectionName(a.agents.prefix)} in AWS CodeConnections, or create it`
  return `${which}, so AWS CodeBuild can run the repositories' GitHub Actions jobs without a stored GitHub token. A new connection must be authorized once by a person in the AWS console (${connectionsConsoleUrl(a.aws.region)}, "Update pending connection"), which installs the AWS Connector for GitHub app: the installer shows the link and waits. Give that app access to ${a.projects.map((p) => p.repo).join(', ')}`
}

/** What will happen, before anything does. `existing`: the stack already in the account, when the check found one. */
export function plan(a: Answers, existing?: Existing | null): Step[] {
  const props = InfraPropsSchema.parse(infraInput(a, existing))
  const stack = stackName(props.prefix)
  const onboarding = a.projects.filter((p) => p.onboard).map((p) => p.repo)
  const steps: [string, string, string][] = [
    ['check', 'Check the AWS account', `${a.aws.account} in ${a.aws.region}`],
    ['connection', 'Connect AWS to GitHub', connectionPlan(a)],
    ['cdk', 'Bootstrap CDK', `aws://${a.aws.account}/${a.aws.region} (only if it isn't already)`],
    ['deploy', `Deploy ${stack}`, `central bucket, agent image (CodeBuild, arm64), for each of the ${props.repositories.length} repositories its own AgentCore worker runtime, execution role, GitHub OIDC role and token secret${props.gpu.enabled ? ' and job definitions' : ''}, and its own AWS CodeBuild runner project that runs every one of its GitHub Actions jobs (${props.runners.computeType}${props.runners.privileged ? ', Docker-in-Docker' : ''}; no job runs on GitHub's own runners), the API runtime and Cognito${props.gpu.enabled ? `, GPU jobs on AWS Batch (${props.gpu.instanceTypes.join('/')}, up to ${props.gpu.maxVcpus} vCPUs${props.gpu.spot ? ', Spot' : ''}, image built on amd64 without holding up the deploy; one queue for every project)${cpuPlan(props)}` : ''}${props.gateway.enabled ? ', the library gateway (AgentCore Gateway and a Lambda for the shared datasheets and parts tools)' : ''}${kbPlan(props)}${observabilityPlan(props.observability, props.prefix)}${memoryPlan(a, props, existing)}${generationsPlan(a)}${layoutPlan(a, existing)}. A project added again after being removed gets new names if its old memory, log delivery or token secret still holds them: the old memory is kept and orphaned, and the new one starts empty`],
    ['token', 'Store the GitHub tokens', `the shared token in the API's secret, and each project's agent token in its own secret${props.gateway.enabled ? '; any distributor keys given in the library gateway\'s secret' : ''}`],
    ['repos', 'Configure the repositories', `each repository's own TRACE_AWS_ROLE, TRACE_AGENT_RUNTIME_ARN, ${RUNNER_VARIABLE} (the CodeBuild runner project its workflows run on)${props.memory.enabled ? ', TRACE_MEMORY_ID' : ''}${props.knowledgeBase.enabled && props.layout === 'nested' ? ', TRACE_KB_ID and TRACE_KB_DATA_SOURCE_ID' : ''}, TRACE_AWS_REGION, TRACE_HOME and secret TRACE_TOKEN in ${a.projects.map((p) => p.repo).join(', ')}`],
    ['onboard', 'Onboard the repositories', onboarding.length ? `open the onboarding PR in ${onboarding.join(', ')}` : 'none chosen'],
    ['people', 'Invite people and assign projects', `${a.adminEmail} (admin)${a.people.length ? `, ${a.people.map((p) => `${p.email} (${p.class})`).join(', ')}` : ''}`],
    ['local', 'Save this installation locally', '~/.trace/client.db, so `trace login` works here'],
    ['gpu', 'Check the GPU image', props.gpu.enabled
      ? 'wait for the GPU image build the deploy started (CodeBuild, amd64; the first takes 30–60 minutes) and start it again if an earlier one failed: GPU and CPU jobs need it, nothing else does'
      : 'GPU jobs are off'],
  ]
  return steps.map(([id, title, detail]) => ({ id, title, detail, status: 'pending' as const }))
}

type Emit = (e: InstallEvent) => void

const cdkBin = (): string => createRequire(import.meta.url).resolve('aws-cdk/bin/cdk')

function runStreaming(cmd: string, args: string[], env: Record<string, string>, onLine: (l: string) => void): Promise<number> {
  return new Promise((resolveP, reject) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const feed = (d: Buffer): void => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    }
    p.stdout.on('data', feed)
    p.stderr.on('data', feed)
    p.on('error', reject)
    p.on('close', (code) => { if (buf.trim()) onLine(buf); resolveP(code ?? 1) })
  })
}

/** Redact anything that looks like a credential before it reaches the page. */
export function redact(line: string, secrets: Secrets): string {
  let out = line
  for (const s of [secrets.githubToken, secrets.githubAdminToken, secrets.awsSecretAccessKey, secrets.awsSessionToken, secrets.awsAccessKeyId, ...Object.values(secrets.projectTokens)]) {
    if (s && s.length >= 8) out = out.split(s).join('••••')
  }
  return out.replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1••••')
}

export interface Hooks {
  cdk?: (args: string[], env: Record<string, string>, onLine: (l: string) => void) => Promise<number>
  outputs?: (creds: AwsCredentialIdentity, region: string, stack: string) => Promise<Record<string, string>>
  freeSecrets?: (creds: AwsCredentialIdentity, region: string, names: readonly string[]) => Promise<string[]>
  /** which projects the stack has, and which names are taken in the account (chooseGenerations) */
  names?: { deployed: () => Promise<Set<string>>; taken: (n: ProjectNames) => Promise<string[]> }
  /** wait for the GPU image build (src/installer/aws.ts ensureGpuImage) */
  gpuImage?: (o: { buildId: string; imageTag: string; startedAfter: Date; log: (l: string) => void }) => Promise<{ ok: boolean; detail: string }>
  /** find or create the GitHub connection and wait until it is authorized (src/installer/aws.ts ensureConnection) */
  connection?: (o: ConnectionWait & { prefix: string; given?: string }) => Promise<GithubConnection>
  /** the library keys stored now (readSecretJson) */
  readSecret?: (sm: SecretsManagerClient, arn: string) => Promise<Record<string, string>>
}

/** A secret's JSON object of strings ({} when it holds anything else). */
export async function readSecretJson(sm: SecretsManagerClient, arn: string): Promise<Record<string, string>> {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }))
  try {
    const v = JSON.parse(r.SecretString ?? '{}') as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

/** The library keys to store: the ones given over the ones stored (an empty field keeps a stored key), without the
 * placeholder CloudFormation generated. */
export function mergeLibraryKeys(stored: Record<string, string>, given: Record<string, string>): Record<string, string> {
  const { unused: _placeholder, ...kept } = stored
  return { ...kept, ...given }
}

export async function apply(a: Answers, s: Secrets, emit: Emit, hooks: Hooks = {}): Promise<boolean> {
  const started = new Date()
  const steps = plan(a)
  const byId = new Map(steps.map((st) => [st.id, st]))
  const set = (id: string, status: Step['status'], detail?: string): void => {
    const st = byId.get(id)
    if (!st) return
    st.status = status
    if (detail) st.detail = detail
    emit({ type: 'step', step: { ...st } })
  }
  const log = (id: string, line: string): void => emit({ type: 'log', step: id, line: redact(line, s) })
  for (const st of steps) emit({ type: 'step', step: { ...st } })
  let props = InfraPropsSchema.parse(infraInput(a))
  const stack = stackName(props.prefix)
  const summary: string[] = []
  const cdk = hooks.cdk ?? ((args, env, onLine) => runStreaming(process.execPath, [cdkBin(), ...args], env, onLine))
  let current = 'check'
  try {
    // 1 — the account
    const creds = await credentials(a.aws, s)
    const check = await checkAws(creds, a.aws.region, stack)
    if (check.account !== a.aws.account) throw new Error(`these credentials are for account ${check.account}, not the confirmed ${a.aws.account}`)
    if (!check.agentCore.ok) throw new Error(`Bedrock AgentCore is not available to these credentials in ${a.aws.region}: ${check.agentCore.reason}`)
    const own = await checkProjectTokens(a, s)
    for (const w of own.warnings) { log('check', w); summary.push(w) }
    set('check', 'done', `${check.arn}`)
    // an installation of an earlier version: its installation-wide memory goes (kept, with retainData, for one deploy)
    const existing = check.existing ?? null
    props = InfraPropsSchema.parse(infraInput(a, existing))
    // a project added again while a removed copy's names are still taken: the next generation, saved at once (a deploy
    // that fails after creating a retained memory must not make the next run pick the same names)
    const names = hooks.names ?? (() => {
      const index = nameIndex(nameClients(creds, a.aws.region))
      return { deployed: () => deployedProjects(cfnClient(creds, a.aws.region), stack), taken: index.taken }
    })()
    const gens = await chooseGenerations(a, props, await names.deployed(), names.taken)
    if (gens.changed.length) {
      a = gens.answers
      saveAnswers({ answers: a })
      props = InfraPropsSchema.parse(infraInput(a, existing))
      const note = generationNote(gens.changed) ?? ''
      log('check', note)
      summary.push(note)
      set('deploy', 'pending', `${byId.get('deploy')?.detail ?? ''} ${note}`)
    }
    const legacy = sharedMemoryNote(a, existing)
    if (legacy) { log('check', legacy); summary.push(legacy) }
    const layout = layoutNote(a, existing)
    if (layout) { log('check', layout); summary.push(layout) }
    const deploys = layoutDeploys(a, existing)

    // 2 — the GitHub connection the CodeBuild runners use: before the deploy, which names it in every runner project
    current = 'connection'
    set('connection', 'running')
    const repos = a.projects.map((p) => p.repo)
    let todo = ''
    const connect = hooks.connection ?? ((o) => ensureConnection(connectionsClient(creds, a.aws.region), o))
    const conn = await connect({
      prefix: props.prefix, ...(a.runners.connectionArn ? { given: a.runners.connectionArn } : {}), region: a.aws.region, repos,
      report: (l) => {
        log('connection', l)
        // the step's own line says what is needed now (what to do, and when the next check is), so the person sees it
        // without opening the log
        if (/^The GitHub connection .* is waiting/.test(l)) { todo = l; set('connection', 'running', l) }
        if (/^Waiting for /.test(l)) set('connection', 'running', todo ? `${todo} ${l}` : l)
      },
    })
    const access = connectorAccessNote(repos)
    log('connection', access)
    summary.push(access)
    set('connection', 'done', `${conn.name || conn.arn} is authorized (${conn.arn})`)
    props = InfraPropsSchema.parse(infraInput(a, existing, undefined, conn.arn))
    const envFor = (d: LayoutDeploy): Record<string, string> => ({
      ...awsEnv(creds, a.aws.region), TRACE_INFRA: JSON.stringify(infraInput(a, existing, d, conn.arn)), CDK_DISABLE_VERSION_CHECK: '1', CI: '1',
    })
    const env = envFor(deploys.at(-1) ?? { layout: 'nested', why: '' })

    // 3 — CDK bootstrap (nested stacks' templates are file assets in its bucket, like the agent source)
    current = 'cdk'
    if (check.cdkBootstrapped) set('cdk', 'skipped', 'already bootstrapped')
    else {
      set('cdk', 'running')
      const code = await cdk(['bootstrap', `aws://${a.aws.account}/${a.aws.region}`, '--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`], env, (l) => log('cdk', l))
      if (code !== 0) throw new Error(`cdk bootstrap exited ${code}`)
      set('cdk', 'done')
    }

    // 4 — deploy (one deploy, or the three of the move to nested stacks, in order)
    current = 'deploy'
    set('deploy', 'running', 'the first deploy builds the agent image: expect 20–40 minutes')
    for (const [i, d] of deploys.entries()) {
      if (deploys.length > 1) log('deploy', `deploy ${i + 1} of ${deploys.length}: ${d.why}`)
      // the drain deleted every project's secret; one still in its recovery window would block the nested stack's
      if (deploys.length > 1 && d.layout === 'nested') {
        const lines = await (hooks.freeSecrets ?? freeSecretNames)(creds, a.aws.region, a.projects.map((p) => githubSecretName(props.prefix, p.repo, p.generation)))
        for (const l of lines) log('deploy', l)
      }
      const code = await cdk(['deploy', stack, '--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`, '--require-approval', 'never', '--progress', 'events'], envFor(d), (l) => log('deploy', l))
      if (code !== 0) throw new Error(`cdk deploy exited ${code}${deploys.length > 1 ? ` (deploy ${i + 1} of ${deploys.length}: ${d.why}; run the installer again to carry on)` : ''}`)
    }
    const out = await (hooks.outputs ?? stackOutputs)(creds, a.aws.region, stack)
    const need = (k: string): string => {
      const v = out[k]
      if (!v) throw new Error(`the stack has no output ${k}`)
      return v
    }
    // each project's own memory (none when memory is off)
    const memoryIds = Object.fromEntries(a.projects.flatMap((p) => {
      const id = out[projectOutputs(p.repo).memoryId]
      return id ? [[p.repo.toLowerCase(), id] as const] : []
    }))
    for (const [repo, id] of Object.entries(memoryIds)) log('deploy', `${repo}: memory ${id}`)
    if (props.memory.enabled && Object.keys(memoryIds).length !== a.projects.length) throw new Error('the stack has no memory output for every project')
    set('deploy', 'done', `${stack} is up`)

    // 5 — the token
    current = 'token'
    set('token', 'running')
    const sm = new SecretsManagerClient({ region: a.aws.region, credentials: creds })
    await sm.send(new PutSecretValueCommand({ SecretId: need('GithubSecretArn'), SecretString: s.githubToken }))
    log('token', 'the API\'s (shared) token stored')
    for (const p of a.projects) {
      // its Project<hash>GithubSecretArn output (the parent's when flat, its nested stack's when nested), else by name
      const secretId = out[projectOutputs(p.repo).secretArn] || githubSecretName(props.prefix, p.repo, p.generation)
      await sm.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: projectToken(s, p.repo) }))
      log('token', `${p.repo}: ${s.projectTokens[p.repo.toLowerCase()] ? 'its own token' : 'the shared token'} stored in its secret`)
    }
    const sharing = sharedTokenWarning(a, s)
    if (sharing) summary.push(sharing)
    // the distributor keys, for the library gateway's Lambda (the only reader of that secret)
    if (props.gateway.enabled) {
      const keysArn = out[LIBRARY_KEYS_OUTPUT]
      if (!keysArn) throw new Error(`the stack has no output ${LIBRARY_KEYS_OUTPUT}`)
      const given = Object.fromEntries(Object.entries(s.libraryKeys).filter(([, v]) => v !== ''))
      if (Object.keys(given).length) {
        const stored = await (hooks.readSecret ?? readSecretJson)(sm, keysArn)
        await sm.send(new PutSecretValueCommand({ SecretId: keysArn, SecretString: JSON.stringify(mergeLibraryKeys(stored, given)) }))
        log('token', `distributor keys stored for the library gateway: ${Object.keys(given).join(', ')}`)
      } else {
        log('token', 'no distributor keys given: the library gateway keeps the ones it has (LCSC needs none)')
      }
    }
    set('token', 'done')

    // 6 — repositories
    current = 'repos'
    set('repos', 'running')
    const adminToken = s.githubAdminToken || s.githubToken
    const agentLogin = (await checkToken(s.githubToken)).login
    const adminLogin = adminToken === s.githubToken ? agentLogin : (await checkToken(adminToken)).login
    if (adminLogin.toLowerCase() === agentLogin.toLowerCase()) {
      summary.push(`The agents' token belongs to ${agentLogin}, so /approve from ${agentLogin} is refused on deploys (an agent must never approve its own). Give the agents a machine account's token, or approve from another account.`)
    }
    for (const p of a.projects) {
      const o = projectOutputs(p.repo)
      const login = own.logins.get(p.repo.toLowerCase()) ?? agentLogin
      if (login.toLowerCase() === adminLogin.toLowerCase() && login !== agentLogin) {
        summary.push(`${p.repo}'s own token belongs to ${login}, so /approve from ${login} is refused on its deploys.`)
      }
      const vars: Record<string, string> = {
        // this project's own role and runtime: neither reaches any other project
        TRACE_AWS_ROLE: need(o.roleArn), TRACE_AWS_REGION: a.aws.region, TRACE_HOME: need('TraceHome'), TRACE_AGENT_RUNTIME_ARN: need(o.runtimeArn),
        // its own CodeBuild runner project: every job of its workflows runs there (`runs-on: codebuild-<project>-…`)
        [RUNNER_VARIABLE]: need(o.runnerProject),
        // The worker trusts claim markers and refuses deploy approvals from this login (the agents' own account).
        TRACE_AGENT_LOGIN: login,
        // its own memory, for the worker.runner = actions fallback (its OIDC role may use that memory only)
        ...(memoryIds[p.repo.toLowerCase()] ? { TRACE_MEMORY_ID: memoryIds[p.repo.toLowerCase()] ?? '' } : {}),
        // its own knowledge base, for the kb-sync job on a push to the default branch and the actions fallback
        ...(out[kbOutputs(p.repo).knowledgeBaseId] ? { TRACE_KB_ID: out[kbOutputs(p.repo).knowledgeBaseId] ?? '', TRACE_KB_DATA_SOURCE_ID: out[kbOutputs(p.repo).dataSourceId] ?? '' } : {}),
      }
      for (const [k, v] of Object.entries(vars)) log('repos', `${p.repo}: ${k} ${await setVariable(adminToken, p.repo, k, v)}`)
      await setSecret(adminToken, p.repo, 'TRACE_TOKEN', projectToken(s, p.repo))
      log('repos', `${p.repo}: TRACE_TOKEN set`)
    }
    set('repos', 'done')

    // 7 — onboarding PRs (gh CLI, with the admin token in this process's environment only for the duration)
    current = 'onboard'
    const toOnboard = a.projects.filter((p) => p.onboard)
    if (!toOnboard.length) set('onboard', 'skipped')
    else {
      set('onboard', 'running')
      const prior = process.env.GH_TOKEN
      process.env.GH_TOKEN = adminToken
      try {
        for (const p of toOnboard) {
          const r = await onboard(p.repo, { apply: p.applySettings, ...(a.escalateTo ? { escalateTo: a.escalateTo } : {}) })
          log('onboard', `${p.repo}: ${r.pr ?? 'no PR'}${r.settings.length ? ` (${r.settings.join('; ')})` : ''}`)
          if (r.pr) summary.push(`Merge the onboarding PR: ${r.pr}`)
        }
      } finally {
        if (prior === undefined) delete process.env.GH_TOKEN
        else process.env.GH_TOKEN = prior
      }
      set('onboard', 'done')
    }

    // 8 — people and their projects (central database on S3: credentials in this process's environment for the duration)
    current = 'people'
    set('people', 'running')
    const saved = { ...process.env }
    Object.assign(process.env, awsEnv(creds, a.aws.region), { TRACE_HOME: need('TraceHome') })
    try {
      const idp = new CognitoIdentityProviderClient({ region: a.aws.region, credentials: creds })
      const pool = need('UserPoolId')
      const subOf = async (email: string): Promise<string> => {
        try {
          const u = await idp.send(new AdminGetUserCommand({ UserPoolId: pool, Username: email }))
          return u.UserAttributes?.find((x) => x.Name === 'sub')?.Value ?? ''
        } catch (e) {
          if (!(e instanceof UserNotFoundException)) throw e
          const c = await idp.send(new AdminCreateUserCommand({
            UserPoolId: pool, Username: email, DesiredDeliveryMediums: ['EMAIL'],
            UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
          }))
          log('people', `${email}: invited (Cognito emails a temporary password)`)
          return c.User?.Attributes?.find((x) => x.Name === 'sub')?.Value ?? ''
        }
      }
      const installer: Principal = { sub: `installer:${check.arn}`, email: a.adminEmail, groups: [GROUPS.admin] }
      for (const p of a.people) {
        const sub = await subOf(p.email)
        if (!sub) throw new Error(`no Cognito id for ${p.email}`)
        await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username: p.email, GroupName: GROUPS[p.class] }))
        // Exactly one class: a person moved from admin to guest must lose the admin group, not keep both.
        const groups = (await idp.send(new AdminListGroupsForUserCommand({ UserPoolId: pool, Username: p.email }))).Groups ?? []
        for (const g of groups) {
          const other = Object.values(GROUPS).includes(g.GroupName ?? '') && g.GroupName !== GROUPS[p.class]
          if (!other) continue
          await idp.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: pool, Username: p.email, GroupName: g.GroupName }))
          log('people', `${p.email}: removed from ${g.GroupName}`)
        }
        await setClass(installer, { sub, email: p.email }, p.class)
        log('people', `${p.email}: ${p.class}`)
        const want = new Set(p.projects.map((r) => r.toLowerCase()))
        for (const repo of p.projects) {
          await assign(installer, { sub, email: p.email }, repo)
          log('people', `${p.email}: assigned to ${repo} (${p.class === 'guest' ? 'read' : 'read and write'})`)
        }
        // The answers are the whole truth for a listed person: projects no longer listed are taken away.
        for (const g of await assignments(installer, { sub })) {
          if (want.has(g.repo.toLowerCase())) continue
          await unassign(installer, sub, g.repo)
          log('people', `${p.email}: unassigned from ${g.repo}`)
        }
      }
      // People granted access earlier but missing from these answers keep it until an admin removes them: say so.
      const listed = new Set(a.people.map((p) => p.email.toLowerCase()))
      const stale = [...new Set((await assignments(installer)).filter((g) => g.email && !listed.has(g.email.toLowerCase()) && g.email.toLowerCase() !== a.adminEmail.toLowerCase()).map((g) => g.email!))]
      if (stale.length) {
        log('people', `not in this installation's list but still assigned: ${stale.join(', ')}`)
        summary.push(`Still have project access though not listed here: ${stale.join(', ')} (remove with \`trace users unassign\`)`)
      }
      for (const p of a.projects) await register(p.repo, null)
    } finally {
      for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'TRACE_HOME']) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    summary.push(`${a.adminEmail} receives a temporary password from Cognito; sign in with \`trace login\`.`)
    set('people', 'done')

    // 9 — this machine
    current = 'local'
    saveInstallation({
      name: 'default', region: a.aws.region, account: a.aws.account, stack, traceHome: need('TraceHome'),
      userPoolId: need('UserPoolId'), clientId: need('UserPoolClientId'), cognitoDomain: need('CognitoDomain'),
      // each project has its own worker runtime and role (its repository's variables): none is the installation's
      apiRuntimeArn: need('ApiRuntimeArn'), workerRuntimeArn: '', actionsRoleArn: '',
      githubSecretArn: need('GithubSecretArn'), memoryIds, callbackPorts: props.callbackPorts,
    })
    saveAnswers({ answers: a })
    set('local', 'done')

    // 10 — the GPU image: the deploy started its build and did not wait (src/infra/gpu.ts); wait now, with the rest up
    current = 'gpu'
    if (!props.gpu.enabled) set('gpu', 'skipped')
    else {
      set('gpu', 'running')
      const imageTag = (out.GpuImageUri ?? '').split(':').at(-1) ?? ''
      const wait = hooks.gpuImage ?? ((o) => ensureGpuImage(codebuildClient(creds, a.aws.region), o))
      const r = await wait({ buildId: out[GPU_IMAGE_BUILD_OUTPUT] ?? '', imageTag, startedAfter: started, log: (l) => log('gpu', l) })
      if (r.ok) set('gpu', 'done', r.detail)
      else {
        set('gpu', 'failed', r.detail)
        summary.push(`GPU and CPU jobs cannot run until the GPU image is built: ${r.detail}. Everything else is installed; fix the cause and run the installer again to build it.`)
      }
    }
    summary.unshift(`trace is installed in ${a.aws.account} (${a.aws.region}) as ${stack}.`)
    summary.push('Write each project\'s rules in .trace/rules.md (they start empty).')
    emit({ type: 'done', ok: true, summary })
    return true
  } catch (e) {
    const m = redact(e instanceof Error ? e.message : String(e), s)
    set(current, 'failed', m)
    emit({ type: 'done', ok: false, summary: [`Stopped at "${byId.get(current)?.title}": ${m}`, 'Fix the cause and run the installer again: every step is safe to repeat.'] })
    return false
  }
}
