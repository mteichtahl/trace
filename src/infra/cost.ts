/**
 * The cost read (cost.explorer.enabled): the Lambda `<prefix>-cost-explorer` (src/infra/lambda/cost-explorer.ts) on a
 * daily EventBridge schedule, writing what AWS billed each project into installation/cost/actuals.db.
 *
 * Its role, least privilege:
 *   ce        GetCostAndUsage and ListCostAllocationTags (Cost Explorer has no resource-level permissions for them:
 *             the Service Authorization Reference lists no resource types, so `*`); UpdateCostAllocationTagsStatus
 *             only with cost.explorer.activateTags
 *   s3        GetObject and a conditional PutObject (If-Match / If-None-Match, as every central database writes) on
 *             installation/cost/* of the central bucket, ListBucket under that prefix only (a missing object is a 404
 *             only with it); nothing else of the bucket: no project's data, no access store
 *   logs      its own log group
 *
 * Why a schedule, not an event: Cost Explorer sends no event when a day's figures arrive, and they settle about a day
 * later, so one read a day is the event-free minimum; the screen says when it read and when it reads next.
 */
import { join } from 'node:path'
import { Duration, RemovalPolicy } from 'aws-cdk-lib'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { ACTUALS_FOLDER, ACTUALS_PREFIX } from '../core/cost.js'
import { bundlingRoot } from './lockfile.js'
import type { InfraProps } from './props.js'

export const COST_EXPLORER_READ_ACTIONS = ['ce:GetCostAndUsage', 'ce:ListCostAllocationTags'] as const
export const COST_EXPLORER_ACTIVATE_ACTIONS = ['ce:UpdateCostAllocationTagsStatus'] as const
/** The actuals' prefix in the central bucket. */
export const ACTUALS_OBJECTS = `${ACTUALS_PREFIX}/${ACTUALS_FOLDER}`

export interface CostReadProps {
  prefix: string
  settings: InfraProps['cost']['explorer']
  central: s3.IBucket
  /** the repository root (the Lambda is bundled from src/) */
  root: string
}

export class CostRead extends Construct {
  readonly function: lambda.Function

  constructor(scope: Construct, id: string, p: CostReadProps) {
    super(scope, id)
    const [hour = '6', minute = '17'] = p.settings.at.split(':')
    const fnLogs = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'trace: reads what AWS billed each project (Cost Explorer) into installation/cost/ of the central bucket',
    })
    fnLogs.grantWrite(role)
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CostExplorerRead', actions: [...COST_EXPLORER_READ_ACTIONS], resources: ['*'] }))
    if (p.settings.activateTags) role.addToPolicy(new iam.PolicyStatement({ sid: 'CostAllocationTagsActivate', actions: [...COST_EXPLORER_ACTIVATE_ACTIONS], resources: ['*'] }))
    const objects = p.central.arnForObjects(`${ACTUALS_OBJECTS}/*`)
    role.addToPolicy(new iam.PolicyStatement({ sid: 'ActualsRead', actions: ['s3:GetObject'], resources: [objects] }))
    for (const key of ['s3:if-match', 's3:if-none-match']) {
      role.addToPolicy(new iam.PolicyStatement({ sid: key === 's3:if-match' ? 'ActualsWriteIfMatch' : 'ActualsWriteIfNoneMatch', actions: ['s3:PutObject'], resources: [objects], conditions: { Null: { [key]: 'false' } } }))
    }
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ActualsList', actions: ['s3:ListBucket'], resources: [p.central.bucketArn], conditions: { StringLike: { 's3:prefix': [`${ACTUALS_OBJECTS}/*`] } },
    }))
    this.function = new NodejsFunction(this, 'Function', {
      functionName: `${p.prefix}-cost-explorer`,
      entry: join(p.root, 'src', 'infra', 'lambda', 'cost-explorer.ts'),
      ...bundlingRoot(p.root),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(2),
      role,
      logGroup: fnLogs,
      bundling: { format: OutputFormat.CJS, target: 'node22', externalModules: ['@aws-sdk/*'] },
      environment: {
        TRACE_CENTRAL_BUCKET: p.central.bucketName,
        TRACE_PREFIX: p.prefix,
        TRACE_COST_SCHEDULE: `${Number(hour)}:${Number(minute)}`,
        TRACE_COST_ACTIVATE_TAGS: p.settings.activateTags ? '1' : '0',
        XDG_CACHE_HOME: '/tmp',
      },
      description: 'trace: once a day, what AWS billed each project (Cost Explorer by trace:project) into the cost ledger',
    })
    const rule = new events.Rule(this, 'Schedule', {
      ruleName: `${p.prefix}-cost-explorer`,
      description: 'trace: the daily read of per-project cost from Cost Explorer',
      schedule: events.Schedule.cron({ hour: String(Number(hour)), minute: String(Number(minute)) }),
    })
    rule.addTarget(new targets.LambdaFunction(this.function, { retryAttempts: 2, maxEventAge: Duration.hours(6) }))
  }
}
