/**
 * Each project's cad function (src/infra/tools.ts CadFunction, docs/enclosure-build.md "Trust"): the tools image on a
 * role that may write its own log group and nothing else (no S3, no X-Ray), the role flag that makes src/gpu/lambda.ts
 * refuse an S3 spec, a worker that may invoke it and is told its name; nested layout only, none in the flat layout.
 */
import { Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, projectHash } from '../../src/infra/props.js'
import { cadFunctionName, toolsFunctionName } from '../../src/infra/tools.js'
import { RUNNERS, type Synth, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, B], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }
type Res = { Type: string; Properties: Record<string, any> }
const resources = (t: Template, type: string): [string, Res][] => Object.entries(t.findResources(type) as Record<string, Res>)
const statements = (t: Template, idPrefix: string): Statement[] =>
  [...resources(t, 'AWS::IAM::Policy'), ...resources(t, 'AWS::IAM::ManagedPolicy')].filter(([id]) => id.startsWith(idPrefix))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Statement[])
const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])

let s: Synth
beforeAll(() => { s = synth(InfraPropsSchema.parse(base), 'Cad') }, 300_000)

describe('each project\'s cad function', () => {
  it('runs the tools image on arm64 with the tools function\'s sizes, flagged as the cad function, with no telemetry settings', () => {
    for (const repo of [A, B]) {
      const t = nestedOf(s, repo)
      const h = projectHash(repo)
      const fns = resources(t, 'AWS::Lambda::Function').filter(([id]) => id.startsWith(`Project${h}Cad`)).map(([, f]) => f.Properties)
      expect(fns).toHaveLength(1)
      const fn = fns[0] as Record<string, any>
      expect(fn).toMatchObject({
        FunctionName: cadFunctionName('trace', h), PackageType: 'Image', Architectures: ['arm64'],
        Timeout: 900, MemorySize: 4096, EphemeralStorage: { Size: 10240 },
      })
      expect(cadFunctionName('trace', h)).toBe(`trace-cad-${h}`)
      // the same image and tag as the tools function
      const tools = resources(t, 'AWS::Lambda::Function').find(([id]) => id.startsWith(`Project${h}Tools`))?.[1]
      expect(JSON.stringify(fn.Code.ImageUri)).toBe(JSON.stringify(tools?.Properties.Code.ImageUri))
      // the handler knows which function it is; nothing of the trace exporter, nothing a script could use
      expect(fn.Environment.Variables).toEqual({ TRACE_PROJECT: repo, TRACE_CAD_FUNCTION_ROLE: '1' })
      expect(resources(t, 'AWS::Lambda::EventInvokeConfig')).toEqual([])
      // its own log group, a month, removed with it
      const lg = resources(t, 'AWS::Logs::LogGroup').find(([id]) => id.startsWith(`Project${h}CadLogs`))?.[1]
      expect(lg?.Properties).toMatchObject({ LogGroupName: `/aws/lambda/trace-cad-${h}`, RetentionInDays: 30 })
    }
  })

  it('has a role that may write its own log group and nothing else: no S3, no X-Ray, no managed policy', () => {
    for (const [repo, other] of [[A, B], [B, A]] as const) {
      const t = nestedOf(s, repo)
      const h = projectHash(repo)
      const st = statements(t, `Project${h}CadRole`)
      expect(st.length).toBeGreaterThan(0)
      const all = st.flatMap(actions)
      expect(all.sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents'])
      expect(all.some((a) => a.startsWith('s3:'))).toBe(false)
      expect(all.some((a) => a.startsWith('xray:'))).toBe(false)
      const text = JSON.stringify(st)
      expect(text).not.toContain('/jobs/')
      expect(text).not.toContain(other)
      expect(text).toContain(`Project${h}CadLogs`)
      const role = resources(t, 'AWS::IAM::Role').find(([id]) => id.startsWith(`Project${h}CadRole`))?.[1]
      expect(role?.Properties.AssumeRolePolicyDocument.Statement).toEqual([expect.objectContaining({
        Principal: { Service: 'lambda.amazonaws.com' }, Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
      })])
      expect(role?.Properties.ManagedPolicyArns).toBeUndefined()
      // the tools function's role is the one with the job files
      expect(JSON.stringify(statements(t, `Project${h}ToolsRole`))).toContain(`/jobs/${repo}/*`)
    }
  })

  it('may be invoked by its worker, which is told its name and memory', () => {
    for (const repo of [A, B]) {
      const t = nestedOf(s, repo)
      const h = projectHash(repo)
      const invoke = statements(t, `Project${h}RuntimeRole`).filter((x) => actions(x).some((a) => a.startsWith('lambda:')))
      expect(invoke.map((x) => x.Sid).sort()).toEqual(['ProjectCadInvoke', 'ProjectToolsInvoke'])
      const cad = invoke.find((x) => x.Sid === 'ProjectCadInvoke')
      expect(cad).toMatchObject({ Effect: 'Allow', Action: 'lambda:InvokeFunction' })
      expect(JSON.stringify(cad?.Resource)).toContain(`Project${h}CadFunction`)
      expect(JSON.stringify(cad?.Resource)).not.toContain(`Project${h}ToolsFunction`)
      const runtime = resources(t, 'AWS::BedrockAgentCore::Runtime')[0]?.[1]
      expect(runtime?.Properties.EnvironmentVariables).toMatchObject({
        TRACE_CAD_FUNCTION: cadFunctionName('trace', h), TRACE_CAD_FUNCTION_MEMORY_MB: '4096', TRACE_TOOLS_FUNCTION: toolsFunctionName('trace', h),
      })
    }
  })

  it('is left out of the flat layout, and with tools.enabled false', () => {
    for (const [cfg, id] of [[{ ...base, layout: 'flat' }, 'CadFlat'], [{ ...base, tools: { enabled: false } }, 'CadOff']] as const) {
      const x = synth(InfraPropsSchema.parse(cfg), id)
      const all = JSON.stringify([x.parent.toJSON(), ...[...x.nested.values()].map((t) => t.toJSON()), ...(x.tools ? [x.tools.toJSON()] : [])])
      expect(all, id).not.toContain('trace-cad-')
      expect(all, id).not.toContain('TRACE_CAD_FUNCTION')
      expect(all, id).not.toContain('ProjectCadInvoke')
    }
  }, 600_000)
})
