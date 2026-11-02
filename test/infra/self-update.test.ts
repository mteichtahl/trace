/**
 * Keeping the installation up to date (README "Staying up to date"): the `<prefix>-self-update` role, which only trace's
 * own repository's ci workflow on its default branch may assume, and which may do only what deploying the stack again
 * takes. And installation/* of the central bucket, where the installer saves the settings, is no other role's.
 */
import type { Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, SELF_UPDATE_OUTPUT, stackName } from '../../src/infra/props.js'
import { RUNNERS, type Synth, synth } from './templates.js'

const A = 'mteichtahl/board'
const TRACE = 'mteichtahl/trace'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A], ciRepositories: [TRACE], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown }
type Res = { Type: string; Properties: Record<string, unknown> }
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

function roleOf(t: Template, name: string): { id: string; role: Res; statements: Statement[] } {
  const roles = Object.entries(t.findResources('AWS::IAM::Role') as Record<string, Res>).filter(([, r]) => r.Properties.RoleName === name)
  expect(roles).toHaveLength(1)
  const [id, role] = roles[0] as [string, Res]
  const statements = Object.values(t.findResources('AWS::IAM::Policy') as Record<string, Res>)
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(`"${id}"`))
    .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
  return { id, role, statements }
}

/** Every IAM statement of every role and policy in a template, with the role ids it is attached to. */
function allStatements(t: Template): { roles: string; s: Statement }[] {
  const out: { roles: string; s: Statement }[] = []
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role') as Record<string, Res>)) {
    for (const p of (r.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]) for (const s of p.PolicyDocument.Statement) out.push({ roles: id, s })
  }
  for (const p of Object.values(t.findResources('AWS::IAM::Policy') as Record<string, Res>)) {
    for (const s of (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement) out.push({ roles: JSON.stringify(p.Properties.Roles), s })
  }
  return out
}

describe('the self-update role', () => {
  let on: Synth
  let off: Synth
  beforeAll(() => {
    on = synth(InfraPropsSchema.parse({ ...base, selfUpdate: { repository: TRACE } }), stackName('trace'))
    off = synth(InfraPropsSchema.parse(base), stackName('trace'))
  }, 300_000)

  it('is there only when selfUpdate is set, with its output', () => {
    expect(Object.values(off.all.findResources('AWS::IAM::Role') as Record<string, Res>).some((r) => r.Properties.RoleName === 'trace-self-update')).toBe(false)
    expect(Object.keys(off.parent.findOutputs(SELF_UPDATE_OUTPUT))).toEqual([])
    const { id } = roleOf(on.parent, 'trace-self-update')
    expect(on.parent.findOutputs(SELF_UPDATE_OUTPUT)[SELF_UPDATE_OUTPUT]?.Value).toEqual({ 'Fn::GetAtt': [id, 'Arn'] })
    // the branch defaults to main; another may be given
    expect(InfraPropsSchema.parse({ ...base, selfUpdate: { repository: TRACE } }).selfUpdate).toEqual({ repository: TRACE, branch: 'main' })
    expect(InfraPropsSchema.safeParse({ ...base, selfUpdate: { repository: 'not a repo' } }).success).toBe(false)
  })

  it('trusts only the ci workflow of trace\'s own repository on its branch, through GitHub OIDC, for an hour', () => {
    const { role } = roleOf(on.parent, 'trace-self-update')
    expect(role.Properties.MaxSessionDuration).toBe(3600)
    const trust = role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] }
    expect(trust.Statement).toHaveLength(1)
    const st = trust.Statement[0] as Statement & { Principal: { Federated: unknown } }
    expect(st.Effect).toBe('Allow')
    expect(st.Action).toBe('sts:AssumeRoleWithWebIdentity')
    expect(JSON.stringify(st.Principal.Federated)).toMatch(/GithubOidc/)
    expect(st.Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${TRACE}:ref:refs/heads/main`,
      },
      StringLike: { 'token.actions.githubusercontent.com:job_workflow_ref': `${TRACE}/.github/workflows/ci.yml@refs/heads/main` },
    })
    const dev = synth(InfraPropsSchema.parse({ ...base, selfUpdate: { repository: TRACE, branch: 'trunk' } }), stackName('trace'))
    const c = JSON.stringify((roleOf(dev.parent, 'trace-self-update').role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement[0]?.Condition)
    expect(c).toContain(`repo:${TRACE}:ref:refs/heads/trunk"`)
    expect(c).toContain(`${TRACE}/.github/workflows/ci.yml@refs/heads/trunk"`)
    expect(c).not.toContain('*')
  })

  it('may only assume the CDK bootstrap roles, read installation/*, read the stack, check the connection and CodeBuild\'s credential, read the shared token, mark pending projects and write projects\' token secrets', () => {
    const { statements } = roleOf(on.parent, 'trace-self-update')
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid ?? '', s]))
    expect(Object.keys(bySid).sort()).toEqual(['CdkBootstrapRoles', 'CodeBuildSourceCredential', 'GithubConnection', 'GithubConnections', 'InstallationSettings', 'PendingProjectsList', 'PendingProjectsMark', 'ProjectTokenSecrets', 'SharedAgentToken', 'StackOutputs', 'WebHooksSecret'])
    for (const s of statements) {
      expect(s.Effect).toBe('Allow')
      for (const a of list(s.Action)) expect(a, `${s.Sid}`).not.toContain('*')
      if (s.Sid !== 'PendingProjectsList') expect(s.Condition).toBeUndefined()
    }
    // the projects created in the web app: listed and marked under installation/pending-projects/ only
    expect(bySid.PendingProjectsList?.Action).toBe('s3:ListBucket')
    expect(bySid.PendingProjectsList?.Condition).toEqual({ StringLike: { 's3:prefix': ['installation/pending-projects/*'] } })
    expect(bySid.PendingProjectsMark?.Action).toBe('s3:PutObject')
    expect(JSON.stringify(bySid.PendingProjectsMark?.Resource)).toMatch(/"\/installation\/pending-projects\/\*"\]\]\}$/)
    // a project it adds gets a copy of the shared token in its own secret; never a value read but the shared one
    expect(bySid.ProjectTokenSecrets?.Action).toBe('secretsmanager:PutSecretValue')
    // live updates from GitHub: a project it adds gets its webhook with the installer's secret, read only
    expect(bySid.WebHooksSecret?.Action).toBe('secretsmanager:GetSecretValue')
    expect(JSON.stringify(bySid.WebHooksSecret?.Resource)).toContain(':secret:trace/web/github-hooks-??????')
    // never the backend's own client secret, which only the hooks function reads
    expect(JSON.stringify(statements)).not.toContain('hooks-client')
    expect(JSON.stringify(bySid.ProjectTokenSecrets?.Resource)).toContain(':secretsmanager:us-east-1:123456789012:secret:trace/github-token/*')
    const text = (v: unknown): string => JSON.stringify(v)
    expect(bySid.CdkBootstrapRoles?.Action).toBe('sts:AssumeRole')
    expect(text(bySid.CdkBootstrapRoles?.Resource)).toBe(text({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::123456789012:role/cdk-hnb659fds-*-123456789012-us-east-1']] }))
    expect(bySid.InstallationSettings?.Action).toBe('s3:GetObject')
    expect(text(bySid.InstallationSettings?.Resource)).toMatch(/"\/installation\/\*"\]\]\}$/)
    expect(list(bySid.StackOutputs?.Action ?? []).sort()).toEqual(['cloudformation:DescribeStacks', 'cloudformation:ListStackResources'])
    expect(text(bySid.StackOutputs?.Resource)).toContain(':cloudformation:us-east-1:123456789012:stack/TraceStack/*')
    expect(text(bySid.StackOutputs?.Resource)).toContain(':cloudformation:us-east-1:123456789012:stack/TraceStack-*/*')
    expect(list(bySid.GithubConnection?.Action ?? []).sort()).toEqual(['codeconnections:GetConnection', 'codeconnections:ListTagsForResource'])
    expect(text(bySid.GithubConnection?.Resource)).toContain(':codeconnections:us-east-1:123456789012:connection/*')
    // ListConnections has no resource-level permission
    expect(bySid.GithubConnections).toMatchObject({ Action: 'codeconnections:ListConnections', Resource: '*' })
    // runners.auth token: whether CodeBuild has a GitHub source credential; never importing, changing or deleting one
    expect(bySid.CodeBuildSourceCredential).toMatchObject({ Action: 'codebuild:ListSourceCredentials', Resource: '*' })
    expect(bySid.SharedAgentToken?.Action).toBe('secretsmanager:GetSecretValue')
    expect(text(bySid.SharedAgentToken?.Resource)).toMatch(/^\{"Ref":"GithubToken[0-9A-F]+"\}$/)
  })

  it('leaves installation/* to it alone: no other role may read, write or list it (but the API, pending-projects/ only)', () => {
    const { id } = roleOf(on.parent, 'trace-self-update')
    const api = Object.entries(on.parent.findResources('AWS::IAM::Role') as Record<string, Res>).find(([k]) => k.startsWith('ApiRuntimeRole'))?.[0] ?? ''
    expect(api).not.toBe('')
    for (const { roles, s } of allStatements(on.all)) {
      if (roles.includes(`"${id}"`) || roles === id) continue
      let r = JSON.stringify(s.Resource ?? '') + JSON.stringify(s.Condition ?? '')
      // projects.create (src/api/actions-projects.ts) records requests under installation/pending-projects/, with
      // conditional writes, for the update to pick up; the settings (installation/props.json) stay the update's alone
      if (roles.includes(`"${api}"`)) r = r.replaceAll('installation/pending-projects/*', '')
      // the cost ledger's actuals (read by the API, written by the cost read alone) and the order watch's rows (the API
      // starts a watch, the order watch checks it): their own prefixes only (src/infra/cost.ts, src/infra/order-watch.ts)
      if (roles.includes(`"${api}"`) || /CostReadRole/.test(roles)) r = r.replaceAll('installation/cost/*', '')
      if (roles.includes(`"${api}"`) || /OrderWatchRole/.test(roles)) r = r.replaceAll('installation/shipping/*', '')
      // the price table fetched from the AWS price list: every worker may read (and list) that one key, nothing else
      // (src/infra/project.ts pricesReadStatements); the statement grants s3:GetObject or s3:ListBucket alone
      if (s.Sid === 'PricesRead' || s.Sid === 'PricesList') {
        expect(list(s.Action), `${roles} ${s.Sid}`).toEqual([s.Sid === 'PricesRead' ? 's3:GetObject' : 's3:ListBucket'])
        r = r.replaceAll('installation/cost/prices.json', '')
      }
      expect(r, `${roles} ${s.Sid ?? ''}`).not.toMatch(/installation\//)
      // a grant on the whole central bucket would reach it too
      const actions = list(s.Action).filter((a) => a.startsWith('s3:') && !['s3:ListBucket'].includes(a))
      if (actions.length) expect(JSON.stringify(s.Resource), `${roles} ${s.Sid ?? ''}`).not.toMatch(/Central[0-9A-F]+","Arn"\]\},"\/\*"/)
    }
  })
})
