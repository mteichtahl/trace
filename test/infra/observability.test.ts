import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { DescribeResourcePoliciesCommand, PutResourcePolicyCommand } from '@aws-sdk/client-cloudwatch-logs'
import { GetTraceSegmentDestinationCommand, UpdateIndexingRuleCommand, UpdateTraceSegmentDestinationCommand } from '@aws-sdk/client-xray'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'
import { beforeAll, describe, expect, it } from 'vitest'
import { POLICY_NAME, type Clients, handle, policyDocument } from '../../src/infra/lambda/transaction-search.js'
import { METRIC_NAMESPACE, RUNTIME_NAMESPACE, dashboardBody } from '../../src/infra/observability.js'
import { InfraPropsSchema, stackName } from '../../src/infra/props.js'
import { TraceStack } from '../../src/infra/stack.js'
import { AnswersSchema } from '../../src/installer/answers.js'
import { infraInput, plan } from '../../src/installer/bootstrap.js'

const base = {
  account: '123456789012', region: 'us-east-1', repositories: ['mteichtahl/trace'],
  model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com',
}

type Res = { Type: string; Properties?: Record<string, unknown>; DeletionPolicy?: string }

const policiesOf = (t: Template, prefix: string): string =>
  Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith(prefix)).map(([, p]) => JSON.stringify(p)).join()

const runtimeEnv = (t: Template, name: string): Record<string, unknown> => {
  const r = Object.values(t.findResources('AWS::BedrockAgentCore::Runtime') as Record<string, Res>).find((x) => x.Properties?.AgentRuntimeName === name)
  return (r?.Properties?.EnvironmentVariables ?? {}) as Record<string, unknown>
}

describe('observability in the stack', () => {
  let t: Template
  beforeAll(() => {
    t = Template.fromStack(new TraceStack(new App(), stackName('trace'), InfraPropsSchema.parse(base)))
  }, 300_000)

  it('is on by default', () => {
    const o = InfraPropsSchema.parse(base).observability
    expect(o).toEqual({ enabled: true, transactionSearch: true, dashboard: true })
  })

  it('tells both runtimes to run ADOT for AgentCore, without message content, and leaves the rest to AgentCore', () => {
    for (const name of ['trace_agent', 'trace_api']) {
      const env = runtimeEnv(t, name)
      expect(env).toMatchObject({ AGENT_OBSERVABILITY_ENABLED: 'true', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false' })
      // AgentCore supplies these for hosted runtimes (they name the runtime's own log group)
      for (const k of ['DISABLE_ADOT_OBSERVABILITY', 'OTEL_SDK_DISABLED', 'OTEL_RESOURCE_ATTRIBUTES', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS']) expect(env[k]).toBeUndefined()
    }
  })

  it('gives each runtime role the execution-role telemetry statements, and PutResourcePolicy on its own log group only', () => {
    for (const [who, name] of [['WorkerRuntimeRole', 'trace_agent'], ['ApiRuntimeRole', 'trace_api']] as const) {
      const p = policiesOf(t, who)
      for (const a of ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets', 'logs:CreateLogStream', 'logs:PutLogEvents']) expect(p).toContain(a)
      expect(p).toContain('/aws/bedrock-agentcore/runtimes/*')
      expect(p).toContain(`/aws/bedrock-agentcore/runtimes/${name}-*`)
      expect(p).toMatch(/"Action":"logs:PutResourcePolicy"/)
    }
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'cloudwatch:PutMetricData', Resource: '*', Condition: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } })]) },
    })
    expect(policiesOf(t, 'WorkerRuntimeRole')).not.toContain('trace_api-*')
  })

  it('turns Transaction Search on with a custom resource that is kept on delete and leaves indexing alone by default', () => {
    const crs = Object.values(t.findResources('Custom::TransactionSearch') as Record<string, Res>)
    expect(crs).toHaveLength(1)
    const cr = crs[0] as Res
    expect(cr.DeletionPolicy).toBe('Retain')
    expect(cr.Properties).toMatchObject({ Account: '123456789012', Region: 'us-east-1' })
    expect(cr.Properties?.SamplingPercent).toBeUndefined()
    const fn = Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('ObservabilityTransactionSearchFn')).map(([, p]) => JSON.stringify(p)).join()
    for (const a of ['xray:GetTraceSegmentDestination', 'xray:UpdateTraceSegmentDestination', 'xray:UpdateIndexingRule', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies']) expect(fn).toContain(a)
    // the image builds are still the only CloudFormation::CustomResource ones
    t.resourceCountIs('AWS::CloudFormation::CustomResource', 2)
  })

  it('delivers the memory\'s application logs to a log group and its traces to X-Ray', () => {
    t.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'APPLICATION_LOGS', Name: 'trace-memory-logs', ResourceArn: Match.anyValue() })
    t.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'TRACES', Name: 'trace-memory-traces' })
    t.hasResourceProperties('AWS::Logs::DeliveryDestination', { DeliveryDestinationType: 'XRAY' })
    t.hasResourceProperties('AWS::Logs::DeliveryDestination', { DestinationResourceArn: Match.anyValue() })
    t.resourceCountIs('AWS::Logs::Delivery', 2)
    const delivery = Object.values(t.findResources('AWS::Logs::Delivery') as Record<string, Res & { DependsOn?: string[] }>)
    expect(delivery.some((d) => (d.DependsOn ?? []).some((x) => x.startsWith('ObservabilityTransactionSearch')))).toBe(true)
  })

  it('has the GPU jobs export their span to X-Ray\'s OTLP endpoint, as the job role', () => {
    t.hasResourceProperties('AWS::Batch::JobDefinition', {
      ContainerProperties: Match.objectLike({
        Environment: Match.arrayWith([
          { Name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', Value: 'https://xray.us-east-1.amazonaws.com/v1/traces' },
          { Name: 'OTEL_TRACES_EXPORTER', Value: 'otlp' },
          { Name: 'OTEL_METRICS_EXPORTER', Value: 'none' },
        ]),
      }),
    })
    expect(policiesOf(t, 'GpuJobRole')).toContain('xray:PutTraceSegments')
  })

  it('has a dashboard of invocations, latency, errors, jobs, tokens, cost, tool calls and GPU jobs, and says where to look', () => {
    const d = Object.values(t.findResources('AWS::CloudWatch::Dashboard') as Record<string, Res>)
    expect(d).toHaveLength(1)
    expect(d[0]?.Properties?.DashboardName).toBe('trace-agents')
    const body = JSON.stringify(d[0]?.Properties?.DashboardBody)
    for (const m of ['Invocations', 'Latency', 'SystemErrors', 'UserErrors', 'Throttles', 'trace.invocations', 'trace.jobs', 'trace.job.duration', 'gen_ai.client.token.usage', 'trace.claude.cost', 'trace.tool.calls', 'trace.tool.errors', 'trace.tool.duration', 'trace.gpu.jobs', 'trace.gpu.duration']) {
      expect(body).toContain(m)
    }
    const outputs = Object.keys(t.toJSON().Outputs as Record<string, unknown>)
    for (const o of ['DashboardUrl', 'WorkerLogGroup', 'ApiLogGroup', 'SpansLogGroup', 'MemoryLogGroup', 'GenAiObservabilityUrl']) expect(outputs).toContain(o)
    expect(JSON.stringify(t.toJSON().Outputs)).toContain('#dashboards/dashboard/trace-agents')
  })

  it('creates nothing when off, and tells the runtimes to stay quiet', () => {
    const off = Template.fromStack(new TraceStack(new App(), 'NoObs', InfraPropsSchema.parse({ ...base, observability: { enabled: false } })))
    for (const r of ['Custom::TransactionSearch', 'AWS::CloudWatch::Dashboard', 'AWS::Logs::DeliverySource', 'AWS::Logs::DeliveryDestination', 'AWS::Logs::Delivery']) off.resourceCountIs(r, 0)
    for (const name of ['trace_agent', 'trace_api']) {
      const env = runtimeEnv(off, name)
      expect(env).toMatchObject({ DISABLE_ADOT_OBSERVABILITY: 'true', OTEL_SDK_DISABLED: 'true' })
      expect(env.AGENT_OBSERVABILITY_ENABLED).toBeUndefined()
    }
    const json = JSON.stringify(off.toJSON())
    expect(json).not.toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')
    expect(json).not.toContain('logs:PutResourcePolicy')
    const outputs = Object.keys(off.toJSON().Outputs as Record<string, unknown>)
    for (const o of ['DashboardUrl', 'SpansLogGroup', 'MemoryLogGroup']) expect(outputs).not.toContain(o)
  }, 300_000)

  it('can skip Transaction Search and the dashboard, and set the indexing percentage', () => {
    const t2 = Template.fromStack(new TraceStack(new App(), 'Partial', InfraPropsSchema.parse({ ...base, observability: { transactionSearch: false, dashboard: false } })))
    t2.resourceCountIs('Custom::TransactionSearch', 0)
    t2.resourceCountIs('AWS::CloudWatch::Dashboard', 0)
    t2.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'TRACES' })
    const t3 = Template.fromStack(new TraceStack(new App(), 'Sampled', InfraPropsSchema.parse({ ...base, observability: { samplingPercent: 25 } })))
    t3.hasResourceProperties('Custom::TransactionSearch', { SamplingPercent: '25' })
    expect(() => InfraPropsSchema.parse({ ...base, observability: { samplingPercent: 101 } })).toThrow()
  }, 300_000)
})

describe('the dashboard body', () => {
  it('is metric-math SEARCH over our namespaces, filtered to these runtimes, with the GPU rows only when there are GPU jobs', () => {
    const b = dashboardBody({ region: 'eu-west-1', runtimes: ['lab_agent', 'lab_api'], gpu: false })
    const text = JSON.stringify(b)
    expect(text).toContain(`Namespace=\\"${RUNTIME_NAMESPACE}\\"`)
    expect(text).toContain(`Namespace=\\"${METRIC_NAMESPACE}\\"`)
    expect(text).toContain('(\\"lab_agent\\" OR \\"lab_api\\")')
    expect(text).not.toContain('trace.gpu.jobs')
    const exprs = b.widgets.flatMap((w) => ((w.properties as { metrics?: { expression: string }[][] }).metrics ?? []).flat().map((m) => m.expression))
    for (const e of exprs) expect(e).toMatch(/^SEARCH\('Namespace="[^"]+" MetricName="[^"]+"[^']*', '(Sum|Average|p90)', 300\)$/)
    for (const w of b.widgets) expect((w.properties as { region?: string }).region ?? 'eu-west-1').toBe('eu-west-1')
    expect(JSON.stringify(dashboardBody({ region: 'eu-west-1', runtimes: [], gpu: true }))).toContain('trace.gpu.duration')
  })
})

// ------------------------------------------------------------------ the Transaction Search custom resource

function fakeClients(o: { destination?: string; policies?: { policyName: string; policyDocument: string }[] }) {
  const calls: string[] = []
  const sent: unknown[] = []
  const c: Clients = {
    xray: {
      send: (async (cmd: unknown) => {
        sent.push(cmd)
        if (cmd instanceof GetTraceSegmentDestinationCommand) { calls.push('get'); return { Destination: o.destination ?? 'XRay', Status: 'ACTIVE' } }
        if (cmd instanceof UpdateTraceSegmentDestinationCommand) { calls.push('update'); return {} }
        if (cmd instanceof UpdateIndexingRuleCommand) { calls.push('indexing'); return {} }
        throw new Error('unexpected xray call')
      }) as Clients['xray']['send'],
    },
    logs: {
      send: (async (cmd: unknown) => {
        sent.push(cmd)
        if (cmd instanceof DescribeResourcePoliciesCommand) { calls.push('describe'); return { resourcePolicies: o.policies ?? [] } }
        if (cmd instanceof PutResourcePolicyCommand) { calls.push('put'); return {} }
        throw new Error('unexpected logs call')
      }) as Clients['logs']['send'],
    },
  }
  return { c, calls, sent }
}

const event = (type: 'Create' | 'Update' | 'Delete', props: Record<string, string> = {}): CloudFormationCustomResourceEvent => ({
  RequestType: type, ServiceToken: 'x', ResponseURL: 'https://example.com', StackId: 's', RequestId: 'r', LogicalResourceId: 'TransactionSearch',
  ResourceType: 'Custom::TransactionSearch', ResourceProperties: { ServiceToken: 'x', Partition: 'aws', Region: 'us-east-1', Account: '123456789012', ...props },
  ...(type === 'Create' ? {} : { PhysicalResourceId: 'transaction-search-123456789012-us-east-1', OldResourceProperties: {} }),
} as CloudFormationCustomResourceEvent)

describe('the Transaction Search custom resource', () => {
  it('writes the X-Ray resource policy and sends segments to CloudWatch Logs when it is off', async () => {
    const f = fakeClients({ destination: 'XRay' })
    const r = await handle(event('Create'), f.c)
    expect(f.calls).toEqual(['get', 'describe', 'put', 'update'])
    expect(r).toMatchObject({ PhysicalResourceId: 'transaction-search-123456789012-us-east-1', Data: { AlreadyEnabled: 'false', PolicyWritten: 'true', Indexing: 'unchanged' } })
    const put = f.sent.find((x) => x instanceof PutResourcePolicyCommand) as PutResourcePolicyCommand
    expect(put.input.policyName).toBe(POLICY_NAME)
    const doc = JSON.parse(put.input.policyDocument ?? '{}') as { Statement: { Principal: unknown; Resource: string[]; Condition: unknown }[] }
    expect(doc.Statement[0]).toMatchObject({
      Principal: { Service: 'xray.amazonaws.com' },
      Resource: ['arn:aws:logs:us-east-1:123456789012:log-group:aws/spans:*', 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/application-signals/data:*'],
      Condition: { ArnLike: { 'aws:SourceArn': 'arn:aws:xray:us-east-1:123456789012:*' }, StringEquals: { 'aws:SourceAccount': '123456789012' } },
    })
    expect((f.sent.find((x) => x instanceof UpdateTraceSegmentDestinationCommand) as UpdateTraceSegmentDestinationCommand).input.Destination).toBe('CloudWatchLogs')
  })

  it('leaves an account that already has it alone, and reuses an existing policy', async () => {
    const on = fakeClients({ destination: 'CloudWatchLogs' })
    expect((await handle(event('Update'), on.c)).Data).toMatchObject({ AlreadyEnabled: 'true', PolicyWritten: 'false' })
    expect(on.calls).toEqual(['get'])
    const consolePolicy = fakeClients({ destination: 'XRay', policies: [{ policyName: 'AWSXRay-TransactionSearch', policyDocument: policyDocument({ Partition: 'aws', Region: 'us-east-1', Account: '123456789012' }) }] })
    await handle(event('Create'), consolePolicy.c)
    expect(consolePolicy.calls).toEqual(['get', 'describe', 'update'])
  })

  it('sets the indexing rule only when asked, and never turns anything off on delete', async () => {
    const f = fakeClients({ destination: 'CloudWatchLogs' })
    const r = await handle(event('Update', { SamplingPercent: '25' }), f.c)
    expect(r.Data?.Indexing).toBe('25')
    const rule = f.sent.find((x) => x instanceof UpdateIndexingRuleCommand) as UpdateIndexingRuleCommand
    expect(rule.input).toEqual({ Name: 'Default', Rule: { Probabilistic: { DesiredSamplingPercentage: 25 } } })
    await expect(handle(event('Update', { SamplingPercent: '150' }), fakeClients({ destination: 'CloudWatchLogs' }).c)).rejects.toThrow(/0–100/)
    const d = fakeClients({})
    expect(await handle(event('Delete'), d.c)).toEqual({ PhysicalResourceId: 'transaction-search-123456789012-us-east-1' })
    expect(d.calls).toEqual([])
  })
})

// ------------------------------------------------------------------ the installer

describe('the installer\'s observability choices', () => {
  const answers = (agents: Record<string, unknown> = {}) => AnswersSchema.parse({
    aws: { region: 'us-east-1', account: '123456789012' },
    agents: { model: 'us.anthropic.claude-sonnet-4-6', ...agents },
    projects: [{ repo: 'mteichtahl/trace' }],
    adminEmail: 'marc@example.com',
  })

  it('passes them to the stack and shows them in the plan', () => {
    expect(infraInput(answers()).observability).toEqual({ enabled: true, transactionSearch: true, dashboard: true })
    expect(infraInput(answers({ samplingPercent: 10, dashboard: false })).observability).toEqual({ enabled: true, transactionSearch: true, dashboard: false, samplingPercent: 10 })
    const deploy = plan(answers()).find((s) => s.id === 'deploy')?.detail ?? ''
    expect(deploy).toMatch(/OpenTelemetry \(ADOT\)/)
    expect(deploy).toMatch(/Transaction Search turned on if it is off/)
    expect(deploy).toMatch(/trace-agents dashboard/)
    expect(plan(answers({ samplingPercent: 5 })).find((s) => s.id === 'deploy')?.detail).toMatch(/X-Ray indexing set to 5%/)
    const off = plan(answers({ observability: false })).find((s) => s.id === 'deploy')?.detail ?? ''
    expect(off).toMatch(/observability off/)
    expect(infraInput(answers({ observability: false })).observability).toMatchObject({ enabled: false })
  })
})
