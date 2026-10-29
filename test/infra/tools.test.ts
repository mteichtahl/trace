/**
 * The tools image and each project's tools function (src/infra/tools.ts, src/infra/stack.ts): the image built and
 * waited for like the agent image, one arm64 function per project running it, whose role reaches only that project's
 * job files and its own log group, and a worker that may invoke its own function and no other. None in the flat layout
 * or with tools.enabled false.
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
      expect(all.every((a) => a.startsWith('s3:') || a === 'logs:CreateLogStream' || a === 'logs:PutLogEvents')).toBe(true)
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

  it('is the only function its worker may invoke, and its worker is told its name', () => {
    for (const repo of [A, B]) {
      const t = nestedOf(s, repo)
      const h = projectHash(repo)
      const invoke = statements(t, `Project${h}RuntimeRole`).filter((x) => actions(x).some((a) => a.startsWith('lambda:')))
      expect(invoke).toHaveLength(1)
      expect(invoke[0]).toMatchObject({ Sid: 'ProjectToolsInvoke', Effect: 'Allow', Action: 'lambda:InvokeFunction' })
      expect(JSON.stringify(invoke[0]?.Resource)).toContain(`Project${h}ToolsFunction`)
      const runtime = resources(t, 'AWS::BedrockAgentCore::Runtime')[0]?.[1]
      expect(runtime?.Properties.EnvironmentVariables).toMatchObject({ TRACE_TOOLS_FUNCTION: toolsFunctionName('trace', h) })
      expect(runtime?.Properties.EnvironmentVariables.TRACE_GPU_BUCKET).toBeDefined()
    }
  })
})

describe('without tools functions', () => {
  it('has none in the flat layout, or with tools.enabled false: no image build, no function, nothing told', () => {
    for (const [cfg, id] of [[{ ...base, layout: 'flat' }, 'ToolsFlat'], [{ ...base, tools: { enabled: false } }, 'ToolsOff']] as const) {
      const x = synth(InfraPropsSchema.parse(cfg), id)
      const all = JSON.stringify([x.parent.toJSON(), ...[...x.nested.values()].map((t) => t.toJSON())])
      expect(all).not.toContain('trace-tools')
      expect(all).not.toContain('TRACE_TOOLS_FUNCTION')
      expect(all).not.toContain('lambda:InvokeFunction"],"Effect":"Allow","Resource":{"Fn::GetAtt":["Project')
    }
  }, 300_000)
})
