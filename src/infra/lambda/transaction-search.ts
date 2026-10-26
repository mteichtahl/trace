/**
 * The custom resource that turns on CloudWatch Transaction Search, which AgentCore observability needs once per
 * account and region (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html):
 *
 *   1. a CloudWatch Logs resource policy letting X-Ray write spans to aws/spans (and /aws/application-signals/data),
 *      unless one already does
 *   2. X-Ray UpdateTraceSegmentDestination → CloudWatchLogs, unless the destination already is CloudWatchLogs
 *   3. optionally X-Ray UpdateIndexingRule "Default" → the given sampling percentage
 *
 * Idempotent: an account that already has Transaction Search is left as it is (only the indexing rule is set, and
 * only when a percentage is given). Deleting the stack never turns it off: the setting is account-wide and other
 * workloads may rely on it.
 */
import { CloudWatchLogsClient, DescribeResourcePoliciesCommand, PutResourcePolicyCommand } from '@aws-sdk/client-cloudwatch-logs'
import { GetTraceSegmentDestinationCommand, UpdateIndexingRuleCommand, UpdateTraceSegmentDestinationCommand, XRayClient } from '@aws-sdk/client-xray'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'

export const POLICY_NAME = 'trace-transaction-search'

export interface Props { Partition: string; Region: string; Account: string; SamplingPercent?: string }

export interface Clients {
  xray: Pick<XRayClient, 'send'>
  logs: Pick<CloudWatchLogsClient, 'send'>
}

const props = (e: CloudFormationCustomResourceEvent): Props => {
  const p = e.ResourceProperties as unknown as Partial<Props>
  if (!p.Partition || !p.Region || !p.Account) throw new Error('Partition, Region and Account are required')
  return { Partition: p.Partition, Region: p.Region, Account: p.Account, ...(p.SamplingPercent !== undefined && p.SamplingPercent !== '' ? { SamplingPercent: String(p.SamplingPercent) } : {}) }
}

/** The resource policy from the AgentCore guide: X-Ray may put log events into the span log groups, for this account only. */
export function policyDocument(p: Props): string {
  const arn = (group: string): string => `arn:${p.Partition}:logs:${p.Region}:${p.Account}:log-group:${group}:*`
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'TransactionSearchXRayAccess',
      Effect: 'Allow',
      Principal: { Service: 'xray.amazonaws.com' },
      Action: 'logs:PutLogEvents',
      Resource: [arn('aws/spans'), arn('/aws/application-signals/data')],
      Condition: {
        ArnLike: { 'aws:SourceArn': `arn:${p.Partition}:xray:${p.Region}:${p.Account}:*` },
        StringEquals: { 'aws:SourceAccount': p.Account },
      },
    }],
  })
}

/** Whether some resource policy in the account already lets X-Ray write to aws/spans (the console's, or ours). */
async function policyExists(logs: Clients['logs']): Promise<boolean> {
  let nextToken: string | undefined
  do {
    const r = await logs.send(new DescribeResourcePoliciesCommand({ ...(nextToken ? { nextToken } : {}) }))
    for (const pol of r.resourcePolicies ?? []) {
      const doc = pol.policyDocument ?? ''
      if (pol.policyName === POLICY_NAME || (doc.includes('xray.amazonaws.com') && doc.includes('aws/spans'))) return true
    }
    nextToken = r.nextToken
  } while (nextToken)
  return false
}

export async function enable(p: Props, c: Clients): Promise<{ alreadyEnabled: boolean; policyWritten: boolean; indexing: string }> {
  const dest = await c.xray.send(new GetTraceSegmentDestinationCommand({}))
  const alreadyEnabled = dest.Destination === 'CloudWatchLogs'
  let policyWritten = false
  if (!alreadyEnabled) {
    if (!(await policyExists(c.logs))) {
      await c.logs.send(new PutResourcePolicyCommand({ policyName: POLICY_NAME, policyDocument: policyDocument(p) }))
      policyWritten = true
    }
    await c.xray.send(new UpdateTraceSegmentDestinationCommand({ Destination: 'CloudWatchLogs' }))
  }
  let indexing = 'unchanged'
  if (p.SamplingPercent !== undefined) {
    const pct = Number(p.SamplingPercent)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`SamplingPercent must be 0–100, not ${p.SamplingPercent}`)
    await c.xray.send(new UpdateIndexingRuleCommand({ Name: 'Default', Rule: { Probabilistic: { DesiredSamplingPercentage: pct } } }))
    indexing = String(pct)
  }
  return { alreadyEnabled, policyWritten, indexing }
}

let clients: Clients | null = null
const real = (): Clients => (clients ??= { xray: new XRayClient({}), logs: new CloudWatchLogsClient({}) })

/** The Provider's handler (Lambda passes its context second, so the clients are not a parameter here). */
export const onEvent = (event: CloudFormationCustomResourceEvent): ReturnType<typeof handle> => handle(event, real())

export async function handle(event: CloudFormationCustomResourceEvent, c: Clients): Promise<{ PhysicalResourceId: string; Data?: Record<string, string> }> {
  const p = props(event)
  const id = `transaction-search-${p.Account}-${p.Region}`
  // Never turned off: Transaction Search is account-wide.
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId }
  const r = await enable(p, c)
  return { PhysicalResourceId: id, Data: { AlreadyEnabled: String(r.alreadyEnabled), PolicyWritten: String(r.policyWritten), Indexing: r.indexing } }
}
