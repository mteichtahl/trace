/**
 * The tools image and each project's tools function (src/infra/tools.ts, src/infra/stack.ts): the image built and
 * waited for like the agent image, one arm64 function per project running it, whose role reaches only that project's
 * job files and its own log group, and a worker that may invoke its own function (and its cad function:
 * test/infra/cad.test.ts) and no other. None in the flat layout or with tools.enabled false.
 */
import { Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, projectHash } from '../../src/infra/props.js'
import { toolsFunctionName } from '../../src/infra/tools.js'
import { RUNNERS, type Synth, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, B], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }
type Res = { Type: string; Properties: Record<string, any> }
const resources = (t: Template, type: string): [string, Res][] => Object.entries(t.findResources(type) as Record<string, Res>)
/** A role's statements, in its inline policy and in the managed ones CDK moves the overflow into */
const statements = (t: Template, idPrefix: string): Statement[] =>
  [...resources(t, 'AWS::IAM::Policy'), ...resources(t, 'AWS::IAM::ManagedPolicy')].filter(([id]) => id.startsWith(idPrefix))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Statement[])
const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])

let s: Synth
beforeAll(() => { s = synth(InfraPropsSchema.parse(base), 'Tools') }, 300_000)

describe('the tools image', () => {
  it('is built from agent/Dockerfile.tools on arm64 into its own repository, and waited for', () => {
    const builds = resources(s.parent, 'AWS::CodeBuild::Project').map(([, b]) => b.Properties)
    const tools = builds.find((b) => b.Name === 'trace-tools-image')
    expect(tools?.Environment).toMatchObject({ Type: 'ARM_CONTAINER', PrivilegedMode: true })
    expect(tools?.Source.BuildSpec).toContain('-f agent/Dockerfile.tools')
    // AgentCore's limit is the agent image's only (Lambda takes 10 GB)
    expect(tools?.Source.BuildSpec).not.toContain('{{.Size}}')
    expect(builds.find((b) => b.Name === 'trace-agent-image')?.Source.BuildSpec).toContain('{{.Size}}')
    expect(resources(s.parent, 'AWS::ECR::Repository').map(([, r]) => r.Properties.RepositoryName).sort()).toEqual(['trace-agent', 'trace-gpu', 'trace-tools'])
    // the custom resource waits (no Wait: 'false', unlike the GPU image): a function needs its image to exist
    const image = resources(s.parent, 'AWS::CloudFormation::CustomResource').find(([id]) => id.startsWith('ToolsImage'))?.[1]
    expect(image?.Properties.Wait).toBeUndefined()
    // and starts only once its project's role may write the build's logs and push (its policy is its own resource),
    // and the provider's functions may start and poll it ("does not allow AWS CodeBuild to create … log streams")
    const deps = (resources(s.parent, 'AWS::CloudFormation::CustomResource').find(([id]) => id.startsWith('ToolsImage'))?.[1] as Res & { DependsOn?: string[] }).DependsOn ?? []
    for (const want of [/^ToolsImageBuildRoleDefaultPolicy/, /^ToolsImageBuild[0-9A-F]{8}$/, /^ImageBuildStartServiceRoleDefaultPolicy/, /^ImageBuildPollServiceRoleDefaultPolicy/]) {
      expect(deps.some((d) => want.test(d)), String(want)).toBe(true)
    }
    const agent = (resources(s.parent, 'AWS::CloudFormation::CustomResource').find(([id]) => id === 'AgentImage')?.[1] as Res & { DependsOn?: string[] }).DependsOn ?? []
    expect(agent.some((d) => /^AgentImageBuildRoleDefaultPolicy/.test(d))).toBe(true)
    // Lambda may pull from the repository (DockerImageCode.fromEcr)
    const repo = resources(s.parent, 'AWS::ECR::Repository').find(([, r]) => r.Properties.RepositoryName === 'trace-tools')?.[1]
    expect(JSON.stringify(repo?.Properties.RepositoryPolicyText)).toContain('lambda.amazonaws.com')
  })
})

describe('each project\'s tools function', () => {
  it('runs the tools image on arm64, for 15 minutes at most, with 4 GB and 10 GB of /tmp', () => {
    for (const repo of [A, B]) {
      const t = nestedOf(s, repo)
      const fns = resources(t, 'AWS::Lambda::Function').filter(([id]) => /Tools/.test(id)).map(([, f]) => f.Properties)
      expect(fns).toHaveLength(1)
      const fn = fns[0] as Record<string, any>
      expect(fn).toMatchObject({
        FunctionName: toolsFunctionName('trace', projectHash(repo)), PackageType: 'Image', Architectures: ['arm64'],
        Timeout: 900, MemorySize: 4096, EphemeralStorage: { Size: 10240 },
      })
      // the tag is the ToolsImage build's (a parameter from the parent, whose value is that resource's ImageUri), so
      // the function is made only once its image exists
      const uri = JSON.stringify(fn.Code.ImageUri)
      const param = /"Ref":"([^"]*ToolsImage[^"]*ImageUri[^"]*)"/i.exec(uri)?.[1]
      expect(param).toBeDefined()
      const stackRes = Object.values(s.parent.findResources('AWS::CloudFormation::Stack') as Record<string, Res>)
        .find((r) => JSON.stringify(r.Properties.Parameters ?? {}).includes(param as string))
      expect(JSON.stringify(stackRes?.Properties.Parameters[param as string])).toMatch(/"Fn::GetAtt":\["ToolsImage[0-9A-F]*","ImageUri"\]/)
      // telemetry as the Batch jobs send it, under its own service name
      expect(fn.Environment.Variables).toMatchObject({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_SERVICE_NAME: 'trace-tools', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://xray.us-east-1.amazonaws.com/v1/traces' })
      // one try per call: no asynchronous retries configured, and no extra resource for it
      expect(resources(t, 'AWS::Lambda::EventInvokeConfig')).toEqual([])
    }
  })

  it('has a role that reaches its project\'s job files and its own log group, nothing else', () => {
    for (const [repo, other] of [[A, B], [B, A]] as const) {
      const t = nestedOf(s, repo)
      const h = projectHash(repo)
      const st = statements(t, `Project${h}ToolsRole`)
      const text = JSON.stringify(st)
      expect(text).toContain(`/jobs/${repo}/*`)
      expect(text).not.toContain(other)
      expect(text).not.toMatch(/\/central\/\*|\/projects\//)
      const all = st.flatMap(actions)
      expect(all.every((a) => a.startsWith('s3:') || a === 'logs:CreateLogStream' || a === 'logs:PutLogEvents' || a.startsWith('xray:'))).toBe(true)
      // its spans go to X-Ray, as the Batch jobs' do: write-only X-Ray actions, nothing that reads traces
      expect(all.filter((a) => a.startsWith('xray:')).sort()).toEqual(['xray:GetSamplingRules', 'xray:GetSamplingTargets', 'xray:PutTelemetryRecords', 'xray:PutTraceSegments'])
      expect(all).not.toContain('s3:*')
      // trusted by Lambda in this account only
      const role = resources(t, 'AWS::IAM::Role').find(([id]) => id.startsWith(`Project${h}ToolsRole`))?.[1]
      expect(role?.Properties.AssumeRolePolicyDocument.Statement).toEqual([expect.objectContaining({
        Principal: { Service: 'lambda.amazonaws.com' }, Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
      })])
      // no managed policies (AWSLambdaBasicExecutionRole would let it make any log group)
      expect(role?.Properties.ManagedPolicyArns).toBeUndefined()
    }
  })

  it('and its cad function (test/infra/cad.test.ts) are the only functions its worker may invoke, and its worker is told its name', () => {
    for (const repo of [A, B]) {
      const t = nestedOf(s, repo)
      const h = projectHash(repo)
      const invoke = statements(t, `Project${h}RuntimeRole`).filter((x) => actions(x).some((a) => a.startsWith('lambda:')))
      expect(invoke.map((x) => x.Sid).sort()).toEqual(['ProjectCadInvoke', 'ProjectToolsInvoke'])
      const tools = invoke.find((x) => x.Sid === 'ProjectToolsInvoke')
      expect(tools).toMatchObject({ Effect: 'Allow', Action: 'lambda:InvokeFunction' })
      expect(JSON.stringify(tools?.Resource)).toContain(`Project${h}ToolsFunction`)
      const runtime = resources(t, 'AWS::BedrockAgentCore::Runtime')[0]?.[1]
      expect(runtime?.Properties.EnvironmentVariables).toMatchObject({ TRACE_TOOLS_FUNCTION: toolsFunctionName('trace', h) })
      expect(runtime?.Properties.EnvironmentVariables.TRACE_GPU_BUCKET).toBeDefined()
    }
  })
})

describe('the flat layout\'s tools functions', () => {
  it('are in one nested stack with the image build, each invocable by its own worker only, and its worker told', () => {
    const x = synth(InfraPropsSchema.parse({ ...base, layout: 'flat' }), 'ToolsFlat')
    expect(x.nested.size).toBe(0)
    const t = x.tools as Template
    expect(t).toBeTruthy()
    // the parent pays one resource: the nested stack (no image build, no function of its own)
    expect(JSON.stringify(x.parent.toJSON())).not.toMatch(/"Type":"AWS::(Lambda::Function|ECR::Repository)"[^}]*trace-tools/)
    expect(resources(t, 'AWS::CodeBuild::Project').map(([, b]) => b.Properties.Name)).toEqual(['trace-tools-image'])
    for (const repo of [A, B]) {
      const h = projectHash(repo)
      const fn = resources(t, 'AWS::Lambda::Function').find(([id]) => id.startsWith(`Project${h}Tools`))?.[1]
      expect(fn?.Properties).toMatchObject({ FunctionName: toolsFunctionName('trace', h), Architectures: ['arm64'] })
      // the function's own policy names its worker's role, nobody else
      const perms = resources(t, 'AWS::Lambda::Permission').filter(([id]) => id.startsWith(`Project${h}Tools`))
      expect(perms).toHaveLength(1)
      expect(perms[0]?.[1].Properties.Action).toBe('lambda:InvokeFunction')
      expect(JSON.stringify(perms[0]?.[1].Properties.Principal)).toMatch(new RegExp(`Project${h}RuntimeRole`))
      // its role: its project's jobs only
      const text = JSON.stringify(statements(t, `Project${h}ToolsRole`))
      expect(text).toContain(`/jobs/${repo}/*`)
      expect(text).not.toContain(repo === A ? B : A)
      // its worker (in the parent) is told the name
      const runtime = resources(x.parent, 'AWS::BedrockAgentCore::Runtime').find(([id]) => id.startsWith(`Project${h}`))?.[1]
      expect(runtime?.Properties.EnvironmentVariables.TRACE_TOOLS_FUNCTION).toBe(toolsFunctionName('trace', h))
    }
  }, 300_000)

  it('are left out when the parent has no room for their stack (20 flat projects), and with tools.enabled false', () => {
    const repos = Array.from({ length: 20 }, (_, i) => `owner-${i}/repository-${i}`)
    for (const [cfg, id] of [[{ ...base, layout: 'flat', repositories: repos }, 'ToolsFlat20'], [{ ...base, tools: { enabled: false } }, 'ToolsOff'], [{ ...base, layout: 'flat', tools: { enabled: false } }, 'ToolsFlatOff']] as const) {
      const x = synth(InfraPropsSchema.parse(cfg), id)
      expect(x.tools, id).toBeNull()
      const all = JSON.stringify([x.parent.toJSON(), ...[...x.nested.values()].map((t) => t.toJSON())])
      expect(all, id).not.toContain('trace-tools')
      expect(all, id).not.toContain('TRACE_TOOLS_FUNCTION')
    }
  }, 600_000)
})
