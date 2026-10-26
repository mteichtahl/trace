/**
 * Per-project behaviour in both layouts: the names' generation (a removed project added again), the API's grant on
 * the workers (exact ARNs and the installation tag), the CPU queue (nested only), the OIDC role's memory, and the GPU
 * image build the deploy does not wait for.
 */
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'
import { Match, type Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { isComplete } from '../../src/infra/lambda/image-build.js'
import { InfraPropsSchema, githubSecretName, memoryDeliveryName, memoryName, projectHash } from '../../src/infra/props.js'
import { RUNNERS, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const HA = projectHash(A)
const HB = projectHash(B)
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, `${B}@develop`], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }
const LAYOUTS = ['nested', 'flat'] as const

type Statement = { Sid?: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> }
type Res = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
const statements = (t: Template, prefix: string): Statement[] => Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith(prefix))
  .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
const resources = (t: Template, type: string): Res[] => Object.values(t.findResources(type) as Record<string, Res>)
/** The template a project's resources are in. */
const own = (s: ReturnType<typeof synth>, layout: (typeof LAYOUTS)[number], repo: string): Template => (layout === 'nested' ? nestedOf(s, repo) : s.parent)

describe("a project's generation", () => {
  it('leaves every name as it was at generation 0, and puts g<n> in the memory, delivery and secret names above it', () => {
    expect(memoryName('trace', A, 0)).toBe(memoryName('trace', A))
    expect(memoryName('trace', A, 3)).toBe(`trace_m_${HA}_g3`)
    expect(memoryName('a'.repeat(21), A, 99)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
    expect(githubSecretName('trace', A, 0)).toBe(`trace/github-token/${A}`)
    expect(githubSecretName('trace', A, 2)).toBe(`trace/github-token/${A}@g2`)
    expect(memoryDeliveryName('trace', A, 'logs')).toBe(`trace-m-${HA}-logs`)
    expect(memoryDeliveryName('trace', A, 'traces', 2)).toBe(`trace-m-${HA}-g2-traces`)
    expect(memoryDeliveryName('a'.repeat(21), A, 'traces', 99)).toMatch(/^[\w-]{1,60}$/)
    expect(() => InfraPropsSchema.parse({ ...base, projectSettings: { [B]: { generation: -1 } } })).toThrow()
  })

  for (const layout of LAYOUTS) {
    it(`names a re-added project's memory, delivery sources and destinations, and secret by its generation (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, layout, projectSettings: { [B.toUpperCase()]: { generation: 2 } } }), `Gen${layout}`)
      const b = own(s, layout, B)
      const a = own(s, layout, A)
      const names = (t: Template, type: string): string[] => resources(t, type).map((r) => String(r.Properties.Name)).filter((n) => n.includes(HB) || n.includes(B)).sort()
      expect(names(b, 'AWS::BedrockAgentCore::Memory')).toEqual([`trace_m_${HB}_g2`])
      expect(names(b, 'AWS::Logs::DeliverySource')).toEqual([`trace-m-${HB}-g2-logs`, `trace-m-${HB}-g2-traces`])
      expect(names(b, 'AWS::Logs::DeliveryDestination')).toEqual([`trace-m-${HB}-g2-logs`, `trace-m-${HB}-g2-traces`])
      expect(names(b, 'AWS::SecretsManager::Secret')).toEqual([`trace/github-token/${B}@g2`])
      // the other project, and everything else of this one, keep their names
      expect(resources(a, 'AWS::BedrockAgentCore::Memory').map((r) => r.Properties.Name)).toContain(`trace_m_${HA}`)
      expect(resources(b, 'AWS::BedrockAgentCore::Runtime').map((r) => String(r.Properties.AgentRuntimeName)).filter((n) => n.includes(HB))).toEqual([`trace_w_${HB}`])
      expect(resources(b, 'AWS::IAM::Role').map((r) => String(r.Properties.RoleName)).filter((n) => n.includes(HB)).sort()).toEqual([
        `trace-ci-${HB}-us-east-1`, `trace-gh-${HB}-us-east-1`, `trace-gpu-${HB}-us-east-1`, ...(layout === 'nested' ? [`trace-kb-${HB}-us-east-1`] : []), `trace-w-${HB}-us-east-1`])
      // the knowledge base (nested only) carries the generation in its name; its role and index need none
      if (layout === 'nested') expect(resources(b, 'AWS::Bedrock::KnowledgeBase').map((r) => r.Properties.Name)).toEqual([`trace-kb-${HB}-g2`])
    }, 300_000)
  }
})

describe("the API's grant on the workers", () => {
  for (const layout of LAYOUTS) {
    it(`names each worker by its exact ARN and this installation's tag, never a name pattern (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, layout }), `Grant${layout}`)
      const api = statements(s.parent, 'ApiRuntimeRole')
      const invoke = api.filter((x) => (Array.isArray(x.Action) ? x.Action : [x.Action]).includes('bedrock-agentcore:InvokeAgentRuntime'))
      expect(invoke.map((x) => x.Sid).sort()).toEqual(['InvokeProjectWorkerEndpoints', 'InvokeProjectWorkers'])
      const runtimes = invoke.find((x) => x.Sid === 'InvokeProjectWorkers')
      expect(runtimes?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/trace:installation': 'trace' } })
      expect(runtimes?.Resource).toHaveLength(2)
      for (const r of runtimes?.Resource as unknown[]) expect(JSON.stringify(r)).toMatch(/AgentRuntimeArn/)
      expect(JSON.stringify(invoke)).not.toContain('_w_*')
      // every runtime is tagged with the installation, the workers with their project too
      for (const repo of [A, B]) {
        for (const r of resources(own(s, layout, repo), 'AWS::BedrockAgentCore::Runtime').filter((x) => String(x.Properties.AgentRuntimeName).startsWith('trace_w_'))) {
          const tags = r.Properties.Tags as Record<string, string>
          if (tags['trace:project'] === repo) expect(tags['trace:installation']).toBe('trace')
        }
      }
      expect(resources(s.parent, 'AWS::BedrockAgentCore::Runtime').find((r) => r.Properties.AgentRuntimeName === 'trace_api')?.Properties.Tags).toEqual({ 'trace:installation': 'trace' })
    }, 300_000)
  }

  it('grants nothing to invoke while the move to nested stacks has drained every project', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, layout: 'flat', layoutMigration: 'drain' }), 'GrantDrain')
    expect(JSON.stringify(statements(s.parent, 'ApiRuntimeRole'))).not.toContain('InvokeAgentRuntime')
  }, 300_000)
})

describe('the CPU queue', () => {
  it('is a second Batch environment and queue of CPU instances, with each project its own CPU job definition and the same job role', () => {
    const s = synth(InfraPropsSchema.parse(base), 'Cpu')
    s.parent.hasResourceProperties('AWS::Batch::ComputeEnvironment', {
      ComputeEnvironmentName: 'trace-cpu',
      ComputeResources: Match.objectLike({ Type: 'EC2', MinvCpus: 0, MaxvCpus: 64, InstanceTypes: ['c7i', 'c6i', 'm7i'], Ec2Configuration: [{ ImageType: 'ECS_AL2023' }] }),
    })
    s.parent.hasResourceProperties('AWS::Batch::JobQueue', { JobQueueName: 'trace-cpu' })
    // one instance role for both environments
    s.parent.resourceCountIs('AWS::Batch::ComputeEnvironment', 2)
    expect(Object.keys(s.parent.findResources('AWS::IAM::Role')).filter((id) => /InstanceProfileRole/.test(id))).toHaveLength(1)
    for (const [repo, h] of [[A, HA], [B, HB]] as const) {
      const n = nestedOf(s, repo)
      const defs = resources(n, 'AWS::Batch::JobDefinition')
      const cpu = defs.find((d) => d.Properties.JobDefinitionName === `trace-cpu-${h}`)
      const gpu = defs.find((d) => d.Properties.JobDefinitionName === `trace-gpu-${h}`)
      const c = cpu?.Properties.ContainerProperties as { ResourceRequirements: { Type: string; Value: string }[]; JobRoleArn: unknown; Image: unknown; Environment: { Name: string; Value: string }[] }
      const g = gpu?.Properties.ContainerProperties as typeof c
      expect(c.ResourceRequirements.sort((x, y) => x.Type.localeCompare(y.Type))).toEqual([{ Type: 'MEMORY', Value: '32768' }, { Type: 'VCPU', Value: '16' }])
      expect(c.JobRoleArn).toEqual(g.JobRoleArn)
      expect(c.Image).toEqual(g.Image)
      expect(c.Environment).toEqual(expect.arrayContaining([{ Name: 'TRACE_GPU', Value: '0' }, { Name: 'TRACE_PROJECT', Value: repo }]))
      expect(cpu?.DependsOn ?? []).toEqual([])
      // the worker is told the queue and its definition, and may submit there only with its own, tagged with its project
      const env = resources(n, 'AWS::BedrockAgentCore::Runtime')[0]?.Properties.EnvironmentVariables as Record<string, unknown>
      expect(env.TRACE_CPU_JOB_DEFINITION).toBe(`trace-cpu-${h}`)
      // the definitions' vCPUs, which src/gpu/batch.ts caps a job's vcpus hint at
      expect([env.TRACE_GPU_JOB_MAX_VCPUS, env.TRACE_CPU_JOB_MAX_VCPUS]).toEqual(['4', '16'])
      expect(env.TRACE_CPU_QUEUE).toEqual(expect.objectContaining({ Ref: expect.any(String) }))
      const submit = statements(n, `Project${h}RuntimeRole`).find((x) => x.Sid === 'ProjectCpuSubmit')
      expect(JSON.stringify(submit?.Resource)).toContain(`job-definition/trace-cpu-${h}`)
      expect(JSON.stringify(submit?.Resource)).toContain((env.TRACE_CPU_QUEUE as { Ref: string }).Ref)
      expect(submit?.Condition).toEqual({ StringEquals: { 'aws:RequestTag/trace:project': repo } })
      expect(JSON.stringify(submit)).not.toContain(h === HA ? HB : HA)
    }
    expect(Object.keys(s.parent.toJSON().Outputs as object)).toContain('CpuJobQueue')
  }, 300_000)

  it('takes its instance types, size, Spot and per-job vCPUs and memory from the settings', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, cpu: { instanceTypes: ['c7i.8xlarge', 'm7i'], maxVcpus: 128, spot: true, vcpus: 32, memoryMiB: 61_440 } }), 'CpuSized')
    s.parent.hasResourceProperties('AWS::Batch::ComputeEnvironment', {
      ComputeEnvironmentName: 'trace-cpu',
      ComputeResources: Match.objectLike({ Type: 'SPOT', MaxvCpus: 128, InstanceTypes: ['c7i.8xlarge', 'm7i'], AllocationStrategy: 'SPOT_PRICE_CAPACITY_OPTIMIZED' }),
    })
    nestedOf(s, A).hasResourceProperties('AWS::Batch::JobDefinition', {
      JobDefinitionName: `trace-cpu-${HA}`,
      ContainerProperties: Match.objectLike({ ResourceRequirements: Match.arrayWith([{ Type: 'MEMORY', Value: '61440' }, { Type: 'VCPU', Value: '32' }]) }),
    })
    expect(() => InfraPropsSchema.parse({ ...base, cpu: { vcpus: 96, maxVcpus: 64 } })).toThrow(/more than cpu.maxVcpus/)
  }, 300_000)

  it('is not there when off, without the GPU side it shares, or in the flat layout', () => {
    for (const [name, extra] of [['Off', { cpu: { enabled: false } }], ['NoGpu', { gpu: { enabled: false } }], ['Flat', { layout: 'flat' }]] as const) {
      const s = synth(InfraPropsSchema.parse({ ...base, ...extra }), `NoCpu${name}`)
      const json = JSON.stringify(s.all.toJSON())
      for (const never of ['trace-cpu', 'TRACE_CPU_QUEUE', 'ProjectCpuSubmit', 'CpuJobQueue']) expect(json, `${name}: ${never}`).not.toContain(never)
    }
  }, 600_000)
})

describe("the OIDC role's memory (worker.runner = actions)", () => {
  for (const layout of LAYOUTS) {
    it(`may use its own project's memory as the worker does, and no other (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, layout }), `Oidc${layout}`)
      for (const [repo, h, oh] of [[A, HA, HB], [B, HB, HA]] as const) {
        const t = own(s, layout, repo)
        const worker = statements(t, `Project${h}RuntimeRole`).filter((x) => String(x.Sid).startsWith('ProjectMemory'))
        const oidc = statements(t, `Project${h}ActionsRole`).filter((x) => String(x.Sid).startsWith('ProjectMemory'))
        expect(oidc).toHaveLength(2)
        expect(oidc).toEqual(worker)
        expect(JSON.stringify(oidc)).toContain(`Project${h}Memory`)
        expect(JSON.stringify(statements(t, `Project${h}ActionsRole`))).not.toContain(oh)
      }
    }, 300_000)
  }

  it('has none when memory is off', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, memory: { enabled: false } }), 'OidcNoMemory')
    expect(JSON.stringify(statements(nestedOf(s, A), `Project${HA}ActionsRole`))).not.toContain('bedrock-agentcore:CreateEvent')
  }, 300_000)
})

describe('the GPU image build', () => {
  it('is started by the deploy, which does not wait for it, and nothing of the core depends on it', () => {
    const s = synth(InfraPropsSchema.parse(base), 'GpuImage')
    const customs = Object.entries(s.parent.findResources('AWS::CloudFormation::CustomResource') as Record<string, Res>)
    const gpu = customs.find(([id]) => id.startsWith('GpuImage'))
    const agent = customs.find(([id]) => id === 'AgentImage')
    expect(gpu?.[1].Properties.Wait).toBe('false')
    expect(agent?.[1].Properties.Wait).toBeUndefined() // the agent image: the core needs it, so the deploy waits
    // no project, nor its job definitions, waits on the GPU image
    for (const t of [s.parent, ...s.nested.values()]) {
      for (const r of Object.values(t.toJSON().Resources as Record<string, Res>)) expect(r.DependsOn ?? [], r.Type).not.toContain(gpu?.[0])
    }
    expect((s.parent.toJSON().Outputs as Record<string, { Value: unknown }>).GpuImageBuild?.Value).toEqual({ 'Fn::GetAtt': [gpu?.[0], 'BuildId'] })
  }, 300_000)

  it("reports a build it was told not to wait for complete at once, without asking CodeBuild", async () => {
    const event = {
      RequestType: 'Create', PhysicalResourceId: 'uri#trace-gpu-image:1234',
      ResourceProperties: { ServiceToken: 'x', ProjectName: 'trace-gpu-image', ImageUri: 'uri', SourceHash: 'h', Wait: 'false' },
    } as unknown as CloudFormationCustomResourceEvent & { PhysicalResourceId: string }
    expect(await isComplete(event)).toEqual({ IsComplete: true, Data: { ImageUri: 'uri', BuildId: 'trace-gpu-image:1234' } })
  })
})
