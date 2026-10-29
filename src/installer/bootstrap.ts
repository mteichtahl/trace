/**
 * Installing trace into an AWS account, step by step. Every step is safe to run again: a second installation
 * updates what the first made.
 *
 *   1 check      the credentials still resolve to the confirmed account
 *   2 cdk        bootstrap CDK in the account/region if it isn't
 *   3 github     how the CodeBuild runners reach GitHub (every GitHub Actions job runs on AWS CodeBuild, never on a
 *                GitHub-hosted runner; README "Where builds run"), from answers runners.auth (chooseRunnerAuth): an
 *                AWS CodeConnections connection already authorized in the account and region (the answers', the one
 *                the stack created or was given before, or one reused), else, by default, the GitHub token imported
 *                as CodeBuild's GitHub source credential (an account's existing one is left alone), so the first
 *                deploy has the runners and nobody opens the console. With runners.auth 'connection' and none
 *                authorized, the stack creates `<prefix>-github` and the runners wait for steps 5 and 6. Also the
 *                new repositories the answers ask for, which their runners' webhooks need
 *   4 deploy     `cdk deploy` the trace stack (the agent image builds in CodeBuild: the first deploy takes a while), in
 *                the layout the installation has (a new one: nested; an earlier one: flat), or, when asked to move a
 *                flat one to nested, three deploys in a row (release, drain, nested: see layoutDeploys). Before it, a
 *                project the stack does not have yet whose fixed names are taken in the account (a removed copy's
 *                retained memory, delivery sources or destinations, or secret in its recovery window) gets the next
 *                generation of names, saved with the answers (chooseGenerations)
 *   5 connection only for a connection that was not authorized: read it from the stack's output and wait, with the
 *                console link and the time of the next check, until a person authorizes it once (it installs the AWS
 *                Connector for GitHub app). A timeout does not stop the installation: everything else is set up, the
 *                workflows run on GitHub's runners meanwhile, and running the installer again resumes with the same
 *                connection
 *   6 runners    then deploy again with the runners: that only adds each repository's runner project and its webhook
 *   7 token      write the GitHub tokens into Secrets Manager: the shared one (the API's), and each project's own
 *                (its own token when one was given, else a copy of the shared one)
 *   8 integrations  the optional integrations given, each checked and stored as <prefix>/integrations/<name>
 *   9 repos      each repository's Actions variables (its own role, runtime, memory and CodeBuild runner project, from
 *                its project's outputs, which are its nested stack's in the nested layout; region, TRACE_HOME) and its
 *                TRACE_TOKEN secret; each build-only repository's (trace's own, by default) TRACE_CODEBUILD_PROJECT
 *                alone. TRACE_CODEBUILD_PROJECT is set only where the runner project exists, and removed where it does
 *                not: the workflows run on AWS when it is set and on GitHub's runners when it is not
 *  10 onboard    the onboarding PR in each repository that asked for it, and its repository settings
 *  11 people     invite each person to Cognito, put them in their class's group (admin, user, guest), and record
 *                the projects they are assigned to
 *  12 local      save the installation on this machine so `tracectl login` and `tracectl remote …` work
 *  13 release    (agents.publishImages: by default, when the token administers trace's source repository) set this
 *                account up to publish trace's images and start the first release (src/installer/release.ts); a
 *                failure is reported, and everything else stays installed
 *  14 gpu        wait for the GPU image build the deploy started (the stack does not wait for it, so a broken GPU
 *                image never rolls back the core) and start it again if an earlier one failed; a failure here is
 *                reported, and everything else stays installed. The wait is a timer (every 30 s: AWS cannot send
 *                this computer the build's events), and each check is streamed to the page as a `wait` event: what
 *                is awaited, when it was checked, when it is next, and the id the page's Check now button sends
 *
 *  15 tour       (only with the sample project and its tour; src/installer/sample.ts) one issue per task of the
 *                sample's tour, each labelled for the agent that takes it, so every agent and every simulation runs
 *                once; the GPU and CPU tasks only when the GPU image is there. The sample itself is a new repository
 *                like any other (ProjectAnswer.create, template 'sample'): created in step 3, filled, put under trace
 *                and its project database seeded in step 10
 *
 * After the deploy succeeds (4: after the last of its deploys) and after the runners' deploy (6), the stack settings it
 * deployed with are saved in the central bucket at installation/props.json (src/installer/record.ts: no secret is in
 * them), with how the runners reach GitHub (runners.auth), trace's own repository and its default branch: what the
 * self-update job of trace's own ci workflow deploys with (src/installer/update.ts, README "Staying up to date"). When
 * that is on (runners.selfUpdate, while trace's own repository is built on AWS), step 9 also sets that repository's
 * TRACE_UPDATE_ROLE, TRACE_AWS_REGION and TRACE_STACK, and removes TRACE_UPDATE_ROLE where it is off.
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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { AwsCredentialIdentity } from '@smithy/types'
import { type Principal, GROUPS, assign, assignments, setClass, unassign } from '../core/access.js'
import { answers as savedAnswers, saveAnswers, saveInstallation } from '../core/client.js'
import { INTEGRATIONS, INTEGRATION_NAMES, type IntegrationName, IntegrationStore, checkIntegration, secretsManagerApi } from '../core/integrations.js'
import { SOURCE, register } from '../core/onboard.js'
import { RUNNER_VARIABLE, runnerOf } from '../core/project.js'
import { type WaitNotice, describeWait } from '../core/wait.js'
import { RELEASE_REGION, RELEASE_REPOSITORIES, RELEASE_STACK } from '../infra/release.js'
import {
  CENTRAL_BUCKET_OUTPUT, CONNECTION_OUTPUT, GPU_IMAGE_BUILD_OUTPUT, INSTALLATION_RECORD_KEY, SELF_UPDATE_OUTPUT, ciRunnerOutput, type InfraInput, type InfraProps, InfraPropsSchema, LAYOUT_OUTPUT, LEGACY_MEMORY_OUTPUT, cpuEnabled, githubSecretName,
  kbOutputs, memoryDeliveryName, memoryName, projectHash, projectOutputs, selfUpdateRoleName, stackName, WEB_OUTPUTS, EXTERNAL_OUTPUTS,
} from '../infra/props.js'
import { REPO_ROOT } from '../infra/stack.js'
import { type Answers, AnswersSchema, type InstallEvent, type Secrets, type Step } from './answers.js'
import {
  type ConnectionChoice, type ConnectionWait, type ProjectNames, type SourceCredential, awsEnv, cfnClient, checkAws, chooseRunnerAuth, codebuildClient, connectionName,
  connectionsClient, connectionsConsoleUrl, connectorAccessNote, webhookRefusedNote, credentials, deployedProjects, ensureGpuImage, ensureSourceCredential, freeSecretNames, liveFacts,
  nameClients, nameIndex, resolveConnection, stackOutputs, waitForConnection,
} from './aws.js'
import { type Facts, resolveAnswers } from './derive.js'
import { type TokenInfo, canConfigure, checkToken, createRepo, deleteVariable, repoExists, repositoryDefaultBranch, setSecret, setVariable } from './github.js'
import { type TourResult, recreateMissingSample, startSampleJourney, startTour, tourPlan, withSample } from './sample.js'
import { EDGE_REGION, edgeStackName } from '../infra/edge.js'
import { type EdgeDeps, deployEdge, edgeLeftOver, wafPlan, withAcl } from './edge.js'
import { type PendingEntry, type PendingIo, absorb, parsePending, s3PendingIo } from './pending.js'
import { type ApiOnboardOptions, type ApiOnboardResult, onboardViaApi } from './onboard-api.js'
import { CDK_BOOTSTRAP_MIN, mapLimit } from './preflight.js'
import { checkNoSecrets, installationRecord } from './record.js'
import { type ReleaseResult, liveReleaseDeps, releaseSetup } from './release.js'
import { traceRepository } from './source.js'

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

/** How the runners reach GitHub, as apply decided it before the deploy (chooseRunnerAuth): the token (CodeBuild's
 * source credential), or the connection to pass (unset: the stack uses or creates its own) and whether it is
 * authorized. */
export type RunnersChoice = { auth: 'token' } | { auth?: 'connection'; connectionArn?: string | undefined; connectionReady: boolean }
/** The repository whose release workflow publishes trace's images: trace's own as the installer found it, else the
 * source onboarding uses. */
export function releaseRepository(a: Answers): string {
  return a.runners.traceRepository || SOURCE
}

/** What the installer tells the person while a repository has no AWS build runner yet. */
export const GITHUB_RUNNERS_NOTE = 'Until the build runners are added, workflows run on GitHub\'s runners.'

/** trace's own repository, when it is built on AWS too: runners.buildTrace, the repository the installer found (and the
 * token can configure), and not one of the projects (a project has its own runner already). */
export function selfBuild(a: Answers): string | null {
  const r = a.runners.traceRepository
  if (!a.runners.buildTrace || !r) return null
  return a.projects.some((p) => p.repo.toLowerCase() === r.toLowerCase()) ? null : r
}

/** The build-only repositories (props.ts ciRepositories): trace's own when it is built on AWS too, then the others the
 * answers add; none of them a project, none twice. */
export function buildRepositories(a: Answers): string[] {
  const projects = new Set(a.projects.map((p) => p.repo.toLowerCase()))
  const out: string[] = []
  for (const r of [selfBuild(a), ...a.runners.ciRepositories]) {
    if (r && !projects.has(r.toLowerCase()) && !out.some((x) => x.toLowerCase() === r.toLowerCase())) out.push(r)
  }
  return out
}

/** How the installer finds trace's own repository and whether it may build it (tests replace both). */
export interface SelfRepositoryDeps {
  /** the GitHub repository the running trace came from (src/installer/source.ts traceRepository) */
  source: () => string | null
  /** whether the token can set that repository's Actions variables (src/installer/github.ts canConfigure) */
  canConfigure: (token: string, repo: string) => Promise<{ ok: boolean; reason: string }>
  /** its default branch (src/installer/github.ts repositoryDefaultBranch); absent or failing: main */
  branch?: (token: string, repo: string) => Promise<string>
}

/** The repository variables the self-update job reads (.github/workflows/ci.yml update-installation). */
export const UPDATE_ROLE_VARIABLE = 'TRACE_UPDATE_ROLE'
export const UPDATE_STACK_VARIABLE = 'TRACE_STACK'

/** Keeping the installation up to date (README "Staying up to date"): trace's own repository and the branch whose ci
 * workflow may deploy it again, when trace's own repository is built on AWS (selfBuild) and runners.selfUpdate is on;
 * null otherwise. */
export function selfUpdateOf(a: Answers): { repository: string; branch: string } | null {
  const r = selfBuild(a)
  return r && a.runners.selfUpdate ? { repository: r, branch: a.runners.traceBranch || 'main' } : null
}

/**
 * Before deploying: trace's own repository for the answers (runners.traceRepository), when it is to be built on AWS
 * (runners.buildTrace) and the token can configure it; '' otherwise. Returns the answers and what to tell the person.
 */
export async function resolveSelfBuild(a: Answers, token: string, d: SelfRepositoryDeps): Promise<{ answers: Answers; note: string | null }> {
  const set = (traceRepository: string, traceBranch = ''): Answers => ({ ...a, runners: { ...a.runners, traceRepository, traceBranch } })
  if (!a.runners.buildTrace) return { answers: set(''), note: null }
  const repo = d.source()
  if (!repo) return { answers: set(''), note: 'trace\'s own repository is not built on AWS: the installer could not tell which GitHub repository this trace was installed from.' }
  if (a.projects.some((p) => p.repo.toLowerCase() === repo.toLowerCase())) return { answers: set(''), note: `trace's own repository (${repo}) is one of the projects: it builds on its own runner.` }
  const access = await d.canConfigure(token, repo)
  if (!access.ok) return { answers: set(''), note: `trace's own repository (${repo}) stays on GitHub's runners: the token cannot set its variables (${access.reason}).` }
  let branch = 'main'
  try { if (d.branch) branch = await d.branch(token, repo) || 'main' } catch { /* main */ }
  return { answers: set(repo, branch), note: `Building trace's own repository (${repo}) on AWS too: a build runner for it alone.` }
}

/** The stack's settings from the answers (and, for the legacy memory's way out and the layout, what is deployed already).
 * `runners`: what apply chose; without it (the plan), the answers' connection, if any, and the stack's default. */
export function infraInput(a: Answers, existing?: Existing | null, deploy?: LayoutDeploy, runners?: RunnersChoice): InfraInput {
  const own = a.projects.filter((p) => p.memoryEventExpiryDays !== null || p.generation > 0)
  const d: LayoutDeploy = deploy ?? layoutDeploys(a, existing).at(-1) ?? { layout: 'nested', why: '' }
  return {
    prefix: a.agents.prefix,
    layout: d.layout,
    ...(d.layoutMigration ? { layoutMigration: d.layoutMigration } : {}),
    account: a.aws.account,
    region: a.aws.region,
    repositories: a.projects.map((p) => `${p.repo}@${p.branch}`),
    ...(buildRepositories(a).length ? { ciRepositories: buildRepositories(a) } : {}),
    ...(selfUpdateOf(a) ? { selfUpdate: selfUpdateOf(a) ?? undefined } : {}),
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
    external: { enabled: a.agents.externalAccess },
    images: { source: a.agents.imageSource, ...(a.agents.imageSource === 'prebuilt' && a.agents.imageRegistry ? { registry: a.agents.imageRegistry } : {}) },
    runners: {
      ...(runners
        ? (runners.auth === 'token' ? { auth: 'token' as const } : { ...(runners.connectionArn ? { connectionArn: runners.connectionArn } : {}), connectionReady: runners.connectionReady })
        : (a.runners.auth === 'token' ? { auth: 'token' as const } : a.runners.connectionArn ? { connectionArn: a.runners.connectionArn } : {})),
      ...(a.runners.computeType !== null ? { computeType: a.runners.computeType } : {}),
      ...(a.runners.privileged !== null ? { privileged: a.runners.privileged } : {}),
      // trace's own repository builds its images on its runner when this installation publishes them
      ...(a.agents.publishImages ? { ciPrivileged: true } : {}),
    },
    web: {
      enabled: a.agents.webEnabled,
      ...(a.agents.webDomain && a.agents.webCertificateArn ? { domainName: a.agents.webDomain, certificateArn: a.agents.webCertificateArn } : {}),
      ...(a.agents.webEmailFrom ? { sesFrom: a.agents.webEmailFrom } : {}),
      waf: { enabled: a.agents.webWaf },
    },
    observability: {
      enabled: a.agents.observability, transactionSearch: a.agents.transactionSearch, dashboard: a.agents.dashboard,
      ...(a.agents.samplingPercent !== null ? { samplingPercent: a.agents.samplingPercent } : {}),
    },
    cost: { explorer: { enabled: a.agents.costExplorer, activateTags: a.agents.costActivateTags }, ...(a.agents.costPrices ? { prices: a.agents.costPrices } : {}) },
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

/** The web app part of the deploy step's description. */
export function webPlan(props: InfraProps): string {
  if (!props.web.enabled) return '; no web app (sign in with `tracectl login` only)'
  const where = props.web.domainName ? `https://${props.web.domainName} (point its DNS at the distribution after the deploy)` : 'CloudFront\'s own address'
  return `; the web app at ${where}: the static app on S3 behind CloudFront, its backend Lambda, live updates (AppSync Events), and sign-in with passkeys and passwords${props.web.sesFrom ? ` or a code by email (from ${props.web.sesFrom}, through SES)` : ''}${wafPlan(props)}`
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

/** The build runners' part of the deploy step's description. */
function runnersPlan(a: Answers, props: InfraProps): string {
  const name = connectionName(a.agents.prefix)
  const how = a.runners.connectionArn
    ? `through the GitHub connection ${a.runners.connectionArn}`
    : a.runners.auth === 'token'
      ? 'with the GitHub token, imported as CodeBuild\'s GitHub source credential (no console step)'
      : a.runners.auth === 'connection'
        ? `through a GitHub connection already authorized in the account and region (${name} first), else a new ${name} it creates, authorized once in the console`
        : `through a GitHub connection already authorized in the account and region (${name} first), else with the GitHub token, imported as CodeBuild's GitHub source credential (no console step)`
  return `, and its own AWS CodeBuild runner project that runs every one of its GitHub Actions jobs (${props.runners.computeType}${props.runners.privileged ? ', Docker-in-Docker' : ''}; its jobs run on GitHub's own runners until it exists), reaching GitHub ${how}`
}

/** The github step's description. */
/** The sample project's repository when it is being installed and its name is known. */
function sampleRepoOf(a: Answers): string | null {
  return a.projects.find((p) => p.create?.template === 'sample')?.repo
    ?? (a.sample.enabled && a.sample.repo ? a.sample.repo : null)
}

function githubPlan(a: Answers): string {
  const created = a.projects.filter((p) => p.create).map((p) => p.repo)
  const how = a.runners.auth === 'connection' || a.runners.connectionArn
    ? `use ${a.runners.connectionArn ? `the GitHub connection ${a.runners.connectionArn}` : `a GitHub connection already authorized in the account and region, else let the stack create ${connectionName(a.agents.prefix)}`}`
    : `${a.runners.auth === 'auto' ? 'use a GitHub connection already authorized in the account and region when there is one; else ' : ''}import the ${a.runners.token === 'admin' ? 'admin' : 'agents\''} token as CodeBuild's GitHub source credential (it needs Administration and Webhooks on each repository), unless the account has one already`
  return `how the build runners reach GitHub: ${how}${created.length ? `; create ${created.join(', ')} first, as its runner needs the repository` : ''}`
}

/** The connection step's description. */
function connectionPlan(a: Answers): string {
  const repos = [...a.projects.map((p) => p.repo), ...buildRepositories(a)].join(', ')
  // the default path: a connection authorized already, else the token; nothing for a person to authorize
  if (a.runners.auth === 'token') return 'nothing to authorize: the build runners reach GitHub with the token'
  if (a.runners.auth === 'auto' && !a.runners.connectionArn) return 'nothing to authorize: the build runners use a GitHub connection only when one is authorized already, and the token otherwise'
  return `only if the build runners use a GitHub connection that is not authorized yet (a new one never is): it is authorized once per AWS account and region, by a person, in the AWS console (${connectionsConsoleUrl(a.aws.region)}, choose it, then "Update pending connection"), which installs the AWS Connector for GitHub app. After the deploy the installer shows the link and waits, checking every 15 seconds, for up to 30 minutes; the workflows run on GitHub's runners meanwhile. Give that app access to ${repos || 'the repositories'}`
}

/** The build-only repositories, as the plan says them. */
function buildPlan(a: Answers): string {
  const self = selfBuild(a)
  const others = buildRepositories(a).filter((r) => r !== self)
  return `${self ? ` Build trace's own repository on AWS too (${self}): a build runner for it alone, nothing else.` : ''}${others.length ? ` Build ${others.join(', ')} on AWS too, without agents: a build runner each, nothing else.` : ''}`
}

/** Keeping the installation up to date, as the plan says it. */
export function selfUpdatePlan(a: Answers): string {
  const u = selfUpdateOf(a)
  if (!u) return ''
  return ` Keep this installation up to date: when ${u.repository}'s ${u.branch} branch changes and its tests pass, its ci workflow deploys this stack again with the settings this installer saves in the central bucket (installation/props.json, no tokens in it). It uses the role ${selfUpdateRoleName(a.agents.prefix)}, which only that workflow on ${u.branch} can use, so whoever can merge to ${u.branch} there can change this installation.`
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
  const a = flat({ ...prev.agents, runners: prev.runners, adminEmail: prev.adminEmail, escalateTo: prev.escalateTo })
  const b = flat({ ...next.agents, runners: next.runners, adminEmail: next.adminEmail, escalateTo: next.escalateTo })
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
export function plan(input: Answers, existing?: Existing | null, prev?: Answers | null): Step[] {
  // the sample project is one more new repository, once its name is known (its owner may be the login still to derive)
  const a = input.sample.enabled && (input.sample.repo || input.github.login) ? withSample(input) : input
  const props = InfraPropsSchema.parse(infraInput(a, existing))
  const stack = stackName(props.prefix)
  const onboarding = a.projects.filter((p) => p.onboard && !p.create).map((p) => p.repo)
  const creating = a.projects.filter((p) => p.create).map((p) => `${p.repo} (${p.create?.template})`)
  const changes = existing ? changesSince(prev ?? null, a) : []
  const deployWhat = `central bucket, agent image (${props.images.source === 'prebuilt' ? 'trace\'s published image for this version when there is one, else built' : 'built'} by CodeBuild, arm64), for each of the ${props.repositories.length} repositories its own AgentCore worker runtime, execution role, GitHub OIDC role and token secret${props.gpu.enabled ? ' and job definitions' : ''}, the API runtime and Cognito${props.gpu.enabled ? `, GPU jobs on AWS Batch (${props.gpu.instanceTypes.join('/')}, up to ${props.gpu.maxVcpus} vCPUs${props.gpu.spot ? ', Spot' : ''}, image made without holding up the deploy; one queue for every project)${cpuPlan(props)}` : ', no GPU or CPU jobs'}${props.gateway.enabled ? ', the library gateway (AgentCore Gateway and a Lambda for the shared datasheets and parts tools)' : ''}${props.external.enabled ? ', external access (an API and an MCP endpoint for connected systems, each its own AgentCore runtime, and their scopes in Cognito)' : ''}${kbPlan(props)}${webPlan(props)}${observabilityPlan(props.observability, props.prefix)}${memoryPlan(a, props, existing)}${runnersPlan(a, props)}${generationsPlan(a)}${layoutPlan(a, existing)}. A project added again after being removed gets new names if its old memory, log delivery or token secret still holds them: the old memory is kept and orphaned, and the new one starts empty`
  const steps: [string, string, string][] = [
    ['check', 'Check the AWS account', `${a.aws.account || 'the credentials\' account'} in ${a.aws.region || 'the profile\'s region'}`],
    ['cdk', 'Bootstrap CDK', `aws://${a.aws.account}/${a.aws.region} (only if it isn't already, or is older than version 6)`],
    ['github', 'Connect CodeBuild to GitHub', githubPlan(a)],
    ['deploy', existing ? `Update ${stack}` : `Deploy ${stack}`, existing ? `${changes.length ? `This run ${changes.join('; ')}. ` : 'No answer changed since the last run from here: CloudFormation leaves unchanged resources alone. '}${deployWhat}.${buildPlan(a)}${selfUpdatePlan(a)}` : `${deployWhat}.${buildPlan(a)}${selfUpdatePlan(a)}`],
    ['connection', 'Authorize the GitHub connection', connectionPlan(a)],
    ['runners', 'Add the build runners', `only if the GitHub connection was not authorized before the deploy: deploy ${stack} again once it is. That only adds each repository's CodeBuild runner project and its GitHub webhook; nothing else changes. ${GITHUB_RUNNERS_NOTE}`],
    ['token', 'Store the GitHub tokens', `the shared token in the API's secret, and each project's agent token in its own secret${props.gateway.enabled ? '; any distributor keys given in the library gateway\'s secret' : ''}`],
    ['integrations', 'Store the optional integrations', 'any integration keys given (Nexar, Mouser, Digi-Key), each checked with its service and stored as <prefix>/integrations/<name>; none is needed, and they can be added later with `tracectl integrations set <name>`'],
    ['repos', 'Configure the repositories', a.projects.length || buildRepositories(a).length
      ? `${a.projects.length ? `each repository's own TRACE_AWS_ROLE, TRACE_AGENT_RUNTIME_ARN, ${RUNNER_VARIABLE} (the CodeBuild runner project its workflows run on)${props.memory.enabled ? ', TRACE_MEMORY_ID' : ''}${props.knowledgeBase.enabled && props.layout === 'nested' ? ', TRACE_KB_ID and TRACE_KB_DATA_SOURCE_ID' : ''}, TRACE_AWS_REGION, TRACE_HOME, TRACE_AGENT_LOGIN and secret TRACE_TOKEN in ${a.projects.map((p) => p.repo).join(', ')}, several at once` : ''}${buildRepositories(a).length ? `${a.projects.length ? '; ' : ''}${RUNNER_VARIABLE} alone in ${buildRepositories(a).join(', ')}` : ''}${selfUpdateOf(a) ? `; ${UPDATE_ROLE_VARIABLE}, TRACE_AWS_REGION and ${UPDATE_STACK_VARIABLE} in ${selfUpdateOf(a)?.repository} (its ci workflow keeps this installation up to date)` : ''}. ${RUNNER_VARIABLE} is set only once the repository's runner exists, and removed where it does not, so its workflows run on GitHub's runners until then`
      : 'no repositories yet: run the installer again to add them'],
    ['onboard', 'Onboard the repositories', [onboarding.length ? `open (or refresh) the onboarding PR in ${onboarding.join(', ')}` : '', creating.length ? `create ${creating.join(', ')}` : ''].filter(Boolean).join('; ') || 'none chosen'],
    ['people', 'Invite people and assign projects', `${a.adminEmail || 'the token\'s email'} (admin)${a.people.length ? `, ${a.people.map((p) => `${p.email} (${p.class})`).join(', ')}` : ''}`],
    ...(props.web.enabled ? [['web', 'Web app: the address people sign in at', props.web.domainName
      ? `https://${props.web.domainName}, served by CloudFront once its DNS points there; passkeys belong to this address`
      : 'CloudFront\'s own address (https://<id>.cloudfront.net), shown when the deploy is done; passkeys belong to this address'] as [string, string, string]] : []),
    ['local', 'Save this installation locally', '~/.trace/client.db, so `tracectl login` works here'],
    ['release', 'Publish trace\'s images', a.agents.publishImages
      ? `set this account up to publish trace's images, all by API: CDK in ${RELEASE_REGION} if needed, the ${RELEASE_STACK} stack there (ECR Public ${Object.values(RELEASE_REPOSITORIES).join(' and ')}, and a release role for ${releaseRepository(a)}'s main and v* tags), the registry's default alias, ${releaseRepository(a)}'s TRACE_RELEASE_ROLE and TRACE_IMAGE_REGISTRY and its trace-images release (where every installation finds the images), then the first release run, on ${selfBuild(a) ? 'its own AWS build runner (Docker-in-Docker)' : 'GitHub\'s runners until it has an AWS one'}`
      : `off: by default only the installation whose token administers ${releaseRepository(a)} publishes (Advanced → "Publish trace's images")`],
    ['gpu', 'The GPU image', props.gpu.enabled
      ? 'after trace is ready: wait for the GPU image the deploy started (copied, or built on amd64: the first build takes 30–60 minutes) and start it again if an earlier one failed. GPU and CPU jobs need it, nothing else does: you can use trace meanwhile'
      : 'GPU jobs are off'],
    ...(sampleRepoOf(a) && a.sample.tour ? [['tour', 'Start the sample\'s tour', tourPlan(sampleRepoOf(a) ?? '', props.gpu.enabled)] as [string, string, string]] : []),
  ]
  return steps.map(([id, title, detail]) => ({ id, title, detail, status: 'pending' as const }))
}

type Emit = (e: InstallEvent) => void

/** `cdk deploy`'s arguments for the stack and app (the installer and the self-update job deploy alike). */
export const cdkDeployArgs = (stack: string, app: readonly string[]): string[] => ['deploy', stack, ...app, '--require-approval', 'never', '--progress', 'events', '--concurrency', '10']

export const cdkBin = (): string => createRequire(import.meta.url).resolve('aws-cdk/bin/cdk')

export function runStreaming(cmd: string, args: string[], env: Record<string, string>, onLine: (l: string) => void): Promise<number> {
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
  gpuImage?: (o: { buildId: string; imageTag: string; startedAfter: Date; log: (l: string) => void; report: (n: WaitNotice) => void }) => Promise<{ ok: boolean; detail: string }>
  /** the library keys stored now (readSecretJson) */
  readSecret?: (sm: SecretsManagerClient, arn: string) => Promise<Record<string, string>>
  /** what the answers leave to be derived (src/installer/aws.ts liveFacts) */
  facts?: (creds: AwsCredentialIdentity, a: Answers) => Promise<Facts>
  /** the optional integrations' store, and checking a key with its service */
  integrations?: Pick<IntegrationStore, 'set'>
  checkIntegration?: typeof checkIntegration
  /** the GitHub connection: which one the deploy uses and whether it is authorized (src/installer/aws.ts
   * resolveConnection), and the wait for a person to authorize it (waitForConnection) */
  connection?: {
    resolve: (o: { prefix: string; given?: string; deployed: Record<string, string> | null }) => Promise<ConnectionChoice>
    wait: (conn: { arn: string; name: string; status: string }, o: ConnectionWait) => Promise<void>
  }
  /** publishing trace's images (src/installer/release.ts releaseSetup), when agents.publishImages */
  release?: (o: { creds: AwsCredentialIdentity; account: string; repository: string; token: string; log: (l: string) => void }) => Promise<ReleaseResult>
  /** CodeBuild's GitHub source credential, for runners.auth token (src/installer/aws.ts ensureSourceCredential) */
  sourceCredential?: (token: string, ours: boolean) => Promise<SourceCredential>
  /** onboarding one repository (src/installer/onboard-api.ts onboardViaApi) */
  onboard?: (repo: string, o: Omit<ApiOnboardOptions, 'token' | 'login'>) => Promise<ApiOnboardResult>
  /** opening the sample project's tour (src/installer/sample.ts startTour) */
  tour?: (token: string, repo: string, o: { gpu: boolean }) => Promise<TourResult>
  /** creating a new project's repository before its variables are set */
  createRepo?: typeof createRepo
  /** whether the token sees a repository (github.ts repoExists): the sample, when it may have been deleted */
  repoExists?: typeof repoExists
  /** trace's own repository and whether the token can configure it (resolveSelfBuild) */
  self?: SelfRepositoryDeps
  /** save the installation record (src/installer/record.ts) in the central bucket (default: S3 PutObject) */
  saveRecord?: (creds: AwsCredentialIdentity, region: string, bucket: string, key: string, text: string) => Promise<void>
  /** the projects created in the web app that wait for a deploy (src/installer/pending.ts; default: S3) */
  pending?: PendingIo
  /** the sample's first journey state (src/installer/sample.ts startSampleJourney) */
  sampleJourney?: (home: string, repo: string, by: string) => Promise<'started' | 'exists'>
  /** the web app's WAF stack in us-east-1 (src/installer/edge.ts): a stack's outputs there, and deleting one left over */
  edge?: { outputs: EdgeDeps['outputs']; remove: (stack: string, region: string) => Promise<void> }
}

/** The edge stack's outputs and its removal, in us-east-1 (CloudFormation). */
export function liveEdgeIo(creds: AwsCredentialIdentity): NonNullable<Hooks['edge']> {
  const client = async (region: string) => { const cfn = await import('@aws-sdk/client-cloudformation'); return { cfn, c: new cfn.CloudFormationClient({ region, credentials: creds }) } }
  return {
    outputs: async (name, region) => {
      const { cfn, c } = await client(region)
      try {
        const st = (await c.send(new cfn.DescribeStacksCommand({ StackName: name }))).Stacks?.[0]
        if (!st || st.StackStatus === 'DELETE_COMPLETE') return null
        return Object.fromEntries((st.Outputs ?? []).flatMap((x) => (x.OutputKey ? [[x.OutputKey, x.OutputValue ?? '']] : [])))
      } catch (e) { if (/does not exist/.test(String(e))) return null; throw e }
    },
    remove: async (name, region) => { const { cfn, c } = await client(region); await c.send(new cfn.DeleteStackCommand({ StackName: name })) },
  }
}

/** Write the installation record to the central bucket. */
export async function putRecord(creds: AwsCredentialIdentity, region: string, bucket: string, key: string, text: string): Promise<void> {
  await new S3Client({ region, credentials: creds }).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: 'application/json' }))
}

/** The repository whose self-update an earlier run turned on (its saved answers), or null. */
export function earlierSelfUpdate(saved: unknown): string | null {
  const prev = AnswersSchema.safeParse(saved)
  return prev.success ? selfUpdateOf(prev.data)?.repository ?? null : null
}

/** The repositories an earlier run gave a build runner to (its saved answers' projects and build-only repositories):
 * any no longer built now must lose TRACE_CODEBUILD_PROJECT, or its jobs would wait for a runner that is gone. */
export function earlierRepositories(saved: unknown): string[] {
  const prev = AnswersSchema.safeParse(saved)
  return prev.success ? [...prev.data.projects.map((p) => p.repo), ...buildRepositories(prev.data)] : []
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
  // read before this run saves its own answers over them
  const earlier = earlierRepositories(savedAnswers().answers)
  const earlierUpdate = earlierSelfUpdate(savedAnswers().answers)
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
    // the sample project, when asked for: one more new repository (its owner is the login, derived just now if need be)
    a = withSample(resolved.answers)
    for (const d of resolved.derived) log('check', `derived: ${d}`)
    // the sample an earlier run created, deleted on GitHub since: created and filled again, not configured as if there
    const gone = await recreateMissingSample(a, (r) => (hooks.repoExists ?? repoExists)(s.githubAdminToken || s.githubToken, r))
    a = gone.answers
    if (gone.recreated) log('check', `${gone.recreated} is no longer on GitHub: it is created again and filled with the sample`)
    const check = await checkAws(creds, a.aws.region, stack)
    if (check.account !== a.aws.account) throw new Error(`these credentials are for account ${check.account}, not the confirmed ${a.aws.account}`)
    if (!check.agentCore.ok) throw new Error(`Bedrock AgentCore is not available to these credentials in ${a.aws.region}: ${check.agentCore.reason}`)
    // GitHub's OIDC provider (one per account): the stack makes it when the account has none, and keeps it when an
    // earlier deploy made it (dropping it from the stack would delete it); one made elsewhere is used, not made
    const makeOidc = Boolean(check.oidcInStack) || !check.oidcProvider
    if (a.agents.createOidcProvider !== makeOidc) { log('check', makeOidc ? 'GitHub\'s OIDC provider: the stack makes (or keeps) it' : 'GitHub\'s OIDC provider exists in the account: the stack uses it'); a = { ...a, agents: { ...a.agents, createOidcProvider: makeOidc } } }
    // trace's own repository, built on AWS too when the token can configure it (runners.buildTrace)
    const adminToken = s.githubAdminToken || s.githubToken
    const self = await resolveSelfBuild(a, adminToken, hooks.self ?? {
      source: () => traceRepository({ root: REPO_ROOT }), canConfigure: (t, r) => canConfigure(t, r), branch: (t, r) => repositoryDefaultBranch(t, r),
    })
    a = self.answers
    if (self.note) log('check', self.note)
    // the whole plan, now that every answer is known
    const existing = check.existing ?? null
    // projects created in the web app since the last deploy (src/installer/pending.ts): taken in as existing, already
    // onboarded repositories, so this deploy keeps or adds them and the saved answers list them from now on
    const pendingIo = hooks.pending ?? s3PendingIo
    const pendingBucket = existing?.outputs[CENTRAL_BUCKET_OUTPUT] ?? ''
    let pending: PendingEntry[] = []
    if (pendingBucket) {
      try { pending = parsePending(await pendingIo.list(creds, a.aws.region, pendingBucket), (l) => log('check', l)) } catch (e) { log('check', `the projects created in the web app could not be read (${redact(e instanceof Error ? e.message : String(e), s)}); run the installer again to add them`) }
    }
    if (pending.length) {
      const taken = absorb(a.projects, pending, (repo, branch) => ({ repo, branch, onboard: false, applySettings: false, memoryEventExpiryDays: null, generation: 0, create: null }))
      a = { ...a, projects: taken.projects }
      if (taken.absorbed.length) {
        const line = `Adding the project${taken.absorbed.length === 1 ? '' : 's'} created in the web app: ${taken.absorbed.join(', ')}.`
        log('check', line)
        summary.push(line)
      }
    }
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
      // what was derived stays derived: worked out again next time (a registry published since, a token that changed)
      ...x, agents: { ...x.agents, gpuEnabled: input.agents.gpuEnabled, cpuEnabled: input.agents.cpuEnabled, knowledgeBase: input.agents.knowledgeBase, publishImages: input.agents.publishImages, imageRegistry: input.agents.imageRegistry },
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

    // the GitHub connection the CodeBuild runners use (nothing is created here: the stack creates its own when there is
    // none to reuse), and whether it is authorized, which decides whether this deploy makes the runners
    const repos = [...a.projects.map((p) => p.repo), ...buildRepositories(a)]
    const connections = hooks.connection ?? (() => {
      const c = connectionsClient(creds, a.aws.region)
      return { resolve: (o: Parameters<typeof resolveConnection>[1]) => resolveConnection(c, o), wait: (conn: Parameters<typeof waitForConnection>[1], o: ConnectionWait) => waitForConnection(c, conn, o) }
    })()
    const runnerAuth = await chooseRunnerAuth(a.runners.auth, { prefix: props.prefix, ...(a.runners.connectionArn ? { given: a.runners.connectionArn } : {}), deployed: existing?.outputs ?? null }, connections.resolve)
    const choice = runnerAuth.auth === 'connection' ? runnerAuth.connection : null
    const ready = choice ? choice.ready : true
    const runnerMessage = runnerAuth.auth === 'connection' ? runnerAuth.connection.message : runnerAuth.message
    log('check', runnerMessage)
    const runnersOf = (r: boolean): RunnersChoice => (choice ? { connectionArn: choice.pass, connectionReady: r } : { auth: 'token' })
    props = InfraPropsSchema.parse(infraInput(a, existing, undefined, runnersOf(ready)))
    // the web app's web ACL, from <prefix>-edge in us-east-1 when the installation is elsewhere (deployEdge, step 4)
    let webAcl: string | null = null
    const envFor = (d: LayoutDeploy, r = ready): Record<string, string> => ({
      ...awsEnv(creds, a.aws.region), TRACE_INFRA: JSON.stringify(withAcl(infraInput(a, existing, d, runnersOf(r)), webAcl)), CDK_DISABLE_VERSION_CHECK: '1', CI: '1',
    })
    const last = deploys.at(-1) ?? { layout: 'nested', why: '' }
    const env = envFor(last)
    const app = ['--app', `node ${join(REPO_ROOT, 'dist', 'infra', 'app.js')}`]
    const deployArgs = cdkDeployArgs(stack, app)
    // after a deploy that succeeded: the settings it deployed with, and how the runners' way to GitHub is decided again
    // (runners.auth), for the self-update job (src/installer/record.ts, src/installer/update.ts)
    const saveRecord = async (step: string, o: Record<string, string>, r: boolean): Promise<void> => {
      const bucket = o[CENTRAL_BUCKET_OUTPUT]
      if (!bucket) throw new Error(`the stack has no output ${CENTRAL_BUCKET_OUTPUT}`)
      const record = installationRecord({
        stack, region: a.aws.region, props: withAcl(infraInput(a, existing, last, runnersOf(r)), webAcl), runnerAuth: a.runners.auth, connectionArn: a.runners.connectionArn,
        traceRepository: a.runners.traceRepository, traceBranch: a.runners.traceBranch,
      })
      const text = JSON.stringify(record, null, 1)
      checkNoSecrets(text, s)
      await (hooks.saveRecord ?? putRecord)(creds, a.aws.region, bucket, INSTALLATION_RECORD_KEY, text)
      log(step, `the installation's settings saved in s3://${bucket}/${INSTALLATION_RECORD_KEY} (no tokens in them)`)
    }

    // 2 — CDK bootstrap (nested stacks' templates are file assets in its bucket, like the agent source); again when it
    // is older than the deploy needs
    current = 'cdk'
    const bootstrapOk = check.cdkBootstrapped && (check.cdkVersion === undefined || check.cdkVersion === null || check.cdkVersion >= CDK_BOOTSTRAP_MIN)
    if (bootstrapOk) set('cdk', 'skipped', 'already bootstrapped')
    else {
      set('cdk', 'running', check.cdkBootstrapped ? `updating the bootstrap from version ${check.cdkVersion}` : undefined)
      const code = await cdk(['bootstrap', `aws://${a.aws.account}/${a.aws.region}`, ...app], env, (l) => log('cdk', l))
      if (code !== 0) throw new Error(`cdk bootstrap exited ${code}`)
      set('cdk', 'done')
    }

    // 3 — CodeBuild and GitHub: the token as CodeBuild's source credential (runners.auth token, or auto without an
    // authorized connection), before the deploy that makes the runners' webhooks with it; and the new repositories,
    // which those webhooks need
    current = 'github'
    set('github', 'running')
    let runnerCredential: SourceCredential['state'] | null = null
    for (const p of a.projects.filter((x) => x.create)) {
      const r = await (hooks.createRepo ?? createRepo)(adminToken, p.repo, { private: p.create?.private ?? true })
      log('github', `${p.repo}: ${r?.created === false ? 'exists already' : 'created'}`)
    }
    if (choice) set('github', 'done', runnerMessage)
    else if (!a.projects.length && !buildRepositories(a).length) set('github', 'skipped', 'no repositories yet, so no build runners')
    else {
      const ours = (opts.prev as (Answers & { runnerCredential?: string }) | null | undefined)?.runnerCredential === 'imported' || savedRunnerCredential() === 'imported'
      const credential = hooks.sourceCredential ?? ((t: string, o: boolean) => ensureSourceCredential(codebuildClient(creds, a.aws.region), t, o))
      const cred = await credential(a.runners.token === 'admin' ? adminToken : s.githubToken, ours)
      runnerCredential = cred.state === 'existing' ? 'existing' : 'imported'
      log('github', cred.detail)
      set('github', 'done', `${runnerMessage} ${cred.detail}`)
    }

    // 4 — deploy (one deploy, or the three of the move to nested stacks, in order), with the runners unless they wait
    // for a connection nobody has authorized yet
    current = 'deploy'
    set('deploy', 'running', existing ? 'updating the stack: only what changed' : `the first deploy ${props.images.source === 'prebuilt' ? 'copies the agent image (or builds it when this version has none published): 15–40 minutes' : 'builds the agent image: expect 20–40 minutes'}`)
    // the web app's WAF first: CloudFront takes a web ACL from us-east-1 only (src/installer/edge.ts). A failure is said
    // and the main deploy goes ahead with the ACL the app had
    const edgeIo = hooks.edge ?? liveEdgeIo(creds)
    const edge = await deployEdge({
      input: infraInput(a, existing, last, runnersOf(ready)), account: a.aws.account, app, env: { ...awsEnv(creds, a.aws.region), CDK_DISABLE_VERSION_CHECK: '1', CI: '1' }, bootstrap: true,
      deps: { cdk, outputs: edgeIo.outputs, log: (l) => log('deploy', l) },
    })
    webAcl = edge.aclArn
    if (edge.note) { log('deploy', edge.note); if (!edge.ok) summary.push(edge.note) }
    for (const [i, d] of deploys.entries()) {
      if (deploys.length > 1) log('deploy', `deploy ${i + 1} of ${deploys.length}: ${d.why}`)
      // the drain deleted every project's secret; one still in its recovery window would block the nested stack's
      if (deploys.length > 1 && d.layout === 'nested') {
        const lines = await (hooks.freeSecrets ?? freeSecretNames)(creds, a.aws.region, a.projects.map((p) => githubSecretName(props.prefix, p.repo, p.generation)))
        for (const l of lines) log('deploy', l)
      }
      const code = await cdk(deployArgs, envFor(d), (l) => log('deploy', l))
      if (code !== 0) throw new Error(`cdk deploy exited ${code}${deploys.length > 1 ? ` (deploy ${i + 1} of ${deploys.length}: ${d.why}; run the installer again to carry on)` : ''}`)
    }
    // <prefix>-edge left over (the WAF turned off outside us-east-1): deleted once the app no longer points at its ACL
    try {
      const edgeStack = edgeStackName(props.prefix)
      if (props.region !== EDGE_REGION && edgeLeftOver(props, Boolean(await edgeIo.outputs(edgeStack, EDGE_REGION)))) {
        await edgeIo.remove(edgeStack, EDGE_REGION)
        log('deploy', `${edgeStack} (${EDGE_REGION}) deleted: the web app no longer uses its web ACL`)
      }
    } catch (e) { log('deploy', `${edgeStackName(props.prefix)} could not be deleted (${e instanceof Error ? e.message : String(e)}): delete it in the CloudFormation console in ${EDGE_REGION}`) }
    const outputs = hooks.outputs ?? stackOutputs
    let out = await outputs(creds, a.aws.region, stack)
    await saveRecord('deploy', out, ready)
    // each project's own memory (none when memory is off)
    const memoryIds = Object.fromEntries(a.projects.flatMap((p) => {
      const id = out[projectOutputs(p.repo).memoryId]
      return id ? [[p.repo.toLowerCase(), id] as const] : []
    }))
    for (const [repo, id] of Object.entries(memoryIds)) log('deploy', `${repo}: memory ${id}`)
    if (props.memory.enabled && Object.keys(memoryIds).length !== a.projects.length) throw new Error('the stack has no memory output for every project')
    set('deploy', 'done', `${stack} is up${ready ? '' : `, without the build runners until the GitHub connection is authorized. ${GITHUB_RUNNERS_NOTE}`}`)

    const access = choice ? connectorAccessNote(repos) : null
    // whether every repository's build runner exists now: only then is TRACE_CODEBUILD_PROJECT set (step 9)
    let runnersReady = ready
    if (ready) {
      set('connection', 'skipped', choice ? choice.message : 'the runners reach GitHub with the token: no connection to authorize')
      set('runners', 'skipped', 'added with the deploy')
    } else if (choice) {
      // 5 — a person authorizes the connection, once for the account and region
      current = 'connection'
      set('connection', 'running')
      const arn = out[CONNECTION_OUTPUT]
      if (!arn) throw new Error(`the stack has no output ${CONNECTION_OUTPUT}`)
      let todo = ''
      let authorized = false
      try {
        await connections.wait({ arn, name: choice.name, status: '' }, {
        region: a.aws.region, repos,
        report: (l) => {
          log('connection', l)
          // the step's own line says what is needed now (what to do, and when the next check is), so the person sees
          // it without opening the log
          if (/^The GitHub connection .* is waiting/.test(l)) { todo = l; set('connection', 'running', l) }
          if (/^Waiting for /.test(l)) set('connection', 'running', todo ? `${todo} ${l}` : l)
        },
        // after every check the page gets the wait: its countdown, and Check now for right after authorizing
        onWait: (n) => emit({ type: 'wait', step: 'connection', wait: n, line: redact(describeWait(n), s) }),
        })
        authorized = true
      } catch (e) {
        // not authorized in time (or the connection broke): the rest is installed all the same, and the workflows run
        // on GitHub's runners until a later run adds the build runners
        const m = redact(e instanceof Error ? e.message : String(e), s)
        log('connection', m)
        set('connection', 'failed', `${m} ${GITHUB_RUNNERS_NOTE}`)
        set('runners', 'skipped', `not added: the GitHub connection is not authorized yet. ${GITHUB_RUNNERS_NOTE}`)
        summary.push(`The build runners are not added yet: the GitHub connection ${choice.name} is not authorized. ${GITHUB_RUNNERS_NOTE} Authorize it at ${connectionsConsoleUrl(a.aws.region)} ("Update pending connection"), then run the installer again: it adds them and switches the workflows to AWS.`)
      }
      if (authorized) {
        if (access) log('connection', access)
        set('connection', 'done', `${choice.name} is authorized (${arn})`)

        // 6 — the runners, now that CodeBuild can make their webhooks
        current = 'runners'
        set('runners', 'running', 'deploying again: this only adds each repository\'s CodeBuild runner project and its GitHub webhook')
        props = InfraPropsSchema.parse(infraInput(a, existing, undefined, runnersOf(true)))
        const code = await cdk(deployArgs, envFor(last, true), (l) => log('runners', l))
        if (code !== 0) throw new Error(`cdk deploy exited ${code} adding the build runners (run the installer again to carry on)`)
        out = await outputs(creds, a.aws.region, stack)
        await saveRecord('runners', out, true)
        runnersReady = true
        set('runners', 'done', `${repos.length} runner project${repos.length === 1 ? '' : 's'} added`)
      }
    }
    if (access && a.projects.length) summary.push(access)
    const need = (k: string): string => {
      const v = out[k]
      if (!v) throw new Error(`the stack has no output ${k}`)
      return v
    }

    // 7 — the tokens
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

    // 8 — the optional integrations: each given one checked (never blocking) and stored as <prefix>/integrations/<name>
    current = 'integrations'
    const given = givenIntegrations(s)
    for (const w of given.incomplete) { log('integrations', w); summary.push(w) }
    const names_ = Object.keys(given.complete) as IntegrationName[]
    if (!names_.length) set('integrations', 'skipped', 'none given: add one any time with `tracectl integrations set <name>`; the parts tools ask LCSC (no key) meanwhile')
    else {
      set('integrations', 'running')
      const store = hooks.integrations ?? new IntegrationStore(props.prefix, await secretsManagerApi({ region: a.aws.region, credentials: creds }))
      const checkKey = hooks.checkIntegration ?? checkIntegration
      await Promise.all(names_.map(async (n) => {
        const values = given.complete[n] ?? {}
        const c = await checkKey(n, values)
        log('integrations', `${INTEGRATIONS[n].title}: ${c.detail}`)
        if (!c.ok) summary.push(`${INTEGRATIONS[n].title}: ${c.detail}. It is stored anyway; replace it with \`tracectl integrations set ${n}\`.`)
        log('integrations', `${n}: stored in ${await store.set(n, values)}`)
      }))
      set('integrations', 'done', names_.map((n) => INTEGRATIONS[n].title).join(', '))
    }

    // 9 — repositories (several at once)
    current = 'repos'
    set('repos', 'running')
    // TRACE_CODEBUILD_PROJECT is the workflows' switch to AWS: set only where the runner project exists, and removed
    // where it does not, so those jobs run on GitHub's runners instead of waiting for one
    const noRunner = async (repo: string): Promise<void> => {
      if (await deleteVariable(adminToken, repo, RUNNER_VARIABLE)) log('repos', `${repo}: ${RUNNER_VARIABLE} removed (no build runner yet: its workflows run on GitHub's runners)`)
    }
    // the runner project a repository's jobs go to: its output names it once GitHub accepted its webhook, and says
    // `none` while GitHub refuses it (src/infra/lambda/runner-webhook.ts), when the jobs stay on GitHub's runners
    const refused: string[] = []
    const runnerFor = (repo: string, output: string): string | null => {
      if (!runnersReady) return null
      const r = runnerOf(need(output))
      if (!r) refused.push(repo)
      return r
    }
    const agentLogin = (await checkToken(s.githubToken)).login
    const adminLogin = adminToken === s.githubToken ? agentLogin : (await checkToken(adminToken)).login
    if (!a.projects.length && !buildRepositories(a).length) set('repos', 'skipped', 'no repositories yet')
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
        const runner = runnerFor(p.repo, o.runnerProject)
        const vars: Record<string, string> = {
          // this project's own role and runtime: neither reaches any other project
          TRACE_AWS_ROLE: need(o.roleArn), TRACE_AWS_REGION: a.aws.region, TRACE_HOME: need('TraceHome'), TRACE_AGENT_RUNTIME_ARN: need(o.runtimeArn),
          // its own CodeBuild runner project, once it exists: every job of its workflows runs there (`runs-on: codebuild-<project>-…`)
          ...(runner ? { [RUNNER_VARIABLE]: runner } : {}),
          // The worker trusts claim markers and refuses deploy approvals from this login (the agents' own account).
          TRACE_AGENT_LOGIN: login,
          // its own memory, for the worker.runner = actions fallback (its OIDC role may use that memory only)
          ...(memoryIds[p.repo.toLowerCase()] ? { TRACE_MEMORY_ID: memoryIds[p.repo.toLowerCase()] ?? '' } : {}),
          // its own knowledge base, for the kb-sync job on a push to the default branch and the actions fallback
          ...(out[kbOutputs(p.repo).knowledgeBaseId] ? { TRACE_KB_ID: out[kbOutputs(p.repo).knowledgeBaseId] ?? '', TRACE_KB_DATA_SOURCE_ID: out[kbOutputs(p.repo).dataSourceId] ?? '' } : {}),
        }
        for (const [k, v] of Object.entries(vars)) log('repos', `${p.repo}: ${k} ${await setVariable(adminToken, p.repo, k, v)}`)
        if (!runner) await noRunner(p.repo)
        await setSecret(adminToken, p.repo, 'TRACE_TOKEN', projectToken(s, p.repo))
        log('repos', `${p.repo}: TRACE_TOKEN set`)
      })
      // the build-only repositories (trace's own, by default): their runner project alone
      for (const r of buildRepositories(a)) {
        const runner = runnerFor(r, ciRunnerOutput(r))
        if (runner) log('repos', `${r}: ${RUNNER_VARIABLE} ${await setVariable(adminToken, r, RUNNER_VARIABLE, runner)} (built on AWS, without agents)`)
        else await noRunner(r)
      }
      // keeping the installation up to date (README "Staying up to date"): trace's own repository's ci workflow reads these
      const update = selfUpdateOf(a)
      if (update) {
        const vars = { [UPDATE_ROLE_VARIABLE]: need(SELF_UPDATE_OUTPUT), TRACE_AWS_REGION: a.aws.region, [UPDATE_STACK_VARIABLE]: stack }
        await Promise.all(Object.entries(vars).map(async ([k, v]) => log('repos', `${update.repository}: ${k} ${await setVariable(adminToken, update.repository, k, v)} (keeps this installation up to date when its ${update.branch} branch changes)`)))
      }
      if (!runnersReady) log('repos', GITHUB_RUNNERS_NOTE)
      const refusedNote = refused.length ? webhookRefusedNote(refused, access) : null
      if (refusedNote) { log('repos', refusedNote); summary.push(refusedNote) }
      set('repos', 'done', runnersReady ? (refusedNote ?? undefined) : GITHUB_RUNNERS_NOTE)
    }
    // self-update turned off (or trace's own repository moved): the role is gone with this deploy, so that repository's
    // workflow must stop trying to use it. Best effort
    const updating = selfUpdateOf(a)?.repository.toLowerCase()
    const stale = [earlierUpdate, a.runners.traceRepository].filter((x): x is string => Boolean(x) && x?.toLowerCase() !== updating)
    for (const r of stale.filter((x, i) => stale.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i)) {
      try {
        if (await deleteVariable(adminToken, r, UPDATE_ROLE_VARIABLE)) log('repos', `${r}: ${UPDATE_ROLE_VARIABLE} removed (this installation no longer updates itself from it)`)
      } catch (e) { log('repos', `${r}: could not remove ${UPDATE_ROLE_VARIABLE} (${redact(e instanceof Error ? e.message : String(e), s)}): remove it by hand`) }
    }
    // repositories an earlier run built that this one does not (a project removed, trace's own turned off): their
    // runner goes with this deploy. Best effort: the token may no longer reach them
    const now = new Set([...a.projects.map((p) => p.repo), ...buildRepositories(a)].map((r) => r.toLowerCase()))
    for (const r of earlier.filter((x) => !now.has(x.toLowerCase()))) {
      try { await noRunner(r) } catch (e) { log('repos', `${r}: could not remove ${RUNNER_VARIABLE} (${redact(e instanceof Error ? e.message : String(e), s)}): remove it by hand, or its jobs wait for a runner that is gone`) }
    }

    // 10 — onboarding PRs and new repositories (REST and git with the admin token; several at once)
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
        for (const n of r.notes) log('onboard', `${p.repo}: ${n}`)
        if (r.state === 'created') summary.push(p.create?.template === 'sample' ? `Created the sample project, ${p.repo}, under trace.` : `Created ${p.repo} under trace.`)
      })
      set('onboard', 'done')
    }

    // 11 — people and their projects (central database on S3: credentials in this process's environment for the
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
          const a = await assign(installer, { sub, email: p.email }, repo, { class: p.class })
          log('people', `${p.email}: assigned to ${repo} as a ${a.part} (${a.part === 'reviewer' ? 'read' : 'read and write'})`)
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
        summary.push(`Still have project access though not listed here: ${stale.join(', ')} (remove with \`tracectl users unassign\`)`)
      }
      for (const p of a.projects) await register(p.repo, null)
      // the sample's first journey state, as projects.create starts one, so the web app shows its stages and gates
      const sample = sampleRepoOf(a)
      if (sample) {
        try {
          const j = await (hooks.sampleJourney ?? startSampleJourney)(need('TraceHome'), sample, a.adminEmail || 'the installer')
          log('people', `${sample}: ${j === 'started' ? 'its journey started (Mixed template, at Define)' : 'its journey is there already'}`)
        } catch (e) {
          const m = redact(e instanceof Error ? e.message : String(e), s)
          log('people', `${sample}: its journey could not be started (${m})`)
          summary.push(`The sample's journey could not be started (${m}): run the installer again, or start it from the web app.`)
        }
      }
    } finally {
      for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'TRACE_HOME']) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    const webUrl = out[WEB_OUTPUTS.url] ?? ''
    if (!existing) summary.push(`${a.adminEmail} receives a temporary password from Cognito; sign in ${webUrl ? `at ${webUrl} or ` : ''}with \`tracectl login\`.`)
    set('people', 'done')

    // the web app's address (its outputs; nothing to do but show it)
    if (byId.has('web')) set('web', webUrl ? 'done' : 'skipped', webUrl || `the stack has no output ${WEB_OUTPUTS.url} yet: run the installer again once the deploy has it`)

    // 12 — this machine
    current = 'local'
    saveInstallation({
      name: 'default', region: a.aws.region, account: a.aws.account, stack, traceHome: need('TraceHome'),
      userPoolId: need('UserPoolId'), clientId: need('UserPoolClientId'), cognitoDomain: need('CognitoDomain'),
      // each project has its own worker runtime and role (its repository's variables): none is the installation's
      apiRuntimeArn: need('ApiRuntimeArn'), workerRuntimeArn: '', actionsRoleArn: '',
      githubSecretArn: need('GithubSecretArn'), memoryIds, callbackPorts: props.callbackPorts,
    })
    remember(a, true)
    // the web app's projects are the installer's own now (in the saved answers and the record): their requests are done
    for (const p of pending) {
      try { await pendingIo.remove(creds, a.aws.region, pendingBucket, p.key) } catch (e) { log('local', `${p.key} could not be removed (${redact(e instanceof Error ? e.message : String(e), s)}); the next update marks it added`) }
    }
    saveAnswers({ traceVersion: (await import('./lifecycle.js')).traceVersion(), ...(runnerCredential ? { runnerCredential } : {}) })
    set('local', 'done')
    // 13 — publishing trace's images from this account (its owner's install, or when asked); never fatal: trace is installed
    current = 'release'
    if (!a.agents.publishImages) set('release', 'skipped')
    else {
      set('release', 'running')
      try {
        const run = hooks.release ?? (async (o) => releaseSetup(await liveReleaseDeps(o.creds, o.token, { cdk: (args, env) => cdk(args, env, o.log), log: o.log }), { account: o.account, repository: o.repository, publish: true }))
        const r = await run({ creds, account: a.aws.account, repository: releaseRepository(a), token: adminToken, log: (l) => log('release', l) })
        set('release', 'done', `${r.registry}: ${r.images.join(', ')}${r.dispatched ? '; the first release is running' : ''}`)
        summary.push(`trace's images publish to ${r.registry} (${r.gallery.join(', ')}) from ${releaseRepository(a)}'s main and v* tags${selfBuild(a) ? ', built on its own AWS runner' : ', on GitHub\'s runners until its AWS runner exists'}.`)
      } catch (e) {
        const m = redact(e instanceof Error ? e.message : String(e), s)
        set('release', 'failed', m)
        summary.push(`Publishing trace's images is not set up: ${m}. Everything else is installed; run \`tracectl release setup\` to finish it.`)
      }
    }

    summary.unshift(`trace is installed in ${a.aws.account} (${a.aws.region}) as ${stack}.${webUrl ? ` Open trace: ${webUrl}` : ''}`)
    if (webUrl && props.web.domainName) summary.push(`Point ${props.web.domainName}'s DNS (a CNAME or alias) at the CloudFront distribution ${out[WEB_OUTPUTS.distributionId] ?? ''}.`)
    // external access: where systems come in, and that nothing can until an admin adds one
    if (props.external.enabled) {
      const api = out[EXTERNAL_OUTPUTS.apiUrl]
      summary.push(api
        ? `External access is on: no system can connect until an admin adds it${webUrl ? ' in the web app (Admin → Connected systems)' : ' with `tracectl services create`'}. Systems call ${api}, or the MCP endpoint ${out[EXTERNAL_OUTPUTS.mcpUrl] ?? ''}, with a token from ${out[EXTERNAL_OUTPUTS.tokenUrl] ?? ''}.`
        : `External access is on, but the stack has no output ${EXTERNAL_OUTPUTS.apiUrl} yet: run the installer again once the deploy has it.`)
    }
    if (!a.projects.length) summary.push('No repositories yet: run `tracectl install` again and pick some (or create one).')
    else summary.push('Write each project\'s rules in .trace/rules.md (they start empty).')
    if (!names_.length) summary.push('Optional: add a Nexar, Mouser or Digi-Key key for live stock and prices: `tracectl integrations set nexar` (see `tracectl integrations list`).')

    // 15 — the sample's tour, last (it runs after the GPU wait below): every agent and every simulation gets its task;
    // the GPU and CPU ones only when the GPU image is there to run them. A failure is reported; the rest stays installed
    const tour = async (gpu: boolean): Promise<void> => {
      const repo = sampleRepoOf(a)
      if (!repo || !a.sample.tour) return
      current = 'tour'
      set('tour', 'running')
      try {
        const t = await (hooks.tour ?? startTour)(adminToken, repo, { gpu })
        for (const l of t.lines) log('tour', l)
        set('tour', 'done', `${t.opened} task${t.opened === 1 ? '' : 's'} opened${t.existing ? `, ${t.existing} already there` : ''}: ${t.url}`)
        summary.push(`The sample's tour has started: every agent and every simulation has a task in ${t.url}. The tasks close as the agents finish them.`)
        if (t.skipped.length) summary.push(props.gpu.enabled
          ? `Not in the tour yet, because the GPU image is not built (${t.skipped.join('; ')}): run the installer again once it is, to add them.`
          : `Not in the tour, because GPU jobs are off: ${t.skipped.join('; ')}.`)
      } catch (e) {
        const m = redact(e instanceof Error ? e.message : String(e), s)
        set('tour', 'failed', m)
        summary.push(`The sample's tour did not start: ${m}. Everything else is installed; run the installer again to open its tasks.`)
      }
    }

    // 14 — the GPU image: the deploy started its build and did not wait (src/infra/gpu.ts). trace is usable now; the
    // page says so, and the wait goes on underneath
    current = 'gpu'
    if (!props.gpu.enabled) {
      set('gpu', 'skipped')
    await tour(false)
      emit({ type: 'done', ok: true, ...(webUrl ? { url: webUrl } : {}), summary })
      return true
    }
    emit({ type: 'ready', ...(webUrl ? { url: webUrl } : {}), summary: [...summary, 'The GPU image is still being made: GPU and CPU jobs wait for it, nothing else does.'] })
    set('gpu', 'running')
    const imageTag = (out.GpuImageUri ?? '').split(':').at(-1) ?? ''
    const wait = hooks.gpuImage ?? ((o) => ensureGpuImage(codebuildClient(creds, a.aws.region), o))
    // a timer (AWS cannot send this computer the build's events): after every check the page gets the wait, with
    // when it checks next and its id for Check now (POST /api/check-now)
    const report = (n: WaitNotice): void => emit({ type: 'wait', step: 'gpu', wait: n, line: redact(describeWait(n), s) })
    const r = await wait({ buildId: out[GPU_IMAGE_BUILD_OUTPUT] ?? '', imageTag, startedAfter: started, log: (l) => log('gpu', l), report })
    if (r.ok) set('gpu', 'done', r.detail)
    else {
      set('gpu', 'failed', r.detail)
      summary.push(`GPU and CPU jobs cannot run until the GPU image is built: ${r.detail}. Everything else is installed; fix the cause and run the installer again to build it.`)
    }
    await tour(r.ok)
    emit({ type: 'done', ok: true, ...(webUrl ? { url: webUrl } : {}), summary })
    return true
  } catch (e) {
    const m = redact(e instanceof Error ? e.message : String(e), s)
    set(current, 'failed', m)
    emit({ type: 'done', ok: false, summary: [`Stopped at "${byId.get(current)?.title ?? current}": ${m}`, 'Fix the cause and run the installer again: every step is safe to repeat.'] })
    return false
  }
}

/** Whether trace imported CodeBuild's GitHub credential on an earlier run (so it may refresh it). */
function savedRunnerCredential(): string | null {
  try { const v = savedAnswers().runnerCredential; return typeof v === 'string' ? v : null } catch { return null }
}
