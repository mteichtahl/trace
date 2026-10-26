/**
 * What the CDK stack needs to know, collected by the installer (or given by hand). Passed to the CDK app in the
 * TRACE_INFRA environment variable as JSON text — never as a file, and never containing a secret: tokens go straight
 * into Secrets Manager and GitHub after the deploy.
 */
import { z } from 'zod'
import { projectHash, projectSlug } from '../core/project.js'

export {
  gpuJobDefinitionName, githubSecretName, memoryName, projectDataPrefix, projectHash, projectJobsPrefix, projectSlug, workerRuntimeName,
} from '../core/project.js'

/** OWNER/REPO, optionally @BRANCH (its default branch; main when omitted). */
const repoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(@[A-Za-z0-9._\/-]+)?$/, 'expected OWNER/REPO or OWNER/REPO@BRANCH')

/** AgentCore Memory's EventExpiryDuration bounds (days). */
const EventExpiryDays = z.number().int().min(3).max(365)

/** One project's own settings, beside its entry in `repositories` (which stays a plain OWNER/REPO[@BRANCH] list). */
export const ProjectSettingsSchema = z.object({
  /** days its memory keeps short-term events; unset: memory.eventExpiryDays */
  memoryEventExpiryDays: EventExpiryDays.optional(),
}).strict()

export const InfraPropsSchema = z.object({
  /** A short name prefixed to every resource: lets two installations share an account. */
  prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/, 'lower-case letters, digits and dashes, 2–21 characters').default('trace'),
  account: z.string().regex(/^\d{12}$/, 'a 12-digit AWS account id'),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'an AWS region such as us-east-1'),
  /** The onboarded repositories. Each is one project with its own worker runtime, roles, GitHub token secret and GPU
   * job definition (src/infra/project.ts); only its default branch's workflows may assume its GitHub OIDC role
   * (subject `repo:OWNER/REPO:ref:refs/heads/BRANCH`). At most 60: the API runtime is told every worker runtime in one
   * environment variable (5000 characters). */
  repositories: z.array(repoSlug).min(1).max(60).superRefine((rs, ctx) => {
    const seen = new Map<string, string>()
    for (const r of rs) {
      const slug = projectSlug(r.split('@')[0] ?? '')
      const h = projectHash(slug)
      const other = seen.get(h)
      if (other === slug) ctx.addIssue({ code: 'custom', message: `${slug} is listed twice` })
      else if (other) ctx.addIssue({ code: 'custom', message: `${slug} and ${other} have the same short hash ${h}: rename one` })
      seen.set(h, slug)
    }
  }),
  /** Create the account's GitHub OIDC provider (there can be only one per account), or use the existing one. */
  createOidcProvider: z.boolean().default(true),
  /** The Bedrock model or inference profile the agents use, e.g. us.anthropic.claude-sonnet-4-6. */
  model: z.string().min(3),
  /** Bucket for the central database (datasheets, parts); empty: one is created and named after the stack. */
  centralBucketName: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
  /** AgentCore session limits (seconds). */
  maxLifetimeSeconds: z.number().int().min(900).max(28_800).default(28_800),
  idleTimeoutSeconds: z.number().int().min(60).max(28_800).default(900),
  /** The first administrator: Cognito emails them a temporary password. Admins grant everyone else access. */
  adminEmail: z.string().email(),
  /** Local ports the CLI and the installer listen on for the Cognito sign-in redirect. */
  callbackPorts: z.array(z.number().int().min(1024).max(65535)).min(1).default([47821, 47822]),
  /** Keep the data when the stack is deleted, or a project is removed from `repositories`: the central bucket (every
   * project's data in it), the image repositories, and each project's memory with its log group and log delivery.
   * false deletes them. (The projects' GitHub token secrets are copies of a credential and always go with them.) */
  retainData: z.boolean().default(true),
  /** GPU jobs (Blender renders, the PCB autorouters) on AWS Batch: AgentCore runtimes have no GPU (src/infra/gpu.ts). */
  gpu: z.object({
    enabled: z.boolean().default(true),
    /** x86 NVIDIA instance types, tried in order of fit */
    instanceTypes: z.array(z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9]+$/, 'an EC2 instance type such as g6.xlarge')).min(1).default(['g6.xlarge', 'g5.xlarge', 'g4dn.xlarge']),
    /** the most vCPUs running at once (4 per job on the default types); the queue scales to zero when idle */
    maxVcpus: z.number().int().min(4).max(4096).default(16),
    /** use Spot instances (cheaper; a job may be interrupted) */
    spot: z.boolean().default(false),
  }).strict().prefault({}),
  /** The agents' memory: one AgentCore Memory per project (short-term events, long-term facts, session summaries,
   * preferences; src/infra/memory.ts). */
  memory: z.object({
    enabled: z.boolean().default(true),
    /** days short-term events are kept before they expire (AgentCore allows 3–365): every project's, unless its
     * projectSettings entry says otherwise */
    eventExpiryDays: EventExpiryDays.default(30),
    /** Keep the installation-wide memory of earlier versions in the stack, unused and marked Retain, for one deploy,
     * so the deploy after it (without this) leaves it in the account instead of deleting it. The installer sets it
     * when it finds that memory (the old `MemoryId` output) and retainData is true; see README "Agent memory". */
    legacySharedMemory: z.boolean().default(false),
  }).strict().prefault({}),
  /** Per-project settings, by OWNER/REPO (no @BRANCH; case-insensitive): every key must be in `repositories`. */
  projectSettings: z.record(z.string(), ProjectSettingsSchema).default({}),
  /** AgentCore observability: OpenTelemetry (ADOT) traces and metrics to CloudWatch (src/infra/observability.ts). */
  observability: z.object({
    enabled: z.boolean().default(true),
    /** turn on CloudWatch Transaction Search in the account and region if it is not (never turned off on delete) */
    transactionSearch: z.boolean().default(true),
    /** X-Ray's account-wide trace indexing percentage (UpdateIndexingRule "Default"); unset leaves the account's
     * setting alone (1% unless someone changed it). Every span is stored in aws/spans whatever this says. */
    samplingPercent: z.number().min(0).max(100).optional(),
    /** a CloudWatch dashboard of invocations, latency, errors, tokens, tool calls and GPU jobs */
    dashboard: z.boolean().default(true),
  }).strict().prefault({}),
}).strict().superRefine((p, ctx) => {
  const listed = new Set(p.repositories.map((r) => (r.split('@')[0] ?? '').toLowerCase()))
  const seen = new Set<string>()
  for (const k of Object.keys(p.projectSettings)) {
    const slug = k.toLowerCase()
    if (!listed.has(slug)) ctx.addIssue({ code: 'custom', path: ['projectSettings', k], message: `${k} is not one of the repositories` })
    else if (seen.has(slug)) ctx.addIssue({ code: 'custom', path: ['projectSettings', k], message: `${k} is listed twice` })
    seen.add(slug)
  }
})

export type InfraProps = z.output<typeof InfraPropsSchema>
export type InfraInput = z.input<typeof InfraPropsSchema>

export function infraPropsFromEnv(env: NodeJS.ProcessEnv = process.env): InfraProps {
  const raw = env.TRACE_INFRA
  if (!raw) throw new Error('TRACE_INFRA is not set: run `trace install`, or set it to the stack settings as JSON')
  return InfraPropsSchema.parse(JSON.parse(raw))
}

/** AgentCore runtime names: a letter, then letters, digits and underscores, at most 48 characters. The API runtime's;
 * the workers' are workerRuntimeName (one per project). */
export const apiRuntimeName = (prefix: string): string => `${prefix.replace(/-/g, '_')}_api`.slice(0, 48)

/** One entry of `repositories`: OWNER/REPO and its default branch (main when omitted). */
export interface ProjectRef { repository: string; slug: string; hash: string; branch: string }

export function projectRefs(repositories: readonly string[]): ProjectRef[] {
  return repositories.map((r) => {
    const [repository = '', branch = 'main'] = r.split('@')
    return { repository, slug: projectSlug(repository), hash: projectHash(repository), branch }
  })
}

/** One project's settings (projectSettings, keyed case-insensitively), with the installation's defaults filled in. */
export function projectSettings(cfg: Pick<InfraProps, 'projectSettings' | 'memory'>, repository: string): { memoryEventExpiryDays: number } {
  const slug = projectSlug(repository)
  const own = Object.entries(cfg.projectSettings).find(([k]) => k.toLowerCase() === slug)?.[1] ?? {}
  return { memoryEventExpiryDays: own.memoryEventExpiryDays ?? cfg.memory.eventExpiryDays }
}

/** The CloudFormation output names of one project (alphanumeric only, so the hash rather than the slug). */
export const projectOutputs = (repository: string): { runtimeArn: string; roleArn: string; secretArn: string; jobDefinition: string; memoryId: string } => {
  const h = projectHash(repository)
  return {
    runtimeArn: `Project${h}RuntimeArn`, roleArn: `Project${h}ActionsRoleArn`, secretArn: `Project${h}GithubSecretArn`, jobDefinition: `Project${h}GpuJobDefinition`,
    memoryId: `Project${h}MemoryId`,
  }
}

/** The installation-wide memory's output before memory was per project: an install that has it is an older one. */
export const LEGACY_MEMORY_OUTPUT = 'MemoryId'

/** The CloudFormation stack name for a prefix: trace → TraceStack, my-lab → MyLabStack. */
export const stackName = (prefix: string): string =>
  prefix.split('-').map((p) => (p[0]?.toUpperCase() ?? '') + p.slice(1)).join('') + 'Stack'
