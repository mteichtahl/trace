/**
 * The web app's AWS WAF (src/infra/edge.ts, src/installer/edge.ts): its web ACL (rules and limits), where it is made
 * (the web app's stack in us-east-1, `<prefix>-edge` there otherwise), the installer's and the self-update's deploy of
 * it and what they pass the main stack, the plan's words and cost, and the self-update role's reach in us-east-1.
 */
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { BODY_TOO_LARGE, WAF_DESCRIPTION, wafDescription, EDGE_ACL_OUTPUT, MAX_BODY_BYTES, TraceEdgeStack, edgeNeeded, edgeStackName } from '../../src/infra/edge.js'
import { InfraPropsSchema } from '../../src/infra/props.js'
import { deployEdge, edgeLeftOver, wafPlan, withAcl } from '../../src/installer/edge.js'
import { RUNNERS, synth } from './templates.js'

const base = { account: '123456789012', region: 'ap-southeast-2', repositories: ['mteichtahl/board'], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }
const ACL = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/trace-web/11111111-1111-1111-1111-111111111111'
type Rule = { Name: string; Priority: number; Action?: Record<string, unknown>; OverrideAction?: unknown; Statement: Record<string, any> }

describe('the edge stack', () => {
  const props = InfraPropsSchema.parse(base)
  const t = Template.fromStack(new TraceEdgeStack(new App(), props))
  const acl = Object.values(t.findResources('AWS::WAFv2::WebACL'))[0] as { Properties: { Scope: string; Name: string; Description: string; DefaultAction: unknown; Rules: Rule[] } }

  it('is <prefix>-edge in us-east-1, with one CLOUDFRONT web ACL and its ARN as an output', () => {
    const stack = new TraceEdgeStack(new App(), props)
    expect(stack.region).toBe('us-east-1')
    expect(stack.stackName).toBe('trace-edge')
    expect(acl.Properties).toMatchObject({ Scope: 'CLOUDFRONT', Name: 'trace-web', DefaultAction: { Allow: {} } })
    expect(Object.keys(t.toJSON().Resources)).toHaveLength(1)
    expect(t.toJSON().Outputs[EDGE_ACL_OUTPUT].Value).toEqual({ 'Fn::GetAtt': [expect.any(String), 'Arn'] })
  })

  it('blocks large API bodies, limits sign-in and the API per address, and runs AWS\'s three managed groups', () => {
    const rules = acl.Properties.Rules
    expect(rules.map((r) => [r.Priority, r.Name])).toEqual([[1, 'BodyTooLarge'], [2, 'AuthRate'], [3, 'ApiRate'], [4, 'IpReputation'], [5, 'KnownBadInputs'], [6, 'Common']])
    const body = rules[0]!.Statement.AndStatement.Statements
    expect(body[0].ByteMatchStatement).toMatchObject({ SearchString: '/api/', PositionalConstraint: 'STARTS_WITH' })
    expect(body[1].RegexMatchStatement).toMatchObject({ FieldToMatch: { SingleHeader: { Name: 'content-length' } }, RegexString: BODY_TOO_LARGE })
    const re = new RegExp(BODY_TOO_LARGE)
    for (const n of [MAX_BODY_BYTES, 9_999_999, 12_000_000, 100_000_000]) expect(re.test(String(n)), String(n)).toBe(true)
    for (const n of [0, 4 * 1024 * 1024, 4_999_999, 999_999]) expect(re.test(String(n)), String(n)).toBe(false)
    expect(rules[1]!.Statement.RateBasedStatement).toMatchObject({ Limit: 100, EvaluationWindowSec: 300, AggregateKeyType: 'IP', ScopeDownStatement: { ByteMatchStatement: { SearchString: '/api/auth/' } } })
    expect(rules[2]!.Statement.RateBasedStatement).toMatchObject({ Limit: 1000, AggregateKeyType: 'IP', ScopeDownStatement: { ByteMatchStatement: { SearchString: '/api/' } } })
    expect(rules[1]!.Action).toEqual({ Block: { CustomResponse: { ResponseCode: 429 } } })
    expect(rules.slice(3).map((r) => r.Statement.ManagedRuleGroupStatement.Name)).toEqual(['AWSManagedRulesAmazonIpReputationList', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesCommonRuleSet'])
    // the core rule set's 8 KB body limit and body XSS rule would refuse chats and prompts: counted, not blocked
    expect(rules[5]!.Statement.ManagedRuleGroupStatement.RuleActionOverrides).toEqual([
      { Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }, { Name: 'CrossSiteScripting_BODY', ActionToUse: { Count: {} } },
    ])
  })

  it('has a description AWS WAF accepts', () => {
    const d = acl.Properties.Description
    expect(d).toMatch(WAF_DESCRIPTION)
    expect(wafDescription("trace web app (dev): AWS's rules ")).toBe('trace web app dev: AWSs rules')
    expect(wafDescription('x'.repeat(300))).toHaveLength(256)
  })

  it('takes its limits from the settings', () => {
    const p = InfraPropsSchema.parse({ ...base, web: { waf: { apiRequestsPer5Minutes: 5000, authRequestsPer5Minutes: 50 } } })
    const rules = (Object.values(Template.fromStack(new TraceEdgeStack(new App(), p)).findResources('AWS::WAFv2::WebACL'))[0] as { Properties: { Rules: Rule[] } }).Properties.Rules
    expect(rules.find((r) => r.Name === 'AuthRate')?.Statement.RateBasedStatement.Limit).toBe(50)
    expect(rules.find((r) => r.Name === 'ApiRate')?.Statement.RateBasedStatement.Limit).toBe(5000)
  })

  it('is needed outside us-east-1 only, with the WAF on and no web ACL of the person\'s own', () => {
    expect(edgeNeeded(InfraPropsSchema.parse(base))).toBe(true)
    expect(edgeNeeded(InfraPropsSchema.parse({ ...base, region: 'us-east-1' }))).toBe(false)
    expect(edgeNeeded(InfraPropsSchema.parse({ ...base, web: { waf: { enabled: false } } }))).toBe(false)
    expect(edgeNeeded(InfraPropsSchema.parse({ ...base, web: { webAclArn: ACL } }))).toBe(false)
    expect(edgeNeeded(InfraPropsSchema.parse({ ...base, web: { enabled: false } }))).toBe(false)
  })
})

describe('the main stack outside us-east-1', () => {
  it('uses the edge stack\'s ACL it was given, and has none (with a warning) until then', () => {
    const given = synth(InfraPropsSchema.parse({ ...base, web: { waf: { aclArn: ACL } } }), 'EdgeGiven')
    const dist = (s: ReturnType<typeof synth>) => (Object.values(s.web!.findResources('AWS::CloudFront::Distribution'))[0] as { Properties: { DistributionConfig: { WebACLId?: unknown } } }).Properties.DistributionConfig
    expect(dist(given).WebACLId).toBe(ACL)
    given.web!.resourceCountIs('AWS::WAFv2::WebACL', 0)
    const none = synth(InfraPropsSchema.parse(base), 'EdgeNotYet')
    expect(dist(none).WebACLId).toBeUndefined()
  })

  it('lets the self-update deploy the edge stack (us-east-1 bootstrap roles, its outputs) and nothing more there', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, selfUpdate: { repository: 'mteichtahl/trace' } }), 'EdgeUpdate')
    const policy = JSON.stringify(s.parent.findResources('AWS::IAM::Policy'))
    expect(policy).toContain('role/cdk-hnb659fds-*-123456789012-us-east-1')
    expect(policy).toContain(':cloudformation:us-east-1:123456789012:stack/trace-edge/*')
    expect(policy).toContain(':cloudformation:us-east-1:123456789012:stack/CDKToolkit/*')
    expect(policy).not.toMatch(/us-east-1:123456789012:stack\/\*|wafv2:/)
    const inUs = synth(InfraPropsSchema.parse({ ...base, region: 'us-east-1', selfUpdate: { repository: 'mteichtahl/trace' } }), 'EdgeUpdateUs')
    expect(JSON.stringify(inUs.parent.findResources('AWS::IAM::Policy'))).not.toContain('trace-edge')
  })
})

describe('deploying it (the installer and the self-update)', () => {
  const input = { ...base, prefix: 'trace' }
  const fake = (o: { toolkit?: boolean; code?: number; acl?: string | null } = {}) => {
    const calls: { args: string[]; env: Record<string, string> }[] = []
    return {
      calls,
      deps: {
        cdk: async (args: string[], env: Record<string, string>) => { calls.push({ args, env }); return args[0] === 'deploy' ? (o.code ?? 0) : 0 },
        outputs: async (stack: string) => (stack === 'CDKToolkit' ? (o.toolkit === false ? null : ({ BootstrapVersion: '27' } as Record<string, string>)) : o.acl === null ? null : ({ [EDGE_ACL_OUTPUT]: o.acl ?? ACL } as Record<string, string>)),
        log: () => undefined,
      },
    }
  }

  it('deploys <prefix>-edge with the same settings and answers its ACL for the main stack', async () => {
    const f = fake()
    const r = await deployEdge({ input, account: '123456789012', app: ['--app', 'x'], env: { A: '1' }, bootstrap: true, deps: f.deps })
    expect(r).toMatchObject({ aclArn: ACL, ok: true })
    expect(f.calls.map((c) => c.args[0])).toEqual(['deploy'])
    expect(f.calls[0]?.args.slice(0, 2)).toEqual(['deploy', edgeStackName('trace')])
    expect(JSON.parse(f.calls[0]?.env.TRACE_INFRA ?? '{}')).toMatchObject({ region: 'ap-southeast-2' })
    expect(withAcl(input, r.aclArn).web).toEqual({ waf: { aclArn: ACL } })
  })

  it('bootstraps us-east-1 when the installer may; the self-update may not, and keeps the ACL the app had', async () => {
    const f = fake({ toolkit: false })
    await deployEdge({ input, account: '123456789012', app: [], env: {}, bootstrap: true, deps: f.deps })
    expect(f.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['bootstrap aws://123456789012/us-east-1', 'deploy trace-edge'])
    const g = fake({ toolkit: false })
    const r = await deployEdge({ input: withAcl(input, ACL), account: '123456789012', app: [], env: {}, bootstrap: false, deps: g.deps })
    expect(g.calls).toEqual([])
    expect(r).toMatchObject({ aclArn: ACL, ok: false })
    expect(r.note).toMatch(/not bootstrapped in us-east-1.*keeps the web ACL it had/)
  })

  it('a failed edge deploy never stops the main one: the ACL the edge stack already has is kept', async () => {
    const r = await deployEdge({ input, account: '1', app: [], env: {}, bootstrap: true, deps: fake({ code: 1 }).deps })
    expect(r).toMatchObject({ aclArn: ACL, ok: false })
    const first = await deployEdge({ input, account: '1', app: [], env: {}, bootstrap: true, deps: fake({ code: 1, acl: null }).deps })
    expect(first).toMatchObject({ aclArn: null, ok: false, note: expect.stringMatching(/no WAF until it is/) })
  })

  it('nothing to do in us-east-1 or with the WAF off; a left-over edge stack is deleted', async () => {
    const f = fake()
    expect(await deployEdge({ input: { ...input, region: 'us-east-1' }, account: '1', app: [], env: {}, bootstrap: true, deps: f.deps })).toMatchObject({ aclArn: null, note: null })
    expect(f.calls).toEqual([])
    expect(edgeLeftOver(InfraPropsSchema.parse({ ...base, web: { waf: { enabled: false } } }), true)).toBe(true)
    expect(edgeLeftOver(InfraPropsSchema.parse(base), true)).toBe(false)
  })

  it('says in the plan where the WAF is and what it costs', () => {
    expect(wafPlan(InfraPropsSchema.parse(base))).toMatch(/AWS WAF in its own small stack trace-edge in us-east-1.*about US\$11 a month and US\$0\.60 per million requests/)
    expect(wafPlan(InfraPropsSchema.parse({ ...base, region: 'us-east-1' }))).toMatch(/in the web app's stack/)
    expect(wafPlan(InfraPropsSchema.parse({ ...base, web: { waf: { enabled: false } } }))).toMatch(/without AWS WAF/)
    expect(wafPlan(InfraPropsSchema.parse({ ...base, web: { webAclArn: ACL } }))).toContain(ACL)
  })
})
