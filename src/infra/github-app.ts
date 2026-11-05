/**
 * trace's token broker (docs/agent-identity.md, piece 1): the Lambda `<prefix>-github-app-token`
 * (src/infra/lambda/github-app-token.ts) behind a function URL with IAM sign-in, which gives an installation token of
 * trace's GitHub app for the caller's own project's repository.
 *
 * Its role, least privilege:
 *   secret    GetSecretValue on `<prefix>/github-app` only (the app's id and private key; written by the installer,
 *             never by CloudFormation: this stack does not make the secret, so a deploy never touches the key)
 *   logs      its own log group
 *
 * Who may call it: the function URL's auth type is AWS_IAM, and only the projects' roles are granted
 * lambda:InvokeFunctionUrl on it (brokerInvokeStatements, added to each project's worker, GitHub OIDC and token roles in
 * src/infra/project.ts). Which repository a token is for, the function decides from the caller's role and its registry
 * (the onboarded repositories, TRACE_GITHUB_APP_PROJECTS), never from the request.
 *
 * Made only with githubApp.enabled (default off: the installer turns it on with the app, docs/agent-identity.md piece
 * 5), in the nested layout, whose parent stack has room for its five resources.
 */
import { join } from 'node:path'
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import { GITHUB_APP_BROKER_OUTPUT, githubAppBrokerName, githubAppSecretName, registryValue } from '../core/github-app.js'
import { bundlingRoot } from './lockfile.js'

/** Lambda allows 4 KB of environment in all: the registry gets most of it. */
export const REGISTRY_MAX = 3500

/**
 * What a project's role needs to ask the broker: its function URL with IAM sign-in, and (as AWS asks of function URLs
 * made since late 2025) invoking the function, which a direct invoke cannot use: it carries no signer, so the
 * function refuses it.
 */
export function brokerInvokeStatements(partition: string, region: string, account: string, prefix: string): iam.PolicyStatement[] {
  const fn = `arn:${partition}:lambda:${region}:${account}:function:${githubAppBrokerName(prefix)}`
  return [
    new iam.PolicyStatement({ sid: 'GithubAppTokenUrl', actions: ['lambda:InvokeFunctionUrl'], resources: [fn], conditions: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } } }),
    new iam.PolicyStatement({ sid: 'GithubAppToken', actions: ['lambda:InvokeFunction'], resources: [fn] }),
  ]
}

export interface GithubAppBrokerProps {
  prefix: string
  /** the onboarded repositories (OWNER/REPO), the registry the broker picks a caller's repository from */
  repositories: readonly string[]
  root: string
}

export class GithubAppBroker extends Construct {
  readonly function: lambda.Function
  readonly url: lambda.FunctionUrl

  constructor(scope: Construct, id: string, p: GithubAppBrokerProps) {
    super(scope, id)
    const { partition, region, account } = Stack.of(this)
    const registry = registryValue(p.repositories)
    if (registry.length > REGISTRY_MAX) throw new Error(`too many repositories for one installation: the token broker's registry would be ${registry.length} characters (Lambda allows about ${REGISTRY_MAX})`)
    const secretName = githubAppSecretName(p.prefix)
    const fnLogs = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'trace: the token broker; reads the GitHub app\'s key and nothing else',
    })
    fnLogs.grantWrite(role)
    role.addToPolicy(new iam.PolicyStatement({ sid: 'AppKey', actions: ['secretsmanager:GetSecretValue'], resources: [`arn:${partition}:secretsmanager:${region}:${account}:secret:${secretName}-??????`] }))
    this.function = new NodejsFunction(this, 'Function', {
      functionName: githubAppBrokerName(p.prefix),
      entry: join(p.root, 'src', 'infra', 'lambda', 'github-app-token.ts'),
      ...bundlingRoot(p.root),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(20),
      role,
      logGroup: fnLogs,
      bundling: { format: OutputFormat.CJS, target: 'node22', externalModules: ['@aws-sdk/*'] },
      environment: { TRACE_PREFIX: p.prefix, TRACE_ACCOUNT: account, TRACE_GITHUB_APP_SECRET: secretName, TRACE_GITHUB_APP_PROJECTS: registry },
      description: 'trace: gives a GitHub app token for the calling project\'s repository alone',
    })
    this.url = this.function.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM })
    new CfnOutput(Stack.of(this), GITHUB_APP_BROKER_OUTPUT, { value: this.url.url, description: 'trace\'s token broker for its GitHub app (each project\'s TRACE_GITHUB_APP_BROKER)' })
  }
}
