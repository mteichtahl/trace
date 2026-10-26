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
  projects: z.array(ProjectAnswer).min(1, 'choose at least one repository'),
  adminEmail: z.string().trim().email('the first administrator\'s email'),
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
  if (emails.includes(a.adminEmail.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['people'], message: 'the first administrator is already an admin: leave them out of the list' })
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

/** A line of progress streamed to the page. */
export const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: StepSchema }),
  z.object({ type: z.literal('log'), step: z.string(), line: z.string() }),
  z.object({ type: z.literal('done'), ok: z.boolean(), summary: z.array(z.string()) }),
])
export type InstallEvent = z.infer<typeof EventSchema>
