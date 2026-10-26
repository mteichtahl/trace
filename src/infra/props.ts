/**
 * What the CDK stack needs to know, collected by the installer (or given by hand). Passed to the CDK app in the
 * TRACE_INFRA environment variable as JSON text — never as a file, and never containing a secret: tokens go straight
 * into Secrets Manager and GitHub after the deploy.
 */
import { z } from 'zod'
import { projectHash, projectSlug } from '../core/project.js'
import { PREBUILT_REGISTRY } from './images.js'

export {
  cpuJobDefinitionName, gpuJobDefinitionName, githubSecretName, knowledgeBaseName, memoryDeliveryName, memoryName, projectDataPrefix, projectHash, projectJobsPrefix,
  projectKbPrefix, projectSlug, workerRuntimeName,
} from '../core/project.js'

/** OWNER/REPO, optionally @BRANCH (its default branch; main when omitted). */
const repoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(@[A-Za-z0-9._\/-]+)?$/, 'expected OWNER/REPO or OWNER/REPO@BRANCH')

/** AgentCore Memory's EventExpiryDuration bounds (days). */
const EventExpiryDays = z.number().int().min(3).max(365)

/** Amazon Titan Text Embeddings V2: its model id, and the output sizes it supports (1,024 is its default). */
export const TITAN_V2 = 'amazon.titan-embed-text-v2:0'
export const TITAN_V2_DIMENSIONS = [256, 512, 1024] as const

/** How the data source splits documents into chunks before they are embedded (CfnDataSource ChunkingConfiguration).
 * fixed: maxTokens with overlapPercentage; semantic: maxTokens, bufferSize, breakpointPercentileThreshold;
 * hierarchical: parentMaxTokens over maxTokens (the child), overlapTokens. S3 Vectors keeps the parent text as
 * non-filterable metadata, so very large parents (thousands of tokens) can exceed its per-vector metadata limit. */
const CHUNKING = {
  strategy: z.enum(['fixed', 'semantic', 'hierarchical']),
  maxTokens: z.number().int().min(20).max(8192),
  overlapPercentage: z.number().int().min(1).max(99),
  parentMaxTokens: z.number().int().min(20).max(8192),
  overlapTokens: z.number().int().min(1).max(1000),
  bufferSize: z.number().int().min(0).max(1),
  breakpointPercentileThreshold: z.number().int().min(50).max(99),
}
export const ChunkingSchema = z.object({
  strategy: CHUNKING.strategy.default('fixed'),
  maxTokens: CHUNKING.maxTokens.default(300),
  overlapPercentage: CHUNKING.overlapPercentage.default(20),
  parentMaxTokens: CHUNKING.parentMaxTokens.default(1500),
  overlapTokens: CHUNKING.overlapTokens.default(60),
  bufferSize: CHUNKING.bufferSize.default(0),
  breakpointPercentileThreshold: CHUNKING.breakpointPercentileThreshold.default(95),
}).strict()

/** A project's knowledge base: an Amazon Bedrock knowledge base over its documents in S3, with an S3 Vectors index
 * (src/infra/knowledge.ts). Nested layout only. */
export const KnowledgeBaseSchema = z.object({
  enabled: z.boolean().default(true),
  /** a Bedrock embedding model id (Titan Text Embeddings V2 by default) */
  embeddingModel: z.string().regex(/^[a-z0-9-]+\.[a-z0-9.:-]+$/, 'a Bedrock foundation model id such as amazon.titan-embed-text-v2:0').default(TITAN_V2),
  /** the vectors' dimensions: the index is made with it and the model asked for it */
  dimensions: z.number().int().min(1).max(4096).default(1024),
  chunking: ChunkingSchema.prefault({}),
}).strict()

/** The parts of KnowledgeBaseSchema one project may set for itself (projectSettings), over the installation's. */
const KnowledgeBaseOverride = z.object({
  enabled: z.boolean().optional(),
  embeddingModel: KnowledgeBaseSchema.shape.embeddingModel.unwrap().optional(),
  dimensions: KnowledgeBaseSchema.shape.dimensions.unwrap().optional(),
  /** only what it changes: everything else is the installation's */
  chunking: z.object(Object.fromEntries(Object.entries(CHUNKING).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof CHUNKING]: z.ZodOptional<(typeof CHUNKING)[K]> }).strict().optional(),
}).strict()

/** One project's own settings, beside its entry in `repositories` (which stays a plain OWNER/REPO[@BRANCH] list). */
export const ProjectSettingsSchema = z.object({
  /** its knowledge base, over `knowledgeBase` (e.g. { enabled: false }, or another chunking strategy) */
  knowledgeBase: KnowledgeBaseOverride.optional(),
  /** days its memory keeps short-term events; unset: memory.eventExpiryDays */
  memoryEventExpiryDays: EventExpiryDays.optional(),
  /** Its names' generation (src/core/project.ts): 0 (unset) keeps the names it always had; above 0, its memory,
   * memory log delivery sources and destinations, and token secret carry `g<n>`. The installer raises it when a project
   * is added again while a removed one's retained memory, delivery or secret (in its recovery window) still holds the
   * names; the old memory stays in the account, orphaned, and the new one starts empty. Never lower it. */
  generation: z.number().int().min(0).max(99).optional(),
}).strict()

export const InfraPropsSchema = z.object({
  /** A short name prefixed to every resource: lets two installations share an account. */
  prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/, 'lower-case letters, digits and dashes, 2–21 characters').default('trace'),
  account: z.string().regex(/^\d{12}$/, 'a 12-digit AWS account id'),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'an AWS region such as us-east-1'),
  /** The onboarded repositories. Each is one project with its own worker runtime, roles, GitHub token secret, memory
   * and GPU job definition (src/infra/project.ts); only its default branch's workflows may assume its GitHub OIDC role
   * (subject `repo:OWNER/REPO:ref:refs/heads/BRANCH`). At most 60: the API runtime is told every worker runtime, and
   * every project's memory, in one environment variable each (5000 characters; checked when the stack is built). With
   * layout 'nested' each project is its own nested stack (one resource and no output of the parent's), so 60 fit; with
   * layout 'flat' CloudFormation's 500 resources and 200 outputs per stack bind at about 24 projects (checked when the
   * stack is built). */
  repositories: z.array(repoSlug).max(60).superRefine((rs, ctx) => {
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
  /** CPU-heavy jobs sent remote (openEMS, Verilator, formal, nextpnr): a second AWS Batch compute environment and queue
   * of x86 CPU instances beside the GPU one, running the same image (src/infra/gpu.ts), with one CPU job definition
   * per project and that project's job role. It shares the GPU side's image, network and execution role, so it exists
   * only with gpu.enabled; and only in layout 'nested', because its job definition is one more resource per project
   * and a flat stack of 24 projects has no room for it (cpuEnabled below). */
  cpu: z.object({
    enabled: z.boolean().default(true),
    /** x86 instance families or types, tried in order of fit */
    instanceTypes: z.array(z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9]+)?$/, 'an EC2 instance family or type such as c7i or c7i.4xlarge')).min(1).default(['c7i', 'c6i', 'm7i']),
    /** the most vCPUs running at once; the queue scales to zero when idle */
    maxVcpus: z.number().int().min(1).max(4096).default(64),
    /** use Spot instances (cheaper; a job may be interrupted) */
    spot: z.boolean().default(false),
    /** what each job asks for: vCPUs and memory (MiB) */
    vcpus: z.number().int().min(1).max(192).default(16),
    memoryMiB: z.number().int().min(1024).max(1_572_864).default(32_768),
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
  /** Each project's knowledge base (src/infra/knowledge.ts): a Bedrock knowledge base over projects/<slug>/kb/ in the
   * central bucket, its vectors in an S3 Vectors index of the installation's one vector bucket. Only in layout
   * 'nested' (kbEnabled below): a flat stack of 24 projects has no room for five more resources per project. */
  knowledgeBase: KnowledgeBaseSchema.prefault({}),
  /** Where each project's resources live (README "Project isolation"). 'nested': one CloudFormation nested stack per
   * project, so the parent carries one resource per project. 'flat': every project's resources in the one stack, as
   * installations before nested stacks were made; kept for them because moving a resource with a fixed name into a
   * nested stack cannot be done in place (the installer picks the layout from the deployed stack's outputs). */
  layout: z.enum(['flat', 'nested']).default('nested'),
  /** The opt-in move of a 'flat' installation to 'nested', one deploy at a time (the installer runs them in order):
   * 'release' marks each project's memory and its log delivery Delete (nothing else changes), 'drain' then removes
   * every project from the stack (its memory and records are deleted), and a 'nested' deploy creates them again.
   * Only with layout 'flat'. */
  layoutMigration: z.enum(['release', 'drain']).optional(),
  /** Per-project settings, by OWNER/REPO (no @BRANCH; case-insensitive): every key must be in `repositories`. */
  projectSettings: z.record(z.string(), ProjectSettingsSchema).default({}),
  /** The library gateway (src/infra/gateway.ts, README "Library gateway"): AgentCore Gateway in front of the shared
   * datasheets and parts tools, which every project's worker then calls instead of running them itself. Off by
   * default: with it off every tool runs in the worker, as before. */
  gateway: z.object({
    enabled: z.boolean().default(false),
  }).strict().prefault({}),
  /** Where the agent and GPU images come from (src/infra/images.ts): 'prebuilt' copies trace's published images for
   * this exact source when they exist, and builds otherwise; 'build' always builds (with BuildKit's inline cache). */
  images: z.object({
    source: z.enum(['prebuilt', 'build']).default('prebuilt'),
    /** the published images are `<registry>-agent:<tag>` and `<registry>-gpu:<tag>` */
    registry: z.string().regex(/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/, 'a registry path such as public.ecr.aws/alias/trace').default(PREBUILT_REGISTRY),
  }).strict().prefault({}),
  /** CI on AWS (src/infra/runners.ts): GitHub Actions jobs of the onboarded repositories run on AWS CodeBuild-hosted
   * runners instead of GitHub's. The stack holds the runners' role and the source credential's secret; the installer
   * makes one CodeBuild runner project and webhook per repository after the deploy (src/installer/runners.ts). The
   * stack holds only their service role. */
  runners: z.object({
    enabled: z.boolean().default(true),
    /** CodeBuild compute for each job (BUILD_GENERAL1_SMALL | MEDIUM | LARGE …) */
    computeType: z.enum(['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE', 'BUILD_GENERAL1_XLARGE', 'BUILD_GENERAL1_2XLARGE']).default('BUILD_GENERAL1_MEDIUM'),
    /** more repositories (OWNER/REPO) that get a runner but are not projects, such as trace's own */
    extraRepos: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')).max(20).default([]),
  }).strict().prefault({}),
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
  if (p.layoutMigration && p.layout !== 'flat') ctx.addIssue({ code: 'custom', path: ['layoutMigration'], message: 'layoutMigration moves a flat installation: it needs layout flat' })
  // the library gateway's name (`<prefix>-library`) must match AgentCore's ^([0-9a-zA-Z][-]?){1,48}$
  if (p.gateway.enabled && !/^([0-9a-zA-Z][-]?){1,48}$/.test(`${p.prefix}-library`)) ctx.addIssue({ code: 'custom', path: ['prefix'], message: 'with the library gateway, the prefix can\'t end with a dash or have two in a row' })
  if (p.cpu.vcpus > p.cpu.maxVcpus) ctx.addIssue({ code: 'custom', path: ['cpu', 'vcpus'], message: `a CPU job asks for ${p.cpu.vcpus} vCPUs, more than cpu.maxVcpus (${p.cpu.maxVcpus})` })
  const listed = new Set(p.repositories.map((r) => (r.split('@')[0] ?? '').toLowerCase()))
  const seen = new Set<string>()
  for (const k of Object.keys(p.projectSettings)) {
    const slug = k.toLowerCase()
    if (!listed.has(slug)) ctx.addIssue({ code: 'custom', path: ['projectSettings', k], message: `${k} is not one of the repositories` })
    else if (seen.has(slug)) ctx.addIssue({ code: 'custom', path: ['projectSettings', k], message: `${k} is listed twice` })
    seen.add(slug)
  }
  // Titan Text Embeddings V2 makes 256, 512 or 1,024 dimensions only; the index must be made with the same number
  const titan = (kb: KnowledgeBaseSettings, path: (string | number)[]): void => {
    if (kb.embeddingModel === TITAN_V2 && !(TITAN_V2_DIMENSIONS as readonly number[]).includes(kb.dimensions)) {
      ctx.addIssue({ code: 'custom', path, message: `${TITAN_V2} makes ${TITAN_V2_DIMENSIONS.join(', ')} dimensions, not ${kb.dimensions}` })
    }
  }
  titan(p.knowledgeBase, ['knowledgeBase', 'dimensions'])
  for (const k of Object.keys(p.projectSettings)) titan(knowledgeBaseOf(p, k), ['projectSettings', k, 'knowledgeBase', 'dimensions'])
})

export type KnowledgeBaseSettings = z.output<typeof KnowledgeBaseSchema>

/** One project's knowledge base settings: its projectSettings override over the installation's `knowledgeBase`. */
export function knowledgeBaseOf(cfg: { projectSettings: Record<string, z.output<typeof ProjectSettingsSchema>>; knowledgeBase: KnowledgeBaseSettings }, repository: string): KnowledgeBaseSettings {
  const slug = repository.trim().toLowerCase()
  const own = Object.entries(cfg.projectSettings).find(([k]) => k.toLowerCase() === slug)?.[1]?.knowledgeBase ?? {}
  const base = cfg.knowledgeBase
  return {
    enabled: own.enabled ?? base.enabled,
    embeddingModel: own.embeddingModel ?? base.embeddingModel,
    dimensions: own.dimensions ?? base.dimensions,
    chunking: { ...base.chunking, ...Object.fromEntries(Object.entries(own.chunking ?? {}).filter(([, v]) => v !== undefined)) },
  }
}

/** Whether this project has a knowledge base: its setting, in the nested layout only (a flat stack has no room), and
 * not while the move to nested stacks is under way. */
export const kbEnabled = (cfg: Parameters<typeof knowledgeBaseOf>[0] & { layout: 'flat' | 'nested'; layoutMigration?: 'release' | 'drain' | undefined }, repository: string): boolean =>
  cfg.layout === 'nested' && cfg.layoutMigration === undefined && knowledgeBaseOf(cfg, repository).enabled

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
export function projectSettings(cfg: Pick<InfraProps, 'projectSettings' | 'memory'>, repository: string): { memoryEventExpiryDays: number; generation: number } {
  const slug = projectSlug(repository)
  const own = Object.entries(cfg.projectSettings).find(([k]) => k.toLowerCase() === slug)?.[1] ?? {}
  return { memoryEventExpiryDays: own.memoryEventExpiryDays ?? cfg.memory.eventExpiryDays, generation: own.generation ?? 0 }
}

/** What each project's GPU job definition asks for (src/infra/gpu.ts). src/gpu/batch.ts caps a job's `vcpus` hint at
 * it: the worker is told it as TRACE_GPU_JOB_MAX_VCPUS, and the CPU definition's (cpu.vcpus) as TRACE_CPU_JOB_MAX_VCPUS. */
export const GPU_JOB_VCPUS = 4

/** Whether the CPU queue exists: cpu.enabled, with the GPU side it shares, in the nested layout (see `cpu`). */
export const cpuEnabled = (cfg: Pick<InfraProps, 'cpu' | 'gpu' | 'layout'>): boolean => cfg.cpu.enabled && cfg.gpu.enabled && cfg.layout === 'nested'

/** The CloudFormation output names of one project (alphanumeric only, so the hash rather than the slug). In the nested
 * layout they are its nested stack's outputs only (the parent carries none of them): the installer reads them there
 * (src/installer/aws.ts stackOutputs). In the flat layout they are the stack's own, as they always were. */
export const projectOutputs = (repository: string): { runtimeArn: string; roleArn: string; secretArn: string; jobDefinition: string; memoryId: string } => {
  const h = projectHash(repository)
  return {
    runtimeArn: `Project${h}RuntimeArn`, roleArn: `Project${h}ActionsRoleArn`, secretArn: `Project${h}GithubSecretArn`, jobDefinition: `Project${h}GpuJobDefinition`,
    memoryId: `Project${h}MemoryId`,
  }
}

/** A project's knowledge base outputs: its nested stack's only (knowledge bases exist only in the nested layout), never
 * the parent's. The installer sets them as the repository variables TRACE_KB_ID and TRACE_KB_DATA_SOURCE_ID. */
export const kbOutputs = (repository: string): { knowledgeBaseId: string; dataSourceId: string } => {
  const h = projectHash(repository)
  return { knowledgeBaseId: `Project${h}KnowledgeBaseId`, dataSourceId: `Project${h}KnowledgeBaseDataSourceId` }
}

/** In the nested layout, the output of each project's nested stack that names its repository (owner/repo), so the
 * installer can tell which nested stack is whose without relying on logical ids alone. */
export const REPOSITORY_OUTPUT = 'Repository'

/** The GPU image build the deploy started (it no longer waits for it: src/infra/gpu.ts): the installer waits for it
 * after the core is up, and starts it again if it failed. Its value is the CodeBuild build id, `<project>:<uuid>`. */
export const GPU_IMAGE_BUILD_OUTPUT = 'GpuImageBuild'

/** The CI runners' output (runners.enabled): their CodeBuild service role (src/infra/runners.ts). */
export const RUNNER_ROLE_OUTPUT = 'RunnerRoleArn'

/** The library gateway's outputs (gateway.enabled): its URL, and the distributor-keys secret the installer writes. */
export const LIBRARY_GATEWAY_OUTPUT = 'LibraryGatewayUrl'
export const LIBRARY_KEYS_OUTPUT = 'LibraryKeysSecretArn'

/** The stack's layout ('flat' or 'nested'), an output so the installer can tell which an installation has. */
export const LAYOUT_OUTPUT = 'Layout'

/** CloudFormation's per-template quotas the stack checks when it is built. */
export const STACK_RESOURCES_MAX = 500
export const STACK_OUTPUTS_MAX = 200
export const STACK_PARAMETERS_MAX = 200

/** The installation-wide memory's output before memory was per project: an install that has it is an older one. */
export const LEGACY_MEMORY_OUTPUT = 'MemoryId'

/** The CloudFormation stack name for a prefix: trace → TraceStack, my-lab → MyLabStack. */
export const stackName = (prefix: string): string =>
  prefix.split('-').map((p) => (p[0]?.toUpperCase() ?? '') + p.slice(1)).join('') + 'Stack'
