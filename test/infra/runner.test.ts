/**
 * The CodeBuild GitHub Actions runner projects (src/infra/runner.ts): one per project in both layouts, and trace's own
 * (src/infra/ci-app.ts). Every job runs on AWS, CodeBuild reaches GitHub through the CodeConnections connection, and
 * the runner's role gives a job nothing in AWS beyond its logs and that connection.
 */
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { RUNNER_VARIABLE, SELF_CI_PROJECT, runnerProjectName } from '../../src/core/project.js'
import { CI_STACK, TraceCiStack, ciSettings } from '../../src/infra/ci-app.js'
import { InfraPropsSchema, projectHash, projectOutputs } from '../../src/infra/props.js'
import { connectionArns } from '../../src/infra/runner.js'
import { CONNECTION_ARN, RUNNERS, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, `${B}@develop`], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }
const LAYOUTS = ['nested', 'flat'] as const
const CODESTAR_ARN = CONNECTION_ARN.replace(':codeconnections:', ':codestar-connections:')

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown }
type Res = { Type: string; Properties: Record<string, unknown> }
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

/** The runner project of a template, its role, and the role's every statement (inline and attached). */
function runnerOf(t: Template, name: string): { project: Res; role: Res; statements: Statement[] } {
  const projects = Object.entries(t.findResources('AWS::CodeBuild::Project') as Record<string, Res>).filter(([, r]) => r.Properties.Name === name)
  expect(projects).toHaveLength(1)
  const [, project] = projects[0] as [string, Res]
  const roleId = (project.Properties.ServiceRole as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0]
  const role = (t.toJSON() as { Resources: Record<string, Res> }).Resources[roleId] as Res
  const inline = ((role.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]).flatMap((p) => p.PolicyDocument.Statement)
  const attached = Object.values(t.findResources('AWS::IAM::Policy') as Record<string, Res>)
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(roleId))
    .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
  return { project, role, statements: [...inline, ...attached] }
}

/** Every check a runner project must pass, whatever template it is in. */
function expectRunner(t: Template, name: string, repository: string): void {
  const { project, role, statements } = runnerOf(t, name)
  const p = project.Properties
  expect(p.Source).toMatchObject({ Type: 'GITHUB', Location: `https://github.com/${repository}`, Auth: { Type: 'CODECONNECTIONS', Resource: CONNECTION_ARN } })
  expect(p.Triggers).toEqual({ Webhook: true, FilterGroups: [[{ Type: 'EVENT', Pattern: 'WORKFLOW_JOB_QUEUED' }]] })
  expect(p.Artifacts).toEqual({ Type: 'NO_ARTIFACTS' })
  expect(p.Environment).toMatchObject({ Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_LARGE', Image: 'aws/codebuild/standard:7.0', PrivilegedMode: false })
  // its own log group (by reference, so it is made first), kept a month
  const group = (p.LogsConfig as { CloudWatchLogs: { Status: string; GroupName: { Ref: string } } }).CloudWatchLogs
  expect(group.Status).toBe('ENABLED')
  const logGroup = (t.toJSON() as { Resources: Record<string, Res> }).Resources[group.GroupName.Ref]
  expect(logGroup?.Type).toBe('AWS::Logs::LogGroup')
  expect(logGroup?.Properties).toMatchObject({ LogGroupName: `/aws/codebuild/${name}`, RetentionInDays: 30 })
  expect(p).not.toHaveProperty('VpcConfig')
  expect(p).not.toHaveProperty('Cache')

  // assumed by CodeBuild for this project only
  const trust = (role.Properties.AssumeRolePolicyDocument as { Statement: { Principal: unknown; Condition: Record<string, Record<string, unknown>> }[] }).Statement
  expect(trust).toHaveLength(1)
  expect(trust[0]?.Principal).toEqual({ Service: 'codebuild.amazonaws.com' })
  expect(JSON.stringify(trust[0]?.Condition.ArnLike?.['aws:SourceArn'])).toContain(`:project/${name}`)
  expect(role.Properties).not.toHaveProperty('ManagedPolicyArns')

  // its logs and the connection: nothing else in AWS
  expect(statements.every((s) => s.Effect === 'Allow')).toBe(true)
  const actions = statements.flatMap((s) => list(s.Action)).sort()
  expect(actions).toEqual([
    'codeconnections:GetConnection', 'codeconnections:GetConnectionToken', 'codeconnections:UseConnection',
    'codestar-connections:GetConnection', 'codestar-connections:GetConnectionToken', 'codestar-connections:UseConnection',
    'logs:CreateLogStream', 'logs:PutLogEvents',
  ])
  const connection = statements.find((s) => s.Sid === 'RunnerConnection')
  expect(list(connection?.Resource).sort()).toEqual([CONNECTION_ARN, CODESTAR_ARN].sort())
  const logs = statements.find((s) => s.Sid === 'RunnerLogs')
  for (const r of list(logs?.Resource)) {
    expect(r).not.toBe('*')
    expect(JSON.stringify(r)).toMatch(/RunnerLogs|\/aws\/codebuild\//)
  }
  for (const s of statements) expect(list(s.Resource)).not.toContain('*')
}

describe("each project's runner project", () => {
  for (const layout of LAYOUTS) {
    it(`is named runnerProjectName, reaches GitHub through the connection on WORKFLOW_JOB_QUEUED, and gives a job no AWS access (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, layout }), `Runner${layout}`)
      for (const repo of [A, B]) {
        const t = layout === 'nested' ? nestedOf(s, repo) : s.parent
        const name = runnerProjectName('trace', repo)
        expect(name).toBe(`trace-ci-${projectHash(repo)}`)
        expectRunner(t, name, repo)
        // its output: the nested stack's in the nested layout (never the parent's), the stack's own when flat
        const outputs = (t.toJSON() as { Outputs: Record<string, { Value: unknown }> }).Outputs
        expect(outputs[projectOutputs(repo).runnerProject]?.Value).toBe(name)
        if (layout === 'nested') expect(Object.keys((s.parent.toJSON() as { Outputs: object }).Outputs)).not.toContain(projectOutputs(repo).runnerProject)
      }
      // the other project's runner is not in this project's nested stack
      if (layout === 'nested') {
        const names = Object.values(nestedOf(s, A).findResources('AWS::CodeBuild::Project') as Record<string, Res>).map((r) => r.Properties.Name)
        expect(names).not.toContain(runnerProjectName('trace', B))
      }
    }, 300_000)
  }

  it('takes the image, compute type and privileged mode of `runners`, and refuses a connection ARN that is not one', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, repositories: [A], runners: { ...RUNNERS, computeType: 'BUILD_GENERAL1_XLARGE', image: 'aws/codebuild/standard:8.0', privileged: true } }), 'RunnerSettings')
    const { project } = runnerOf(nestedOf(s, A), runnerProjectName('trace', A))
    expect(project.Properties.Environment).toMatchObject({ ComputeType: 'BUILD_GENERAL1_XLARGE', Image: 'aws/codebuild/standard:8.0', PrivilegedMode: true })
    expect(() => InfraPropsSchema.parse({ ...base, runners: { connectionArn: 'arn:aws:iam::123456789012:role/x' } })).toThrow(/CodeConnections connection ARN/)
    const { runners: _, ...noRunners } = base
    expect(() => InfraPropsSchema.parse(noRunners)).toThrow()
    expect(RUNNER_VARIABLE).toBe('TRACE_CODEBUILD_PROJECT')
  }, 300_000)

  it('names the connection under both of the service names', () => {
    expect(connectionArns(CONNECTION_ARN)).toEqual([CONNECTION_ARN, CODESTAR_ARN])
    expect(connectionArns(CODESTAR_ARN)).toEqual([CONNECTION_ARN, CODESTAR_ARN])
  })
})

describe("trace's own CI stack", () => {
  const ctx = (o: Record<string, unknown>) => (k: string): unknown => o[k]

  it('is one runner project named trace-ci for mteichtahl/trace by default', () => {
    const s = ciSettings(ctx({ connectionArn: CONNECTION_ARN }), {})
    expect(s).toEqual({ repository: 'mteichtahl/trace', connectionArn: CONNECTION_ARN, computeType: 'BUILD_GENERAL1_LARGE', image: 'aws/codebuild/standard:7.0', privileged: false })
    const t = Template.fromStack(new TraceCiStack(new App(), CI_STACK, s, { account: '123456789012', region: 'us-east-1' }))
    t.resourceCountIs('AWS::CodeBuild::Project', 1)
    t.resourceCountIs('AWS::IAM::Policy', 0)
    expect(SELF_CI_PROJECT).toBe('trace-ci')
    expectRunner(t, SELF_CI_PROJECT, 'mteichtahl/trace')
  })

  it('takes the connection and repository from the environment, and refuses to go without a connection', () => {
    const s = ciSettings(ctx({}), { TRACE_CONNECTION_ARN: CONNECTION_ARN, TRACE_CI_REPOSITORY: 'Other/Repo', TRACE_CI_PRIVILEGED: 'true' })
    expect(s).toMatchObject({ repository: 'other/repo', connectionArn: CONNECTION_ARN, privileged: true })
    // context wins over the environment
    expect(ciSettings(ctx({ repository: 'a/b', connectionArn: CONNECTION_ARN }), { TRACE_CI_REPOSITORY: 'c/d' }).repository).toBe('a/b')
    expect(() => ciSettings(ctx({}), {})).toThrow(/connectionArn.*TRACE_CONNECTION_ARN/)
    expect(() => ciSettings(ctx({ connectionArn: 'nope' }), {})).toThrow(/CodeConnections connection ARN/)
  })
})
