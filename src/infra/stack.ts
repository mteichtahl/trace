/**
 * The cloud side of trace, in one CDK stack:
 *
 *   central bucket      $TRACE_HOME (central/): the central database (datasheets, parts) every project shares;
 *                       projects/<slug>/ and jobs/<slug>/ for each project's own data and GPU job files; access/ for
 *                       who may do what (the API's only)
 *   agent image         built from this repository by AWS CodeBuild on arm64 (no local Docker), pushed to ECR; every
 *                       runtime runs it
 *   projects            one ProjectStack per repository (src/infra/project.ts): its worker runtime on Bedrock
 *                       AgentCore with its own execution role, its GitHub token secret, its GitHub OIDC role and its
 *                       GPU job definition and job role. Each role reaches that project's resources only, so the
 *                       line between projects holds in IAM even though the agent has Bash and the role's credentials
 *   agent memory        AgentCore Memory (src/infra/memory.ts): one for the installation, namespaced
 *                       /trace/<owner>/<repo>/<agent>/; each worker may use only its project's actors and namespaces
 *   GPU                 one AWS Batch queue and compute environment shared by every project (src/infra/gpu.ts)
 *   observability       OpenTelemetry (ADOT) from every runtime and the GPU jobs, CloudWatch Transaction Search,
 *                       the memory's vended logs and traces, and a dashboard (src/infra/observability.ts)
 *   people              a Cognito user pool (no self sign-up; admins invite people) with three classes as groups —
 *                       admin, user (read/write on assigned projects), guest (read on assigned projects) — and the
 *                       API runtime: the same image in `api` mode, reachable only with a Cognito token, which checks
 *                       the person's class and project assignments (src/core/access.ts) on every request
 *
 * The API runtime is the one component that spans projects: it reads every project's settings and status with the
 * shared GitHub token, reads (never writes) every project's memory records, and hands tasks to each project's worker
 * runtime (InvokeAgentRuntime), always after its access check. It runs no model and gives nothing a shell.
 *
 * Workers accept only IAM (their repository's workflows, and the API); the API accepts only Cognito tokens (people).
 * A person's token can never reach a worker, and a workflow never acts as a person.
 *
 * Outputs carry everything the installer then writes into GitHub (each repository's variables, from that project's
 * outputs: src/infra/props.ts projectOutputs) and the local settings.
 */
import { join } from 'node:path'
import { CfnOutput, CustomResource, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
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
import type { Construct } from 'constructs'
import { JOBS_PREFIX, workerRuntimeNamePattern } from '../core/project.js'
import { GpuCompute } from './gpu.js'
import { TraceMemory } from './memory.js'
import { Observability, gpuTelemetryEnv } from './observability.js'
import { ACCESS_PREFIX, CENTRAL_PREFIX, ProjectStack, grantPrefixes } from './project.js'
import { type InfraProps, apiRuntimeName, projectRefs } from './props.js'

/** The repository root, from dist/infra or src/infra. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..')

export { ACCESS_PREFIX, CENTRAL_PREFIX } from './project.js'

/** AgentCore's limit on one environment variable's value (CreateAgentRuntime environmentVariables). */
export const ENV_VALUE_MAX = 5000

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
        })
      : null
    // ------------------------------------------------------------------ the agents' memory (AgentCore Memory, src/infra/memory.ts)
    const memory = cfg.memory.enabled ? new TraceMemory(this, 'AgentMemory', { prefix: cfg.prefix, eventExpiryDays: cfg.memory.eventExpiryDays }) : null
    const memoryEnv: Record<string, string> = memory ? { TRACE_MEMORY_ID: memory.memoryId } : {}
    const image = new CustomResource(this, 'AgentImage', {
      serviceToken: provider.serviceToken,
      properties: { ProjectName: build.projectName, ImageUri: imageUri, SourceHash: source.assetHash },
    })

    // ------------------------------------------------------------------ the projects (one worker runtime and its roles each)
    const issuer = 'token.actions.githubusercontent.com'
    const oidc = cfg.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GithubOidc', { url: `https://${issuer}`, clientIds: ['sts.amazonaws.com'] })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', `arn:aws:iam::${cfg.account}:oidc-provider/${issuer}`)
    const refs = projectRefs(cfg.repositories)
    const projects = refs.map((ref) => new ProjectStack(this, `Project${ref.hash}`, {
      cfg, project: ref, bucket: central, images: repo, imageUri: image.getAttString('ImageUri'), oidcProviderArn: oidc.openIdConnectProviderArn,
      gpu, memory,
      environment: {
        AWS_REGION: cfg.region, TRACE_HOME: traceHome, CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: cfg.model, TRACE_WORKSPACE: '/mnt/workspace', ...memoryEnv,
      },
    }))
    // The API is told every worker runtime: `owner/repo=<runtime id>` separated by spaces (src/api/workers.ts).
    const workerList = Fn.join(' ', projects.map((p, i) => Fn.join('=', [refs[i]?.slug ?? '', p.runtime.attrAgentRuntimeId])))
    // runtime ids are `<name>-<10 characters>`
    const workerListLength = refs.reduce((n, r, i) => n + r.slug.length + 1 + (projects[i]?.runtimeName.length ?? 0) + 11 + 1, 0)
    if (workerListLength > ENV_VALUE_MAX) throw new Error(`too many repositories for one installation: the API's list of worker runtimes would be ${workerListLength} characters (AgentCore allows ${ENV_VALUE_MAX})`)

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
    // every project's worker runtime of this installation (by name; one statement however many projects there are)
    const workers = `arn:aws:bedrock-agentcore:${cfg.region}:${cfg.account}:runtime/${workerRuntimeNamePattern(cfg.prefix)}`
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'InvokeProjectWorkers', actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: [workers, `${workers}/runtime-endpoint/*`] }))
    if (memory) memory.grantReadRecords(apiRole)

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
    })
    api.node.addDependency(apiRole)
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup'],
      resources: [users.userPoolArn],
    }))

    // ------------------------------------------------------------------ observability (OpenTelemetry/ADOT, src/infra/observability.ts)
    new Observability(this, 'Observability', {
      prefix: cfg.prefix, settings: cfg.observability, gpu: Boolean(gpu), gpuJobRoles: gpu?.jobRoles ?? [],
      memory: memory ? { arn: memory.memoryArn, id: memory.memoryId } : null,
      runtimes: [
        ...projects.map((p) => ({ id: p.node.id, runtime: p.runtime, name: p.runtimeName, role: p.role })),
        { id: 'Api', runtime: api, name: apiName, role: apiRole },
      ],
    })

    // ------------------------------------------------------------------ outputs
    new CfnOutput(this, 'TraceHome', { value: traceHome, description: 'TRACE_HOME: the central database location' })
    new CfnOutput(this, 'CentralBucket', { value: central.bucketName })
    new CfnOutput(this, 'GithubSecretArn', { value: githubToken.secretArn, description: 'The API\'s GitHub token (across projects); each project has its own (Project<hash>GithubSecretArn)' })
    new CfnOutput(this, 'AgentImageUri', { value: imageUri })
    new CfnOutput(this, 'Region', { value: cfg.region })
    new CfnOutput(this, 'ApiRuntimeArn', { value: api.attrAgentRuntimeArn })
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId })
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() })
    if (memory) new CfnOutput(this, 'MemoryId', { value: memory.memoryId, description: 'TRACE_MEMORY_ID: the agents\' AgentCore Memory' })
    if (gpu) {
      new CfnOutput(this, 'GpuJobQueue', { value: gpu.queue.jobQueueArn })
      new CfnOutput(this, 'GpuImageUri', { value: gpu.imageUri })
    }
  }
}
