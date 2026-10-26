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
export const Role = z.enum(['read', 'write'])

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
}).strict()

export const ProjectAnswer = z.object({
  repo: Repo,
  /** Open the onboarding PR (workflows, empty rules, project database) in this repository. */
  onboard: z.boolean().default(true),
  /** Repository settings the loop needs: auto-merge, branch deletion, labels, the required-check ruleset. */
  applySettings: z.boolean().default(true),
}).strict()

export const PersonAnswer = z.object({
  email: z.string().trim().email(),
  admin: z.boolean().default(false),
  grants: z.array(z.object({ repo: Repo, role: Role }).strict()).default([]),
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
  a.people.forEach((p, i) => p.grants.forEach((g, j) => {
    if (!repos.has(g.repo.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['people', i, 'grants', j, 'repo'], message: `${g.repo} is not one of the projects being installed` })
  }))
})
export type Answers = z.output<typeof AnswersSchema>
export type AnswersInput = z.input<typeof AnswersSchema>

export const SecretsSchema = z.object({
  /** The token the agents and workflows use (stored in Secrets Manager and as each repository's TRACE_TOKEN). */
  githubToken: z.string().min(20, 'a GitHub token'),
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
