/**
 * AgentCore observability for the stack (OpenTelemetry through ADOT; the code side is src/core/telemetry.ts):
 *
 *   runtimes           the image loads ADOT (`node --require …/register`, agent/Dockerfile); AgentCore Runtime
 *                      supplies its OTEL_* settings, and this adds AGENT_OBSERVABILITY_ENABLED=true and turns
 *                      GenAI message-content capture off. Disabled: DISABLE_ADOT_OBSERVABILITY=true (AgentCore's
 *                      defaults unset) and OTEL_SDK_DISABLED=true (ADOT starts nothing).
 *   IAM                the execution role statements the AgentCore guide lists are in stack.ts (X-Ray, runtime log
 *                      groups, PutMetricData in the bedrock-agentcore namespace); this adds logs:PutResourcePolicy on
 *                      each runtime's own log group (spans delivered there), and X-Ray writes for the GPU job role
 *   Transaction Search a custom resource (lambda/transaction-search.ts): on if it is not, idempotent, never turned off
 *   GPU jobs           the job definition names X-Ray's OTLP endpoint, so the runner exports its span (TRACEPARENT)
 *   memory             vended delivery of the memory's APPLICATION_LOGS to a log group and its TRACES to X-Ray
 *   dashboard          invocations, latency, errors, jobs, tokens, cost, tool calls and GPU jobs
 *
 * Disabled, nothing is created: only the two environment variables that keep the runtimes quiet.
 */
import { join } from 'node:path'
import { CfnOutput, CustomResource, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Provider } from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'
import type { InfraProps } from './props.js'

/** Where ADOT's EMF metrics land (OTEL_EXPORTER_OTLP_LOGS_HEADERS x-aws-metric-namespace on AgentCore). */
export const METRIC_NAMESPACE = 'bedrock-agentcore'
/** AgentCore Runtime's own metrics (Invocations, Latency, SystemErrors, UserErrors, Throttles, …). */
export const RUNTIME_NAMESPACE = 'AWS/Bedrock-AgentCore'
/** The shared span log group Transaction Search writes to (agents on the unified destination use their own group). */
export const SPANS_LOG_GROUP = 'aws/spans'

/** Runtime environment when observability is on. AgentCore sets the rest (OTEL_RESOURCE_ATTRIBUTES, the OTLP headers). */
export const ENABLED_ENV: Readonly<Record<string, string>> = {
  AGENT_OBSERVABILITY_ENABLED: 'true',
  // ADOT's GenAI instrumentations would otherwise record prompts and completions on spans
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
}
/** Runtime environment when it is off: AgentCore's ADOT defaults unset, and the SDK the image loads does nothing. */
export const DISABLED_ENV: Readonly<Record<string, string>> = { DISABLE_ADOT_OBSERVABILITY: 'true', OTEL_SDK_DISABLED: 'true' }

/** The GPU job's environment: export the runner's span to X-Ray's OTLP endpoint (SigV4, the job role). */
export function gpuTelemetryEnv(cfg: Pick<InfraProps, 'observability' | 'region' | 'prefix'>): Record<string, string> {
  if (!cfg.observability.enabled) return {}
  return {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://xray.${cfg.region}.amazonaws.com/v1/traces`,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_SERVICE_NAME: `${cfg.prefix}-gpu`,
  }
}

export interface ObservedRuntime {
  /** worker or api: names the outputs */
  id: 'Worker' | 'Api'
  runtime: CfnRuntime
  /** the runtime's name (agentRuntimeName), for its log group's ARN pattern */
  name: string
  role: iam.IRole
}

export interface ObservabilityProps {
  prefix: string
  settings: InfraProps['observability']
  runtimes: readonly ObservedRuntime[]
  /** the agents' memory, when there is one: its logs and traces are delivered */
  memory?: { arn: string; id: string } | null
  /** the GPU job role, when there are GPU jobs: it may write spans */
  gpuJobRole?: iam.IRole | null
  /** whether the GPU side exists (its widgets) */
  gpu: boolean
}

export class Observability extends Construct {
  readonly transactionSearch: CustomResource | null = null
  readonly dashboard: cloudwatch.CfnDashboard | null = null
  readonly dashboardName: string

  constructor(scope: Construct, id: string, p: ObservabilityProps) {
    super(scope, id)
    const stack = Stack.of(this)
    const { region, account, partition } = stack
    this.dashboardName = `${p.prefix}-agents`

    if (!p.settings.enabled) {
      for (const r of p.runtimes) for (const [k, v] of Object.entries(DISABLED_ENV)) r.runtime.addPropertyOverride(`EnvironmentVariables.${k}`, v)
      return
    }
    for (const r of p.runtimes) {
      for (const [k, v] of Object.entries(ENABLED_ENV)) r.runtime.addPropertyOverride(`EnvironmentVariables.${k}`, v)
      // AgentCore delivers the agent's spans to its own log group and needs to let X-Ray write there
      r.role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'AgentCoreSpanDestination',
        actions: ['logs:PutResourcePolicy'],
        resources: [`arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${r.name}-*`],
      }))
    }
    p.gpuJobRole?.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'GpuJobSpans',
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
      resources: ['*'],
    }))

    // ------------------------------------------------------------------ Transaction Search (account-wide, once)
    if (p.settings.transactionSearch) {
      const fn = new NodejsFunction(this, 'TransactionSearchFn', {
        entry: join(import.meta.dirname, '..', '..', 'src', 'infra', 'lambda', 'transaction-search.ts'),
        handler: 'onEvent',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: Duration.minutes(2),
        bundling: { format: OutputFormat.CJS, target: 'node22', externalModules: ['@aws-sdk/*'] },
        logGroup: new logs.LogGroup(this, 'TransactionSearchFnLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
        description: 'trace: turns on CloudWatch Transaction Search if it is off (never turns it off)',
      })
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['xray:GetTraceSegmentDestination', 'xray:UpdateTraceSegmentDestination', 'xray:UpdateIndexingRule', 'xray:GetIndexingRules'],
        resources: ['*'],
      }))
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:DescribeResourcePolicies', 'logs:PutResourcePolicy'], resources: ['*'] }))
      const provider = new Provider(this, 'TransactionSearchProvider', { onEventHandler: fn })
      this.transactionSearch = new CustomResource(this, 'TransactionSearch', {
        serviceToken: provider.serviceToken,
        resourceType: 'Custom::TransactionSearch',
        // RETAIN as well as a no-op Delete: removing the stack must never turn Transaction Search off
        removalPolicy: RemovalPolicy.RETAIN,
        properties: {
          Partition: partition, Region: region, Account: account,
          ...(p.settings.samplingPercent !== undefined ? { SamplingPercent: String(p.settings.samplingPercent) } : {}),
        },
      })
    }

    // ------------------------------------------------------------------ the memory's logs and traces (vended delivery)
    if (p.memory) {
      const group = new logs.LogGroup(this, 'MemoryLogs', {
        logGroupName: `/aws/vendedlogs/bedrock-agentcore/memory/APPLICATION_LOGS/${p.memory.id}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      })
      const logsSource = new logs.CfnDeliverySource(this, 'MemoryLogsSource', { name: `${p.prefix}-memory-logs`, logType: 'APPLICATION_LOGS', resourceArn: p.memory.arn })
      const tracesSource = new logs.CfnDeliverySource(this, 'MemoryTracesSource', { name: `${p.prefix}-memory-traces`, logType: 'TRACES', resourceArn: p.memory.arn })
      const logsDest = new logs.CfnDeliveryDestination(this, 'MemoryLogsDestination', { name: `${p.prefix}-memory-logs`, destinationResourceArn: group.logGroupArn })
      const tracesDest = new logs.CfnDeliveryDestination(this, 'MemoryTracesDestination', { name: `${p.prefix}-memory-traces`, deliveryDestinationType: 'XRAY' })
      const logsDelivery = new logs.CfnDelivery(this, 'MemoryLogsDelivery', { deliverySourceName: logsSource.name, deliveryDestinationArn: logsDest.attrArn })
      const tracesDelivery = new logs.CfnDelivery(this, 'MemoryTracesDelivery', { deliverySourceName: tracesSource.name, deliveryDestinationArn: tracesDest.attrArn })
      logsDelivery.addDependency(logsSource)
      tracesDelivery.addDependency(tracesSource)
      // X-Ray as a destination needs Transaction Search
      if (this.transactionSearch) tracesDelivery.node.addDependency(this.transactionSearch)
      new CfnOutput(stack, 'MemoryLogGroup', { value: group.logGroupName, description: 'The agents\' memory: its APPLICATION_LOGS' })
    }

    // ------------------------------------------------------------------ the dashboard
    if (p.settings.dashboard) {
      this.dashboard = new cloudwatch.CfnDashboard(this, 'Dashboard', {
        dashboardName: this.dashboardName,
        dashboardBody: JSON.stringify(dashboardBody({ region, runtimes: p.runtimes.map((r) => r.name), gpu: p.gpu })),
      })
      new CfnOutput(stack, 'DashboardUrl', {
        value: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards/dashboard/${this.dashboardName}`,
        description: 'The trace agents\' CloudWatch dashboard',
      })
    }

    // ------------------------------------------------------------------ where to look
    for (const r of p.runtimes) {
      new CfnOutput(stack, `${r.id}LogGroup`, {
        value: Fn.join('', ['/aws/bedrock-agentcore/runtimes/', r.runtime.attrAgentRuntimeId, '-DEFAULT']),
        description: `The ${r.id.toLowerCase()} runtime's log group (its logs, and its spans on the unified destination)`,
      })
    }
    new CfnOutput(stack, 'SpansLogGroup', { value: SPANS_LOG_GROUP, description: 'The shared span log group (CloudWatch Transaction Search)' })
    new CfnOutput(stack, 'GenAiObservabilityUrl', {
      value: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#gen-ai-observability`,
      description: 'CloudWatch GenAI Observability: the agents, their sessions and traces',
    })
  }
}

// ------------------------------------------------------------------ the dashboard's body

type Widget = Record<string, unknown>

/** A metric-math SEARCH: every series of that metric, whatever its dimensions (they are trace.* attributes). */
const search = (id: string, namespace: string, metric: string, stat: string, extra = '', label?: string): Record<string, unknown> => ({
  expression: `SEARCH('Namespace="${namespace}" MetricName="${metric}"${extra ? ` ${extra}` : ''}', '${stat}', 300)`,
  id, ...(label ? { label } : {}),
})

function graph(title: string, region: string, x: number, y: number, queries: Record<string, unknown>[], o: { w?: number; stacked?: boolean; yLabel?: string } = {}): Widget {
  return {
    type: 'metric', x, y, width: o.w ?? 8, height: 6,
    properties: {
      title, region, view: 'timeSeries', stacked: o.stacked ?? false, period: 300,
      metrics: queries.map((q) => [q]),
      ...(o.yLabel ? { yAxis: { left: { label: o.yLabel, showUnits: false } } } : {}),
    },
  }
}

/** The dashboard: AgentCore's own runtime metrics, then trace's (namespace bedrock-agentcore, from ADOT's EMF). */
export function dashboardBody(o: { region: string; runtimes: readonly string[]; gpu: boolean }): { widgets: Widget[] } {
  const { region } = o
  const rt = o.runtimes.map((n) => `"${n}"`).join(' OR ')
  const runtimeFilter = o.runtimes.length ? `(${rt})` : ''
  // dimension names in the filter keep other agents' metrics in the shared namespace out
  const ours = '"trace.outcome"'
  const widgets: Widget[] = [
    {
      type: 'text', x: 0, y: 0, width: 24, height: 2,
      properties: {
        markdown: `## trace agents\nSessions, traces and spans: [CloudWatch GenAI Observability](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#gen-ai-observability) · [Transaction Search](https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:traces/query). Metrics below: AgentCore Runtime (\`${RUNTIME_NAMESPACE}\`), then trace's own (\`${METRIC_NAMESPACE}\`).`,
      },
    },
    graph('Runtime invocations', region, 0, 2, [search('inv', RUNTIME_NAMESPACE, 'Invocations', 'Sum', runtimeFilter)]),
    graph('Runtime latency (avg)', region, 8, 2, [search('lat', RUNTIME_NAMESPACE, 'Latency', 'Average', runtimeFilter)], { yLabel: 'ms' }),
    graph('Runtime errors and throttles', region, 16, 2, [
      search('sys', RUNTIME_NAMESPACE, 'SystemErrors', 'Sum', runtimeFilter),
      search('usr', RUNTIME_NAMESPACE, 'UserErrors', 'Sum', runtimeFilter),
      search('thr', RUNTIME_NAMESPACE, 'Throttles', 'Sum', runtimeFilter),
    ]),
    graph('Invocations by kind and outcome', region, 0, 8, [search('tinv', METRIC_NAMESPACE, 'trace.invocations', 'Sum', ours)], { stacked: true }),
    graph('Jobs by kind and outcome', region, 8, 8, [search('jobs', METRIC_NAMESPACE, 'trace.jobs', 'Sum', ours)], { stacked: true }),
    graph('Job duration (p90)', region, 16, 8, [search('jdur', METRIC_NAMESPACE, 'trace.job.duration', 'p90', ours)], { yLabel: 's' }),
    graph('Claude tokens by type', region, 0, 14, [search('tok', METRIC_NAMESPACE, 'gen_ai.client.token.usage', 'Sum', '"trace.agent"')], { stacked: true }),
    graph('Claude cost (estimate, USD)', region, 8, 14, [search('cost', METRIC_NAMESPACE, 'trace.claude.cost', 'Sum', '"trace.agent"')], { stacked: true }),
    graph('Tool calls', region, 16, 14, [search('tools', METRIC_NAMESPACE, 'trace.tool.calls', 'Sum', ours)], { stacked: true }),
    graph('Tool errors', region, 0, 20, [search('terr', METRIC_NAMESPACE, 'trace.tool.errors', 'Sum', '"trace.tool.name"')]),
    graph('Tool duration (p90)', region, 8, 20, [search('tdur', METRIC_NAMESPACE, 'trace.tool.duration', 'p90', ours)], { yLabel: 'ms' }),
  ]
  if (o.gpu) {
    widgets.push(graph('GPU jobs by kind, backend and outcome', region, 16, 20, [search('gpu', METRIC_NAMESPACE, 'trace.gpu.jobs', 'Sum', ours)], { stacked: true }))
    widgets.push(graph('GPU job duration (p90, queue wait included)', region, 0, 26, [search('gdur', METRIC_NAMESPACE, 'trace.gpu.duration', 'p90', ours)], { w: 24, yLabel: 's' }))
  }
  return { widgets }
}
