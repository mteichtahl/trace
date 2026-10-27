/**
 * What the installer asks for. Split in two on purpose:
 *
 *   Answers  non-secret choices, remembered in ~/.trace/client.db so a second run starts where the first left off
 *   Secrets  tokens and keys, held in the installer's memory only: written to AWS Secrets Manager and GitHub,
 *            never to disk, never into a CloudFormation template, never sent back to the browser
 *
 * Shared by the local server and the browser page, so both validate the same way.
 */
import { z } from 'zod'

export const Repo = z.string().trim().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')
/** admin: everything, everywhere; user: read/write on assigned projects; guest: read on assigned projects. */
export const PersonClass = z.enum(['admin', 'user', 'guest'])

export const AwsAnswers = z.object({
  mode: z.enum(['profile', 'keys']).default('profile'),
  profile: z.string().default('default'),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'an AWS region such as us-east-1'),
  /** The account the credentials resolved to, confirmed by the person (guards against the wrong profile). */
  account: z.string().regex(/^\d{12}$/, 'a 12-digit account id'),
}).strict()

export const AgentAnswers = z.object({
  prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/, 'lower-case letters, digits and dashes').default('trace'),
  model: z.string().min(3, 'choose the model the agents use'),
  maxLifetimeHours: z.number().min(0.25).max(8).default(8),
  idleMinutes: z.number().min(1).max(480).default(15),
  createOidcProvider: z.boolean().default(true),
  centralBucketName: z.string().regex(/^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])?$/, 'a valid S3 bucket name, or empty').default(''),
  retainData: z.boolean().default(true),
  /** GPU jobs on AWS Batch (Blender renders, the PCB autorouters): AgentCore has no GPU */
  gpuEnabled: z.boolean().default(true),
  gpuMaxVcpus: z.number().int().min(4).max(4096).default(16),
  gpuSpot: z.boolean().default(false),
  /** CPU-heavy remote jobs (openEMS, Verilator, formal, nextpnr) on a second Batch queue of CPU instances; needs the GPU
   * side (it shares its image) and the nested layout (props.ts cpu) */
  cpuEnabled: z.boolean().default(true),
  cpuMaxVcpus: z.number().int().min(1).max(4096).default(64),
  cpuSpot: z.boolean().default(false),
  /** what each CPU job asks for */
  cpuVcpus: z.number().int().min(1).max(192).default(16),
  cpuMemoryMiB: z.number().int().min(1024).max(1_572_864).default(32_768),
  /** each project's Bedrock knowledge base (props.ts knowledgeBase); nested layout only */
  knowledgeBase: z.boolean().default(true),
  /** The library gateway (props.ts gateway): the shared datasheets and parts tools behind AgentCore Gateway */
  libraryGateway: z.boolean().default(false),
  /** AgentCore observability: OpenTelemetry traces and metrics to CloudWatch (GenAI Observability) */
  observability: z.boolean().default(true),
  /** turn on CloudWatch Transaction Search in the account and region (account-wide; never turned off) */
  transactionSearch: z.boolean().default(true),
  /** X-Ray's account-wide trace indexing percentage; null leaves the account's setting alone */
  samplingPercent: z.number().min(0).max(100).nullable().default(null),
  /** a CloudWatch dashboard for the agents */
  dashboard: z.boolean().default(true),
  /** move an installation whose projects are all in one stack (layout flat) to one nested stack per project: three
   * deploys in a row, and every project's memory records are deleted (README "Project isolation"). Ignored for a new
   * installation, which is nested already. */
  migrateLayout: z.boolean().default(false),
}).strict()

/** The CodeBuild compute types a runner job may have (props.ts runners.computeType; repeated here because this file is
 * bundled into the page, which does not load the stack's settings). */
export const RUNNER_COMPUTE_TYPES = ['BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE', 'BUILD_GENERAL1_XLARGE', 'BUILD_GENERAL1_2XLARGE'] as const

/** The most build-only repositories the answers may add besides trace's own (props.ts ciRepositories takes 10). */
export const EXTRA_BUILD_REPOSITORIES_MAX = 9

/** Where every GitHub Actions job runs: AWS CodeBuild runners in the installation's account (props.ts runners), once
 * they exist; GitHub's own runners until then. CodeBuild reaches GitHub through an AWS CodeConnections connection. */
export const RunnerAnswers = z.object({
  /** Build trace's own repository on AWS too (a build runner for it alone: props.ts ciRepositories), when the tokens can
   * configure it. On by default. */
  buildTrace: z.boolean().default(true),
  /** trace's own repository as the installer found it (src/installer/source.ts traceRepository) and the token can
   * configure; '' when it found none it can. The installer checks it again before using it. */
  traceRepository: z.union([Repo, z.literal('')]).default(''),
  /** Other repositories to build on AWS without making them projects: each gets a build runner and nothing else. */
  ciRepositories: z.array(Repo).max(EXTRA_BUILD_REPOSITORIES_MAX).default([]),
  /** An existing GitHub connection to use; empty: the installer reuses one already authorized in the account and region
   * (`<prefix>-github` first), else the stack creates `<prefix>-github` and the installer waits after the deploy for a
   * person to authorize it. */
  connectionArn: z.string().trim().regex(/^(arn:aws[a-z-]*:(codeconnections|codestar-connections):[a-z0-9-]+:\d{12}:connection\/[0-9a-f-]{36})?$/, 'an AWS CodeConnections connection ARN, or empty').default(''),
  /** A job's CodeBuild compute type; null: the stack's default (BUILD_GENERAL1_LARGE). */
  computeType: z.enum(RUNNER_COMPUTE_TYPES).nullable().default(null),
  /** Docker-in-Docker for jobs that build containers; null: the stack's default (off). */
  privileged: z.boolean().nullable().default(null),
}).strict()

export const ProjectAnswer = z.object({
  repo: Repo,
  /** Its default branch: only workflows running there may assume the AWS role. */
  branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/).default('main'),
  /** Open the onboarding PR (workflows, empty rules, project database) in this repository. */
  onboard: z.boolean().default(true),
  /** Repository settings the loop needs: auto-merge, branch deletion, labels, the required-check ruleset. */
  applySettings: z.boolean().default(true),
  /** Days its agents' memory keeps short-term events (AgentCore allows 3–365); null: the installation's default (30). */
  memoryEventExpiryDays: z.number().int().min(3, 'at least 3 days').max(365, 'at most 365 days').nullable().default(null),
  /** Its names' generation (props.ts projectSettings.generation): 0 normally. The installer raises it, and saves it
   * here, when the project is added again while a removed copy's retained memory, delivery or secret holds its names. */
  generation: z.number().int().min(0).max(99).default(0),
}).strict()

export const PersonAnswer = z.object({
  email: z.string().trim().email(),
  class: PersonClass.default('user'),
  /** The projects they are assigned to (admins reach every project whatever is listed here). */
  projects: z.array(Repo).default([]),
}).strict()

/** The sample project (src/installer/sample.ts): a repository the installer creates and fills with a small board design
 * that exercises every agent and every tool, every simulation included, then onboards like any other project. */
export const SampleAnswers = z.object({
  enabled: z.boolean().default(false),
  /** OWNER/NAME of the sample's repository; empty: the GitHub token's own account, `<login>/trace-sample`. An existing
   * repository is used as it is (its files are added or updated, nothing is deleted). */
  repo: z.union([Repo, z.literal('')]).default(''),
  /** private (the default) or public, when the installer creates it */
  private: z.boolean().default(true),
  /** once installed, start the sample's tour: one task per agent and per simulation, so every one of them runs */
  tour: z.boolean().default(true),
}).strict()

export const AnswersSchema = z.object({
  github: z.object({ login: z.string().default('') }).strict().default({ login: '' }),
  aws: AwsAnswers,
  agents: AgentAnswers,
  runners: RunnerAnswers.prefault({}),
  projects: z.array(ProjectAnswer).default([]),
  sample: SampleAnswers.prefault({}),
  adminEmail: z.string().trim().email('the first administrator\'s email'),
  people: z.array(PersonAnswer).default([]),
  escalateTo: z.string().regex(/^(@?[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?)?$/, 'a GitHub login or @org/team').default(''),
}).strict().superRefine((a, ctx) => {
  if (!a.projects.length && !a.sample.enabled) ctx.addIssue({ code: 'custom', path: ['projects'], message: 'choose at least one repository, or install the sample project' })
  if (a.sample.enabled && !a.sample.repo && !a.github.login) ctx.addIssue({ code: 'custom', path: ['sample', 'repo'], message: 'name the sample\'s repository (OWNER/NAME): the GitHub token has not been checked, so its account is not known' })
  // the sample is a project too (it may already be listed, from an earlier run): people may be assigned to it
  const sample = a.sample.enabled ? (a.sample.repo || `${a.github.login}/trace-sample`).toLowerCase() : ''
  const listed = new Set(a.projects.map((p) => p.repo.toLowerCase()))
  if (listed.size !== a.projects.length) ctx.addIssue({ code: 'custom', path: ['projects'], message: 'a repository is listed twice' })
  const repos = new Set([...listed, ...(sample ? [sample] : [])])
  a.people.forEach((p, i) => p.projects.forEach((r, j) => {
    if (!repos.has(r.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['people', i, 'projects', j], message: `${r} is not one of the projects being installed` })
  }))
  const emails = a.people.map((p) => p.email.toLowerCase())
  if (new Set(emails).size !== emails.length) ctx.addIssue({ code: 'custom', path: ['people'], message: 'a person is listed twice' })
  if (emails.includes(a.adminEmail.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['people'], message: 'the first administrator is already an admin: leave them out of the list' })
  const extra = a.runners.ciRepositories.map((r) => r.toLowerCase())
  extra.forEach((r, i) => {
    if (repos.has(r)) ctx.addIssue({ code: 'custom', path: ['runners', 'ciRepositories', i], message: `${a.runners.ciRepositories[i]} is one of the projects already: it has its own build runner` })
    else if (extra.indexOf(r) !== i) ctx.addIssue({ code: 'custom', path: ['runners', 'ciRepositories', i], message: `${a.runners.ciRepositories[i]} is listed twice` })
  })
  if (a.agents.cpuVcpus > a.agents.cpuMaxVcpus) ctx.addIssue({ code: 'custom', path: ['agents', 'cpuVcpus'], message: 'a CPU job cannot ask for more vCPUs than the CPU queue may run at once' })
})
export type Answers = z.output<typeof AnswersSchema>
export type AnswersInput = z.input<typeof AnswersSchema>

export const SecretsSchema = z.object({
  /** The shared token: the API's (it reads and writes every project's settings), and every project's agent token
   * unless that project has its own below. Stored in Secrets Manager (and as each such repository's TRACE_TOKEN). */
  githubToken: z.string().min(20, 'a GitHub token'),
  /** A project's own agent token (OWNER/REPO → token), optional: a fine-grained token limited to that repository is
   * what keeps one project's agent out of the others' repositories. Stored in that project's secret and as its
   * TRACE_TOKEN; never in the answers. */
  projectTokens: z.record(Repo, z.string().trim().refine((v) => v === '' || v.length >= 20, 'a GitHub token')).default({}).transform((r) =>
    Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '').map(([k, v]) => [k.toLowerCase(), v]))),
  /** Distributor API keys for the parts tools (optional), by the names the providers read. Written to the library
   * gateway's secret when the gateway is on; a key left empty keeps the one stored, so a second run needs none. */
  libraryKeys: z.object({
    MOUSER_API_KEY: z.string().trim().default(''),
    DIGIKEY_CLIENT_ID: z.string().trim().default(''),
    DIGIKEY_CLIENT_SECRET: z.string().trim().default(''),
    NEXAR_CLIENT_ID: z.string().trim().default(''),
    NEXAR_CLIENT_SECRET: z.string().trim().default(''),
  }).strict().prefault({}),
  /** Used only during installation to change repository settings, if the agents' token can't (optional). */
  githubAdminToken: z.string().default(''),
  /** Only when aws.mode = keys. */
  awsAccessKeyId: z.string().default(''),
  awsSecretAccessKey: z.string().default(''),
  awsSessionToken: z.string().default(''),
}).strict()
export type Secrets = z.output<typeof SecretsSchema>

/** One step of the installation, as the page shows it. */
export const StepSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']),
})
export type Step = z.infer<typeof StepSchema>

/** A timer wait as the page shows it (core/wait.ts WaitNotice; times are ISO 8601). */
export const WaitNoticeSchema = z.object({
  id: z.string(),
  what: z.string(),
  source: z.enum(['event', 'timer']),
  startedAt: z.string(),
  jobId: z.string().nullable().default(null),
  state: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
  intervalMs: z.number().nullable(),
  checks: z.number(),
  why: z.string().nullable(),
})
export type WaitNoticeView = z.infer<typeof WaitNoticeSchema>

/** A line of progress streamed to the page. `wait`: after every check of a timer wait, the wait as it stands and
 * its plain-language line (describeWait); the page counts down to nextCheckAt itself and offers Check now. */
export const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: StepSchema }),
  z.object({ type: z.literal('log'), step: z.string(), line: z.string() }),
  z.object({ type: z.literal('wait'), step: z.string(), wait: WaitNoticeSchema, line: z.string() }),
  z.object({ type: z.literal('done'), ok: z.boolean(), summary: z.array(z.string()) }),
])
export type InstallEvent = z.infer<typeof EventSchema>
