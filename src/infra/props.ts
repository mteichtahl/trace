/**
 * What the CDK stack needs to know, collected by the installer (or given by hand). Passed to the CDK app in the
 * TRACE_INFRA environment variable as JSON text — never as a file, and never containing a secret: tokens go straight
 * into Secrets Manager and GitHub after the deploy.
 */
import { z } from 'zod'
import { PriceOverridesSchema } from '../core/prices.js'
import { projectHash, projectSlug } from '../core/project.js'
import { IMMUTABLE_SUBJECT } from '../core/github-subject.js'

export {
  connectionName, cpuJobDefinitionName, gpuJobDefinitionName, githubSecretName, knowledgeBaseName, memoryDeliveryName, memoryName, projectDataPrefix, projectHash, projectJobsPrefix,
  projectKbPrefix, projectSlug, workerRuntimeName,
} from '../core/project.js'

/** OWNER/REPO, optionally @BRANCH (its default branch; main when omitted). */
const repoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(@[A-Za-z0-9._\/-]+)?$/, 'expected OWNER/REPO or OWNER/REPO@BRANCH')

/** The most build-only repositories (`ciRepositories`) one installation takes: each is three resources and one output
 * of the parent stack. */
export const CI_REPOSITORIES_MAX = 10

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

/**
 * A pinned registry for trace's published images (`public.ecr.aws/<alias>`), for a fork that wants one. Empty (the
 * default): nothing to set, ever: each install finds the registry in the source repository's trace-images release,
 * which publishing writes (src/installer/release.ts publishedRegistry; src/installer/derive.ts), and builds when there
 * is none. Advanced → "Published images registry" (answers agents.imageRegistry) overrides both.
 */
export const PUBLISHED_REGISTRY = ''

export { IMMUTABLE_SUBJECT }

/** The OIDC subjects a role trusts for a repository's runs, `suffix` being the rest of the claim (`:ref:refs/heads/main`):
 * the name form, and the immutable form when its ids are known (githubSubjects). Never a wildcard over the ids. The name
 * form alone stays a string, so the roles of repositories without ids keep the template they had. */
export function githubSubjects(repository: string, subjects: Readonly<Record<string, string>>, suffix: string): string | string[] {
  const immutable = subjects[repository.toLowerCase()]
  return immutable ? [`repo:${repository}${suffix}`, `${immutable}${suffix}`] : `repo:${repository}${suffix}`
}

export const InfraPropsSchema = z.object({
  /** A short name prefixed to every resource: lets two installations share an account. */
  prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/, 'lower-case letters, digits and dashes, 2–21 characters').default('trace'),
  account: z.string().regex(/^\d{12}$/, 'a 12-digit AWS account id'),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'an AWS region such as us-east-1'),
  /** The onboarded repositories. Each is one project with its own worker runtime, roles, GitHub token secret, memory
   * and GPU job definition (src/infra/project.ts); only its default branch's workflows may assume its GitHub OIDC role
   * (subject `repo:OWNER/REPO:ref:refs/heads/BRANCH`, or its immutable form: githubSubjects). At most 60: the API
   * runtime is told every worker runtime, and every project's memory, in one environment variable each (5000
   * characters; checked when the stack is built). With
   * layout 'nested' each project is its own nested stack (one resource and no output of the parent's), so 60 fit; with
   * layout 'flat' CloudFormation's 500 resources and 200 outputs per stack bind at about 20 projects (checked when the
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
  /** Build-only repositories (OWNER/REPO, such as trace's own): each gets a CodeBuild runner project and nothing else (no
   * worker, roles, secret, memory or job definitions), so its GitHub Actions jobs run on AWS like the projects'. In the
   * parent stack (three resources and one output each, ciRunnerOutput), made with the same GitHub connection and only
   * once it is authorized (runners.connectionReady). None may also be in `repositories` (a project has its runner
   * already); at most CI_REPOSITORIES_MAX. */
  ciRepositories: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')).max(CI_REPOSITORIES_MAX).default([]).superRefine((rs, ctx) => {
    const seen = new Map<string, string>()
    for (const r of rs) {
      let slug: string
      try { slug = projectSlug(r) } catch (e) { ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) }); continue }
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
   * and a flat stack of 20 projects has no room for it (cpuEnabled below). */
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
   * 'nested' (kbEnabled below): a flat stack of 20 projects has no room for five more resources per project. */
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
  /** External access (src/infra/external.ts, docs/external-access.md): other systems and AI agents call trace with
   * their own keys (a Cognito app client per connected system, which admins add in the web app). With it on the stack
   * has the `trace-external` scopes on the user pool and two more AgentCore runtimes, `<prefix>_external` (the API for
   * connected systems) and `<prefix>_mcp` (an MCP endpoint in front of it), and the API may manage the systems' app
   * clients. Off by default: with it off none of that exists, and nothing outside can get in. */
  external: z.object({
    enabled: z.boolean().default(false),
  }).strict().prefault({}),
  /** Where the agent and GPU images come from (src/infra/images.ts): 'prebuilt' copies trace's published images for
   * this exact source when they exist, and builds otherwise; 'build' always builds (with BuildKit's inline cache). */
  images: z.object({
    source: z.enum(['prebuilt', 'build']).default('prebuilt'),
    /** where the published images are: `<registry>/trace-agent:<tag>` and `<registry>/trace-gpu:<tag>`; empty: none
     * published yet (always built). The answers' (agents.imageRegistry, found at install time when not given), else
     * PUBLISHED_REGISTRY */
    registry: z.string().regex(/^([a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*)?$/, 'a registry such as public.ecr.aws/<alias>, or empty').default(PUBLISHED_REGISTRY),
  }).strict().prefault({}),
  /** Where every GitHub Actions job of every project (and of each `ciRepositories` entry) runs: an AWS CodeBuild runner
   * project per repository (src/infra/runner.ts); until it exists, the workflows fall back to GitHub's ubuntu-24.04
   * runner. CodeBuild reaches GitHub through an AWS CodeConnections connection (the AWS Connector for GitHub app), or
   * through the GitHub token the installer imported as CodeBuild's GitHub source credential (auth 'token'; README
   * "Where builds run"). */
  runners: z.object({
    /** How CodeBuild reaches GitHub for the runners' webhooks, runner registration and source:
     *   'connection'  an AWS CodeConnections connection (connectionArn, or `<prefix>-github` the stack creates): no token
     *                 stored, but a new connection needs one console authorization per account and region
     *   'token'       the account's CodeBuild GitHub source credential (ImportSourceCredentials, a personal access
     *                 token, imported by the installer before the deploy): no console step, the token is stored with
     *                 CodeBuild. The stack makes no connection, and the runner projects name no source auth
     * 'connection' by default, so a plain `cdk deploy` of an installation made that way keeps its connection. */
    auth: z.enum(['connection', 'token']).default('connection'),
    /** auth 'connection': an existing connection to reuse; unset: the stack creates `<prefix>-github` (connectionName) itself. Either
     * way its ARN is the stack's CONNECTION_OUTPUT. */
    connectionArn: z.string().regex(/^arn:aws[a-z-]*:(codeconnections|codestar-connections):[a-z0-9-]+:\d{12}:connection\/[0-9a-f-]{36}$/, 'an AWS CodeConnections connection ARN').optional(),
    /** Whether the connection is authorized (AVAILABLE), so the runner projects can be made. A new connection is
     * PENDING until a person authorizes it once in the AWS console, and CodeBuild cannot make a runner's webhook
     * against a pending one, so the tools deploy with false first (the connection, no runners), wait for the person,
     * and deploy again with true. True by default, so a plain `cdk deploy` never removes runners that exist. */
    connectionReady: z.boolean().default(true),
    /** The runner webhooks' Attempt (src/infra/runner.ts): unset, a new one every deploy, so a webhook GitHub refused
     * is tried again on the next deploy; set only to keep templates the same between synths (tests). */
    webhookAttempt: z.string().min(1).optional(),
    /** the CodeBuild compute type of a job (a job can ask for another with an `instance-size:` label) */
    computeType: z.enum(['BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE', 'BUILD_GENERAL1_XLARGE', 'BUILD_GENERAL1_2XLARGE']).default('BUILD_GENERAL1_LARGE'),
    /** the CodeBuild image jobs run on: Ubuntu 24.04 (standard:8.0), like the GitHub-hosted ubuntu-24.04 runners the workflows were
     * written for (22.04's standard:7.0 has no nextpnr-ecp5, nextpnr-gowin or fpga-trellis, which CI installs) */
    image: z.string().min(3).default('aws/codebuild/standard:8.0'),
    /** Docker-in-Docker for jobs that build containers */
    privileged: z.boolean().default(false),
    /** Docker-in-Docker for the build-only repositories' runners (`ciRepositories`) alone: trace's own builds its images
     * there when this installation publishes them (src/installer/release.ts) */
    ciPrivileged: z.boolean().default(false),
  }).strict().prefault({}),
  /** The web app (src/infra/web.ts, README "Web app", docs/web-build.md): the static app on S3 behind CloudFront, its
   * backend Lambda behind the same address (/api/*), AppSync Events for live updates, a Cognito app client of its own,
   * and the pool's choice-based sign-in (passkeys with the app's address as relying party). In its own nested stack in
   * either layout. */
  web: z.object({
    enabled: z.boolean().default(true),
    /** a custom domain for the app (e.g. trace.example.com), with certificateArn; unset: CloudFront's own address. The
     * DNS record (a CNAME or alias to the distribution) is the person's to make */
    domainName: z.string().regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain name such as trace.example.com').optional(),
    /** the ACM certificate for domainName, in us-east-1 (CloudFront's) */
    certificateArn: z.string().regex(/^arn:aws[a-z-]*:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]{36}$/, 'an ACM certificate ARN in us-east-1').optional(),
    /** the Bedrock model or inference profile the app's chat agent uses; unset: `model`, the agents' (webModel) */
    model: z.string().min(3).optional(),
    /** CloudWatch dashboards the Operations page may read, besides the agents' own (`<prefix>-agents`) */
    dashboards: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, 'a CloudWatch dashboard name')).max(20).default([]),
    /** A verified Amazon SES identity (an address, or one at a verified domain) the user pool sends email from. Email
     * one-time codes as a first sign-in factor need it (Cognito sends them only through SES): unset, sign-in offers
     * passkeys and passwords, and Cognito's own sender keeps sending the invitations. */
    sesFrom: z.string().email().optional(),
    /** An AWS WAF (WAFv2) web ACL to put in front of the app's address: CLOUDFRONT scope, so it is made in us-east-1,
     * outside this stack (e.g. AWS's managed common rules and a rate-based rule per address). Unset: no WAF; the
     * backend's own per-person limits still apply */
    webAclArn: z.string().regex(/^arn:aws[a-z-]*:wafv2:us-east-1:\d{12}:global\/webacl\/[\w-]+\/[0-9a-f-]{36}$/, 'a WAFv2 web ACL ARN of CLOUDFRONT scope (us-east-1, global/webacl/…)').optional(),
    /** AWS WAF in front of the app (src/infra/edge.ts): AWS's managed rules, rate limits per address, a size limit.
     * On by default (about US$11 a month and US$0.60 per million requests): the address is public and sign-in is not
     * behind a token. In the installation's region when that is us-east-1, else in the stack `<prefix>-edge` there,
     * whose output the tools pass back as aclArn. Ignored when webAclArn names a web ACL of your own */
    waf: z.object({
      enabled: z.boolean().default(true),
      /** requests to /api/* per address in 5 minutes */
      apiRequestsPer5Minutes: z.number().int().min(100).max(2_000_000_000).default(1000),
      /** requests to /api/auth/* (sign-in) per address in 5 minutes */
      authRequestsPer5Minutes: z.number().int().min(10).max(2_000_000_000).default(100),
      /** the `<prefix>-edge` stack's web ACL (its WebAclArn output), set by the installer and the self-update before
       * they deploy this stack; unset outside us-east-1, the app has no WAF until it is */
      aclArn: z.string().regex(/^arn:aws[a-z-]*:wafv2:us-east-1:\d{12}:global\/webacl\/[\w-]+\/[0-9a-f-]{36}$/, 'a WAFv2 web ACL ARN of CLOUDFRONT scope').optional(),
    }).strict().prefault({}),
    /** The regions a global or cross-region inference profile may route the chat model to (the backend may invoke the
     * model there); unset: any region */
    modelRegions: z.array(z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, 'an AWS region')).max(30).optional(),
  }).strict().prefault({}),
  /** Keeping the installation up to date (README "Staying up to date"): when set, the stack has the role
   * `<prefix>-self-update` (SelfUpdateRoleArn), which only trace's own repository's ci workflow (.github/workflows/ci.yml)
   * on `branch` can assume through GitHub OIDC. That job reads the settings the installer saved (installation/props.json
   * in the central bucket) and deploys this stack again with them (src/installer/update.ts). Unset: no such role. */
  selfUpdate: z.object({
    /** trace's own repository, OWNER/REPO (the installer's src/installer/source.ts) */
    repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO'),
    /** the branch whose ci workflow may update the installation */
    branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/, 'a branch name').default('main'),
  }).strict().optional(),
  /** GitHub's immutable OIDC subject prefix (IMMUTABLE_SUBJECT) of each repository whose workflows assume a role here,
   * by OWNER/REPO in lower case: its roles trust that form beside `repo:OWNER/REPO` (githubSubjects). A repository not
   * listed is trusted by its name form only. */
  githubSubjects: z.record(z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/, 'OWNER/REPO in lower case'), z.string().regex(IMMUTABLE_SUBJECT, 'repo:OWNER@ID/REPO@ID')).default({}),
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
  /** Cloud cost per project (src/core/cost.ts, src/infra/cost.ts). */
  cost: z.object({
    /** overrides of the price table the estimates use (src/core/prices.ts), with their date: they win over the price
     * list and the built-in table */
    prices: PriceOverridesSchema.optional(),
    /** the price table from the AWS price list (Price List Query API, GetProducts), refreshed once a day by the cost
     * Lambda at cost.explorer.at into installation/cost/prices.json (src/core/price-list.ts, src/core/prices-store.ts);
     * off: the built-in table and the overrides only */
    priceList: z.object({
      enabled: z.boolean().default(true),
      /** the Price List endpoint asked; unset: the nearest of the three to the installation's region */
      endpoint: z.enum(['us-east-1', 'eu-central-1', 'ap-south-1']).optional(),
    }).strict().prefault({}),
    /** a daily read of what AWS billed each project, from Cost Explorer by the trace:project cost allocation tag */
    explorer: z.object({
      enabled: z.boolean().default(true),
      /** activate trace:project and trace:installation as cost allocation tags when they are not (needs the account
       * to be allowed to: in an organization, only its management account is) */
      activateTags: z.boolean().default(true),
      /** when it reads, UTC, HH:MM */
      at: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).default('06:17'),
    }).strict().prefault({}),
  }).strict().prefault({}),
}).strict().superRefine((p, ctx) => {
  if (p.runners.auth === 'token' && p.runners.connectionArn) ctx.addIssue({ code: 'custom', path: ['runners', 'connectionArn'], message: "runners.connectionArn is for auth 'connection': with auth 'token' the runners use CodeBuild's GitHub source credential" })
  if (p.layoutMigration && p.layout !== 'flat') ctx.addIssue({ code: 'custom', path: ['layoutMigration'], message: 'layoutMigration moves a flat installation: it needs layout flat' })
  // the library gateway's name (`<prefix>-library`) must match AgentCore's ^([0-9a-zA-Z][-]?){1,48}$
  if (p.gateway.enabled && !/^([0-9a-zA-Z][-]?){1,48}$/.test(`${p.prefix}-library`)) ctx.addIssue({ code: 'custom', path: ['prefix'], message: 'with the library gateway, the prefix can\'t end with a dash or have two in a row' })
  // external access's runtimes (`<prefix>_external`, `<prefix>_mcp`) must match AgentCore's runtime name pattern
  if (p.external.enabled) {
    for (const name of [externalRuntimeName(p.prefix), mcpRuntimeName(p.prefix)]) {
      if (!RUNTIME_NAME.test(name)) ctx.addIssue({ code: 'custom', path: ['prefix'], message: `with external access, the runtime name ${name} must be a letter then at most 47 letters, digits or underscores: use a shorter prefix` })
    }
  }
  // a custom domain is served with its certificate: one without the other is a mistake
  if (Boolean(p.web.domainName) !== Boolean(p.web.certificateArn)) ctx.addIssue({ code: 'custom', path: ['web', p.web.domainName ? 'certificateArn' : 'domainName'], message: 'web.domainName and web.certificateArn go together: the custom domain needs its us-east-1 certificate' })
  if (p.cpu.vcpus > p.cpu.maxVcpus)ctx.addIssue({ code: 'custom', path: ['cpu', 'vcpus'], message: `a CPU job asks for ${p.cpu.vcpus} vCPUs, more than cpu.maxVcpus (${p.cpu.maxVcpus})` })
  const listed = new Set(p.repositories.map((r) => (r.split('@')[0] ?? '').toLowerCase()))
  // a build-only repository is never a project too (a project has its own runner), nor shares a project's hash (the
  // runner project's name is `<prefix>-ci-<hash>`)
  const hashes = new Map(p.repositories.map((r) => { const slug = (r.split('@')[0] ?? '').toLowerCase(); return [projectHash(slug), slug] as const }))
  p.ciRepositories.forEach((r, i) => {
    const slug = r.toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.][a-z0-9._-]{0,99}$/.test(slug) || slug.includes('..')) return // refused above
    if (listed.has(slug)) ctx.addIssue({ code: 'custom', path: ['ciRepositories', i], message: `${r} is one of the repositories already (a project has its own build runner): list it once` })
    else if (hashes.has(projectHash(slug))) ctx.addIssue({ code: 'custom', path: ['ciRepositories', i], message: `${r} and ${hashes.get(projectHash(slug))} have the same short hash ${projectHash(slug)}: rename one` })
  })
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
  if (!raw) throw new Error('TRACE_INFRA is not set: run `tracectl install`, or set it to the stack settings as JSON')
  return InfraPropsSchema.parse(JSON.parse(raw))
}

/** AgentCore runtime names: a letter, then letters, digits and underscores, at most 48 characters. The API runtime's;
 * the workers' are workerRuntimeName (one per project). */
export const apiRuntimeName = (prefix: string): string => `${prefix.replace(/-/g, '_')}_api`.slice(0, 48)

/** AgentCore's pattern for a runtime's name. */
export const RUNTIME_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/

/** External access's runtimes (external.enabled), named from the prefix as the API's is, but never cut short: a name
 * too long is refused when the settings are read (the schema's check), not silently made to collide. */
export const externalRuntimeName = (prefix: string): string => `${prefix.replace(/-/g, '_')}_external`
export const mcpRuntimeName = (prefix: string): string => `${prefix.replace(/-/g, '_')}_mcp`

/** The Cognito resource server connected systems' scopes belong to (`trace-external/read`, `trace-external/write`). */
export const EXTERNAL_RESOURCE_SERVER = 'trace-external'
export const EXTERNAL_SCOPES = ['read', 'write'] as const

/** External access's outputs (external.enabled): the two addresses connected systems call, the token address they get
 * a token at, and the resource server their scopes belong to. */
export const EXTERNAL_OUTPUTS = { apiUrl: 'ExternalApiUrl', mcpUrl: 'McpUrl', tokenUrl: 'TokenUrl', resourceServer: 'ExternalResourceServer' } as const

/** The model the web app's chat agent uses: web.model, else the agents'. */
export const webModel = (cfg: Pick<InfraProps, 'model' | 'web'>): string => cfg.web.model ?? cfg.model

/** The web app's settings parameter (SSM, String): a fixed name, so the backend finds it without a reference that
 * would make a cycle (docs/web-build.md). */
export const webConfigParameter = (prefix: string): string => `/${prefix}/web/config`

/** The web app's outputs (the parent's): its address, its distribution, the live events' HTTP endpoint, and its
 * Cognito app client. */
export const WEB_OUTPUTS = { url: 'WebUrl', distributionId: 'WebDistributionId', eventsEndpoint: 'EventsApiEndpoint', clientId: 'WebClientId' } as const

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
export const projectOutputs = (repository: string): { runtimeArn: string; roleArn: string; secretArn: string; jobDefinition: string; memoryId: string; runnerProject: string } => {
  const h = projectHash(repository)
  return {
    runtimeArn: `Project${h}RuntimeArn`, roleArn: `Project${h}ActionsRoleArn`, secretArn: `Project${h}GithubSecretArn`, jobDefinition: `Project${h}GpuJobDefinition`,
    memoryId: `Project${h}MemoryId`, runnerProject: `Project${h}RunnerProject`,
  }
}

/** A build-only repository's output (the parent's, in either layout): its CodeBuild runner project's name, which the
 * installer sets as that repository's TRACE_CODEBUILD_PROJECT. Absent while the runners wait for the connection. */
export const ciRunnerOutput = (repository: string): string => `CiRunner${projectHash(repository)}Project`

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

/** The library gateway's outputs (gateway.enabled): its URL, and the distributor-keys secret the installer writes. */
export const LIBRARY_GATEWAY_OUTPUT = 'LibraryGatewayUrl'
export const LIBRARY_KEYS_OUTPUT = 'LibraryKeysSecretArn'

/** The ARN of the GitHub connection the runners use (runners.connectionArn, or the one the stack created): the
 * installer reads it after the first deploy to show the person what to authorize. */
export const CONNECTION_OUTPUT = 'GithubConnectionArn'
/** 'true' when the stack created that connection itself (no runners.connectionArn): the tools then keep using it,
 * without passing its ARN, so the stack keeps managing it. */
export const CONNECTION_CREATED_OUTPUT = 'GithubConnectionCreated'

/** The installation's own settings, as the installer last deployed them (installation/props.json in the central bucket:
 * no secret in it), for the self-update job (src/installer/update.ts). Here, not in src/core/project.ts, so the harness
 * bundle does not carry it. No project's role, the API's or a job's may read or write it: only the installer (the
 * person's own credentials) writes it and only the self-update role reads it. */
export const INSTALLATION_PREFIX = 'installation'
export const INSTALLATION_RECORD_KEY = `${INSTALLATION_PREFIX}/props.json`

/** The self-update role's ARN (selfUpdate): the installer sets it as trace's own repository's TRACE_UPDATE_ROLE. */
export const SELF_UPDATE_OUTPUT = 'SelfUpdateRoleArn'
/** The self-update role's name: one per installation (its prefix). */
export const selfUpdateRoleName = (prefix: string): string => `${prefix}-self-update`
/** The central bucket's name, an output: where the installer saves the installation's settings (INSTALLATION_PREFIX). */
export const CENTRAL_BUCKET_OUTPUT = 'CentralBucket'
/** The CDK bootstrap qualifier the installer bootstraps with (`cdk bootstrap` without --qualifier: CDK's default), which
 * names the bootstrap roles a deploy assumes: cdk-<qualifier>-{deploy,file-publishing,image-publishing,lookup}-role-<account>-<region>. */
export const CDK_QUALIFIER = 'hnb659fds'

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
