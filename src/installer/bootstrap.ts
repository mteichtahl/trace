/**
 * Installing trace into an AWS account, step by step. Every step is safe to run again: a second installation
 * updates what the first made.
 *
 *   1 check      the credentials still resolve to the confirmed account
 *   2 cdk        bootstrap CDK in the account/region if it isn't
 *   3 deploy     `cdk deploy` the trace stack (the agent image builds in CodeBuild: the first deploy takes a while), in
 *                the layout the installation has (a new one: nested; an earlier one: flat), or, when asked to move a
 *                flat one to nested, three deploys in a row (release, drain, nested: see layoutDeploys). Before it, a
 *                project the stack does not have yet whose fixed names are taken in the account (a removed copy's
 *                retained memory, delivery sources or destinations, or secret in its recovery window) gets the next
 *                generation of names, saved with the answers (chooseGenerations)
 *   4 token      write the GitHub tokens into Secrets Manager: the shared one (the API's), and each project's own
 *                (its own token when one was given, else a copy of the shared one)
 *   5 repos      each repository's Actions variables (its own role, runtime and memory, from its project's outputs,
 *                which are its nested stack's in the nested layout; region, TRACE_HOME) and its TRACE_TOKEN secret
 *   6 onboard    the onboarding PR in each repository that asked for it, and its repository settings
 *   7 people     invite each person to Cognito, put them in their class's group (admin, user, guest), and record
 *                the projects they are assigned to
 *   8 local      save the installation on this machine so `trace login` and `trace remote …` work
 *   9 gpu        wait for the GPU image build the deploy started (the stack does not wait for it, so a broken GPU
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
import { answers as savedAnswers, saveAnswers, saveInstallation } from '../core/client.js'
import { INTEGRATIONS, INTEGRATION_NAMES, type IntegrationName, IntegrationStore, checkIntegration, secretsManagerApi } from '../core/integrations.js'
import { register } from '../core/onboard.js'
import { runnerProjectName } from '../infra/runners.js'
import {
  GPU_IMAGE_BUILD_OUTPUT, type InfraInput, type InfraProps, InfraPropsSchema, LAYOUT_OUTPUT, LEGACY_MEMORY_OUTPUT, RUNNER_ROLE_OUTPUT, cpuEnabled, githubSecretName,
  kbOutputs, memoryDeliveryName, memoryName, projectHash, projectOutputs, stackName,
} from '../infra/props.js'
import { REPO_ROOT } from '../infra/stack.js'
import type { Answers, InstallEvent, Secrets, Step } from './answers.js'
import {
  type ProjectNames, awsEnv, cfnClient, checkAws, codebuildClient, credentials, deployedProjects, ensureGpuImage, freeSecretNames, liveFacts, nameClients, nameIndex,
  stackOutputs,
} from './aws.js'
import { type Facts, resolveAnswers } from './derive.js'
import { type TokenInfo, checkToken, createRepo, deleteVariable, setSecret, setVariable } from './github.js'
import { type ApiOnboardOptions, type ApiOnboardResult, onboardViaApi } from './onboard-api.js'
import { CDK_BOOTSTRAP_MIN, mapLimit } from './preflight.js'
import { type RunnerSpec, ensureRunner, ensureSourceCredential, removeRunner, runnerProjects, runnerRepos } from './runners.js'

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
    return 'This installation keeps every project in the one stack (layout flat), which holds about 24 projects. New installations put each project in its own nested stack, which holds 60; '
      + 'moving this one is a choice ("move to nested stacks") because it deletes every project\'s memory records.'
  }
  return 'Moving to one nested stack per project, in three deploys: '
    + `${a.agents.retainData ? 'the first marks each project\'s memory and log delivery Delete, ' : ''}the next removes every project from the stack, DELETING each project's memory and every record in it (each memory's log group ${a.agents.retainData ? 'stays in the account' : 'goes too'}), and the last creates every project again in its own nested stack, with an empty memory. `
    + 'AgentCore cannot copy memory records, and CloudFormation cannot move these resources (they have fixed names) into a nested stack in place. '
    + 'The projects are offline from the second deploy until the repositories\' variables are rewritten; workflows that run in between fail: re-run them.'
}

/** The stack's settings from the answers (and, for the legacy memory's way out and the layout, what is deployed already). */
export function infraInput(a: Answers, existing?: Existing | null, deploy?: LayoutDeploy): InfraInput {
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
    // null (decide from the preflight) never reaches here after resolveAnswers; on its own it means on
    gpu: { enabled: a.agents.gpuEnabled ?? true, maxVcpus: a.agents.gpuMaxVcpus, spot: a.agents.gpuSpot },
    cpu: { enabled: a.agents.cpuEnabled ?? true, maxVcpus: a.agents.cpuMaxVcpus, spot: a.agents.cpuSpot, vcpus: a.agents.cpuVcpus, memoryMiB: a.agents.cpuMemoryMiB },
    knowledgeBase: { enabled: a.agents.knowledgeBase ?? true },
    gateway: { enabled: a.agents.libraryGateway },
    images: { source: a.agents.imageSource },
    runners: { enabled: a.agents.runners, extraRepos: a.agents.runnerExtraRepos },
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

/** What changed since the answers of the last installation from this machine (null: none known), in words. */
export function changesSince(prev: Answers | null, next: Answers): string[] {
  if (!prev) return []
  const out: string[] = []
  const was = new Set(prev.projects.map((p) => p.repo.toLowerCase()))
  const now = new Set(next.projects.map((p) => p.repo.toLowerCase()))
  const added = next.projects.filter((p) => !was.has(p.repo.toLowerCase())).map((p) => p.repo)
  const removed = prev.projects.filter((p) => !now.has(p.repo.toLowerCase())).map((p) => p.repo)
  if (added.length) out.push(`adds ${added.join(', ')}`)
  if (removed.length) out.push(`removes ${removed.join(', ')} (its runtime, roles, secret, job definitions and runner go; ${next.agents.retainData ? 'its memory and knowledge base stay' : 'its memory and knowledge base are deleted'})`)
  const flat = (o: Record<string, unknown>, at = ''): Record<string, string> => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (
    v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(flat(v as Record<string, unknown>, `${at}${k}.`)) : [[`${at}${k}`, JSON.stringify(v)]])))
  const a = flat({ ...prev.agents, adminEmail: prev.adminEmail, escalateTo: prev.escalateTo })
  const b = flat({ ...next.agents, adminEmail: next.adminEmail, escalateTo: next.escalateTo })
  const settings = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort()
  if (settings.length) out.push(`changes ${settings.map((k) => `${k} ${a[k] ?? 'unset'} → ${b[k] ?? 'unset'}`).join(', ')}`)
  const people = (x: Answers): string => JSON.stringify([...x.people].sort((p, q) => p.email.localeCompare(q.email)))
  if (people(prev) !== people(next)) out.push('changes the people or their projects')
  return out
}

/** How long each part takes, roughly (estimates from the steps' own work, not measured on a real deploy). */
export function timeline(a: Answers, existing?: Existing | null, o: { cdkBootstrapped?: boolean } = {}): string[] {
  const fresh = !existing
  const prebuilt = a.agents.imageSource === 'prebuilt'
  const lines: string[] = []
  if (fresh && !o.cdkBootstrapped) lines.push('CDK bootstrap: about 2 minutes')
  lines.push(fresh
    ? `the stack: about 15 minutes of CloudFormation (Cognito, roles, AgentCore runtimes and memories, ${a.projects.length} project stack${a.projects.length === 1 ? '' : 's'} in parallel), plus the agent image: ${prebuilt ? 'about 5 minutes to copy trace\'s published image when there is one for this version, else' : ''} 20–40 minutes to build it`
    : 'the stack: a few minutes when only settings or projects change; when trace itself changed, the agent image is rebuilt from its cache (about 5–10 minutes, the system packages are not installed again) or copied')
  lines.push(`the repositories, their runners, onboarding and people: about 1–2 minutes, ${a.projects.length > 1 ? 'in parallel' : 'together'}`)
  if (a.agents.gpuEnabled !== false) lines.push(`then trace is ready to use; the GPU image ${prebuilt ? 'copies in about 10 minutes when published, else builds' : 'builds'} in the background (${fresh ? '30–60 minutes the first time' : 'faster from its cache'}): only GPU and CPU jobs wait for it`)
  else lines.push('then trace is ready to use (GPU and CPU jobs are off, so there is no GPU image to wait for)')
  return lines
}

/** What will happen, before anything does. `existing`: the stack already in the account, when the check found one;
 * `prev`: the answers of the last installation from this machine, so a re-run says what changes. */
export function plan(a: Answers, existing?: Existing | null, prev?: Answers | null): Step[] {
  const props = InfraPropsSchema.parse(infraInput(a, existing))
  const stack = stackName(props.prefix)
  const onboarding = a.projects.filter((p) => p.onboard && !p.create).map((p) => p.repo)
  const creating = a.projects.filter((p) => p.create).map((p) => `${p.repo} (${p.create?.template})`)
  const changes = existing ? changesSince(prev ?? null, a) : []
  const deployWhat = `central bucket, agent image (${props.images.source === 'prebuilt' ? 'trace\'s published image for this version when there is one, else built' : 'built'} by CodeBuild, arm64), for each of the ${props.repositories.length} repositories its own AgentCore worker runtime, execution role, GitHub OIDC role and token secret${props.gpu.enabled ? ' and job definitions' : ''}, the API runtime and Cognito${props.gpu.enabled ? `, GPU jobs on AWS Batch (${props.gpu.instanceTypes.join('/')}, up to ${props.gpu.maxVcpus} vCPUs${props.gpu.spot ? ', Spot' : ''}, image made without holding up the deploy; one queue for every project)${cpuPlan(props)}` : ', no GPU or CPU jobs'}${props.gateway.enabled ? ', the library gateway (AgentCore Gateway and a Lambda for the shared datasheets and parts tools)' : ''}${kbPlan(props)}${observabilityPlan(props.observability, props.prefix)}${memoryPlan(a, props, existing)}${generationsPlan(a)}${layoutPlan(a, existing)}${props.runners.enabled ? ', and the CI runners\' CodeBuild role' : ''}. A project added again after being removed gets new names if its old memory, log delivery or token secret still holds them: the old memory is kept and orphaned, and the new one starts empty`
  const steps: [string, string, string][] = [
    ['check', 'Check the AWS account', `${a.aws.account || 'the credentials\' account'} in ${a.aws.region || 'the profile\'s region'}`],
    ['cdk', 'Bootstrap CDK', `aws://${a.aws.account}/${a.aws.region} (only if it isn't already, or is older than version 6)`],
    ['deploy', existing ? `Update ${stack}` : `Deploy ${stack}`, existing ? `${changes.length ? `This run ${changes.join('; ')}. ` : 'No answer changed since the last run from here: CloudFormation leaves unchanged resources alone. '}${deployWhat}` : deployWhat],
    ['token', 'Store the GitHub tokens', `the shared token in the API's secret, and each project's agent token in its own secret${props.gateway.enabled ? '; any distributor keys given in the library gateway\'s secret' : ''}`],
    ['integrations', 'Store the optional integrations', 'any integration keys given (Nexar, Mouser, Digi-Key), each checked with its service and stored as <prefix>/integrations/<name>; none is needed, and they can be added later with `trace integrations set <name>`'],
    ['repos', 'Configure the repositories', a.projects.length ? `each repository's own TRACE_AWS_ROLE, TRACE_AGENT_RUNTIME_ARN${props.memory.enabled ? ', TRACE_MEMORY_ID' : ''}${props.knowledgeBase.enabled && props.layout === 'nested' ? ', TRACE_KB_ID and TRACE_KB_DATA_SOURCE_ID' : ''}, TRACE_AWS_REGION, TRACE_HOME, TRACE_AGENT_LOGIN and secret TRACE_TOKEN in ${a.projects.map((p) => p.repo).join(', ')}, several at once` : 'no repositories yet: run the installer again to add them'],
    ['runners', 'Run CI on AWS', props.runners.enabled ? `a CodeBuild-hosted GitHub Actions runner (aws/codebuild/standard:8.0) and its webhook for each of ${[...a.projects.map((p) => p.repo), ...props.runners.extraRepos].join(', ') || 'no repository yet'}, and its TRACE_CODEBUILD_PROJECT variable, so their trace workflows run on AWS; the token becomes CodeBuild's GitHub source credential unless the account has one. A repository the token cannot administer keeps GitHub's runners` : 'off: the trace workflows run on GitHub\'s runners'],
    ['onboard', 'Onboard the repositories', [onboarding.length ? `open (or refresh) the onboarding PR in ${onboarding.join(', ')}` : '', creating.length ? `create ${creating.join(', ')}` : ''].filter(Boolean).join('; ') || 'none chosen'],
    ['people', 'Invite people and assign projects', `${a.adminEmail || 'the token\'s email'} (admin)${a.people.length ? `, ${a.people.map((p) => `${p.email} (${p.class})`).join(', ')}` : ''}`],
    ['local', 'Save this installation locally', '~/.trace/client.db, so `trace login` works here'],
    ['gpu', 'The GPU image', props.gpu.enabled
      ? 'after trace is ready: wait for the GPU image the deploy started (copied, or built on amd64: the first build takes 30–60 minutes) and start it again if an earlier one failed. GPU and CPU jobs need it, nothing else does: you can use trace meanwhile'
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
  /** the library keys stored now (readSecretJson) */
  readSecret?: (sm: SecretsManagerClient, arn: string) => Promise<Record<string, string>>
  /** what the answers leave to be derived (src/installer/aws.ts liveFacts) */
  facts?: (creds: AwsCredentialIdentity, a: Answers) => Promise<Facts>
  /** the optional integrations' store, and checking a key with its service */
  integrations?: Pick<IntegrationStore, 'set'>
  checkIntegration?: typeof checkIntegration
  /** CodeBuild runners (src/installer/runners.ts) */
  runners?: {
    credential: (token: string, ours: boolean) => Promise<{ state: 'imported' | 'refreshed' | 'existing'; detail: string }>
    ensure: (spec: RunnerSpec) => Promise<string>
    list: (prefix: string) => Promise<string[]>
    remove: (name: string) => Promise<void>
  }
  /** onboarding one repository (src/installer/onboard-api.ts onboardViaApi) */
  onboard?: (repo: string, o: Omit<ApiOnboardOptions, 'token' | 'login'>) => Promise<ApiOnboardResult>
  /** creating a new project's repository before its variables are set */
  createRepo?: typeof createRepo
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

/** The integrations given with the secrets: each complete one (every key it takes), from `integrations` and the older
 * `libraryKeys` fields. An incomplete one is reported, not stored. */
export function givenIntegrations(s: Secrets): { complete: Partial<Record<IntegrationName, Record<string, string>>>; incomplete: string[] } {
  const complete: Partial<Record<IntegrationName, Record<string, string>>> = {}
  const incomplete: string[] = []
  const legacy = Object.fromEntries(Object.entries(s.libraryKeys).filter(([, v]) => v))
  for (const n of INTEGRATION_NAMES) {
    const raw = { ...Object.fromEntries(INTEGRATIONS[n].keys.filter((k) => legacy[k]).map((k) => [k, legacy[k] ?? ''])), ...(s.integrations[n] ?? {}) }
    const given = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
    if (!Object.keys(given).length) continue
    const missing = INTEGRATIONS[n].keys.filter((k) => !given[k])
    if (missing.length) incomplete.push(`${INTEGRATIONS[n].title}: ${missing.join(', ')} missing, so it was not stored`)
    else complete[n] = Object.fromEntries(INTEGRATIONS[n].keys.map((k) => [k, given[k] ?? '']))
  }
  return { complete, incomplete }
}

export interface ApplyOptions {
  /** the answers of the last installation from this machine (the plan's changes) */
  prev?: Answers | null
}

export async function apply(input: Answers, s: Secrets, emit: Emit, hooks: Hooks = {}, opts: ApplyOptions = {}): Promise<boolean> {
  const started = new Date()
  let a = input
  let steps: Step[] = [{ id: 'check', title: 'Check the AWS account', detail: 'credentials, account and region', status: 'pending' }]
  let byId = new Map(steps.map((st) => [st.id, st]))
  const set = (id: string, status: Step['status'], detail?: string): void => {
    const st = byId.get(id)
    if (!st) return
    st.status = status
    if (detail) st.detail = detail
    emit({ type: 'step', step: { ...st } })
  }
  const log = (id: string, line: string): void => emit({ type: 'log', step: id, line: redact(line, s) })
  const summary: string[] = []
  const cdk = hooks.cdk ?? ((args, env, onLine) => runStreaming(process.execPath, [cdkBin(), ...args], env, onLine))
  let current = 'check'
  let stack = stackName(a.agents.prefix)
  try {
    // 1 — the account, and everything the answers leave to be worked out (derive.ts)
    set('check', 'running')
    const creds = await credentials(a.aws, s)
    const facts = await (hooks.facts ?? ((c, x) => liveFacts(c, x, s.githubToken)))(creds, a)
    if (!a.github.login && !facts.login) facts.login = (await checkToken(s.githubToken)).login
    const resolved = resolveAnswers(a, facts)
    if (resolved.missing.length) throw new Error(resolved.missing.join('; '))
    a = resolved.answers
    for (const d of resolved.derived) log('check', `derived: ${d}`)
    const check = await checkAws(creds, a.aws.region, stack)
    if (check.account !== a.aws.account) throw new Error(`these credentials are for account ${check.account}, not the confirmed ${a.aws.account}`)
    if (!check.agentCore.ok) throw new Error(`Bedrock AgentCore is not available to these credentials in ${a.aws.region}: ${check.agentCore.reason}`)
    // GitHub's OIDC provider (one per account): the stack makes it when the account has none, and keeps it when an
    // earlier deploy made it (dropping it from the stack would delete it); one made elsewhere is used, not made
    const makeOidc = Boolean(check.oidcInStack) || !check.oidcProvider
    if (a.agents.createOidcProvider !== makeOidc) { log('check', makeOidc ? 'GitHub\'s OIDC provider: the stack makes (or keeps) it' : 'GitHub\'s OIDC provider exists in the account: the stack uses it'); a = { ...a, agents: { ...a.agents, createOidcProvider: makeOidc } } }
    // the whole plan, now that every answer is known
    const existing = check.existing ?? null
    steps = plan(a, existing, opts.prev ?? null)
    byId = new Map(steps.map((st) => [st.id, st]))
    for (const st of steps) emit({ type: 'step', step: { ...st } })
    set('check', 'running')
    const own = await checkProjectTokens(a, s)
    for (const w of own.warnings) { log('check', w); summary.push(w) }
    set('check', 'done', `${check.arn}`)
    let props = InfraPropsSchema.parse(infraInput(a, existing))
    stack = stackName(props.prefix)
    // a project added again while a removed copy's names are still taken: the next generation, saved at once (a deploy
    // that fails after creating a retained memory must not make the next run pick the same names)
    const names = hooks.names ?? (() => {
      const index = nameIndex(nameClients(creds, a.aws.region))
      return { deployed: () => deployedProjects(cfnClient(creds, a.aws.region), stack), taken: index.taken }
    })()
    const gens = await chooseGenerations(a, props, await names.deployed(), names.taken)
    // saved for the next run: what was decided from the preflight stays to be decided again (a quota raised since turns
    // GPU jobs on), and once onboarding is done a created repository is an existing one
    const remember = (x: Answers, onboarded = false): void => saveAnswers({ answers: {
      ...x, agents: { ...x.agents, gpuEnabled: input.agents.gpuEnabled, cpuEnabled: input.agents.cpuEnabled, knowledgeBase: input.agents.knowledgeBase },
      ...(onboarded ? { projects: x.projects.map((p) => ({ ...p, create: null })) } : {}),
    } })
    if (gens.changed.length) {
      a = gens.answers
      remember(a)
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
    const envFor = (d: LayoutDeploy): Record<string, string> => ({
      ...awsEnv(creds, a.aws.region), TRACE_INFRA: JSON.stringify(infraInput(a, existing, d)), CDK_DISABLE_VERSION_CHECK: '1', CI: '1',
    })
    const env = envFor(deploys.at(-1) ?? { layout: 'nested', why: '' })

    // 2 — CDK bootstrap (nested stacks' templates are file assets in its bucket, like the agent source); again when it
    // is older than the deploy needs
    current = 'cdk'
    const bootstrapOk = check.cdkBootstrapped && (check.cdkVersion === undefined || check.cdkVersion === null || check.cdkVersion >= CDK_BOOTSTRAP_MIN)
    if (bootstrapOk) set('cdk', 'skipped', 'already bootstrapped')
    else {
      set('cdk', 'running', check.cdkBootstrapped ? `updating the bootstrap from version ${check.cdkVersion}` : undefined)
      const code = await cdk(['bootstrap', `aws://${a.aws.account}/${a.aws.region}`, '--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`], env, (l) => log('cdk', l))
      if (code !== 0) throw new Error(`cdk bootstrap exited ${code}`)
      set('cdk', 'done')
    }

    // 3 — deploy (one deploy, or the three of the move to nested stacks, in order)
    current = 'deploy'
    set('deploy', 'running', existing ? 'updating the stack: only what changed' : `the first deploy ${props.images.source === 'prebuilt' ? 'copies the agent image (or builds it when this version has none published): 15–40 minutes' : 'builds the agent image: expect 20–40 minutes'}`)
    for (const [i, d] of deploys.entries()) {
      if (deploys.length > 1) log('deploy', `deploy ${i + 1} of ${deploys.length}: ${d.why}`)
      // the drain deleted every project's secret; one still in its recovery window would block the nested stack's
      if (deploys.length > 1 && d.layout === 'nested') {
        const lines = await (hooks.freeSecrets ?? freeSecretNames)(creds, a.aws.region, a.projects.map((p) => githubSecretName(props.prefix, p.repo, p.generation)))
        for (const l of lines) log('deploy', l)
      }
      const code = await cdk(['deploy', stack, '--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`, '--require-approval', 'never', '--progress', 'events', '--concurrency', '10'], envFor(d), (l) => log('deploy', l))
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

    // 4 — the tokens
    current = 'token'
    set('token', 'running')
    const sm = new SecretsManagerClient({ region: a.aws.region, credentials: creds })
    await sm.send(new PutSecretValueCommand({ SecretId: need('GithubSecretArn'), SecretString: s.githubToken }))
    log('token', 'the API\'s (shared) token stored')
    await mapLimit(a.projects, 6, async (p) => {
      // its Project<hash>GithubSecretArn output (the parent's when flat, its nested stack's when nested), else by name
      const secretId = out[projectOutputs(p.repo).secretArn] || githubSecretName(props.prefix, p.repo, p.generation)
      await sm.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: projectToken(s, p.repo) }))
      log('token', `${p.repo}: ${s.projectTokens[p.repo.toLowerCase()] ? 'its own token' : 'the shared token'} stored in its secret`)
    })
    const sharing = sharedTokenWarning(a, s)
    if (sharing) summary.push(sharing)
    set('token', 'done')

    // 5 — the optional integrations: each given one checked (never blocking) and stored as <prefix>/integrations/<name>
    current = 'integrations'
    const given = givenIntegrations(s)
    for (const w of given.incomplete) { log('integrations', w); summary.push(w) }
    const names_ = Object.keys(given.complete) as IntegrationName[]
    if (!names_.length) set('integrations', 'skipped', 'none given: add one any time with `trace integrations set <name>`; the parts tools ask LCSC (no key) meanwhile')
    else {
      set('integrations', 'running')
      const store = hooks.integrations ?? new IntegrationStore(props.prefix, await secretsManagerApi({ region: a.aws.region, credentials: creds }))
      const checkKey = hooks.checkIntegration ?? checkIntegration
      await Promise.all(names_.map(async (n) => {
        const values = given.complete[n] ?? {}
        const c = await checkKey(n, values)
        log('integrations', `${INTEGRATIONS[n].title}: ${c.detail}`)
        if (!c.ok) summary.push(`${INTEGRATIONS[n].title}: ${c.detail}. It is stored anyway; replace it with \`trace integrations set ${n}\`.`)
        log('integrations', `${n}: stored in ${await store.set(n, values)}`)
      }))
      set('integrations', 'done', names_.map((n) => INTEGRATIONS[n].title).join(', '))
    }

    // 6 — repositories (several at once)
    current = 'repos'
    const adminToken = s.githubAdminToken || s.githubToken
    const agentLogin = (await checkToken(s.githubToken)).login
    const adminLogin = adminToken === s.githubToken ? agentLogin : (await checkToken(adminToken)).login
    if (!a.projects.length) set('repos', 'skipped', 'no repositories yet')
    else {
      set('repos', 'running')
      if (adminLogin.toLowerCase() === agentLogin.toLowerCase()) {
        summary.push(`The agents' token belongs to ${agentLogin}, so /approve from ${agentLogin} is refused on deploys (an agent must never approve its own). Give the agents a machine account's token, or approve from another account.`)
      }
      await mapLimit(a.projects, 4, async (p) => {
        const o = projectOutputs(p.repo)
        const login = own.logins.get(p.repo.toLowerCase()) ?? agentLogin
        if (login.toLowerCase() === adminLogin.toLowerCase() && login !== agentLogin) {
          summary.push(`${p.repo}'s own token belongs to ${login}, so /approve from ${login} is refused on its deploys.`)
        }
        if (p.create) await (hooks.createRepo ?? createRepo)(adminToken, p.repo, { private: p.create.private })
        const vars: Record<string, string> = {
          // this project's own role and runtime: neither reaches any other project
          TRACE_AWS_ROLE: need(o.roleArn), TRACE_AWS_REGION: a.aws.region, TRACE_HOME: need('TraceHome'), TRACE_AGENT_RUNTIME_ARN: need(o.runtimeArn),
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
      })
      set('repos', 'done')
    }

    // 7 — CI on AWS: a CodeBuild-hosted runner per repository (src/installer/runners.ts). Never fatal: a repository
    // whose runner can't be made keeps GitHub's runners (its TRACE_CODEBUILD_PROJECT is removed, so no job waits)
    current = 'runners'
    const runnerFor = runnerRepos(a.projects.map((p) => p.repo), props.runners.extraRepos)
    const rh = hooks.runners ?? liveRunners(codebuildClient(creds, a.aws.region))
    let runnerCredential: 'imported' | 'refreshed' | 'existing' | null = null
    if (!props.runners.enabled) {
      for (const name of await rh.list(props.prefix)) { await rh.remove(name); log('runners', `removed ${name}`) }
      await mapLimit(runnerFor, 4, async (r) => { if (await deleteVariable(adminToken, r, RUNNER_VARIABLE).catch(() => false)) log('runners', `${r}: ${RUNNER_VARIABLE} removed`) })
      set('runners', 'skipped', 'off: the trace workflows run on GitHub\'s runners')
    } else if (!runnerFor.length) set('runners', 'skipped', 'no repositories yet')
    else {
      set('runners', 'running')
      const roleArn = need(RUNNER_ROLE_OUTPUT)
      const ours = (opts.prev as (Answers & { runnerCredential?: string }) | null | undefined)?.runnerCredential === 'imported' || savedRunnerCredential() === 'imported'
      const cred = await rh.credential(a.agents.runnerToken === 'admin' ? adminToken : s.githubToken, ours)
      runnerCredential = cred.state === 'existing' ? 'existing' : 'imported'
      log('runners', cred.detail)
      const made: string[] = []
      const failed: string[] = []
      await mapLimit(runnerFor, 4, async (r) => {
        try {
          const name = await rh.ensure({ prefix: props.prefix, repo: r, roleArn, computeType: props.runners.computeType })
          await setVariable(adminToken, r, RUNNER_VARIABLE, name)
          made.push(r)
          log('runners', `${r}: jobs run on ${name} (runs-on codebuild-${name}-<run id>-<attempt>)`)
        } catch (e) {
          failed.push(r)
          const why = redact(e instanceof Error ? e.message : String(e), s)
          log('runners', `${r}: no runner: ${why}`)
          summary.push(`${r}'s CI stays on GitHub's runners: ${why}`)
          await deleteVariable(adminToken, r, RUNNER_VARIABLE).catch(() => false)
        }
      })
      // runners of repositories no longer here
      const want = new Set(runnerFor.map((r) => runnerProjectName(props.prefix, projectHash(r))))
      for (const name of await rh.list(props.prefix)) if (!want.has(name)) { await rh.remove(name); log('runners', `removed ${name} (its repository is no longer here)`) }
      set('runners', failed.length && !made.length ? 'failed' : 'done', `${made.length} on CodeBuild${failed.length ? `, ${failed.length} kept on GitHub's runners (${failed.join(', ')})` : ''}`)
    }

    // 8 — onboarding PRs and new repositories (REST and git with the admin token; several at once)
    current = 'onboard'
    const toOnboard = a.projects.filter((p) => p.onboard || p.create)
    if (!toOnboard.length) set('onboard', 'skipped')
    else {
      set('onboard', 'running')
      const onboardOne = hooks.onboard ?? ((repo: string, o: Omit<ApiOnboardOptions, 'token' | 'login'>) => onboardViaApi(repo, { ...o, token: adminToken, login: adminLogin }))
      await mapLimit(toOnboard, 3, async (p) => {
        const r = await onboardOne(p.repo, { apply: p.applySettings, create: p.create, ...(a.escalateTo ? { escalateTo: a.escalateTo } : {}) })
        log('onboard', `${p.repo}: ${r.state}${r.pr ? ` ${r.pr}` : ''}${r.settings.length ? ` (${r.settings.join('; ')})` : ''}`)
        if (r.pr && r.state !== 'refreshed') summary.push(`Merge the onboarding PR: ${r.pr}`)
        if (r.pr && r.state === 'refreshed') summary.push(`Merge the workflow refresh: ${r.pr}`)
        if (r.state === 'created') summary.push(`Created ${p.repo} under trace.`)
      })
      set('onboard', 'done')
    }

    // 9 — people and their projects (central database on S3: credentials in this process's environment for the
    // duration). Cognito for everyone at once; the access store, which is one file, one write after another.
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
      const subs = await mapLimit(a.people, 5, async (p) => {
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
        return sub
      })
      for (const [i, p] of a.people.entries()) {
        const sub = subs[i] ?? ''
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
    if (!existing) summary.push(`${a.adminEmail} receives a temporary password from Cognito; sign in with \`trace login\`.`)
    set('people', 'done')

    // 10 — this machine
    current = 'local'
    saveInstallation({
      name: 'default', region: a.aws.region, account: a.aws.account, stack, traceHome: need('TraceHome'),
      userPoolId: need('UserPoolId'), clientId: need('UserPoolClientId'), cognitoDomain: need('CognitoDomain'),
      // each project has its own worker runtime and role (its repository's variables): none is the installation's
      apiRuntimeArn: need('ApiRuntimeArn'), workerRuntimeArn: '', actionsRoleArn: '',
      githubSecretArn: need('GithubSecretArn'), memoryIds, callbackPorts: props.callbackPorts,
    })
    remember(a, true)
    saveAnswers({ traceVersion: (await import('./lifecycle.js')).traceVersion(), ...(runnerCredential ? { runnerCredential } : {}) })
    set('local', 'done')
    summary.unshift(`trace is installed in ${a.aws.account} (${a.aws.region}) as ${stack}.`)
    if (!a.projects.length) summary.push('No repositories yet: run `trace install` again and pick some (or create one).')
    else summary.push('Write each project\'s rules in .trace/rules.md (they start empty).')
    if (!names_.length) summary.push('Optional: add a Nexar, Mouser or Digi-Key key for live stock and prices: `trace integrations set nexar` (see `trace integrations list`).')

    // 11 — the GPU image: the deploy started its build and did not wait (src/infra/gpu.ts). trace is usable now; the
    // page says so, and the wait goes on underneath
    current = 'gpu'
    if (!props.gpu.enabled) {
      set('gpu', 'skipped')
      emit({ type: 'done', ok: true, summary })
      return true
    }
    emit({ type: 'ready', summary: [...summary, 'The GPU image is still being made: GPU and CPU jobs wait for it, nothing else does.'] })
    set('gpu', 'running')
    const imageTag = (out.GpuImageUri ?? '').split(':').at(-1) ?? ''
    const wait = hooks.gpuImage ?? ((o) => ensureGpuImage(codebuildClient(creds, a.aws.region), o))
    const r = await wait({ buildId: out[GPU_IMAGE_BUILD_OUTPUT] ?? '', imageTag, startedAfter: started, log: (l) => log('gpu', l) })
    if (r.ok) set('gpu', 'done', r.detail)
    else {
      set('gpu', 'failed', r.detail)
      summary.push(`GPU and CPU jobs cannot run until the GPU image is built: ${r.detail}. Everything else is installed; fix the cause and run the installer again to build it.`)
    }
    emit({ type: 'done', ok: true, summary })
    return true
  } catch (e) {
    const m = redact(e instanceof Error ? e.message : String(e), s)
    set(current, 'failed', m)
    emit({ type: 'done', ok: false, summary: [`Stopped at "${byId.get(current)?.title ?? current}": ${m}`, 'Fix the cause and run the installer again: every step is safe to repeat.'] })
    return false
  }
}

/** The repository variable naming a repository's CodeBuild runner project (src/core/onboard.ts RUNS_ON reads it). */
export const RUNNER_VARIABLE = 'TRACE_CODEBUILD_PROJECT'

/** Whether trace imported CodeBuild's GitHub credential on an earlier run (so it may refresh it). */
function savedRunnerCredential(): string | null {
  try { const v = savedAnswers().runnerCredential; return typeof v === 'string' ? v : null } catch { return null }
}

/** The runner calls, live. */
export function liveRunners(cb: Parameters<typeof ensureRunner>[0]): NonNullable<Hooks['runners']> {
  return {
    credential: (token, ours) => ensureSourceCredential(cb, token, ours),
    ensure: (spec) => ensureRunner(cb, spec),
    list: (prefix) => runnerProjects(cb, prefix),
    remove: (name) => removeRunner(cb, name),
  }
}
