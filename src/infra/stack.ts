/**
 * The cloud side of trace, in one CDK stack:
 *
 *   central bucket      $TRACE_HOME: the central database (datasheets, parts) every project shares
 *   GitHub secret       the token the agents use to clone, push and comment (value written by the installer)
 *   agent image         built from this repository by AWS CodeBuild on arm64 (no local Docker), pushed to ECR
 *   agent runtime       Bedrock AgentCore Runtime running the image: Claude, the trace tools, git, gh, KiCad,
 *                       ngspice, Icarus; session storage at /mnt/workspace
 *   actions role        assumed by the onboarded repositories' workflows through GitHub OIDC: invokes the worker
 *                       runtime and reads/writes the central bucket
 *   people              a Cognito user pool (no self sign-up; admins invite people) with three classes as groups —
 *                       admin, user (read/write on assigned projects), guest (read on assigned projects) — and the
 *                       API runtime: the same image in `api` mode, reachable only with a Cognito token, which checks
 *                       the person's class and project assignments (src/core/access.ts) on every request
 *
 * Two runtimes, one image: the worker runtime accepts only IAM (the repositories' workflows), the API runtime only
 * Cognito tokens (people). A person's token can never reach the worker, and a workflow never acts as a person.
 *
 * Outputs carry everything the installer then writes into GitHub (repository variables) and the local settings.
 */
import { join } from 'node:path'
import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
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
import { type InfraProps, runtimeName } from './props.js'

/** The repository root, from dist/infra or src/infra. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..')

/** What the image build doesn't need (keeps the source asset small and its hash stable). */
/** The central database's prefix in the bucket, and the access store's beside it (src/core/access.ts accessHome). */
export const CENTRAL_PREFIX = 'central'
export const ACCESS_PREFIX = 'access'

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
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }],
    })
    const traceHome = `s3://${central.bucketName}/${CENTRAL_PREFIX}`

    const githubToken = new secrets.Secret(this, 'GithubToken', {
      secretName: `${cfg.prefix}/github-token`,
      description: 'The GitHub token the trace agents use (written by `trace install`, never by CloudFormation).',
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
    const image = new CustomResource(this, 'AgentImage', {
      serviceToken: provider.serviceToken,
      properties: { ProjectName: build.projectName, ImageUri: imageUri, SourceHash: source.assetHash },
    })

    // ------------------------------------------------------------------ the runtimes' roles (one each)
    // The worker handles untrusted text (issues, logs, code) from the repositories: it gets the central database and
    // the model, nothing about people. The API serves signed-in people: it also gets the access store and Cognito.
    const modelAccess = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetInferenceProfile'],
      resources: ['arn:aws:bedrock:*::foundation-model/anthropic.*', `arn:aws:bedrock:*:${cfg.account}:inference-profile/*`],
    })
    const runtimeRole = (id: string, name: string, description: string): iam.Role => {
      const role = new iam.Role(this, id, {
        roleName: `${cfg.prefix}-${name}-${cfg.region}`,
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': cfg.account },
            ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${cfg.region}:${cfg.account}:*` },
          },
        }),
        description,
      })
      repo.grantPull(role)
      role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }))
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [`arn:aws:logs:${cfg.region}:${cfg.account}:log-group:/aws/bedrock-agentcore/runtimes/*`, `arn:aws:logs:${cfg.region}:${cfg.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
      }))
      role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [`arn:aws:logs:${cfg.region}:${cfg.account}:log-group:*`] }))
      role.addToPolicy(new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'], resources: ['*'] }))
      role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } }))
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
        resources: [`arn:aws:bedrock-agentcore:${cfg.region}:${cfg.account}:workload-identity-directory/default`, `arn:aws:bedrock-agentcore:${cfg.region}:${cfg.account}:workload-identity-directory/default/workload-identity/*`],
      }))
      role.addToPolicy(modelAccess)
      githubToken.grantRead(role)
      central.grantReadWrite(role, `${CENTRAL_PREFIX}/*`)
      return role
    }
    const workerRole = runtimeRole('WorkerRuntimeRole', 'agent-worker', 'Run by the trace worker on Bedrock AgentCore (repositories\' work)')
    const apiRole = runtimeRole('ApiRuntimeRole', 'agent-api', 'Run by the trace API on Bedrock AgentCore (signed-in people)')
    central.grantReadWrite(apiRole, `${ACCESS_PREFIX}/*`)

    const runtime = new CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName: runtimeName(cfg.prefix),
      description: 'trace: Claude working on the onboarded repositories',
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.getAttString('ImageUri') } },
      roleArn: workerRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: { idleRuntimeSessionTimeout: cfg.idleTimeoutSeconds, maxLifetime: cfg.maxLifetimeSeconds },
      filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }],
      environmentVariables: {
        AWS_REGION: cfg.region,
        TRACE_HOME: traceHome,
        TRACE_GITHUB_SECRET_ARN: githubToken.secretArn,
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: cfg.model,
        TRACE_WORKSPACE: '/mnt/workspace',
        TRACE_AGENT_MODE: 'worker',
      },
    })
    runtime.node.addDependency(workerRole)

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

    const discoveryUrl = `https://cognito-idp.${cfg.region}.amazonaws.com/${users.userPoolId}/.well-known/openid-configuration`
    const api = new CfnRuntime(this, 'ApiRuntime', {
      agentRuntimeName: `${runtimeName(cfg.prefix).replace(/_agent$/, '')}_api`.slice(0, 48),
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
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: cfg.model,
        TRACE_WORKSPACE: '/mnt/workspace',
        TRACE_AGENT_MODE: 'api',
        TRACE_COGNITO_POOL_ID: users.userPoolId,
        TRACE_COGNITO_CLIENT_ID: client.userPoolClientId,
        TRACE_COGNITO_ISSUER: `https://cognito-idp.${cfg.region}.amazonaws.com/${users.userPoolId}`,
      },
    })
    api.node.addDependency(apiRole)
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup'],
      resources: [users.userPoolArn],
    }))

    // ------------------------------------------------------------------ the onboarded repositories' role (GitHub OIDC)
    const issuer = 'token.actions.githubusercontent.com'
    const oidc = cfg.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GithubOidc', { url: `https://${issuer}`, clientIds: ['sts.amazonaws.com'] })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', `arn:aws:iam::${cfg.account}:oidc-provider/${issuer}`)
    const actionsRole = new iam.Role(this, 'ActionsRole', {
      roleName: `${cfg.prefix}-github-actions-${cfg.region}`,
      maxSessionDuration: Duration.hours(2),
      description: 'Assumed by the onboarded repositories\' trace workflows (GitHub OIDC)',
      assumedBy: new iam.WebIdentityPrincipal(oidc.openIdConnectProviderArn, {
        StringEquals: { [`${issuer}:aud`]: 'sts.amazonaws.com' },
        // Only runs on each repository's default branch: workflow_run, issues, schedule and pushes to it. A branch or a
        // pull request can't assume this role, so it can't reach the agents or the central store with its own code.
        StringLike: { [`${issuer}:sub`]: cfg.repositories.map((r) => { const [slug, branch = 'main'] = r.split('@'); return `repo:${slug}:ref:refs/heads/${branch}` }) },
      }),
    })
    actionsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [runtime.attrAgentRuntimeArn, `${runtime.attrAgentRuntimeArn}/*`],
    }))
    actionsRole.addToPolicy(modelAccess) // the in-Actions fallback (worker.runner = actions)
    central.grantReadWrite(actionsRole, `${CENTRAL_PREFIX}/*`)

    // ------------------------------------------------------------------ outputs
    new CfnOutput(this, 'TraceHome', { value: traceHome, description: 'TRACE_HOME: the central database location' })
    new CfnOutput(this, 'CentralBucket', { value: central.bucketName })
    new CfnOutput(this, 'GithubSecretArn', { value: githubToken.secretArn })
    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.attrAgentRuntimeArn })
    new CfnOutput(this, 'AgentImageUri', { value: imageUri })
    new CfnOutput(this, 'ActionsRoleArn', { value: actionsRole.roleArn })
    new CfnOutput(this, 'Region', { value: cfg.region })
    new CfnOutput(this, 'ApiRuntimeArn', { value: api.attrAgentRuntimeArn })
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId })
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() })
  }
}
