/**
 * What the installer asks for. Split in two on purpose:
 *
 *   Answers  non-secret choices, remembered in ~/.trace/client.db so a second run starts where the first left off
 *   Secrets  tokens and keys, held in the installer's memory only: written to AWS Secrets Manager and GitHub,
 *            never to disk, never into a CloudFormation template, never sent back to the browser
 *
 * Only two things are required: AWS credentials (a profile, the default one when nothing is said, or keys) and one
 * GitHub token (Secrets.githubToken). Everything else has a default or is derived before anything is created
 * (src/installer/derive.ts): the account from STS, the region from the profile (else us-east-1), the GitHub login and
 * the first administrator's email from the token, the model from the region's inference profiles, and whether the
 * GPU/CPU queues and knowledge bases are on from the account's quotas and the region's services. An empty value
 * here means "derive it"; `null` on gpuEnabled, cpuEnabled and knowledgeBase means "decide from the preflight".
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
  /** empty: the profile's region, else us-east-1 */
  region: z.string().regex(/^([a-z]{2}(-[a-z]+)+-\d)?$/, 'an AWS region such as us-east-1').default(''),
  /** The account the credentials resolve to (STS). Empty: whatever they resolve to; set (a second run): the install
   * stops if the credentials now resolve to another account (guards against the wrong profile). */
  account: z.string().regex(/^(\d{12})?$/, 'a 12-digit account id').default(''),
}).strict().prefault({})

export const AgentAnswers = z.object({
  prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/, 'lower-case letters, digits and dashes').default('trace'),
  /** empty: the newest Claude Sonnet inference profile the region offers (derive.ts pickModel) */
  model: z.string().refine((v) => v === '' || v.length >= 3, 'a Bedrock model or inference profile id').default(''),
  maxLifetimeHours: z.number().min(0.25).max(8).default(8),
  idleMinutes: z.number().min(1).max(480).default(15),
  createOidcProvider: z.boolean().default(true),
  centralBucketName: z.string().regex(/^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])?$/, 'a valid S3 bucket name, or empty').default(''),
  retainData: z.boolean().default(true),
  /** GPU jobs on AWS Batch (Blender renders, the PCB autorouters): AgentCore has no GPU. null: on when the account's
   * G and VT instance quota allows one job (the preflight), off when it is 0 */
  gpuEnabled: z.boolean().nullable().default(null),
  gpuMaxVcpus: z.number().int().min(4).max(4096).default(16),
  gpuSpot: z.boolean().default(false),
  /** CPU-heavy remote jobs (openEMS, Verilator, formal, nextpnr) on a second Batch queue of CPU instances; needs the GPU
   * side (it shares its image) and the nested layout (props.ts cpu) */
  cpuEnabled: z.boolean().nullable().default(null),
  cpuMaxVcpus: z.number().int().min(1).max(4096).default(64),
  cpuSpot: z.boolean().default(false),
  /** what each CPU job asks for */
  cpuVcpus: z.number().int().min(1).max(192).default(16),
  cpuMemoryMiB: z.number().int().min(1024).max(1_572_864).default(32_768),
  /** each project's Bedrock knowledge base (props.ts knowledgeBase); nested layout only. null: on where the region
   * has Amazon S3 Vectors */
  knowledgeBase: z.boolean().nullable().default(null),
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
  /** CI on AWS: each repository's trace workflows (and runnerExtraRepos') run on CodeBuild-hosted runners
   * (src/installer/runners.ts) instead of GitHub's */
  runners: z.boolean().default(true),
  /** which token CodeBuild keeps as its GitHub source credential (it needs Administration and Webhooks on each
   * repository): the agents' token, or the admin token (which is then stored by CodeBuild) */
  runnerToken: z.enum(['agent', 'admin']).default('agent'),
  /** repositories that get a CodeBuild runner without being projects (trace's own, for its ci.yml) */
  runnerExtraRepos: z.array(z.string().trim().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')).max(20).default([]),
  /** where the images come from (src/infra/images.ts): trace's published ones for this source when they exist, or a
   * build in this account */
  imageSource: z.enum(['prebuilt', 'build']).default('prebuilt'),
}).strict().prefault({})

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
  /** A new repository: created (and scaffolded from this template) by the installer instead of onboarded with a PR.
   * null: it exists already. */
  create: z.object({
    template: z.enum(['empty', 'python', 'kicad', 'rust']).default('empty'),
    private: z.boolean().default(true),
  }).strict().nullable().default(null),
}).strict()

export const PersonAnswer = z.object({
  email: z.string().trim().email(),
  class: PersonClass.default('user'),
  /** The projects they are assigned to (admins reach every project whatever is listed here). */
  projects: z.array(Repo).default([]),
}).strict()

export const AnswersSchema = z.object({
  github: z.object({ login: z.string().default('') }).strict().default({ login: '' }),
  aws: AwsAnswers,
  agents: AgentAnswers,
  /** none is fine: trace installs, and repositories are added by running the installer again */
  projects: z.array(ProjectAnswer).max(60).default([]),
  /** empty: the token's verified primary email (GitHub /user/emails) */
  adminEmail: z.string().trim().refine((v) => v === '' || z.string().email().safeParse(v).success, 'the first administrator\'s email').default(''),
  people: z.array(PersonAnswer).default([]),
  escalateTo: z.string().regex(/^(@?[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?)?$/, 'a GitHub login or @org/team').default(''),
}).strict().superRefine((a, ctx) => {
  const repos = new Set(a.projects.map((p) => p.repo.toLowerCase()))
  if (repos.size !== a.projects.length) ctx.addIssue({ code: 'custom', path: ['projects'], message: 'a repository is listed twice' })
  a.people.forEach((p, i) => p.projects.forEach((r, j) => {
    if (!repos.has(r.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['people', i, 'projects', j], message: `${r} is not one of the projects being installed` })
  }))
  const emails = a.people.map((p) => p.email.toLowerCase())
  if (new Set(emails).size !== emails.length) ctx.addIssue({ code: 'custom', path: ['people'], message: 'a person is listed twice' })
  if (a.adminEmail && emails.includes(a.adminEmail.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['people'], message: 'the first administrator is already an admin: leave them out of the list' })
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
  /** The optional integrations' credentials (src/core/integrations.ts), by integration and key; each one given is
   * checked with its service (never blocking) and stored as `<prefix>/integrations/<name>`. */
  integrations: z.record(z.string(), z.record(z.string(), z.string())).default({}),
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

/** A line of progress streamed to the page. */
export const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: StepSchema }),
  z.object({ type: z.literal('log'), step: z.string(), line: z.string() }),
  /** trace is usable: everything but the GPU image is installed (its build may still be running) */
  z.object({ type: z.literal('ready'), summary: z.array(z.string()) }),
  z.object({ type: z.literal('done'), ok: z.boolean(), summary: z.array(z.string()) }),
])
export type InstallEvent = z.infer<typeof EventSchema>

/** One preflight finding (src/installer/preflight.ts), as the page shows it. */
export const FIX_ACTIONS = ['bedrock-use-case', 'bedrock-agreement', 'quota-increase', 'delete-failed-stack', 'share-source', 'clear-leftovers'] as const
export type FixAction = (typeof FIX_ACTIONS)[number]
export interface Check {
  id: string
  /** fail: installing would fail (it is refused until fixed); warn: installs, but something will not work until fixed;
   * info: what will happen; ok: nothing to do */
  status: 'ok' | 'info' | 'warn' | 'fail'
  title: string
  detail: string
  /** what to do about it, in words */
  fix?: string
  /** where to do it (a console page or a document) */
  link?: string
  /** what the installer can do about it itself, when asked (POST /api/fix) */
  action?: { id: FixAction; label: string; params?: Record<string, string | number> }
}
