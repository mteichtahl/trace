/**
 * Cloud cost per project and the order watch, as synthesized (src/infra/cost.ts, src/infra/order-watch.ts): the two
 * scheduled Lambdas' roles are least privilege, the API reads the ledger and starts watches but writes no cost, the
 * workers never read the carrier key, and every project resource carries the project's cost allocation tag.
 */
import { Match, type Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, projectHash } from '../../src/infra/props.js'
import { RUNNERS, type Synth, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/board'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> }
type Res = { Type: string; Properties: Record<string, unknown> }
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

/** The statements of the policies attached to the role whose logical id starts with `prefix`. */
function statementsOfRole(t: Template, prefix: string): Statement[] {
  const ids = Object.keys(t.findResources('AWS::IAM::Role')).filter((k) => k.startsWith(prefix))
  expect(ids).toHaveLength(1)
  return Object.values(t.findResources('AWS::IAM::Policy') as Record<string, Res>)
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(`"${ids[0]}"`))
    .flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
}
const actions = (s: readonly Statement[]): string[] => s.flatMap((x) => list(x.Action)).sort()
const text = (v: unknown): string => JSON.stringify(v)

let syn: Synth
beforeAll(() => { syn = synth(InfraPropsSchema.parse(base), 'CostStack') }, 300_000)

describe('the daily cost read', () => {
  it('is a function on a daily schedule, told the bucket, the prefix and whether it may activate the tags', () => {
    syn.parent.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'trace-cost-explorer', Runtime: 'nodejs22.x', Environment: { Variables: { TRACE_PREFIX: 'trace', TRACE_COST_ACTIVATE_TAGS: '1', TRACE_COST_SCHEDULE: '6:17', TRACE_CENTRAL_BUCKET: { Ref: Match.stringLikeRegexp('^Central') }, XDG_CACHE_HOME: '/tmp' } } })
    syn.parent.hasResourceProperties('AWS::Events::Rule', { Name: 'trace-cost-explorer', ScheduleExpression: 'cron(17 6 * * ? *)' })
  })

  it('may read Cost Explorer and activate the cost allocation tags, and write installation/cost/ with conditional puts only', () => {
    const s = statementsOfRole(syn.parent, 'CostReadRole')
    expect(actions(s)).toEqual(['ce:GetCostAndUsage', 'ce:ListCostAllocationTags', 'ce:UpdateCostAllocationTagsStatus', 'logs:CreateLogStream', 'logs:PutLogEvents', 's3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:PutObject'])
    // Cost Explorer has no resource-level permissions for these
    for (const x of s.filter((y) => list(y.Action).some((a) => a.startsWith('ce:')))) expect(x.Resource).toBe('*')
    for (const x of s.filter((y) => list(y.Action).some((a) => a.startsWith('s3:') && a !== 's3:ListBucket'))) expect(text(x.Resource)).toMatch(/"\/installation\/cost\/\*"/)
    const puts = s.filter((y) => list(y.Action).includes('s3:PutObject'))
    expect(puts.map((p) => Object.keys(p.Condition?.Null ?? {})[0]).sort()).toEqual(['s3:if-match', 's3:if-none-match'])
    expect(s.find((y) => y.Sid === 'ActualsList')?.Condition).toEqual({ StringLike: { 's3:prefix': ['installation/cost/*'] } })
    expect(text(s)).not.toMatch(/projects\/|access\/|secretsmanager|DeleteObject/)
  })

  it('may not activate the tags when cost.explorer.activateTags is false, and is absent when the read is off', () => {
    const noAct = synth(InfraPropsSchema.parse({ ...base, cost: { explorer: { activateTags: false } } }), 'CostNoActivate')
    expect(actions(statementsOfRole(noAct.parent, 'CostReadRole'))).not.toContain('ce:UpdateCostAllocationTagsStatus')
    const off = synth(InfraPropsSchema.parse({ ...base, cost: { explorer: { enabled: false } } }), 'CostOff')
    expect(Object.keys(off.parent.findResources('AWS::IAM::Role')).some((k) => k.startsWith('CostReadRole'))).toBe(false)
    expect(text(off.parent.toJSON())).not.toContain('ce:GetCostAndUsage')
  }, 300_000)

  it('hands the price overrides to the workers, dated', () => {
    const prices = { asOf: '2026-10-01', gpu: { perHour: 1.2, basis: 'g6.xlarge, our negotiated rate' } }
    const s = synth(InfraPropsSchema.parse({ ...base, cost: { prices } }), 'CostPrices')
    const rt = Object.values(nestedOf(s, A).findResources('AWS::BedrockAgentCore::Runtime') as Record<string, { Properties: { EnvironmentVariables: Record<string, unknown> } }>)[0]
    expect(JSON.parse(String(rt?.Properties.EnvironmentVariables.TRACE_PRICES))).toEqual(prices)
  }, 300_000)
})

describe('the order watch', () => {
  it('reads and conditionally writes installation/shipping/ only, and reads only the carrier key', () => {
    syn.parent.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'trace-order-watch' })
    syn.parent.hasResourceProperties('AWS::Events::Rule', { Name: 'trace-order-watch', ScheduleExpression: 'rate(1 hour)' })
    const s = statementsOfRole(syn.parent, 'OrderWatchRole')
    expect(actions(s)).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents', 's3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:PutObject', 'secretsmanager:GetSecretValue'])
    const key = s.find((x) => x.Sid === 'CarrierKey')
    expect(text(key?.Resource)).toMatch(/:secret:trace\/order-watch\/dhl-\?{6}/)
    for (const x of s.filter((y) => list(y.Action).some((a) => a === 's3:GetObject' || a === 's3:PutObject'))) expect(text(x.Resource)).toMatch(/"\/installation\/shipping\/\*"/)
    expect(s.filter((y) => list(y.Action).includes('s3:PutObject')).map((p) => Object.keys(p.Condition?.Null ?? {})[0]).sort()).toEqual(['s3:if-match', 's3:if-none-match'])
    expect(text(s)).not.toMatch(/projects\/|access\/|integrations\//)
  })

  it('keeps the carrier key from the workers and the gateway: their integrations grant does not reach it', () => {
    const n = nestedOf(syn, A)
    const all = text(Object.values(n.findResources('AWS::IAM::Policy')))
    expect(all).not.toContain('order-watch')
  })
})

describe('the API', () => {
  it('reads the actuals, starts watches with conditional puts, invokes the order watch, and sets the carrier key without reading it', () => {
    const s = Object.entries(syn.parent.findResources('AWS::IAM::Policy') as Record<string, Res>).filter(([k]) => k.startsWith('ApiRuntimeRoleCostPolicy'))
      .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
    expect(text(s.filter((x) => list(x.Action).includes('s3:GetObject')).map((x) => x.Resource))).toMatch(/installation\/cost\/\*.*installation\/shipping\/\*/)
    const puts = s.filter((x) => list(x.Action).includes('s3:PutObject'))
    expect(puts.map((p) => Object.keys(p.Condition?.Null ?? {})[0]).sort()).toEqual(['s3:if-match', 's3:if-none-match'])
    for (const p of puts) expect(text(p.Resource)).not.toContain('/cost/')
    expect(s.find((x) => x.Sid === 'OrderWatchCheckNow')).toMatchObject({ Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [expect.stringMatching(/^OrderWatchFunction/), 'Arn'] } })
    const key = s.find((x) => x.Sid === 'ManageOrderWatchKey')
    expect(list(key?.Action ?? [])).not.toContain('secretsmanager:GetSecretValue')
    expect(text(key?.Resource)).toMatch(/secret:trace\/order-watch\/\*/)
  })
})

describe('cost allocation tags', () => {
  it('tags every taggable resource of a project with trace:project and trace:installation', () => {
    const n = nestedOf(syn, A).toJSON() as { Resources: Record<string, { Type: string; Properties?: { Tags?: unknown } }> }
    // the resource types that bill per project and take tags in CloudFormation
    const billed = ['AWS::BedrockAgentCore::Runtime', 'AWS::BedrockAgentCore::Memory', 'AWS::CodeBuild::Project', 'AWS::SecretsManager::Secret', 'AWS::Logs::LogGroup', 'AWS::SNS::Topic', 'AWS::Batch::JobDefinition']
    for (const [id, r] of Object.entries(n.Resources).filter(([, r]) => billed.includes(r.Type))) {
      expect(text(r.Properties?.Tags), `${id} ${r.Type}`).toContain('trace:project')
      expect(text(r.Properties?.Tags), `${id} ${r.Type}`).toContain(A)
    }
    expect(projectHash(A)).toMatch(/^[0-9a-f]{8}$/)
  })
})
