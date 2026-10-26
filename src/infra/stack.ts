/**
 * The cloud side of trace, in one CDK stack:
 *
 *   central bucket      $TRACE_HOME (central/): the central database (datasheets, parts) every project shares;
 *                       projects/<slug>/ and jobs/<slug>/ for each project's own data and GPU job files; access/ for
 *                       who may do what (the API's only); prompts/ for the installation's prompt overrides (the API
 *                       writes them, conditionally; workers and workflows read them)
 *   agent image         built from this repository by AWS CodeBuild on arm64 (no local Docker), pushed to ECR; every
 *                       runtime runs it
 *   projects            one ProjectStack per repository (src/infra/project.ts): its worker runtime on Bedrock
 *                       AgentCore with its own execution role, its GitHub token secret, its GitHub OIDC role, its
 *                       AgentCore memory, its GPU job definition and job role, and its CodeBuild GitHub Actions
 *                       runner project (src/infra/runner.ts: every CI job runs on AWS, never on a GitHub-hosted
 *                       runner; its role gives a job no AWS access), once the GitHub connection is authorized
 *                       (runners.connectionReady). Each role reaches that project's
 *                       resources only, so the line between projects holds in IAM even though the agent has Bash
 *                       and the role's credentials. Layout 'nested' (the default) puts each in its own nested stack,
 *                       so this stack holds one resource per project and 60 fit; 'flat' keeps them here, as earlier
 *                       installations have them (about 20 fit)
 *   GitHub connection   the AWS CodeConnections connection the runners reach GitHub through: the one given
 *                       (runners.connectionArn), or `<prefix>-github`, created here and kept (Retain) when the stack
 *                       goes; its ARN is the GithubConnectionArn output (src/infra/runner.ts GithubConnection)
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
import { JOBS_PREFIX, PROJECTS_PREFIX, memoryName } from '../core/project.js'
import { LibraryGateway } from './gateway.js'
import { GpuCompute } from './gpu.js'
import { KB_RETRIEVE_ACTIONS, VectorStore, knowledgeBaseArn } from './knowledge.js'
import { TraceMemory, grantReadRecords, sharedMemoryName } from './memory.js'
import { DISABLED_ENV, ENABLED_ENV, Observability, gpuTelemetryEnv } from './observability.js'
import { GithubConnection } from './runner.js'
import { ACCESS_PREFIX, CENTRAL_PREFIX, PROMPTS_PREFIX, type ProjectProps, ProjectNestedStack, ProjectStack, grantPrefixes } from './project.js'
import {
  GPU_IMAGE_BUILD_OUTPUT, type InfraProps, LAYOUT_OUTPUT, LIBRARY_GATEWAY_OUTPUT, LIBRARY_KEYS_OUTPUT, STACK_OUTPUTS_MAX, STACK_PARAMETERS_MAX, STACK_RESOURCES_MAX, apiRuntimeName, cpuEnabled,
  kbEnabled, projectRefs, projectSettings,
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

/** What the image build doesn't need (keeps the source asset small and its hash stable). */
export const SOURCE_EXCLUDE = [
  '.env', '.env.*', '**/.env', '**/.env.*', '*.pem', '**/*.pem', '*.key', '**/*.key', '.aws', '**/.aws', '.npmrc.local', '**/id_rsa*',
  '.git', 'node_modules', '**/node_modules', 'dist', 'cdk.out', '.venv', '**/__pycache__', '**/*.pyc', 'test', 'python/tests',
  '.trace', '*.db', '*.db-*', 'coverage',
]

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
    const traceHome = `s3://${central.bucketName}/${CENTRAL_PREFIX}`

    // The API's token: it reads and writes every project's settings (after its access check). Each worker has its
    // own project's secret instead (src/infra/project.ts).
    const githubToken = new secrets.Secret(this, 'GithubToken', {
      secretName: `${cfg.prefix}/github-token`,
      description: 'The GitHub token the trace API uses across projects (written by `trace install`, never by CloudFormation).',
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
    const build = new codebuild.Project(this, 'AgentImageBuild', {
      projectName: `${cfg.prefix}-agent-image`,
      description: 'Builds the trace agent image (agent/Dockerfile) for AgentCore, on arm64',
      source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      environmentVariables: { REPOSITORY_URI: { value: repo.repositoryUri }, IMAGE_TAG: { value: 'latest' } },
      timeout: Duration.minutes(90),
      logging: { cloudWatch: { logGroup: new logs.LogGroup(this, 'AgentImageBuildLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }) } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: { commands: ['aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPOSITORY_URI%%/*}"'] },
          build: { commands: ['docker build --platform linux/arm64 -f agent/Dockerfile -t "$REPOSITORY_URI:$IMAGE_TAG" .'] },
          post_build: { commands: ['docker push "$REPOSITORY_URI:$IMAGE_TAG"'] },
        },
      }),
    })
    repo.grantPullPush(build)
    source.grantRead(build)

    const builder = (name: string, handler: 'onEvent' | 'isComplete'): NodejsFunction => new NodejsFunction(this, name, {
      entry: join(REPO_ROOT, 'src', 'infra', 'lambda', 'image-build.ts'),
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
    const provider = new Provider(this, 'ImageBuildProvider', { onEventHandler: start, isCompleteHandler: poll, queryInterval: Duration.seconds(30), totalTimeout: Duration.minutes(100) })
    const imageUri = `${repo.repositoryUri}:${source.assetHash}`

    // ------------------------------------------------------------------ GPU jobs (AWS Batch), built the same way on amd64
    const gpu = cfg.gpu.enabled
      ? new GpuCompute(this, 'Gpu', {
          prefix: cfg.prefix, instanceTypes: cfg.gpu.instanceTypes, maxVcpus: cfg.gpu.maxVcpus, spot: cfg.gpu.spot,
          bucket: central, source, buildProvider: provider, retainData: cfg.retainData,
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
    // the GitHub connection the CodeBuild runners use (src/infra/runner.ts): given, or created here; the runner
    // projects only once it is authorized (runners.connectionReady)
    const connection = new GithubConnection(this, 'GithubConnection', { prefix: cfg.prefix, connectionArn: cfg.runners.connectionArn })
    const projectProps = (ref: (typeof refs)[number]): ProjectProps => ({
      cfg, project: ref, bucket: central, images: repo, imageUri: image.getAttString('ImageUri'), oidcProviderArn: oidc.openIdConnectProviderArn,
      gpu, vectorBucketArn: vectors?.arn ?? null, gateway: library?.ref ?? null,
      connectionArn: cfg.runners.connectionReady ? connection.connectionArn : null,
      environment: {
        AWS_REGION: cfg.region, TRACE_HOME: traceHome, CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: cfg.model, TRACE_WORKSPACE: '/mnt/workspace',
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

    // ------------------------------------------------------------------ people: Cognito and the API runtime
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
        emailBody: 'Your trace user name is {username} and your temporary password is {####}. Sign in with `trace login`.',
      },
      removalPolicy: RemovalPolicy.RETAIN,
    })
    const domain = users.addDomain('Domain', { cognitoDomain: { domainPrefix: `${cfg.prefix}-${cfg.account}` } })
    const client = users.addClient('Cli', {
      userPoolClientName: `${cfg.prefix}-cli`,
      generateSecret: false,
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
    repo.grantPull(apiRole)
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }))
    const apiLogs = `arn:aws:logs:${cfg.region}:${cfg.account}:log-group:/aws/bedrock-agentcore/runtimes/${apiName}-*`
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], resources: [apiLogs, `${apiLogs}:log-stream:*`],
    }))
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [`arn:aws:logs:${cfg.region}:${cfg.account}:log-group:*`] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'], resources: ['*'] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } }))
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
      resources: [`arn:aws:bedrock-agentcore:${cfg.region}:${cfg.account}:workload-identity-directory/default`, `arn:aws:bedrock-agentcore:${cfg.region}:${cfg.account}:workload-identity-directory/default/workload-identity/*`],
    }))
    githubToken.grantRead(apiRole)
    grantPrefixes(apiRole, central, { conditional: [CENTRAL_PREFIX] })
    central.grantReadWrite(apiRole, `${ACCESS_PREFIX}/*`)
    // the installation's prompt overrides (prompts.set / reset / revert, admins only, src/prompts/store.ts): read, and
    // write only with conditional puts (the central store's way); the workers and workflows only read them
    grantPrefixes(apiRole, central, { conditional: [PROMPTS_PREFIX] })
    // which memory records are inactive, per project (memory.deactivate / reactivate, src/agents/runtime/memory-state.ts):
    // read and conditional writes under projects/<slug>/memory-state/ only, nothing else of projects/
    grantPrefixes(apiRole, central, { conditional: [`${PROJECTS_PREFIX}/*/${MEMORY_STATE}`] })
    // every project's worker runtime of this installation: by its exact ARN (from its nested stack's output, or the
    // runtime itself when flat), and on the runtime also by this installation's tag. InvokeAgentRuntime authorizes the
    // runtime and the runtime endpoint (Service Authorization Reference: both resource types take aws:ResourceTag);
    // the endpoint (DEFAULT, made by AgentCore) is not tagged by this stack, so its statement has the ARNs only
    if (projects.length) {
      const arns = projects.map((p) => p.runtime.attrAgentRuntimeArn)
      apiRole.addToPolicy(new iam.PolicyStatement({
        sid: 'InvokeProjectWorkers', actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: arns,
        conditions: { StringEquals: { [`aws:ResourceTag/${INSTALLATION_TAG}`]: cfg.prefix } },
      }))
      apiRole.addToPolicy(new iam.PolicyStatement({
        sid: 'InvokeProjectWorkerEndpoints', actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: arns.map((a) => `${a}/runtime-endpoint/*`),
      }))
    }
    grantReadRecords(apiRole, memories)
    // kb.search on any project's knowledge base, after the access check (src/api/actions.ts); nothing else of them.
    // The ARN is made from the id, so the parent takes one output per knowledge base from its nested stack, not two.
    if (kbs.length) {
      apiRole.addToPolicy(new iam.PolicyStatement({
        sid: 'RetrieveProjectKnowledgeBases', actions: [...KB_RETRIEVE_ACTIONS],
        resources: kbs.map((k) => knowledgeBaseArn(this.partition, cfg.region, cfg.account, k.kb.knowledgeBaseId)),
      }))
    }

    const discoveryUrl = `https://cognito-idp.${cfg.region}.amazonaws.com/${users.userPoolId}/.well-known/openid-configuration`
    const api = new CfnRuntime(this, 'ApiRuntime', {
      agentRuntimeName: apiName,
      description: 'trace: what people do with their projects, behind Cognito and per-project grants',
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.getAttString('ImageUri') } },
      roleArn: apiRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      authorizerConfiguration: { customJwtAuthorizer: { discoveryUrl, allowedClients: [client.userPoolClientId] } },
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: cfg.idleTimeoutSeconds, maxLifetime: cfg.maxLifetimeSeconds },
      filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }],
      environmentVariables: {
        AWS_REGION: cfg.region,
        TRACE_HOME: traceHome,
        TRACE_GITHUB_SECRET_ARN: githubToken.secretArn,
        TRACE_WORKSPACE: '/mnt/workspace',
        TRACE_AGENT_MODE: 'api',
        TRACE_COGNITO_POOL_ID: users.userPoolId,
        TRACE_COGNITO_CLIENT_ID: client.userPoolClientId,
        TRACE_COGNITO_ISSUER: `https://cognito-idp.${cfg.region}.amazonaws.com/${users.userPoolId}`,
        TRACE_AWS_ACCOUNT: cfg.account,
        TRACE_WORKER_RUNTIMES: workerList,
        ...memoryEnv,
      },
      tags: { [INSTALLATION_TAG]: cfg.prefix },
    })
    api.node.addDependency(apiRole)
    const observabilityEnv = Math.max(Object.keys(ENABLED_ENV).length, Object.keys(DISABLED_ENV).length)
    for (const r of [api, ...projects.map((p) => p.runtime)]) {
      const env = r.environmentVariables
      if (env && typeof env === 'object' && !('resolve' in env)) checkRuntimeEnv(r.agentRuntimeName, env, observabilityEnv)
    }
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup'],
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
      ],
    })

    // ------------------------------------------------------------------ outputs
    new CfnOutput(this, LAYOUT_OUTPUT, { value: cfg.layout, description: 'Where each project\'s resources are: nested (a nested stack each) or flat (this stack)' })
    // Nested: the parent carries none of a project's outputs (Project<hash>RuntimeArn, ActionsRoleArn, MemoryId, …):
    // they are its nested stack's, and the installer reads them there (src/installer/aws.ts stackOutputs), so the
    // parent's outputs do not grow with the projects. Flat: the stack's own, as they always were (src/infra/project.ts).
    const hint = nested ? '' : `: with layout 'flat' about 20 projects fit; see README "Project isolation" for the move to layout 'nested'`
    this.node.addValidation({ validate: () => stackQuotaErrors(this, hint) })
    for (const n of nestedStacks) n.node.addValidation({ validate: () => stackQuotaErrors(n, '') })
    new CfnOutput(this, 'TraceHome', { value: traceHome, description: 'TRACE_HOME: the central database location' })
    if (library) {
      new CfnOutput(this, LIBRARY_GATEWAY_OUTPUT, { value: library.ref.url, description: 'The library gateway (the workers\' TRACE_GATEWAY_URL)' })
      new CfnOutput(this, LIBRARY_KEYS_OUTPUT, { value: library.keys.secretArn, description: 'The distributor keys the library gateway\'s Lambda reads (written by `trace install`)' })
    }
    new CfnOutput(this, 'CentralBucket', { value: central.bucketName })
    new CfnOutput(this, 'GithubSecretArn', { value: githubToken.secretArn, description: 'The API\'s GitHub token (across projects); each project has its own (Project<hash>GithubSecretArn)' })
    new CfnOutput(this, 'AgentImageUri', { value: imageUri })
    new CfnOutput(this, 'Region', { value: cfg.region })
    new CfnOutput(this, 'ApiRuntimeArn', { value: api.attrAgentRuntimeArn })
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId })
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() })
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
