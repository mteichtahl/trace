/**
 * AgentCore observability for the stack (OpenTelemetry through ADOT; the code side is src/core/telemetry.ts):
 *
 *   runtimes           the image loads ADOT (`node --require …/register`, agent/Dockerfile); AgentCore Runtime
 *                      supplies its OTEL_* settings, and this adds AGENT_OBSERVABILITY_ENABLED=true and turns
 *                      GenAI message-content capture off. Disabled: DISABLE_ADOT_OBSERVABILITY=true (AgentCore's
 *                      defaults unset) and OTEL_SDK_DISABLED=true (ADOT starts nothing).
 *   IAM                the execution role statements the AgentCore guide lists are in stack.ts (X-Ray, runtime log
 *                      groups, PutMetricData in the bedrock-agentcore namespace); this adds logs:PutResourcePolicy on
 *                      each runtime's own log group (spans delivered there), and X-Ray writes for each project's GPU
 *                      job role
 *   Transaction Search a custom resource (lambda/transaction-search.ts): on if it is not, idempotent, never turned off
 *   GPU jobs           the job definition names X-Ray's OTLP endpoint, so the runner exports its span (TRACEPARENT)
 *   memory             for each project's memory: vended delivery of its APPLICATION_LOGS to its own log group and
 *                      of its TRACES to X-Ray. The log group, sources, destinations and deliveries follow retainData
 *                      like the memory itself (Retain, or Delete, on stack deletion and on removal of the project)
 *   dashboard          invocations, latency, errors, jobs, tokens, cost, tool calls, GPU jobs, and the memories'
 *                      operations (one SEARCH across every project's memory); then the same jobs, tool calls, cost and
 *                      GPU jobs per project (trace.project.*, dimension trace.project = project-<hash>: src/core/
 *                      telemetry.ts PROJECT METRICS), one series per project, which Operations attributes to projects
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
import { memoryDeliveryName } from '../core/project.js'
import type { InfraProps } from './props.js'
import { bundlingRoot } from './lockfile.js'

/** Where ADOT's EMF metrics land (OTEL_EXPORTER_OTLP_LOGS_HEADERS x-aws-metric-namespace on AgentCore). */
export const METRIC_NAMESPACE = 'bedrock-agentcore'
/** AgentCore Runtime's own metrics (Invocations, Latency, SystemErrors, UserErrors, Throttles, …). */
export const RUNTIME_NAMESPACE = 'AWS/Bedrock-AgentCore'
/** The shared span log group Transaction Search writes to (agents on the unified destination use their own group). */
export const SPANS_LOG_GROUP = 'aws/spans'

/** The agents' CloudWatch dashboard (observability.dashboard): the web app's Operations page reads it too. */
export const agentsDashboardName = (prefix: string): string => `${prefix}-agents`

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
  /** Api, or a project's construct id (Project<hash>): names the `<id>LogGroup` output */
  id: string
  runtime: CfnRuntime
  /** the runtime's name (agentRuntimeName), for its log group's ARN pattern */
  name: string
  role: iam.IRole
}

/** One project's memory, for its log and trace delivery. */
export interface ObservedMemory {
  /** the project's construct id (Project<hash>): names its resources and its `<id>MemoryLogGroup` output */
  id: string
  /** the project's hash (the dashboard's search term) */
  hash: string
  /** the project's repository and its names' generation: name its delivery sources and destinations
   * (src/core/project.ts memoryDeliveryName) */
  repository: string
  generation?: number
  /** the memory's name (<prefix>_m_<hash>), for the dashboard */
  name: string
  arn: string
  memoryId: string
  /** where its log group and delivery go: the project's own construct in the nested layout (its nested stack), or
   * this construct (the flat layout, unchanged) when unset */
  scope?: Construct
}

export interface ObservabilityProps {
  prefix: string
  settings: InfraProps['observability']
  runtimes: readonly ObservedRuntime[]
  /** every project's memory: their logs and traces are delivered */
  memories?: readonly ObservedMemory[]
  /** keep the memories' log groups and deliveries when the stack is deleted or a project removed (as the memories) */
  retainData?: boolean
  /** mark the deliveries (sources, destinations, deliveries) Delete whatever retainData says: the 'release' step of
   * the move to nested stacks, so that the next deploy frees their names. The log groups keep retainData's policy:
   * their names carry the memory id, which the new memory does not share. */
  releaseDeliveries?: boolean
  /** the projects' GPU job roles, when there are GPU jobs: they may write spans */
  gpuJobRoles?: readonly iam.IRole[]
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
    this.dashboardName = agentsDashboardName(p.prefix)

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
    for (const role of p.gpuJobRoles ?? []) {
      role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'GpuJobSpans',
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
        resources: ['*'],
      }))
    }

    // ------------------------------------------------------------------ Transaction Search (account-wide, once)
    if (p.settings.transactionSearch) {
      const fn = new NodejsFunction(this, 'TransactionSearchFn', {
        entry: join(import.meta.dirname, '..', '..', 'src', 'infra', 'lambda', 'transaction-search.ts'),
        ...bundlingRoot(join(import.meta.dirname, '..', '..')),
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

    // ------------------------------------------------------------------ each project memory's logs and traces (vended delivery)
    const keep = p.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY
    const keepDelivery = p.releaseDeliveries ? RemovalPolicy.DESTROY : keep
    for (const m of p.memories ?? []) {
      // delivery source and destination names: [\w-]{1,60}, unique in the account and region (and with retainData
      // they outlive the project: its generation, when above 0, keeps a re-added project's apart)
      const name = (kind: 'logs' | 'traces'): string => memoryDeliveryName(p.prefix, m.repository, kind, m.generation ?? 0)
      // flat: in this construct, ids prefixed with the project's (as ever); nested: in the project's own construct
      const at: Construct = m.scope ?? this
      const pre = m.scope ? '' : m.id
      const group = new logs.LogGroup(at, `${pre}MemoryLogs`, {
        logGroupName: `/aws/vendedlogs/bedrock-agentcore/memory/APPLICATION_LOGS/${m.memoryId}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: keep,
      })
      const logsSource = new logs.CfnDeliverySource(at, `${pre}MemoryLogsSource`, { name: name('logs'), logType: 'APPLICATION_LOGS', resourceArn: m.arn })
      const tracesSource = new logs.CfnDeliverySource(at, `${pre}MemoryTracesSource`, { name: name('traces'), logType: 'TRACES', resourceArn: m.arn })
      const logsDest = new logs.CfnDeliveryDestination(at, `${pre}MemoryLogsDestination`, { name: name('logs'), destinationResourceArn: group.logGroupArn })
      const tracesDest = new logs.CfnDeliveryDestination(at, `${pre}MemoryTracesDestination`, { name: name('traces'), deliveryDestinationType: 'XRAY' })
      const logsDelivery = new logs.CfnDelivery(at, `${pre}MemoryLogsDelivery`, { deliverySourceName: logsSource.name, deliveryDestinationArn: logsDest.attrArn })
      const tracesDelivery = new logs.CfnDelivery(at, `${pre}MemoryTracesDelivery`, { deliverySourceName: tracesSource.name, deliveryDestinationArn: tracesDest.attrArn })
      for (const r of [logsSource, tracesSource, logsDest, tracesDest, logsDelivery, tracesDelivery]) r.applyRemovalPolicy(keepDelivery)
      logsDelivery.addDependency(logsSource)
      tracesDelivery.addDependency(tracesSource)
      // X-Ray as a destination needs Transaction Search (nested: CDK makes the project's nested stack wait for it)
      if (this.transactionSearch) tracesDelivery.node.addDependency(this.transactionSearch)
      new CfnOutput(Stack.of(at), `${m.id}MemoryLogGroup`, { value: group.logGroupName, description: `The project's memory (${m.name}): its APPLICATION_LOGS` })
    }

    // ------------------------------------------------------------------ the dashboard
    if (p.settings.dashboard) {
      this.dashboard = new cloudwatch.CfnDashboard(this, 'Dashboard', {
        dashboardName: this.dashboardName,
        dashboardBody: JSON.stringify(dashboardBody({ region, runtimes: p.runtimes.map((r) => r.name), memories: (p.memories ?? []).map((m) => m.hash), gpu: p.gpu })),
      })
      new CfnOutput(stack, 'DashboardUrl', {
        value: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards/dashboard/${this.dashboardName}`,
        description: 'The trace agents\' CloudWatch dashboard',
      })
    }

    // ------------------------------------------------------------------ where to look
    for (const r of p.runtimes) {
      // in the runtime's own stack: a project's nested stack in the nested layout
      new CfnOutput(Stack.of(r.runtime), `${r.id}LogGroup`, {
        value: Fn.join('', ['/aws/bedrock-agentcore/runtimes/', r.runtime.attrAgentRuntimeId, '-DEFAULT']),
        description: `The ${r.name} runtime's log group (its logs, and its spans on the unified destination)`,
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

/**
 * The dashboard: AgentCore's own runtime metrics, then trace's (namespace bedrock-agentcore, from ADOT's EMF), then
 * the projects' memories. `memories` are the projects' hashes: each memory's name and id (<prefix>_m_<hash>-…) carry
 * it, so one SEARCH term per project finds that memory's series whichever dimension AgentCore files them under.
 */
export function dashboardBody(o: { region: string; runtimes: readonly string[]; memories?: readonly string[]; gpu: boolean }): { widgets: Widget[] } {
  const { region } = o
  const rt = o.runtimes.map((n) => `"${n}"`).join(' OR ')
  // a SEARCH expression is at most 1024 characters: with many projects, every runtime in the namespace is shown
  const runtimeFilter = o.runtimes.length && rt.length <= 800 ? `(${rt})` : ''
  const mt = (o.memories ?? []).join(' OR ')
  const memoryFilter = mt.length <= 800 ? `(${mt})` : 'memory'
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
  let y = o.gpu ? 32 : 26
  if (o.memories?.length) {
    widgets.push(graph('Memory operations (every project\'s memory)', region, 0, y, [search('minv', RUNTIME_NAMESPACE, 'Invocations', 'Sum', memoryFilter)], { stacked: true }))
    widgets.push(graph('Memory latency (avg)', region, 8, y, [search('mlat', RUNTIME_NAMESPACE, 'Latency', 'Average', memoryFilter)], { yLabel: 'ms' }))
    widgets.push(graph('Memory errors and throttles', region, 16, y, [
      search('merr', RUNTIME_NAMESPACE, 'Errors', 'Sum', memoryFilter),
      search('mthr', RUNTIME_NAMESPACE, 'Throttles', 'Sum', memoryFilter),
    ]))
    y += 6
  }
  // per project: one series per project and outcome (the label carries project-<hash>: src/web/ops.ts attribute). Kept
  // apart from the aggregate widgets above, which stay exactly as they were
  const proj = '"trace.project"'
  widgets.push({ type: 'text', x: 0, y, width: 24, height: 1, properties: { markdown: '### Per project (`trace.project` is the project\'s hash: Operations names the projects for the people on them)' } })
  y += 1
  widgets.push(graph('Jobs per project', region, 0, y, [search('pjobs', METRIC_NAMESPACE, 'trace.project.jobs', 'Sum', proj)], { stacked: true }))
  widgets.push(graph('Job duration per project (p90)', region, 8, y, [search('pjdur', METRIC_NAMESPACE, 'trace.project.job.duration', 'p90', proj)], { yLabel: 's' }))
  widgets.push(graph('Tool calls per project', region, 16, y, [search('ptools', METRIC_NAMESPACE, 'trace.project.tool.calls', 'Sum', proj)], { stacked: true }))
  y += 6
  widgets.push(graph('Tool duration per project (p90)', region, 0, y, [search('ptdur', METRIC_NAMESPACE, 'trace.project.tool.duration', 'p90', proj)], { yLabel: 'ms' }))
  widgets.push(graph('Claude cost per project (estimate, USD)', region, 8, y, [search('pcost', METRIC_NAMESPACE, 'trace.project.claude.cost', 'Sum', proj)], { stacked: true }))
  if (o.gpu) widgets.push(graph('GPU and CPU jobs per project', region, 16, y, [search('pgpu', METRIC_NAMESPACE, 'trace.project.gpu.jobs', 'Sum', proj)], { stacked: true }))
  return { widgets }
}
