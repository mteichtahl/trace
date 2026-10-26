/**
 * Where a repository's GitHub Actions jobs run: an AWS CodeBuild runner project, in the installation's own AWS account.
 * GitHub-hosted runners are never used (every build and every CI job of trace runs on AWS), so each workflow job
 * names one of these in `runs-on: codebuild-<project name>-${{ github.run_id }}-${{ github.run_attempt }}` (the
 * project name comes from the repository variable TRACE_CODEBUILD_PROJECT, src/core/project.ts RUNNER_VARIABLE).
 *
 *   project      a CodeBuild project whose source is the repository on GitHub and whose webhook (made by
 *                CloudFormation through Triggers) is filtered on EVENT = WORKFLOW_JOB_QUEUED: GitHub tells CodeBuild a
 *                job is queued, CodeBuild starts a build that registers itself as a just-in-time runner for that one
 *                job, runs it, and is gone. The buildspec is ignored for runner builds (CodeBuild runs the runner agent;
 *                a job could only bring a buildspec back with the `buildspec-override:true` label), so the project's
 *                is a placeholder. Linux container, the image and compute type of `runners` (a job may ask for another
 *                with the `image:` and `instance-size:` labels), privileged only when asked (Docker-in-Docker); no
 *                artifacts, no cache, no VPC
 *   source auth  the installation's AWS CodeConnections connection (the AWS Connector for GitHub app), as the source's
 *                own credential (Source.Auth type CODECONNECTIONS): no GitHub token is stored for it, and the
 *                account's default CodeBuild source credential, whatever it is, is not used
 *   logs         its own log group, /aws/codebuild/<name>, kept a month, deleted with the project
 *   role         its service role, assumed by CodeBuild only for this project (aws:SourceAccount, aws:SourceArn), and
 *                allowed only:
 *                  logs        CreateLogStream and PutLogEvents on its own log group
 *                  connection  codeconnections:UseConnection, GetConnectionToken and GetConnection (and the same
 *                              codestar-connections actions, the service's former name, whose ARNs are the same
 *                              connection's) on that one connection ARN
 *
 * The security line: a CodeBuild build's container gets its service role's credentials, so whatever this role allows
 * every job of the repository can do with them. That is why it allows nothing in AWS beyond its logs and the
 * connection: no S3, no ECR, no Bedrock, no other project's anything. A job reaches AWS exactly as it did on a
 * GitHub-hosted runner, by assuming its project's GitHub OIDC role (src/infra/project.ts ActionsRole, default branch
 * only) with `aws-actions/configure-aws-credentials`; moving the job onto CodeBuild gives it no AWS access of its own.
 * What the role does give a job is the connection itself: GetConnectionToken returns a GitHub token of the AWS
 * Connector app's installation, which reaches whatever repositories the app is installed on with the app's
 * permissions. CodeBuild needs it to register the runner and to fetch the source, and IAM has no condition key to
 * tell CodeBuild's own calls from a job's, so install the app on the onboarded repositories only.
 *
 * The connection (GithubConnection below): a stack given `connectionArn` uses that one and manages nothing of it;
 * a stack given none creates `<prefix>-github` (AWS::CodeConnections::Connection, tagged trace:installation) and
 * outputs its ARN either way (props.ts CONNECTION_OUTPUT). The tools (the installer, `npm run deploy:ci`) look for an
 * authorized GitHub connection in the account and region first and pass it in, so a connection is authorized once per
 * account and region and reused by every installation and by trace's own CI; a stack creates its own only when there
 * is none. A connection a stack created is always kept (RETAIN, whatever retainData says) when the stack goes or stops
 * using it: another stack may be reusing it.
 *
 * Why the runner projects can wait for a second deploy (runners.connectionReady): a new connection is PENDING until a
 * person authorizes it once in the AWS console, and CodeBuild cannot make a runner project's webhook against a pending
 * connection (and may refuse the project). So when the connection is not AVAILABLE the tools deploy with
 * connectionReady false (the connection, and no runner projects, roles, log groups or runner outputs), show the
 * person the link and wait, then deploy again with true, which only adds the runners and their webhooks. It is true
 * by default, so a plain `cdk deploy` never removes runners that exist.
 */
import { CfnOutput, Fn, RemovalPolicy, Stack, Tags, Token } from 'aws-cdk-lib'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import { CfnConnection } from 'aws-cdk-lib/aws-codeconnections'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import { connectionName } from '../core/project.js'
import { CONNECTION_CREATED_OUTPUT, CONNECTION_OUTPUT } from './props.js'

/** How long a runner build may take: longer than any job of the workflows (the longest asks for 150 minutes). */
export const RUNNER_TIMEOUT_MINUTES = 480

/** The placeholder buildspec: CodeBuild runs the runner agent instead of it. */
const PLACEHOLDER_BUILDSPEC = [
  'version: 0.2',
  'phases:',
  '  build:',
  '    commands:',
  '      - echo "a GitHub Actions runner project: CodeBuild runs the runner agent, not this buildspec"',
].join('\n')

export interface RunnerProjectProps {
  /** the CodeBuild project's name (runnerProjectName, or SELF_CI_PROJECT for trace's own repository) */
  name: string
  /** OWNER/REPO */
  repository: string
  /** the AWS CodeConnections connection CodeBuild reaches GitHub through */
  connectionArn: string
  computeType: string
  image: string
  privileged: boolean
  /** more tags for the project and its role */
  tags?: Record<string, string>
  /** the log group's (DESTROY by default: build logs are not data) */
  removalPolicy?: RemovalPolicy
}

/** The connection's ARN under both of the service's names (codeconnections, and codestar-connections before it). An
 * ARN known only at deploy time (a connection the stack creates, or a nested stack's parameter) is assumed to be in
 * the stack's own partition, region and account, which a created one always is. */
export function connectionArns(arn: string, stack?: Stack): string[] {
  if (Token.isUnresolved(arn) && stack) {
    const id = Fn.select(1, Fn.split(':connection/', arn))
    const { partition, region, account } = stack
    return [arn, Fn.join('', ['arn:', partition, ':codestar-connections:', region, ':', account, ':connection/', id])]
  }
  const m = /^(arn:[^:]+:)(codeconnections|codestar-connections)(:.*)$/.exec(arn)
  if (!m) return [arn]
  return ['codeconnections', 'codestar-connections'].map((s) => `${m[1]}${s}${m[3]}`)
}

/**
 * The GitHub connection the runners use: the one given, or a new `<prefix>-github` (PENDING until a person authorizes
 * it), kept when the stack is deleted (another stack may reuse it). Outputs its ARN (CONNECTION_OUTPUT) and whether
 * this stack created it (CONNECTION_CREATED_OUTPUT), so the tools can keep using it on later runs.
 */
export class GithubConnection extends Construct {
  readonly connectionArn: string
  /** the connection this stack created (null when it was given one) */
  readonly created: CfnConnection | null

  constructor(scope: Construct, id: string, p: { prefix: string; connectionArn?: string | undefined; tags?: Record<string, string> }) {
    super(scope, id)
    if (p.connectionArn) {
      this.connectionArn = p.connectionArn
      this.created = null
    } else {
      this.created = new CfnConnection(this, 'Connection', {
        connectionName: connectionName(p.prefix),
        providerType: 'GitHub',
        tags: Object.entries({ 'trace:installation': p.prefix, ...p.tags }).map(([key, value]) => ({ key, value })),
      })
      this.created.applyRemovalPolicy(RemovalPolicy.RETAIN)
      this.connectionArn = this.created.attrConnectionArn
    }
    const stack = Stack.of(this)
    new CfnOutput(stack, CONNECTION_OUTPUT, { value: this.connectionArn, description: 'The GitHub connection (AWS CodeConnections) the CodeBuild runners use' })
    new CfnOutput(stack, CONNECTION_CREATED_OUTPUT, { value: this.created ? 'true' : 'false', description: 'Whether this stack created that connection (it is kept when the stack is deleted)' })
  }
}

export class RunnerProject extends Construct {
  readonly project: codebuild.CfnProject
  readonly role: iam.Role
  readonly logGroup: logs.LogGroup
  readonly projectName: string

  constructor(scope: Construct, id: string, p: RunnerProjectProps) {
    super(scope, id)
    const { region, account, partition } = Stack.of(this)
    this.projectName = p.name
    const projectArn = `arn:${partition}:codebuild:${region}:${account}:project/${p.name}`

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/codebuild/${p.name}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: p.removalPolicy ?? RemovalPolicy.DESTROY,
    })

    // Its policy is inline (no AWS::IAM::Policy of its own), and the project is the L1: the L2 would add report-group,
    // VPC and log grants of its own to the role, and every one of those is a permission every job would have.
    this.role = new iam.Role(this, 'Role', {
      roleName: `${p.name}-${region}`,
      description: `CodeBuild GitHub Actions runner for ${p.repository}: its logs and the GitHub connection only`.slice(0, 1000),
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': account }, ArnLike: { 'aws:SourceArn': projectArn } },
      }),
      inlinePolicies: {
        Runner: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'RunnerLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [this.logGroup.logGroupArn, `arn:${partition}:logs:${region}:${account}:log-group:${this.logGroup.logGroupName}:log-stream:*`],
            }),
            new iam.PolicyStatement({
              sid: 'RunnerConnection',
              actions: [
                'codeconnections:UseConnection', 'codeconnections:GetConnectionToken', 'codeconnections:GetConnection',
                'codestar-connections:UseConnection', 'codestar-connections:GetConnectionToken', 'codestar-connections:GetConnection',
              ],
              resources: connectionArns(p.connectionArn, Stack.of(this)),
            }),
          ],
        }),
      },
    })

    this.project = new codebuild.CfnProject(this, 'Project', {
      name: p.name,
      description: `GitHub Actions runner for ${p.repository} (trace: every job runs on AWS)`.slice(0, 255),
      serviceRole: this.role.roleArn,
      source: {
        type: 'GITHUB',
        location: `https://github.com/${p.repository}`,
        auth: { type: 'CODECONNECTIONS', resource: p.connectionArn },
        buildSpec: PLACEHOLDER_BUILDSPEC,
      },
      triggers: {
        webhook: true,
        filterGroups: [[{ type: 'EVENT', pattern: 'WORKFLOW_JOB_QUEUED' }]],
      },
      artifacts: { type: 'NO_ARTIFACTS' },
      environment: {
        type: 'LINUX_CONTAINER',
        computeType: p.computeType,
        image: p.image,
        imagePullCredentialsType: 'CODEBUILD',
        privilegedMode: p.privileged,
      },
      logsConfig: { cloudWatchLogs: { status: 'ENABLED', groupName: this.logGroup.logGroupName }, s3Logs: { status: 'DISABLED' } },
      timeoutInMinutes: RUNNER_TIMEOUT_MINUTES,
    })
    // the role's policy must be in place before CodeBuild checks it, and the webhook is made with the project
    this.project.node.addDependency(this.role)

    for (const [k, v] of Object.entries(p.tags ?? {})) {
      Tags.of(this.project).add(k, v)
      Tags.of(this.role).add(k, v)
    }
  }
}
