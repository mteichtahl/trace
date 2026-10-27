/**
 * TraceRelease (src/infra/release.ts): the two ECR Public repositories with their catalog data, and the release role,
 * trusted only by the source repository's main and v* tags and allowed only to push to those two repositories.
 */
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { PUSH_ACTIONS, RELEASE_REGION, RELEASE_ROLE_OUTPUT, RELEASE_STACK, TraceReleaseStack, releaseSettings } from '../../src/infra/release.js'

type Res = { Type: string; Properties: Record<string, unknown> }
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> }
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

const synth = (createOidcProvider = false): Template => {
  const app = new App()
  return Template.fromStack(new TraceReleaseStack(app, RELEASE_STACK, { repository: 'mteichtahl/trace', createOidcProvider }, { account: '123456789012' }))
}

describe('the release stack', () => {
  const t = synth()

  it('is in us-east-1, with trace-agent (arm64) and trace-gpu (x86-64) on ECR Public, described for the gallery', () => {
    expect(RELEASE_REGION).toBe('us-east-1')
    const repos = Object.values(t.findResources('AWS::ECR::PublicRepository') as Record<string, Res>)
    expect(repos.map((r) => r.Properties.RepositoryName).sort()).toEqual(['trace-agent', 'trace-gpu'])
    const byName = Object.fromEntries(repos.map((r) => [r.Properties.RepositoryName, r.Properties.RepositoryCatalogData as Record<string, unknown>]))
    expect(byName['trace-agent']).toMatchObject({ Architectures: ['ARM 64'], OperatingSystems: ['Linux'], RepositoryDescription: expect.stringContaining('AgentCore') })
    expect(byName['trace-gpu']).toMatchObject({ Architectures: ['x86-64'], OperatingSystems: ['Linux'], RepositoryDescription: expect.stringContaining('AWS Batch') })
    // no repository policy: public repositories are readable by anyone already, and nobody else may push
    for (const r of repos) expect(r.Properties).not.toHaveProperty('RepositoryPolicyText')
  })

  it("trusts only the source repository's main branch and v* tags, through GitHub's OIDC provider", () => {
    const roles = Object.values(t.findResources('AWS::IAM::Role') as Record<string, Res>)
    expect(roles).toHaveLength(1)
    const role = roles[0] as Res
    expect(role.Properties.RoleName).toBe('trace-release')
    const trust = (role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement
    expect(trust).toHaveLength(1)
    expect(list(trust[0]?.Action)).toEqual(['sts:AssumeRoleWithWebIdentity'])
    expect(trust[0]?.Condition).toEqual({
      StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
      StringLike: { 'token.actions.githubusercontent.com:sub': ['repo:mteichtahl/trace:ref:refs/heads/main', 'repo:mteichtahl/trace:ref:refs/tags/v*'] },
    })
    // the account's provider, unless asked to make one
    expect(Object.keys(t.findResources('Custom::AWSCDKOpenIdConnectProvider'))).toEqual([])
    expect(JSON.stringify(trust[0])).toContain('oidc-provider/token.actions.githubusercontent.com')
    expect(Object.keys(synth(true).findResources('Custom::AWSCDKOpenIdConnectProvider'))).toHaveLength(1)
  })

  it('may only log in and push to the two repositories: no delete, no policy, no other repository', () => {
    const role = Object.values(t.findResources('AWS::IAM::Role') as Record<string, Res>)[0] as Res
    const statements = ((role.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]).flatMap((p) => p.PolicyDocument.Statement)
    expect(Object.keys(t.findResources('AWS::IAM::Policy'))).toEqual([])
    const by = Object.fromEntries(statements.map((s) => [s.Sid, s]))
    expect(list(by.Login?.Action)).toEqual(['ecr-public:GetAuthorizationToken'])
    expect(list(by.BearerToken?.Action)).toEqual(['sts:GetServiceBearerToken'])
    expect(by.BearerToken?.Condition).toEqual({ StringEquals: { 'sts:AWSServiceName': 'ecr-public.amazonaws.com' } })
    expect(list(by.Push?.Action).sort()).toEqual([...PUSH_ACTIONS].sort())
    const pushed = list(by.Push?.Resource).map((r) => JSON.stringify(r))
    expect(pushed).toHaveLength(2)
    expect(pushed.every((r) => /AgentRepository|GpuRepository/.test(r))).toBe(true)
    const every = statements.flatMap((s) => list(s.Action))
    expect(every.filter((a) => /Delete|Policy|Create|\*$/.test(a))).toEqual([])
    expect(Object.keys((t.toJSON() as { Outputs: object }).Outputs)).toContain(RELEASE_ROLE_OUTPUT)
  })

  it('takes its settings from context or the environment', () => {
    expect(releaseSettings(() => undefined, {})).toEqual({ repository: 'mteichtahl/trace', createOidcProvider: false })
    expect(releaseSettings((k) => ({ repository: 'Me/Fork', createOidcProvider: 'true' })[k], {})).toEqual({ repository: 'me/fork', createOidcProvider: true })
    expect(() => releaseSettings(() => undefined, { TRACE_CREATE_OIDC_PROVIDER: 'yes' })).toThrow(/true or false/)
  })
})
