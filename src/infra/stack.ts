/**
 * The cloud side of trace, in one CDK stack:
 *
 *   central bucket      $TRACE_HOME (central/): the central database (datasheets, parts) every project shares;
 *                       projects/<slug>/ and jobs/<slug>/ for each project's own data and GPU job files; access/ for
 *                       who may do what (the API's only); prompts/ for the installation's prompt overrides (the API
 *                       writes them, conditionally; workers and workflows read them)
 *   agent image         built from this repository by AWS CodeBuild on arm64 (no local Docker), pushed to ECR; every
 *                       runtime runs it. At most 2 GB (AgentCore's limit; its build fails over AGENT_IMAGE_MAX_BYTES)
 *   tools image         (nested layout) built the same way from agent/Dockerfile.tools: KiCad, Blender, the FPGA and
 *                       verification tools, CalculiX and ffmpeg, which each project's tools function runs (its own AWS
 *                       Lambda function, src/infra/tools.ts) for the worker
 *   projects            one ProjectStack per repository (src/infra/project.ts): its worker runtime on Bedrock
 *                       AgentCore with its own execution role, its GitHub token secret, its GitHub OIDC role, its
 *                       AgentCore memory, its GPU job definition and job role, and its CodeBuild GitHub Actions
 *                       runner project (src/infra/runner.ts: its CI jobs run on AWS, on GitHub's runners only until
 *                       it exists; its role gives a job no AWS access), once the GitHub connection is authorized
 *                       (runners.connectionReady). Each role reaches that project's
 *                       resources only, so the line between projects holds in IAM even though the agent has Bash
 *                       and the role's credentials. Layout 'nested' (the default) puts each in its own nested stack,
 *                       so this stack holds one resource per project and 60 fit; 'flat' keeps them here, as earlier
 *                       installations have them (about 20 fit)
 *   GitHub connection   runners.auth 'connection' only: the AWS CodeConnections connection the runners reach GitHub
 *                       through: the one given (runners.connectionArn), or `<prefix>-github`, created here and kept
 *                       (Retain) when the stack goes; its ARN is the GithubConnectionArn output (src/infra/runner.ts
 *                       GithubConnection). With auth 'token' the runners use the account's CodeBuild GitHub source
 *                       credential instead, and there is no connection
 *   build-only runners  one CodeBuild runner project per `ciRepositories` entry (such as trace's own repository), in
 *                       this stack in either layout, with its CiRunner<hash>Project output; nothing else of a
 *                       project. Like the projects' runners, only once the connection is authorized (or at once, with
 *                       auth 'token'); privileged with runners.ciPrivileged
 *   agent memory        AgentCore Memory (src/infra/memory.ts): one per project, made by its ProjectStack, still
 *                       namespaced /trace/<owner>/<repo>/<agent>/; each worker may use only its own project's memory
 *   GPU                 one AWS Batch queue and compute environment shared by every project, and (cpu.enabled) a
 *                       second queue and environment of CPU instances for CPU-heavy remote jobs (src/infra/gpu.ts).
 *                       The deploy starts the GPU image's build without waiting for it, so a failed GPU image cannot
 *                       roll back the core; the installer waits for it afterwards
 *   observability       OpenTelemetry (ADOT) from every runtime and the GPU jobs, CloudWatch Transaction Search,
 *                       each project memory's vended logs and traces, and a dashboard (src/infra/observability.ts)
 *   people              a Cognito user pool (no self sign-up; admins invite people) with three classes as groups —
 *                       admin, user (read/write on assigned projects), guest (read on assigned projects) — and the
 *                       API runtime: the same image in `api` mode, reachable only with a Cognito token, which checks
 *                       the person's class and project assignments (src/core/access.ts) on every request
 *   web app             (web.enabled) the static app on S3 behind CloudFront, its backend Lambda on /api/*, AppSync
 *                       Events, its own Cognito app client and the pool's choice-based sign-in, with the app's address
 *                       as the passkey relying party (src/infra/web.ts: the address in its own nested stack, made
 *                       before the pool; what names the pool in this one, after it)
 *
 * The API runtime is the one component that spans projects: it reads every project's settings and status with the
 * shared GitHub token, reads (never writes) the records of every project's memory, keeps which of them people marked
 * inactive (projects/<slug>/memory-state), and hands tasks to each project's worker
 * runtime (InvokeAgentRuntime), always after its access check. It runs no model and gives nothing a shell.
 *
 * Workers accept only IAM (their repository's workflows, and the API); the API accepts only Cognito tokens (people).
 * A person's token can never reach a worker, and a workflow never acts as a person.
 *
 * Outputs carry everything the installer then writes into GitHub (each repository's variables, from that project's
 * outputs: src/infra/props.ts projectOutputs, the parent's own in the flat layout and each project's nested stack's in
 * the nested one, which the installer reads there) and the local settings.
 */
import { join } from 'node:path'
import { CfnOutput, CfnParameter, CfnResource, CustomResource, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Asset } from 'aws-cdk-lib/aws-s3-assets'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { Provider } from 'aws-cdk-lib/custom-resources'
import type { Construct, IConstruct } from 'constructs'
import { MEMORY_STATE } from '../agents/runtime/memory-state.js'
import { integrationsPrefix } from '../core/integrations.js'
import { JOBS_PREFIX, PROJECTS_PREFIX, memoryName, projectHash, projectSlug, runnerProjectName } from '../core/project.js'
import { grantApiRuntime } from './api-grants.js'
import { ExternalAccess } from './external.js'
import { LibraryGateway } from './gateway.js'
import { AGENT_IMAGE_MAX_BYTES, imageBuildEnv, imageBuildSpec, imageContentTag } from './images.js'
import { FlatToolsStack, type ToolsImage, buildToolsImage, flatToolsFit, toolsImageProjectArn } from './tools.js'
import { bundlingRoot } from './lockfile.js'
import { GpuCompute } from './gpu.js'
import { KB_RETRIEVE_ACTIONS, VectorStore, knowledgeBaseArn } from './knowledge.js'
import { TraceMemory, grantReadRecords, sharedMemoryName } from './memory.js'
import { DISABLED_ENV, ENABLED_ENV, Observability, gpuTelemetryEnv } from './observability.js'
import { GithubConnection, RunnerProject, RunnerWebhooks } from './runner.js'
import { ACTUALS_OBJECTS, CostRead } from './cost.js'
import { OrderWatch, WATCH_OBJECTS, orderWatchName } from './order-watch.js'
import { orderWatchSecretsPrefix } from '../core/integrations-catalog.js'
import { apiVocabularyStatement } from './voice.js'
import { EDGE_REGION, edgeNeeded, edgeStackName } from './edge.js'
import { SELF_WRITABLE, TraceWeb, addWebClient, traceWebProps } from './web.js'
import { ACCESS_PREFIX, AGENT_FACTS, CENTRAL_PREFIX, PEOPLE_RECORDS, PROMPTS_PREFIX, type ProjectProps, ProjectNestedStack, ProjectStack, grantPrefixes } from './project.js'
import {
  CDK_QUALIFIER, CENTRAL_BUCKET_OUTPUT, INSTALLATION_PREFIX, GPU_IMAGE_BUILD_OUTPUT, type InfraProps, SELF_UPDATE_OUTPUT, ciRunnerOutput, LAYOUT_OUTPUT, selfUpdateRoleName, LIBRARY_GATEWAY_OUTPUT, LIBRARY_KEYS_OUTPUT, STACK_OUTPUTS_MAX, STACK_PARAMETERS_MAX, STACK_RESOURCES_MAX, apiRuntimeName, EXTERNAL_RESOURCE_SERVER, cpuEnabled, toolsEnabled, TOOLS_IMAGE_OUTPUT, webModel,
  githubSubjects, kbEnabled, projectRefs, projectSettings,
} from './props.js'

/** The tag every runtime (and memory) of an installation carries: its prefix. The API's grant on the workers is scoped
 * by it as well as by their ARNs, so it can never reach another installation's runtime in the account. */
export const INSTALLATION_TAG = 'trace:installation'

/** The repository root, from dist/infra or src/infra. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..')

export { ACCESS_PREFIX, CENTRAL_PREFIX, PROMPTS_PREFIX } from './project.js'

/** AgentCore's limits on a runtime's environment (CreateAgentRuntime environmentVariables: 0–50 entries, each
 * value 0–5000 characters). */
export const ENV_VALUE_MAX = 5000
export const ENV_ENTRIES_MAX = 50

/** AgentCore runtime and memory ids: `<name>-<10 characters>`. */
const ID_SUFFIX = 11

/**
 * The longest `owner/repo=<id> …` list (the encoding of TRACE_WORKER_RUNTIMES and TRACE_PROJECT_MEMORIES) with these
 * slugs and resource names: what the value will be once CloudFormation has filled in the ids.
 */
export const idListLength = (entries: readonly { slug: string; name: string }[]): number =>
  entries.reduce((n, e, i) => n + (i ? 1 : 0) + e.slug.length + 1 + e.name.length + ID_SUFFIX, 0)

/** A Bedrock knowledge base id: 10 letters and digits, whatever its name (TRACE_PROJECT_KBS's ids). */
export const KB_ID_LENGTH = 10

/** The length of TRACE_PROJECT_KBS (`owner/repo=<knowledge base id> …`) for these slugs. */
export const kbListLength = (slugs: readonly string[]): number => slugs.reduce((n, s, i) => n + (i ? 1 : 0) + s.length + 1 + KB_ID_LENGTH, 0)

/** Refuse, at synth time, a runtime environment AgentCore would refuse at deploy time. `extra`: entries the
 * observability construct adds later as property overrides. */
export function checkRuntimeEnv(runtime: string, env: Record<string, unknown>, extra: number): void {
  const n = Object.keys(env).length + extra
  if (n > ENV_ENTRIES_MAX) throw new Error(`the ${runtime} runtime would have ${n} environment variables (AgentCore allows ${ENV_ENTRIES_MAX})`)
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && !v.includes('${Token[') && v.length > ENV_VALUE_MAX) throw new Error(`the ${runtime} runtime's ${k} would be ${v.length} characters (AgentCore allows ${ENV_VALUE_MAX})`)
  }
}

/**
 * Refuse, at synth time, a template CloudFormation would refuse at deploy time: more than 500 resources, 200 outputs
 * or 200 parameters. Counted after CDK has added the parameters and outputs that join nested stacks to the parent.
 */
export function stackQuotaErrors(stack: Stack, hint: string): string[] {
  const own = stack.node.findAll().filter((c: IConstruct) => Stack.of(c) === stack)
  const errors: string[] = []
  const check = (what: string, n: number, max: number): void => {
    if (n > max) errors.push(`${stack.node.path} would have ${n} ${what} (CloudFormation allows ${max} per template)${hint}`)
  }
  check('resources', own.filter((c) => c instanceof CfnResource).length, STACK_RESOURCES_MAX)
  check('outputs', own.filter((c) => c instanceof CfnOutput).length, STACK_OUTPUTS_MAX)
  check('parameters', own.filter((c) => c instanceof CfnParameter).length, STACK_PARAMETERS_MAX)
  return errors
}

/** What the image build doesn't need (keeps the source asset small and its hash stable), and what must not reach it:
 * credentials. `.npmrc` among them: the images read agent/npmrc, its settings without credentials (scripts/npmrc.mjs). */
export const SOURCE_EXCLUDE = [
  '.env', '.env.*', '**/.env', '**/.env.*', '*.pem', '**/*.pem', '*.key', '**/*.key', '.aws', '**/.aws', '.npmrc', '**/.npmrc', '.npmrc.local', '**/id_rsa*',
  '.git', 'node_modules', '**/node_modules', 'dist', 'cdk.out', '.venv', '**/__pycache__', '**/*.pyc', 'test', 'python/tests',
  '.trace', '*.db', '*.db-*', 'coverage', 'web/**',
]

/** Where the API keeps each project's chats (projects/<slug>/chats/) and the projects created from the app that wait for
 * the next stack update (installation/pending-projects/): docs/web-build.md. */
export const CHATS_PREFIX: (typeof PEOPLE_RECORDS)[number] = 'chats'
export const JOURNEY_PREFIX: (typeof PEOPLE_RECORDS)[number] = 'journey'
export const PENDING_PROJECTS = 'installation/pending-projects'

export class TraceStack extends Stack {
  constructor(scope: Construct, id: string, cfg: InfraProps, props: StackProps = {}) {
    super(scope, id, { ...props, env: { account: cfg.account, region: cfg.region }, description: 'trace: autonomous repository harness on Bedrock AgentCore' })
    const keep = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY

    // ------------------------------------------------------------------ data
    const central = new s3.Bucket(this, 'Central', {
      ...(cfg.centralBucketName ? { bucketName: cfg.centralBucketName } : {}),
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: keep,
      autoDeleteObjects: !cfg.retainData,
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(90) },
        // GPU job staging (src/gpu/protocol.ts): transient, kept a week for debugging
        { prefix: `${JOBS_PREFIX}/`, expiration: Duration.days(7), noncurrentVersionExpiration: Duration.days(1) },
      ],
    })
    // Its object events go to EventBridge (default bus), where rules pick the few that matter: a project's journey
    // record written (src/infra/project.ts JourneyEventsRule: journey.ask's wait) and its journey or agents' facts
    // written (src/infra/web.ts JourneyEvents: live updates on people's screens). Set as the bucket's own CloudFormation
    // property rather than CDK's eventBridgeEnabled, whose custom resource would add a Lambda to this stack. It is an
    // in-place update of the bucket (no interruption); like any change to a bucket's notification configuration it
    // replaces one made outside the stack, and this stack configures none
    const centralCfn = central.node.defaultChild as s3.CfnBucket
    centralCfn.addPropertyOverride('NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled', true)
    const traceHome = `s3://${central.bucketName}/${CENTRAL_PREFIX}`

    // The API's token: it reads and writes every project's settings (after its access check). Each worker has its
    // own project's secret instead (src/infra/project.ts).
    const githubToken = new secrets.Secret(this, 'GithubToken', {
      secretName: `${cfg.prefix}/github-token`,
      description: 'The GitHub token the trace API uses across projects (written by `tracectl install`, never by CloudFormation).',
      removalPolicy: RemovalPolicy.RETAIN,
    })

    // ------------------------------------------------------------------ the agent image (CodeBuild, arm64)
    const repo = new ecr.Repository(this, 'AgentImages', {
      repositoryName: `${cfg.prefix}-agent`,
      imageScanOnPush: true,
      removalPolicy: keep,
      emptyOnDelete: !cfg.retainData,
      lifecycleRules: [{ maxImageCount: 10 }],
    })
    const source = new Asset(this, 'AgentSource', { path: REPO_ROOT, exclude: SOURCE_EXCLUDE })
    // what the published images for this source are tagged (src/infra/images.ts; the release workflow tags them so)
    const contentTag = imageContentTag(REPO_ROOT)
    // Kept when the stack goes or rolls back (RETAIN): a failed image build fails the deploy, and the rollback would
    // otherwise delete the one log that says why. Its events expire after a month; the empty group stays until removed
    const buildLogs = new logs.LogGroup(this, 'AgentImageBuildLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN })
    const build = new codebuild.Project(this, 'AgentImageBuild', {
      projectName: `${cfg.prefix}-agent-image`,
      description: 'Builds the trace agent image (agent/Dockerfile) for AgentCore, on arm64',
      source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      environmentVariables: { REPOSITORY_URI: { value: repo.repositoryUri }, IMAGE_TAG: { value: 'latest' }, ...imageBuildEnv(cfg.images, 'agent', contentTag) },
      timeout: Duration.minutes(90),
      logging: { cloudWatch: { logGroup: buildLogs } },
      // the published image when there is one for this source, else a build cached on the previous image (images.ts)
      buildSpec: codebuild.BuildSpec.fromObject(imageBuildSpec({ dockerfile: 'agent/Dockerfile', platform: 'linux/arm64', maxBytes: AGENT_IMAGE_MAX_BYTES })),
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
    })
    repo.grantPullPush(build)
    source.grantRead(build)

    const builder = (name: string, handler: 'onEvent' | 'isComplete'): NodejsFunction => new NodejsFunction(this, name, {
      entry: join(REPO_ROOT, 'src', 'infra', 'lambda', 'image-build.ts'),
      ...bundlingRoot(REPO_ROOT),
      handler,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(1),
      bundling: { format: OutputFormat.CJS, target: 'node22', externalModules: ['@aws-sdk/*'] },
      logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
    })
    const start = builder('ImageBuildStart', 'onEvent')
    const poll = builder('ImageBuildPoll', 'isComplete')
    for (const f of [start, poll]) f.addToRolePolicy(new iam.PolicyStatement({ actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'], resources: [build.projectArn] }))
    // a failed build's message carries the end of its log (lambda/image-build.ts buildLogTail): the rollback deletes it.
    // The group's ARN ends in :* and so covers its streams
    poll.addToRolePolicy(new iam.PolicyStatement({ sid: 'ImageBuildLogTail', actions: ['logs:GetLogEvents'], resources: [buildLogs.logGroupArn] }))
    const provider = new Provider(this, 'ImageBuildProvider', { onEventHandler: start, isCompleteHandler: poll, queryInterval: Duration.seconds(30), totalTimeout: Duration.minutes(100) })
    const imageUri = `${repo.repositoryUri}:${source.assetHash}`

    // ------------------------------------------------------------------ GPU jobs (AWS Batch), built the same way on amd64
    const gpu = cfg.gpu.enabled
      ? new GpuCompute(this, 'Gpu', {
          prefix: cfg.prefix, instanceTypes: cfg.gpu.instanceTypes, maxVcpus: cfg.gpu.maxVcpus, spot: cfg.gpu.spot,
          bucket: central, source, buildProvider: provider, retainData: cfg.retainData, images: cfg.images, contentTag,
          allowBuild: (arn) => { for (const f of [start, poll]) f.addToRolePolicy(new iam.PolicyStatement({ actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'], resources: [arn] })) },
          environment: gpuTelemetryEnv(cfg),
          cpu: cpuEnabled(cfg) ? cfg.cpu : null,
        })
      : null
    // ------------------------------------------------------------------ the installation-wide memory of earlier versions
    // Each project has its own memory now (src/infra/project.ts). The old one had no DeletionPolicy, so removing it
    // from the template would delete it whatever retainData says: memory.legacySharedMemory keeps it here for one
    // deploy, unchanged (its name must not change: that replaces it), unused and now Retain, so the next deploy
    // without it leaves it in the account. Nothing is granted on it and no runtime is told it.
    const legacy = cfg.memory.legacySharedMemory
      ? new TraceMemory(this, 'AgentMemory', {
          name: sharedMemoryName(cfg.prefix),
          description: 'trace: the agents\' memory, by project and agent (actor <owner>/<repo>/<agent>)',
          eventExpiryDays: cfg.memory.eventExpiryDays,
          removalPolicy: RemovalPolicy.RETAIN,
        })
      : null
    const image = new CustomResource(this, 'AgentImage', {
      serviceToken: provider.serviceToken,
      properties: { ProjectName: build.projectName, ImageUri: imageUri, SourceHash: source.assetHash },
    })
    // started only once the project's role (its policy, a resource of its own) and the provider's may do their part
    image.node.addDependency(build, start, poll)

    // ------------------------------------------------------------------ the tools image (CodeBuild, arm64): the tools functions'
    // KiCad, Blender, the FPGA and verification tools, CalculiX and ffmpeg (agent/Dockerfile.tools, src/infra/tools.ts),
    // which AgentCore's 2 GB image limit keeps out of the agent image. Waited for, like the agent image: a function
    // can't be made before its image is in the repository. Nested layout only (props.ts toolsEnabled)
    const toolsBuild = (scope: Construct): ToolsImage => {
      // its build is started and polled by the image-build provider: by the project's name (the same in either layout,
      // and no reference to the flat layout's tools stack, which takes the provider's token from this one)
      for (const f of [start, poll]) f.addToRolePolicy(new iam.PolicyStatement({ actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'], resources: [toolsImageProjectArn(this, cfg.prefix)] }))
      return buildToolsImage(scope, {
        prefix: cfg.prefix, source, buildLogs, serviceToken: provider.serviceToken,
        environment: imageBuildEnv(cfg.images, 'tools', contentTag), dependsOn: [start, poll],
      })
    }
    const tools = toolsEnabled(cfg) ? toolsBuild(this) : null

    // ------------------------------------------------------------------ the projects (one worker runtime and its roles each)
    const issuer = 'token.actions.githubusercontent.com'
    const oidc = cfg.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GithubOidc', { url: `https://${issuer}`, clientIds: ['sts.amazonaws.com'] })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', `arn:aws:iam::${cfg.account}:oidc-provider/${issuer}`)
    // the 'drain' step of the move to nested stacks: every project out of the stack, so a nested deploy can make them again
    const refs = cfg.layoutMigration === 'drain' ? [] : projectRefs(cfg.repositories)
    const nested = cfg.layout === 'nested'
    // the knowledge bases' vectors: one S3 vector bucket for the installation, an index per project in it (nested only)
    const vectors = refs.some((r) => kbEnabled(cfg, r.repository)) ? new VectorStore(this, 'KnowledgeVectors', { prefix: cfg.prefix, removalPolicy: keep }) : null
    // the library gateway (gateway.enabled): the shared datasheets and parts tools behind AgentCore Gateway
    const library = cfg.gateway.enabled ? new LibraryGateway(this, 'Library', { prefix: cfg.prefix, bucket: central, traceHome, root: REPO_ROOT }) : null
    // how the CodeBuild runners reach GitHub (src/infra/runner.ts). auth 'connection': the GitHub connection, given or
    // created here, and the runner projects only once it is authorized (runners.connectionReady). auth 'token': the
    // account's CodeBuild GitHub source credential (the installer imported it before the deploy), so no connection
    const connection = cfg.runners.auth === 'connection' ? new GithubConnection(this, 'GithubConnection', { prefix: cfg.prefix, connectionArn: cfg.runners.connectionArn }) : null
    const runnerAuth = connection ? (cfg.runners.connectionReady ? { connectionArn: connection.connectionArn } : null) : { connectionArn: null }
    // the runners' webhooks, made by one custom resource provider here (src/infra/runner.ts RunnerWebhooks), so GitHub
    // refusing one leaves its repository on GitHub's runners instead of failing the deploy. For the build-only
    // repositories and the nested layout's projects; the flat layout's projects keep CloudFormation's own webhook (a flat
    // stack of 20 projects is at its 500 resources already, so it has no room for a custom resource each)
    const webhooks = runnerAuth && (cfg.ciRepositories.length || (nested && refs.length))
      ? new RunnerWebhooks(this, 'RunnerWebhooks', { prefix: cfg.prefix, root: REPO_ROOT, connectionArn: runnerAuth.connectionArn }).serviceToken
      : null
    const runnerSource = runnerAuth ? { ...runnerAuth, webhooks: nested ? webhooks : null } : null
    // the build-only repositories (ciRepositories): a runner project each, here in the parent, and its output
    if (runnerSource) {
      const { computeType, image, privileged, ciPrivileged } = cfg.runners
      for (const r of cfg.ciRepositories) {
        const repository = projectSlug(r)
        const runner = new RunnerProject(this, `CiRunner${projectHash(repository)}`, {
          name: runnerProjectName(cfg.prefix, repository), repository, connectionArn: runnerSource.connectionArn, webhooks,
          computeType, image, privileged: privileged || ciPrivileged,
          ...(cfg.runners.webhookAttempt ? { attempt: cfg.runners.webhookAttempt } : {}),
          tags: { 'trace:installation': cfg.prefix, 'trace:ci': repository },
        })
        // its project's name once it has its webhook, `none` while GitHub refuses it (core/project.ts runnerOf)
        new CfnOutput(this, ciRunnerOutput(repository), { value: runner.runner, description: `${repository}: its CodeBuild runner project (TRACE_CODEBUILD_PROJECT), build only; none while GitHub refuses its webhook` })
      }
    }
    const projectProps = (ref: (typeof refs)[number]): ProjectProps => ({
      cfg, project: ref, bucket: central, images: repo, imageUri: image.getAttString('ImageUri'), oidcProviderArn: oidc.openIdConnectProviderArn,
      gpu, vectorBucketArn: vectors?.arn ?? null, gateway: library?.ref ?? null,
      tools: tools ? { images: tools.images, tag: tools.tag } : null,
      runnerSource,
      environment: {
        AWS_REGION: cfg.region, TRACE_HOME: traceHome, CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: cfg.model, TRACE_WORKSPACE: '/mnt/workspace',
        // the installation's price overrides for the cost ledger's estimates (src/core/prices.ts), which win over the
        // price list the workers read from installation/cost/prices.json and over the built-in table
        ...(cfg.cost.prices ? { TRACE_PRICES: JSON.stringify(cfg.cost.prices) } : {}),
      },
    })
    const nestedStacks: ProjectNestedStack[] = []
    const projects = refs.map((ref) => {
      if (!nested) return new ProjectStack(this, `Project${ref.hash}`, projectProps(ref))
      const n = new ProjectNestedStack(this, `Project${ref.hash}Stack`, projectProps(ref))
      nestedStacks.push(n)
      return n.project
    })
    // The API is told every worker runtime, and every project's memory, as `owner/repo=<id>` separated by spaces
    // (src/api/workers.ts, src/agents/runtime/memory.ts parseProjectMemories). Each is one value of at most 5000 characters.
    // (empty while the move to nested stacks drains the projects: Fn.join refuses an empty list)
    const idList = (ids: readonly string[]): string => (!ids.length ? '' : Fn.join(' ', ids.map((id, i) => Fn.join('=', [refs[i]?.slug ?? '', id]))))
    const workerList = idList(projects.map((p) => p.runtime.attrAgentRuntimeId))
    const workerListLength = idListLength(refs.map((r, i) => ({ slug: r.slug, name: projects[i]?.runtimeName ?? '' })))
    if (workerListLength > ENV_VALUE_MAX) throw new Error(`too many repositories for one installation: the API's list of worker runtimes would be ${workerListLength} characters (AgentCore allows ${ENV_VALUE_MAX})`)
    const memories = projects.flatMap((p) => (p.memory ? [p.memory] : []))
    const memoryEnv: Record<string, string> = {}
    if (memories.length) {
      memoryEnv.TRACE_PROJECT_MEMORIES = idList(projects.map((p) => p.memory?.memoryId ?? ''))
      const memoryListLength = idListLength(refs.map((r) => ({ slug: r.slug, name: memoryName(cfg.prefix, r.repository, projectSettings(cfg, r.repository).generation) })))
      if (memoryListLength > ENV_VALUE_MAX) throw new Error(`too many repositories for one installation: the API's list of project memories would be ${memoryListLength} characters (AgentCore allows ${ENV_VALUE_MAX})`)
    }
    // every project's knowledge base, for the API's kb.search (src/tools/kb/env.ts parseProjectKbs): the same encoding,
    // with only the projects that have one. Each id reaches the parent as an output of its project's nested stack.
    const kbs = projects.flatMap((p, i) => (p.knowledgeBase ? [{ slug: refs[i]?.slug ?? '', kb: p.knowledgeBase }] : []))
    if (kbs.length) {
      memoryEnv.TRACE_PROJECT_KBS = Fn.join(' ', kbs.map((k) => Fn.join('=', [k.slug, k.kb.knowledgeBaseId])))
      const kbLength = kbListLength(kbs.map((k) => k.slug))
      if (kbLength > ENV_VALUE_MAX) throw new Error(`too many repositories for one installation: the API's list of knowledge bases would be ${kbLength} characters (AgentCore allows ${ENV_VALUE_MAX})`)
    }

    // ------------------------------------------------------------------ the web app's address (src/infra/web.ts)
    // Its nested stack first: the pool takes its address as the passkey relying party, and nothing in it names the pool
    // ------------------------------------------------------------------ cloud cost per project (src/infra/cost.ts)
    // (and the AWS price list, refreshed by the same Lambda on the same daily schedule: cost.priceList)
    if (cfg.cost.explorer.enabled || cfg.cost.priceList.enabled) {
      new CostRead(this, 'CostRead', {
        prefix: cfg.prefix, settings: cfg.cost.explorer, central, root: REPO_ROOT,
        priceList: {
          ...cfg.cost.priceList, region: cfg.region, models: [cfg.model, webModel(cfg)],
          gpuTypes: cfg.gpu.enabled ? cfg.gpu.instanceTypes : [], cpuTypes: cpuEnabled(cfg) ? cfg.cpu.instanceTypes : [],
        },
      })
    }
    // ------------------------------------------------------------------ shipped orders, with their carrier (src/infra/order-watch.ts)
    const orderWatch = new OrderWatch(this, 'OrderWatch', { prefix: cfg.prefix, central, root: REPO_ROOT })
    const web = cfg.web.enabled ? new TraceWeb(this, 'Web', { ...traceWebProps(cfg, REPO_ROOT), central }) : null
    // email one-time codes need the pool to send through SES (Cognito's own sender cannot send them)
    const emailCodes = Boolean(web && cfg.web.sesFrom)

    // ------------------------------------------------------------------ people: Cognito and the API runtime
    const signIn = web
      ? 'To accept, open ' + web.url + '/invite and enter this email address and the temporary password; you then choose your own sign-in (a passkey, or a password with an authenticator app). You can also sign in with `tracectl login`.'
      : 'Sign in with `tracectl login`.'
    const users = new cognito.UserPool(this, 'Users', {
      userPoolName: `${cfg.prefix}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      userInvitation: {
        emailSubject: 'You have been invited to trace',
        emailBody: `You have been invited to trace. Your user name is {username} and your temporary password is {####} (it works once, for 7 days). ${signIn}`,
      },
      // a person's email is display only (identity is the sub), and a change to it takes effect only once the new
      // address is verified: until then the original stays, so nobody can take an address that is not theirs.
      // UserAttributeUpdateSettings is updatable in place on an existing pool (no replacement)
      keepOriginal: { email: true },
      // the web app's choice-based sign-in (USER_AUTH): passkeys bound to its address, passwords, and email codes when
      // the pool sends through SES. The CLI's client keeps SRP and the hosted domain
      ...(web ? {
        signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: true, emailOtp: emailCodes } },
        passkeyRelyingPartyId: web.domain,
        passkeyUserVerification: cognito.PasskeyUserVerification.PREFERRED,
      } : {}),
      ...(emailCodes && cfg.web.sesFrom ? { email: cognito.UserPoolEmail.withSES({ fromEmail: cfg.web.sesFrom, fromName: 'trace', sesRegion: cfg.region }) } : {}),
      removalPolicy: RemovalPolicy.RETAIN,
    })
    const domain = users.addDomain('Domain', { cognitoDomain: { domainPrefix: `${cfg.prefix}-${cfg.account}` } })
    const client = users.addClient('Cli', {
      userPoolClientName: `${cfg.prefix}-cli`,
      generateSecret: false,
      // a person may change nothing of their own profile but their email (Cognito requires a required attribute to be
      // writable), and that only through verification (keepOriginal above)
      writeAttributes: SELF_WRITABLE,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: cfg.callbackPorts.map((p) => `http://localhost:${p}/callback`),
        logoutUrls: cfg.callbackPorts.map((p) => `http://localhost:${p}/signed-out`),
      },
    })
    // the web app's own client: its sign-in pages call the pool's API (USER_AUTH, refresh), never the hosted domain
    const webClient = web ? addWebClient(users, cfg.prefix) : null
    // The three classes of person (src/core/access.ts). A person's class is their group, carried in their token.
    new cognito.CfnUserPoolGroup(this, 'AdminsGroup', { userPoolId: users.userPoolId, groupName: 'trace-admins', precedence: 0, description: 'admin: everything, on every project, including managing people' })
    new cognito.CfnUserPoolGroup(this, 'UsersGroup', { userPoolId: users.userPoolId, groupName: 'trace-users', precedence: 1, description: 'user: read and write on the projects they are assigned to' })
    new cognito.CfnUserPoolGroup(this, 'GuestsGroup', { userPoolId: users.userPoolId, groupName: 'trace-guests', precedence: 2, description: 'guest: read only, on the projects they are assigned to' })
    const admin = new cognito.CfnUserPoolUser(this, 'FirstAdmin', {
      userPoolId: users.userPoolId,
      username: cfg.adminEmail,
      userAttributes: [{ name: 'email', value: cfg.adminEmail }, { name: 'email_verified', value: 'true' }],
      desiredDeliveryMediums: ['EMAIL'],
    })
    const adminInGroup = new cognito.CfnUserPoolUserToGroupAttachment(this, 'FirstAdminIsAdmin', { userPoolId: users.userPoolId, groupName: 'trace-admins', username: cfg.adminEmail })
    adminInGroup.addDependency(admin)
    adminInGroup.node.addDependency(this.node.findChild('AdminsGroup'))

    // ------------------------------------------------------------------ the API's role
    // People's requests, after the access check: the access store, Cognito, the shared GitHub token, every project's
    // memory records (read only), the central database, and invoking the projects' workers. No model, no GPU.
    const apiRole = new iam.Role(this, 'ApiRuntimeRole', {
      roleName: `${cfg.prefix}-agent-api-${cfg.region}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cfg.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${cfg.region}:${cfg.account}:*` },
        },
      }),
      description: 'Run by the trace API on Bedrock AgentCore (signed-in people, every project after the access check)',
    })
    const apiName = apiRuntimeName(cfg.prefix)
    // what the API's code may do (src/infra/api-grants.ts), made once for both roles that run it: this one, the
    // people's, gets every statement; the external runtime's (external.enabled) only what connected systems' actions need
    const apiGrants = {
      scope: this, region: cfg.region, account: cfg.account, partition: this.partition, prefix: cfg.prefix, installationTag: INSTALLATION_TAG,
      images: repo, central, githubToken, workers: projects.map((p) => p.runtime.attrAgentRuntimeArn), memories,
      knowledgeBases: kbs.map((k) => k.kb.knowledgeBaseId), orderWatchArn: orderWatch.function.functionArn,
    }
    grantApiRuntime(apiRole, { ...apiGrants, runtimeName: apiName }, { people: true })

    const discoveryUrl = `https://cognito-idp.${cfg.region}.amazonaws.com/${users.userPoolId}/.well-known/openid-configuration`
    // the API's environment, built once: the people's API runtime has it, and (external.enabled) the external runtime
    // runs the same code with the same, in its own mode
    const apiEnv: Record<string, string> = {
      AWS_REGION: cfg.region,
      TRACE_HOME: traceHome,
      TRACE_GITHUB_SECRET_ARN: githubToken.secretArn,
      TRACE_WORKSPACE: '/mnt/workspace',
      TRACE_AGENT_MODE: 'api',
      TRACE_COGNITO_POOL_ID: users.userPoolId,
      TRACE_COGNITO_CLIENT_ID: client.userPoolClientId,
      ...(webClient ? { TRACE_COGNITO_WEB_CLIENT_ID: webClient.userPoolClientId } : {}),
      TRACE_COGNITO_ISSUER: `https://cognito-idp.${cfg.region}.amazonaws.com/${users.userPoolId}`,
      TRACE_AWS_ACCOUNT: cfg.account,
      TRACE_WORKER_RUNTIMES: workerList,
      // the workers' code version: tool calls move to a new session when it changes (src/api/workers.ts toolSession)
      TRACE_WORKER_BUILD: contentTag,
      TRACE_INTEGRATIONS_PREFIX: integrationsPrefix(cfg.prefix),
      // the order watch a check now invokes (order.check_now, src/api/actions-build.ts)
      TRACE_ORDER_WATCH: orderWatchName(cfg.prefix),
      // names the projects' dictation vocabularies (<prefix>-<hash>-<language>: src/api/actions-voice.ts), and (external
      // access) the connected systems' app clients (<prefix>-svc-<name>)
      TRACE_PREFIX: cfg.prefix,
      // what a project created in the web app gets, and how this installation can move (src/api/actions-layout.ts)
      TRACE_LAYOUT: cfg.layout,
      // the price table's other two sources (cost.get, usage.month: src/api/actions-cost.ts): the admin's overrides,
      // and whether the price list is fetched (the fetched table itself is read from installation/cost/prices.json)
      ...(cfg.cost.prices ? { TRACE_PRICES: JSON.stringify(cfg.cost.prices) } : {}),
      TRACE_PRICE_LIST: cfg.cost.priceList.enabled ? '1' : '0',
      // where this installation's self-update runs (projects.create says when a new project's agent arrives)
      ...(cfg.selfUpdate ? { TRACE_SELF_UPDATE: `${cfg.selfUpdate.repository}@${cfg.selfUpdate.branch}` } : {}),
      ...memoryEnv,
    }
    const lifecycle = { idleRuntimeSessionTimeout: cfg.idleTimeoutSeconds, maxLifetime: cfg.maxLifetimeSeconds }
    const filesystems = [{ sessionStorage: { mountPath: '/mnt/workspace' } }]

    // ------------------------------------------------------------------ external access (external.enabled, src/infra/external.ts)
    // connected systems' scopes, the external API and MCP runtimes (the external one with a role of its own, made from
    // the same grants as the API's minus everything only people's actions need), and the API role's grant on the
    // systems' app clients.
    // The external runtime gets the API's environment, plus the token address and the resource server; never its own
    // ARN or the MCP runtime's (the MCP runtime names it: that would be a cycle)
    const tokenUrl = `${domain.baseUrl()}/oauth2/token`
    const externalEnv: Record<string, string> = { TRACE_TOKEN_URL: tokenUrl, TRACE_EXTERNAL_RESOURCE_SERVER: EXTERNAL_RESOURCE_SERVER }
    const external = cfg.external.enabled
      ? new ExternalAccess(this, 'External', {
          prefix: cfg.prefix, region: cfg.region, account: cfg.account, pool: users, tokenUrl, discoveryUrl,
          images: repo, imageUri: image.getAttString('ImageUri'), apiRole, grants: apiGrants, apiEnvironment: { ...apiEnv, ...externalEnv },
          lifecycle, filesystems, tags: { [INSTALLATION_TAG]: cfg.prefix },
        })
      : null

    const api = new CfnRuntime(this, 'ApiRuntime', {
      agentRuntimeName: apiName,
      description: 'trace: what people do with their projects, behind Cognito and per-project grants',
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.getAttString('ImageUri') } },
      roleArn: apiRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      // the CLI's client, and the web app's (its backend calls the API with the person's token)
      authorizerConfiguration: { customJwtAuthorizer: { discoveryUrl, allowedClients: [client.userPoolClientId, ...(webClient ? [webClient.userPoolClientId] : [])] } },
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      lifecycleConfiguration: lifecycle,
      filesystemConfigurations: filesystems,
      // with external access, what services.create tells an admin: the two runtimes (their addresses), the token
      // address and the scopes' resource server
      environmentVariables: external
        ? { ...apiEnv, TRACE_EXTERNAL_RUNTIME_ARN: external.external.attrAgentRuntimeArn, TRACE_MCP_RUNTIME_ARN: external.mcp.attrAgentRuntimeArn, ...externalEnv }
        : apiEnv,
      tags: { [INSTALLATION_TAG]: cfg.prefix },
    })
    api.node.addDependency(apiRole)
    const observabilityEnv = Math.max(Object.keys(ENABLED_ENV).length, Object.keys(DISABLED_ENV).length)
    for (const r of [api, ...(external ? [external.external, external.mcp] : []), ...projects.map((p) => p.runtime)]) {
      const env = r.environmentVariables
      if (env && typeof env === 'object' && !('resolve' in env)) checkRuntimeEnv(r.agentRuntimeName, env, observabilityEnv)
    }
    // the installation's optional integrations (src/core/integrations.ts, integrations.* for admins): create, overwrite,
    // describe and delete them, never read their values
    apiRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ManageIntegrations',
      actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:TagResource'],
      resources: [`arn:${this.partition}:secretsmanager:${cfg.region}:${cfg.account}:secret:${integrationsPrefix(cfg.prefix)}*`],
    }))
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup',
        // users.class and the removal from a person's last project end their sessions
        'cognito-idp:AdminUserGlobalSignOut'],
      resources: [users.userPoolArn],
    }))

    // ------------------------------------------------------------------ observability (OpenTelemetry/ADOT, src/infra/observability.ts)
    new Observability(this, 'Observability', {
      prefix: cfg.prefix, settings: cfg.observability, gpu: Boolean(gpu), gpuJobRoles: gpu?.jobRoles ?? [],
      retainData: cfg.retainData, releaseDeliveries: cfg.layoutMigration === 'release',
      memories: projects.flatMap((p, i) => (p.memory
        ? [{
            id: p.node.id, hash: refs[i]?.hash ?? '', repository: refs[i]?.repository ?? '', generation: p.generation,
            name: memoryName(cfg.prefix, refs[i]?.repository ?? '', p.generation), arn: p.memory.memoryArn, memoryId: p.memory.memoryId, ...(nested ? { scope: p } : {}),
          }]
        : [])),
      runtimes: [
        ...projects.map((p) => ({ id: p.node.id, runtime: p.runtime, name: p.runtimeName, role: p.role })),
        { id: 'Api', runtime: api, name: apiName, role: apiRole },
        ...(external
          ? [{ id: 'External', runtime: external.external, name: external.externalName, role: external.externalRole }, { id: 'Mcp', runtime: external.mcp, name: external.mcpName, role: external.mcpRole }]
          : []),
      ],
    })

    // ------------------------------------------------------------------ the web app's parts that name the pool
    if (web && webClient) web.attach({ pool: users, client: webClient, apiRuntimeArn: api.attrAgentRuntimeArn, email: emailCodes })
    // ------------------------------------------------------------------ keeping the installation up to date (selfUpdate)
    // The role trace's own repository's ci workflow assumes, on `branch` only, to deploy this stack again with the
    // settings the installer saved (src/installer/update.ts). It may do exactly what that takes and nothing else:
    //   sts        AssumeRole on this account and region's CDK bootstrap roles (cdk-<qualifier>-*-role-<account>-<region>):
    //              the deploy itself runs as CDK's deploy role and CloudFormation's execution role, as the installer's does
    //   s3         GetObject on installation/* of the central bucket (the saved settings), nothing else of the bucket
    //   cfn        DescribeStacks and ListStackResources on this stack and its nested stacks (their outputs)
    //   github     the CodeConnections reads the installer makes to tell whether the GitHub connection is authorized, and
    //              (runners.auth token) whether CodeBuild has a GitHub source credential; never importing or changing one
    //   secret     GetSecretValue on the shared agent token (TRACE_CODEBUILD_PROJECT on the repositories), and
    //              PutSecretValue on the projects' token secrets (<prefix>/github-token/*: a project created in the web app
    //              gets a copy of the shared token, as the installer gives it)
    //   pending    list installation/pending-projects/* and put (mark) its records: the projects created in the web app
    // Whoever can merge to that branch can therefore change this installation: README "Staying up to date".
    if (cfg.selfUpdate) {
      const { repository, branch } = cfg.selfUpdate
      const { partition, account, region } = this
      const updater = new iam.Role(this, 'SelfUpdateRole', {
        roleName: selfUpdateRoleName(cfg.prefix),
        maxSessionDuration: Duration.hours(1),
        description: `Assumed only by ${repository}'s ci workflow on ${branch} (GitHub OIDC), to keep this trace installation up to date`.slice(0, 1000),
        assumedBy: new iam.WebIdentityPrincipal(oidc.openIdConnectProviderArn, {
          StringEquals: { [`${issuer}:aud`]: 'sts.amazonaws.com', [`${issuer}:sub`]: githubSubjects(repository, cfg.githubSubjects, `:ref:refs/heads/${branch}`) },
          // the workflow file the job comes from, at that branch: only .github/workflows/ci.yml, not another workflow there
          StringLike: { [`${issuer}:job_workflow_ref`]: `${repository}/.github/workflows/ci.yml@refs/heads/${branch}` },
        }),
      })
      // and, with the web app's WAF outside us-east-1, the bootstrap roles there and the edge stack's outputs
      // (src/installer/edge.ts: <prefix>-edge, and whether CDKToolkit is there); nothing else in us-east-1
      const edge = edgeNeeded(cfg)
      updater.addToPolicy(new iam.PolicyStatement({
        sid: 'CdkBootstrapRoles', actions: ['sts:AssumeRole'],
        resources: [`arn:${partition}:iam::${account}:role/cdk-${CDK_QUALIFIER}-*-${account}-${region}`, ...(edge ? [`arn:${partition}:iam::${account}:role/cdk-${CDK_QUALIFIER}-*-${account}-${EDGE_REGION}`] : [])],
      }))
      if (edge) {
        updater.addToPolicy(new iam.PolicyStatement({
          sid: 'EdgeStackOutputs', actions: ['cloudformation:DescribeStacks'],
          resources: [`arn:${partition}:cloudformation:${EDGE_REGION}:${account}:stack/${edgeStackName(cfg.prefix)}/*`, `arn:${partition}:cloudformation:${EDGE_REGION}:${account}:stack/CDKToolkit/*`],
        }))
      }
      updater.addToPolicy(new iam.PolicyStatement({ sid: 'InstallationSettings', actions: ['s3:GetObject'], resources: [central.arnForObjects(`${INSTALLATION_PREFIX}/*`)] }))
      updater.addToPolicy(new iam.PolicyStatement({
        sid: 'StackOutputs', actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources'],
        resources: [`arn:${partition}:cloudformation:${region}:${account}:stack/${this.stackName}/*`, `arn:${partition}:cloudformation:${region}:${account}:stack/${this.stackName}-*/*`],
      }))
      updater.addToPolicy(new iam.PolicyStatement({
        sid: 'GithubConnection', actions: ['codeconnections:GetConnection', 'codeconnections:ListTagsForResource'],
        resources: [`arn:${partition}:codeconnections:${region}:${account}:connection/*`, `arn:${partition}:codestar-connections:${region}:${account}:connection/*`],
      }))
      // ListConnections has no resource-level permission
      updater.addToPolicy(new iam.PolicyStatement({ sid: 'GithubConnections', actions: ['codeconnections:ListConnections'], resources: ['*'] }))
      // runners.auth token: whether CodeBuild has a GitHub source credential (it only looks; ListSourceCredentials has no
      // resource-level permission and returns no token)
      updater.addToPolicy(new iam.PolicyStatement({ sid: 'CodeBuildSourceCredential', actions: ['codebuild:ListSourceCredentials'], resources: ['*'] }))
      updater.addToPolicy(new iam.PolicyStatement({ sid: 'SharedAgentToken', actions: ['secretsmanager:GetSecretValue'], resources: [githubToken.secretArn] }))
      // projects created in the web app (projects.create, src/installer/pending.ts): list the requests the API recorded
      // under installation/pending-projects/ and mark them added (or count a failed attempt) after the deploy; nothing
      // else of the bucket is listed or written
      updater.addToPolicy(new iam.PolicyStatement({
        sid: 'PendingProjectsList', actions: ['s3:ListBucket'], resources: [central.bucketArn], conditions: { StringLike: { 's3:prefix': [`${PENDING_PROJECTS}/*`] } },
      }))
      updater.addToPolicy(new iam.PolicyStatement({ sid: 'PendingProjectsMark', actions: ['s3:PutObject'], resources: [central.arnForObjects(`${PENDING_PROJECTS}/*`)] }))
      // a project it adds gets its token secret written as the installer writes it (a copy of the shared token): only
      // the projects' secrets (<prefix>/github-token/<owner>/<repo>…), never their values read
      updater.addToPolicy(new iam.PolicyStatement({
        sid: 'ProjectTokenSecrets', actions: ['secretsmanager:PutSecretValue'],
        resources: [`arn:${partition}:secretsmanager:${region}:${account}:secret:${cfg.prefix}/github-token/*`],
      }))
      new CfnOutput(this, SELF_UPDATE_OUTPUT, { value: updater.roleArn, description: `${repository}'s TRACE_UPDATE_ROLE: keeps this installation up to date from its ci workflow on ${branch}` })
    }

    // ------------------------------------------------------------------ outputs
    new CfnOutput(this, LAYOUT_OUTPUT, { value: cfg.layout, description: 'Where each project\'s resources are: nested (a nested stack each) or flat (this stack)' })
    // Nested: the parent carries none of a project's outputs (Project<hash>RuntimeArn, ActionsRoleArn, MemoryId, …):
    // they are its nested stack's, and the installer reads them there (src/installer/aws.ts stackOutputs), so the
    // parent's outputs do not grow with the projects. Flat: the stack's own, as they always were (src/infra/project.ts).
    // The flat layout's tools functions: every project's in one nested stack of its own (with the tools image's build),
    // so the parent pays one resource for them all, and only when the parent has room for it (flatToolsFit). Without
    // it a flat project's KiCad and the rest go to the queue (src/gpu/jobs.ts TRACE_TOOLS_ELSEWHERE)
    const flatTools = !nested && cfg.tools.enabled && projects.length && flatToolsFit(this)
      ? new FlatToolsStack(this, 'ToolsStack', {
          cfg, bucket: central, build: toolsBuild,
          projects: projects.map((p, i) => ({ ref: refs[i] as (typeof refs)[number], project: p })),
        })
      : null
    if (flatTools) flatTools.node.addValidation({ validate: () => stackQuotaErrors(flatTools, '') })
    const hint = nested ? '' : `: with layout 'flat' about 20 projects fit; see README "Project isolation" for the move to layout 'nested'`
    this.node.addValidation({ validate: () => stackQuotaErrors(this, hint) })
    for (const n of nestedStacks) n.node.addValidation({ validate: () => stackQuotaErrors(n, '') })
    if (web) web.stack.node.addValidation({ validate: () => stackQuotaErrors(web.stack, '') })
    new CfnOutput(this, 'TraceHome', { value: traceHome, description: 'TRACE_HOME: the central database location' })
    if (library) {
      new CfnOutput(this, LIBRARY_GATEWAY_OUTPUT, { value: library.ref.url, description: 'The library gateway (the workers\' TRACE_GATEWAY_URL)' })
      new CfnOutput(this, LIBRARY_KEYS_OUTPUT, { value: library.keys.secretArn, description: 'The distributor keys the library gateway\'s Lambda reads (written by `tracectl install`)' })
    }
    new CfnOutput(this, CENTRAL_BUCKET_OUTPUT, { value: central.bucketName })
    new CfnOutput(this, 'GithubSecretArn', { value: githubToken.secretArn, description: 'The API\'s GitHub token (across projects); each project has its own (Project<hash>GithubSecretArn)' })
    new CfnOutput(this, 'AgentImageUri', { value: imageUri })
    // in either layout: the installer reads it to tell its own tools repository from one a failed deploy left behind
    const toolsUri = tools?.uri ?? flatTools?.imageUri
    if (toolsUri) new CfnOutput(this, TOOLS_IMAGE_OUTPUT, { value: toolsUri, description: 'The projects\' tools functions\' image (agent/Dockerfile.tools)' })
    new CfnOutput(this, 'Region', { value: cfg.region })
    new CfnOutput(this, 'ApiRuntimeArn', { value: api.attrAgentRuntimeArn })
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId })
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() })
    if (external) external.addOutputs(this, tokenUrl)
    // each project's own memory is its Project<hash>MemoryId output (src/infra/project.ts)
    if (legacy) new CfnOutput(this, 'LegacyMemoryId', { value: legacy.memoryId, description: 'The installation-wide memory of earlier versions: retained, unused; left in the account by the next deploy' })
    if (gpu) {
      new CfnOutput(this, 'GpuJobQueue', { value: gpu.queue.jobQueueArn })
      new CfnOutput(this, 'GpuImageUri', { value: gpu.imageUri })
      new CfnOutput(this, GPU_IMAGE_BUILD_OUTPUT, { value: gpu.imageBuildId, description: 'The GPU image build this deploy started (the deploy does not wait for it; the installer does)' })
      if (gpu.cpuQueue) new CfnOutput(this, 'CpuJobQueue', { value: gpu.cpuQueue.jobQueueArn })
    }
  }
}
