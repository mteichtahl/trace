/**
 * The order watch: the Lambda `<prefix>-order-watch` (src/infra/lambda/order-watch.ts) on an hourly schedule, which
 * follows shipped orders' parcels with their carrier (src/core/shipping.ts), and which the API invokes for a check now.
 *
 * Its role, least privilege:
 *   s3        GetObject and a conditional PutObject on installation/shipping/* of the central bucket, ListBucket under
 *             that prefix only; nothing of any project and nothing of the access store
 *   secret    GetSecretValue on the `dhl` integration's secret only (<prefix>/integrations/dhl-??????); no worker or
 *             gateway role reads it (src/infra/project.ts integrationsReadStatement lists the tools' integrations)
 *   logs      its own log group
 *
 * It reaches the carrier's API over the internet (no VPC). The API's role gets lambda:InvokeFunction on this one
 * function (order.check_now) and the watch's prefix with conditional writes (order.update starts a watch).
 */
import { join } from 'node:path'
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { integrationSecretName } from '../core/integrations-catalog.js'
import { SHIPPING_PREFIX } from '../core/shipping.js'
import { bundlingRoot } from './lockfile.js'

/** The watch's prefix in the central bucket. */
export const WATCH_OBJECTS = `${SHIPPING_PREFIX}/shipping`
export const orderWatchName = (prefix: string): string => `${prefix}-order-watch`

export interface OrderWatchProps { prefix: string; central: s3.IBucket; root: string }

export class OrderWatch extends Construct {
  readonly function: lambda.Function

  constructor(scope: Construct, id: string, p: OrderWatchProps) {
    super(scope, id)
    const { partition, region, account } = Stack.of(this)
    const secretName = integrationSecretName(p.prefix, 'dhl')
    const fnLogs = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'trace: follows shipped orders with their carrier; reads and writes installation/shipping/ only',
    })
    fnLogs.grantWrite(role)
    const objects = p.central.arnForObjects(`${WATCH_OBJECTS}/*`)
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WatchRead', actions: ['s3:GetObject'], resources: [objects] }))
    for (const key of ['s3:if-match', 's3:if-none-match']) {
      role.addToPolicy(new iam.PolicyStatement({ sid: key === 's3:if-match' ? 'WatchWriteIfMatch' : 'WatchWriteIfNoneMatch', actions: ['s3:PutObject'], resources: [objects], conditions: { Null: { [key]: 'false' } } }))
    }
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WatchList', actions: ['s3:ListBucket'], resources: [p.central.bucketArn], conditions: { StringLike: { 's3:prefix': [`${WATCH_OBJECTS}/*`] } } }))
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CarrierKey', actions: ['secretsmanager:GetSecretValue'], resources: [`arn:${partition}:secretsmanager:${region}:${account}:secret:${secretName}-??????`] }))
    this.function = new NodejsFunction(this, 'Function', {
      functionName: orderWatchName(p.prefix),
      entry: join(p.root, 'src', 'infra', 'lambda', 'order-watch.ts'),
      ...bundlingRoot(p.root),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(2),
      role,
      logGroup: fnLogs,
      bundling: { format: OutputFormat.CJS, target: 'node22', externalModules: ['@aws-sdk/*'] },
      environment: { TRACE_CENTRAL_BUCKET: p.central.bucketName, TRACE_DHL_SECRET: secretName, XDG_CACHE_HOME: '/tmp' },
      description: 'trace: checks shipped orders with their carrier on a backed-off timer (carriers send no events)',
    })
    const rule = new events.Rule(this, 'Schedule', {
      ruleName: orderWatchName(p.prefix),
      description: 'trace: the hourly look at the shipped orders whose next check is due',
      schedule: events.Schedule.rate(Duration.hours(1)),
    })
    rule.addTarget(new targets.LambdaFunction(this.function, { retryAttempts: 1, maxEventAge: Duration.hours(1) }))
  }
}
