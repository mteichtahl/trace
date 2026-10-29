/**
 * The CodeBuild GitHub Actions runner projects (src/infra/runner.ts): one per project in both layouts, and one per
 * build-only repository (ciRepositories, such as trace's own) in the parent, once the GitHub connection (given, or
 * created by the stack) is ready. CodeBuild reaches GitHub through the CodeConnections connection, and
 * the runner's role gives a job nothing in AWS beyond its logs and that connection.
 */
import type { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { RUNNER_VARIABLE, runnerProjectName } from '../../src/core/project.js'
import { CI_REPOSITORIES_MAX, CONNECTION_CREATED_OUTPUT, CONNECTION_OUTPUT, InfraPropsSchema, ciRunnerOutput, projectHash, projectOutputs } from '../../src/infra/props.js'
import { connectionArns } from '../../src/infra/runner.js'
import { CONNECTION_ARN, RUNNERS, nestedOf, nestedResourceId, synth } from './templates.js'

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

/** How a runner gets its webhook: the RunnerWebhook custom resource (the nested layout's projects and the build-only
 * repositories: GitHub refusing it never fails the deploy), or CloudFormation's Triggers (the flat layout's projects). */
type Hook = 'custom' | 'triggers'

/** Checks the runner's webhook is made the one way `how` says and not the other, and returns what the runner's
 * TRACE_CODEBUILD_PROJECT output must be: the custom resource's Runner attribute (the name, or `none` while GitHub
 * refuses the webhook), or the project's name. */
function webhookOf(t: Template, name: string, how: Hook): unknown {
  const { project } = runnerOf(t, name)
  const hooks = Object.entries(t.findResources('Custom::RunnerWebhook') as Record<string, Res & { DependsOn?: string[] }>).filter(([, r]) => r.Properties.ProjectName === name)
  if (how === 'triggers') {
    expect(hooks).toEqual([])
    expect(project.Properties.Triggers).toEqual({ Webhook: true, FilterGroups: [[{ Type: 'EVENT', Pattern: 'WORKFLOW_JOB_QUEUED' }]] })
    return name
  }
  expect(project.Properties).not.toHaveProperty('Triggers')
  expect(hooks).toHaveLength(1)
  const [id, hook] = hooks[0] as [string, Res & { DependsOn?: string[] }]
  expect(hook.Properties.ServiceToken).toBeDefined()
  // a new Attempt every deploy, so a refused webhook is tried again (fixed by the test synth)
  expect(hook.Properties.Attempt).toBe('test')
  // made after the project
  const projectId = Object.entries(t.findResources('AWS::CodeBuild::Project') as Record<string, Res>).find(([, r]) => r.Properties.Name === name)?.[0]
  expect(hook.DependsOn).toContain(projectId)
  return { 'Fn::GetAtt': [id, 'Runner'] }
}

/** Every check a runner project must pass, whatever template it is in. `connection`: the ARN as the template says it
 * (the given one by default; a reference when the stack created the connection). */
function expectRunner(t: Template, name: string, repository: string, how: Hook, connection: unknown = CONNECTION_ARN): void {
  const { project, role, statements } = runnerOf(t, name)
  const p = project.Properties
  expect(p.Source).toMatchObject({ Type: 'GITHUB', Location: `https://github.com/${repository}`, Auth: { Type: 'CODECONNECTIONS', Resource: connection } })
  webhookOf(t, name, how)
  expect(p.Artifacts).toEqual({ Type: 'NO_ARTIFACTS' })
  expect(p.Environment).toMatchObject({ Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_LARGE', Image: 'aws/codebuild/standard:8.0', PrivilegedMode: false })
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
  const granted = list(statements.find((s) => s.Sid === 'RunnerConnection')?.Resource)
  if (connection === CONNECTION_ARN) expect(granted.sort()).toEqual([CONNECTION_ARN, CODESTAR_ARN].sort())
  else {
    // the created connection's ARN, and the same connection under codestar-connections in this stack's own account
    expect(granted).toHaveLength(2)
    expect(granted[0]).toEqual(connection)
    expect(JSON.stringify(granted[1])).toContain(':codestar-connections:')
    expect(JSON.stringify(granted[1])).toContain(JSON.stringify(connection))
  }
  const logs = statements.find((s) => s.Sid === 'RunnerLogs')
  for (const r of list(logs?.Resource)) {
    expect(r).not.toBe('*')
    expect(JSON.stringify(r)).toMatch(/Runner(?:[0-9a-f]{8})?Logs|\/aws\/codebuild\//)
  }
  for (const s of statements) expect(list(s.Resource)).not.toContain('*')
}

describe("each project's runner project", () => {
  it("with runners.auth token, names no source credential (CodeBuild uses the account's GitHub source credential), and its role has no connection statement", () => {
    const s = synth(InfraPropsSchema.parse({ ...base, runners: { auth: 'token' } }), 'RunnerToken')
    // no connection at all: neither made nor named, and none of its outputs
    expect(Object.keys(s.parent.findResources('AWS::CodeConnections::Connection'))).toEqual([])
    const outs = Object.keys((s.parent.toJSON() as { Outputs: object }).Outputs)
    expect(outs).not.toContain(CONNECTION_OUTPUT)
    expect(outs).not.toContain(CONNECTION_CREATED_OUTPUT)
    for (const repo of [A, B]) {
      const t = nestedOf(s, repo)
      const name = runnerProjectName('trace', repo)
      const { project, statements } = runnerOf(t, name)
      expect(project.Properties.Source).toMatchObject({ Type: 'GITHUB', Location: `https://github.com/${repo}` })
      expect(project.Properties.Source).not.toHaveProperty('Auth')
      const value = webhookOf(t, name, 'custom')
      expect(statements.flatMap((x) => list(x.Action)).sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents'])
      expect((t.toJSON() as { Outputs: Record<string, { Value: unknown }> }).Outputs[projectOutputs(repo).runnerProject]?.Value).toEqual(value)
    }
    // a connection is for auth connection only
    expect(() => InfraPropsSchema.parse({ ...base, runners: { auth: 'token', connectionArn: CONNECTION_ARN } })).toThrow(/auth 'connection'/)
  }, 300_000)

  for (const layout of LAYOUTS) {
    it(`is named runnerProjectName, reaches GitHub through the connection on WORKFLOW_JOB_QUEUED, and gives a job no AWS access (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, layout }), `Runner${layout}`)
      for (const repo of [A, B]) {
        const t = layout === 'nested' ? nestedOf(s, repo) : s.parent
        const name = runnerProjectName('trace', repo)
        expect(name).toBe(`trace-ci-${projectHash(repo)}`)
        const how: Hook = layout === 'nested' ? 'custom' : 'triggers'
        expectRunner(t, name, repo, how)
        // its output: the nested stack's in the nested layout (never the parent's), the stack's own when flat
        const outputs = (t.toJSON() as { Outputs: Record<string, { Value: unknown }> }).Outputs
        expect(outputs[projectOutputs(repo).runnerProject]?.Value).toEqual(webhookOf(t, name, how))
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
    // nothing is needed up front: no connection (the stack creates one), and ready by default
    const { runners: _, ...noRunners } = base
    expect(InfraPropsSchema.parse(noRunners).runners).toEqual({ auth: 'connection', connectionReady: true, computeType: 'BUILD_GENERAL1_LARGE', image: 'aws/codebuild/standard:8.0', privileged: false, ciPrivileged: false })
    expect(RUNNER_VARIABLE).toBe('TRACE_CODEBUILD_PROJECT')
  }, 300_000)

  it('names the connection under both of the service names', () => {
    expect(connectionArns(CONNECTION_ARN)).toEqual([CONNECTION_ARN, CODESTAR_ARN])
    expect(connectionArns(CODESTAR_ARN)).toEqual([CONNECTION_ARN, CODESTAR_ARN])
  })
})

type Out = Record<string, { Value: unknown }>
const outputsOf = (t: Template): Out => (t.toJSON() as { Outputs: Out }).Outputs

describe("the installation's GitHub connection", () => {
  it('uses a given connection without creating one, and outputs it', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, repositories: [A] }), 'ConnGiven')
    s.all.resourceCountIs('AWS::CodeConnections::Connection', 0)
    expect(outputsOf(s.parent)[CONNECTION_OUTPUT]?.Value).toBe(CONNECTION_ARN)
    expect(outputsOf(s.parent)[CONNECTION_CREATED_OUTPUT]?.Value).toBe('false')
  }, 300_000)

  for (const layout of LAYOUTS) {
    it(`creates <prefix>-github when given none, keeps it on delete, outputs it, and the runners use it (${layout})`, () => {
      for (const retainData of [true, false]) {
        const s = synth(InfraPropsSchema.parse({ ...base, layout, retainData, prefix: 'lab', runners: {} }), `ConnNew${layout}${retainData}`)
        const conns = s.parent.findResources('AWS::CodeConnections::Connection') as Record<string, Res & { DeletionPolicy?: string }>
        expect(Object.keys(conns)).toHaveLength(1)
        s.all.resourceCountIs('AWS::CodeConnections::Connection', 1)
        const [id, conn] = Object.entries(conns)[0] as [string, Res & { DeletionPolicy?: string }]
        expect(conn.Properties).toEqual({ ConnectionName: 'lab-github', ProviderType: 'GitHub', Tags: [{ Key: 'trace:installation', Value: 'lab' }] })
        // kept whatever retainData says: another stack may be reusing it
        expect(conn.DeletionPolicy).toBe('Retain')
        const ref = { 'Fn::GetAtt': [id, 'ConnectionArn'] }
        expect(outputsOf(s.parent)[CONNECTION_OUTPUT]?.Value).toEqual(ref)
        expect(outputsOf(s.parent)[CONNECTION_CREATED_OUTPUT]?.Value).toBe('true')
        for (const repo of [A, B]) {
          if (layout === 'flat') expectRunner(s.parent, runnerProjectName('lab', repo), repo, 'triggers', ref)
          else {
            // a parameter of its nested stack, which the parent sets to the connection's ARN
            const t = nestedOf(s, repo)
            const { project } = runnerOf(t, runnerProjectName('lab', repo))
            const param = (project.Properties.Source as { Auth: { Resource: { Ref: string } } }).Auth.Resource.Ref
            expect(Object.keys((t.toJSON() as { Parameters: object }).Parameters)).toContain(param)
            expectRunner(t, runnerProjectName('lab', repo), repo, 'custom', { Ref: param })
            const passed = (s.parent.toJSON() as { Resources: Record<string, Res> }).Resources[nestedResourceId(s, projectHash(repo))]?.Properties.Parameters as Record<string, unknown>
            expect(passed[param]).toEqual(ref)
          }
        }
      }
    }, 600_000)

    it(`makes no runner project, role, log group or runner output until the connection is ready, but still the connection (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, layout, runners: { connectionReady: false } }), `ConnPending${layout}`)
      // (the agent and GPU image builds are CodeBuild projects too: only the runners are counted)
      const runners = (x: typeof s) => Object.values(x.all.findResources('AWS::CodeBuild::Project') as Record<string, Res>).map((r) => r.Properties.Name).filter((n) => /^trace-ci-[0-9a-f]{8}$/.test(String(n)))
      expect(runners(s)).toEqual([])
      s.parent.resourceCountIs('AWS::CodeConnections::Connection', 1)
      const roles = Object.values(s.all.findResources('AWS::IAM::Role') as Record<string, Res>).map((r) => String(r.Properties.RoleName ?? ''))
      for (const repo of [A, B]) {
        expect(roles.some((n) => n.startsWith(runnerProjectName('trace', repo)))).toBe(false)
        expect(Object.keys(outputsOf(s.all))).not.toContain(projectOutputs(repo).runnerProject)
      }
      const groups = Object.values(s.all.findResources('AWS::Logs::LogGroup') as Record<string, Res>).map((r) => String(r.Properties.LogGroupName ?? ''))
      expect(groups.filter((g) => g.startsWith('/aws/codebuild/trace-ci-'))).toEqual([])
      expect(outputsOf(s.parent)[CONNECTION_OUTPUT]).toBeDefined()
      // and with it ready, the runners
      const ready = synth(InfraPropsSchema.parse({ ...base, layout, runners: {} }), `ConnReady${layout}`)
      expect(runners(ready).sort()).toEqual([A, B].map((r) => runnerProjectName('trace', r)).sort())
    }, 600_000)
  }
})

describe('the build-only repositories (ciRepositories)', () => {
  const C = 'mteichtahl/trace-tools'
  const TRACE = 'MTeichtahl/Trace'
  const only = { ...base, repositories: [B] }
  const ciRunners = (t: Template): string[] => Object.values(t.findResources('AWS::CodeBuild::Project') as Record<string, Res>).map((r) => String(r.Properties.Name)).filter((n) => /^trace-ci-[0-9a-f]{8}$/.test(n))

  for (const layout of LAYOUTS) {
    it(`get a runner project each in the parent, named runnerProjectName, with its output, and nothing else of a project (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...only, layout, ciRepositories: [TRACE, C] }), `Ci${layout}`)
      for (const repo of ['mteichtahl/trace', C]) {
        const name = runnerProjectName('trace', repo)
        // in either layout through the custom resource: GitHub refusing its webhook never fails the deploy
        expectRunner(s.parent, name, repo, 'custom')
        expect(outputsOf(s.parent)[ciRunnerOutput(repo)]?.Value).toEqual(webhookOf(s.parent, name, 'custom'))
        expect(ciRunnerOutput(repo)).toBe(`CiRunner${projectHash(repo)}Project`)
        // no worker, roles, secret, memory or job definition of its own
        const own = JSON.stringify(s.all.toJSON()).match(new RegExp(`Project${projectHash(repo)}`, 'g')) ?? []
        expect(own).toEqual([])
      }
      // the parent holds them in either layout; the project's runner stays where it was
      expect(ciRunners(s.parent).sort()).toEqual([runnerProjectName('trace', 'mteichtahl/trace'), runnerProjectName('trace', C), ...(layout === 'flat' ? [runnerProjectName('trace', B)] : [])].sort())
      expect(ciRunners(s.all)).toHaveLength(3)
      s.all.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2) // B's worker and the API: none for the build-only ones
    }, 300_000)

    it(`get no runner, role, log group or output until the connection is ready (${layout})`, () => {
      const s = synth(InfraPropsSchema.parse({ ...only, layout, ciRepositories: [C], runners: { connectionReady: false } }), `CiPending${layout}`)
      expect(ciRunners(s.all)).toEqual([])
      expect(Object.keys(outputsOf(s.all))).not.toContain(ciRunnerOutput(C))
      const roles = Object.values(s.all.findResources('AWS::IAM::Role') as Record<string, Res>).map((r) => String(r.Properties.RoleName ?? ''))
      expect(roles.some((n) => n.startsWith(runnerProjectName('trace', C)))).toBe(false)
    }, 300_000)
  }

  it('uses the connection the stack created, like the projects\' runners', () => {
    const s = synth(InfraPropsSchema.parse({ ...only, ciRepositories: [C], runners: {} }), 'CiCreated')
    const [id] = Object.keys(s.parent.findResources('AWS::CodeConnections::Connection'))
    expectRunner(s.parent, runnerProjectName('trace', C), C, 'custom', { 'Fn::GetAtt': [id, 'ConnectionArn'] })
  }, 300_000)

  it('with the token: a runner at once, on the account\'s GitHub credential; Docker for them alone with ciPrivileged', () => {
    const s = synth(InfraPropsSchema.parse({ ...only, ciRepositories: [C], runners: { auth: 'token', ciPrivileged: true } }), 'CiToken')
    expect(Object.keys(s.all.findResources('AWS::CodeConnections::Connection'))).toEqual([])
    const ci = runnerOf(s.parent, runnerProjectName('trace', C)).project.Properties
    expect(ci.Source).not.toHaveProperty('Auth')
    expect(ci.Environment).toMatchObject({ PrivilegedMode: true })
    expect(outputsOf(s.parent)[ciRunnerOutput(C)]?.Value).toEqual(webhookOf(s.parent, runnerProjectName('trace', C), 'custom'))
    // the projects' runners keep runners.privileged (off)
    const project = Object.values(s.all.findResources('AWS::CodeBuild::Project') as Record<string, Res>).find((r) => r.Properties.Name === runnerProjectName('trace', B))
    expect(project?.Properties.Environment).toMatchObject({ PrivilegedMode: false })
  }, 300_000)

  it('refuses one that is a project, listed twice, not a repository, or too many; none by default', () => {
    expect(InfraPropsSchema.parse(only).ciRepositories).toEqual([])
    expect(() => InfraPropsSchema.parse({ ...base, ciRepositories: ['MTEICHTAHL/trace'] })).toThrow(/is one of the repositories already/)
    expect(() => InfraPropsSchema.parse({ ...only, ciRepositories: [C, C.toUpperCase()] })).toThrow(/listed twice/)
    expect(() => InfraPropsSchema.parse({ ...only, ciRepositories: ['not a repo'] })).toThrow(/OWNER\/REPO/)
    expect(() => InfraPropsSchema.parse({ ...only, ciRepositories: ['a/..'] })).toThrow()
    const many = Array.from({ length: CI_REPOSITORIES_MAX + 1 }, (_, i) => `o/r${i}`)
    expect(() => InfraPropsSchema.parse({ ...only, ciRepositories: many })).toThrow()
    expect(InfraPropsSchema.parse({ ...only, ciRepositories: many.slice(1) }).ciRepositories).toHaveLength(CI_REPOSITORIES_MAX)
  })
})

describe("the runners' webhooks (RunnerWebhooks)", () => {
  /** The provider's function's statements (the one whose description names the webhooks). */
  const webhookStatements = (t: Template): Statement[] => {
    const fns = Object.entries(t.findResources('AWS::Lambda::Function') as Record<string, Res>).filter(([, r]) => String(r.Properties.Description).includes('GitHub webhooks'))
    expect(fns).toHaveLength(1)
    const roleId = ((fns[0] as [string, Res])[1].Properties.Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0]
    return Object.values(t.findResources('AWS::IAM::Policy') as Record<string, Res>)
      .filter((p) => JSON.stringify(p.Properties.Roles).includes(roleId))
      .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
  }

  it("may touch only this installation's runner projects' webhooks, and the connection", () => {
    const s = synth(InfraPropsSchema.parse(base), 'Hooks')
    const st = webhookStatements(s.parent)
    const hooks = st.find((x) => x.Sid === 'RunnerWebhooks')
    expect(list(hooks?.Action).sort()).toEqual(['codebuild:BatchGetProjects', 'codebuild:CreateWebhook', 'codebuild:DeleteWebhook'])
    expect(JSON.stringify(hooks?.Resource)).toContain(':project/trace-ci-*')
    expect(list(st.find((x) => x.Sid === 'RunnerWebhooksConnection')?.Resource).sort()).toEqual([CONNECTION_ARN, CODESTAR_ARN].sort())
    for (const x of st) expect(list(x.Resource)).not.toContain('*')
    // and with the token, no connection statement
    const token = webhookStatements(synth(InfraPropsSchema.parse({ ...base, runners: { auth: 'token' } }), 'HooksToken').parent)
    expect(token.map((x) => x.Sid)).not.toContain('RunnerWebhooksConnection')
  }, 300_000)

  it('is made only where a runner uses it: not while the connection is pending, nor for a flat stack with no build-only repository', () => {
    const fns = (t: Template): number => Object.values(t.findResources('AWS::Lambda::Function') as Record<string, Res>).filter((r) => String(r.Properties.Description).includes('GitHub webhooks')).length
    expect(fns(synth(InfraPropsSchema.parse({ ...base, runners: { connectionReady: false } }), 'HooksPending').all)).toBe(0)
    expect(fns(synth(InfraPropsSchema.parse({ ...base, layout: 'flat' }), 'HooksFlat').all)).toBe(0)
    expect(fns(synth(InfraPropsSchema.parse({ ...base, layout: 'flat', repositories: [B], ciRepositories: [A] }), 'HooksFlatCi').all)).toBe(1)
  }, 600_000)
})
