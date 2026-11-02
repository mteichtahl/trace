/**
 * The web app in the stack (web.enabled, src/infra/web.ts): its nested stack (private site bucket, the backend Lambda
 * behind a function URL, CloudFront with origin access control on both origins, security headers), and in the parent
 * the parts that name the pool (the web client, AppSync Events, the settings parameter), the pool's choice-based
 * sign-in and passkey relying party, and no dependency cycle between them.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { beforeAll, describe, expect, it } from 'vitest'
import { InfraPropsSchema, WEB_HOOKS_OUTPUTS, WEB_OUTPUTS, stackName, webConfigParameter } from '../../src/infra/props.js'
import { REPO_ROOT, TraceStack } from '../../src/infra/stack.js'
import { imageContentTag } from '../../src/infra/images.js'
import { API_FUNCTION, FORWARDED_AUTH_HEADER, HOOKS_CONCURRENCY, HOOKS_ORIGIN_HEADER, HOOKS_PATH, HOOKS_ROUTE, bundleBackend, SPA_FUNCTION, SUBSCRIBE_HANDLER, VOICE_PREFIX, contentSecurityPolicy, modelResources } from '../../src/infra/web.js'
import { RUNNERS, type Synth, synth } from './templates.js'

const base = { account: '123456789012', region: 'us-east-1', repositories: ['mteichtahl/trace'], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }
const CERT = 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000'

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource?: unknown; Condition?: unknown }
type Res = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
const statements = (t: Template, prefix: string): Statement[] => Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith(prefix))
  .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])
const only = (t: Template, type: string): Res => {
  const all = Object.values(t.findResources(type)) as Res[]
  expect(all).toHaveLength(1)
  return all[0] as Res
}

/** Simulate the SPA function (CloudFront Functions are plain ES5 here). */
const spa = (uri: string): string => (new Function(`${SPA_FUNCTION}; return handler`)() as (e: { request: { uri: string } }) => { uri: string })({ request: { uri } }).uri
const apiAuth = (headers: Record<string, { value: string }>): Record<string, { value: string }> =>
  (new Function(`${API_FUNCTION}; return handler`)() as (e: { request: { headers: Record<string, { value: string }> } }) => { headers: Record<string, { value: string }> })({ request: { headers } }).headers

let on: Synth
let web: Template
beforeAll(() => {
  on = synth(InfraPropsSchema.parse(base), stackName('trace'))
  if (!on.web) throw new Error('no web stack')
  web = on.web
}, 300_000)

describe('the web app', () => {
  it('is on by default, and a custom domain needs its certificate', () => {
    const p = InfraPropsSchema.parse(base)
    expect(p.web).toEqual({ enabled: true, dashboards: [], waf: { enabled: true, apiRequestsPer5Minutes: 1000, authRequestsPer5Minutes: 100 }, hooks: { enabled: true } })
    expect(InfraPropsSchema.safeParse({ ...base, web: { domainName: 'trace.example.com' } }).success).toBe(false)
    expect(InfraPropsSchema.safeParse({ ...base, web: { certificateArn: CERT } }).success).toBe(false)
    expect(InfraPropsSchema.safeParse({ ...base, web: { domainName: 'trace.example.com', certificateArn: CERT } }).success).toBe(true)
    // CloudFront takes certificates from us-east-1 only
    expect(InfraPropsSchema.safeParse({ ...base, web: { domainName: 'trace.example.com', certificateArn: CERT.replace('us-east-1', 'eu-west-1') } }).success).toBe(false)
    expect(InfraPropsSchema.safeParse({ ...base, web: { sesFrom: 'not an address' } }).success).toBe(false)
  })

  it('serves the app from a private, TLS-only bucket', () => {
    const buckets = Object.values(web.findResources('AWS::S3::Bucket')) as Res[]
    expect(buckets).toHaveLength(2) // the site and the voice cache
    for (const b of buckets) expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true })
    const policies = Object.values(web.findResources('AWS::S3::BucketPolicy')) as Res[]
    expect(policies).toHaveLength(2)
    for (const p of policies) expect(JSON.stringify(p.Properties)).toContain('"aws:SecureTransport":"false"')
    // the site's policy lets CloudFront (this distribution only) read
    const site = policies.map((p) => JSON.stringify(p.Properties)).find((t) => t.includes('cloudfront.amazonaws.com'))
    expect(site).toMatch(/"s3:GetObject"/)
    expect(site).toMatch(/AWS:SourceArn/)
    // the voice cache expires
    web.hasResourceProperties('AWS::S3::Bucket', { LifecycleConfiguration: { Rules: [Match.objectLike({ Prefix: `${VOICE_PREFIX}/`, ExpirationInDays: 30, Status: 'Enabled' })] } })
  })

  it('reaches both origins through origin access control', () => {
    const oacs = (Object.values(web.findResources('AWS::CloudFront::OriginAccessControl')) as Res[]).map((r) => r.Properties.OriginAccessControlConfig as { OriginAccessControlOriginType: string; SigningBehavior: string })
    expect(oacs.map((o) => o.OriginAccessControlOriginType).sort()).toEqual(['lambda', 's3'])
    for (const o of oacs) expect(o.SigningBehavior).toBe('always')
    const d = only(web, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as {
      Origins: { OriginAccessControlId?: unknown; S3OriginConfig?: { OriginAccessIdentity: string } }[]; HttpVersion: string; PriceClass: string; Aliases?: string[]
      DefaultCacheBehavior: Record<string, unknown>; CacheBehaviors: Record<string, unknown>[]; CustomErrorResponses?: unknown
    }
    // the site, the backend, and (web.hooks) GitHub's webhook's function, which alone has no origin access control: see
    // the 'GitHub's webhook' tests below
    expect(d.Origins).toHaveLength(3)
    expect(d.Origins.filter((o) => o.OriginAccessControlId !== undefined)).toHaveLength(2)
    expect(d.HttpVersion).toBe('http2and3')
    expect(d.PriceClass).toBe('PriceClass_100')
    expect(d.Aliases).toBeUndefined()
    // no error-response rewriting: /api/* 404s stay 404s
    expect(d.CustomErrorResponses).toBeUndefined()
    const api = d.CacheBehaviors.find((b) => b.PathPattern === '/api/*')
    expect(api).toMatchObject({
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'], Compress: true, ViewerProtocolPolicy: 'https-only',
      CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CachingDisabled
      OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // AllViewerExceptHostHeader
    })
    expect(d.DefaultCacheBehavior).toMatchObject({ Compress: true, ViewerProtocolPolicy: 'redirect-to-https', FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [expect.stringMatching(/^SpaRoutes/), 'FunctionARN'] } }] })
    // CloudFront may invoke the function URL, from this distribution only
    web.hasResourceProperties('AWS::Lambda::Permission', { Action: 'lambda:InvokeFunctionUrl', Principal: 'cloudfront.amazonaws.com', SourceArn: Match.anyValue() })
    web.hasResourceProperties('AWS::Lambda::Permission', { Action: 'lambda:InvokeFunction', Principal: 'cloudfront.amazonaws.com', InvokedViaFunctionUrl: true })
  })

  it('runs the backend on Node.js 22 arm64 behind an IAM function URL with response streaming, told its settings parameter (the API\'s build is in the settings, not here)', () => {
    const fn = (Object.values(web.findResources('AWS::Lambda::Function')) as Res[]).find((f) => f.Properties.FunctionName === 'trace-web')
    expect(fn?.Properties).toMatchObject({
      Runtime: 'nodejs22.x', Architectures: ['arm64'], MemorySize: 1024, Timeout: 900, Handler: 'index.handler',
      Environment: { Variables: { TRACE_WEB_CONFIG_PARAM: '/trace/web/config', NODE_OPTIONS: '--enable-source-maps' } },
    })
    const urls = (Object.values(web.findResources('AWS::Lambda::Url')) as Res[]).map((u) => u.Properties)
    expect(urls.find((u) => JSON.stringify(u.TargetFunctionArn).includes('Backend'))).toMatchObject({ AuthType: 'AWS_IAM', InvokeMode: 'RESPONSE_STREAM' })
    web.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 })
  })

  it('sends the app\'s routes to index.html and leaves files and /api alone', () => {
    expect(spa('/')).toBe('/index.html')
    expect(spa('/p/abc/journey')).toBe('/index.html')
    expect(spa('/assets/index-abc123.js')).toBe('/assets/index-abc123.js')
    expect(spa('/favicon.svg')).toBe('/favicon.svg')
    // a project's file pages end in the file's name: still the app's routes, not the site bucket (AccessDenied)
    expect(spa('/p/mteichtahl~testyyyu/files/runs/340ea235715542de/tran.raw')).toBe('/index.html')
    expect(spa('/p/abc/files/hw/test.kicad_sch')).toBe('/index.html')
    expect(spa('/view/p/abc/files/docs/requirements.md')).toBe('/index.html')
    expect(spa('/theme.js')).toBe('/theme.js')
    const fns = (Object.values(web.findResources('AWS::CloudFront::Function')) as Res[]).map((f) => f.Properties)
    expect(fns.map((f) => f.FunctionCode).sort()).toEqual([API_FUNCTION, SPA_FUNCTION].sort())
    for (const f of fns) expect(f.FunctionConfig).toMatchObject({ Runtime: 'cloudfront-js-2.0' })
    // origin access control signs in Authorization: the viewer's bearer token travels in its own header
    expect(apiAuth({ authorization: { value: 'Bearer t' }, [FORWARDED_AUTH_HEADER]: { value: 'forged' } })[FORWARDED_AUTH_HEADER]).toEqual({ value: 'Bearer t' })
    expect(apiAuth({ [FORWARDED_AUTH_HEADER]: { value: 'forged' } })[FORWARDED_AUTH_HEADER]).toBeUndefined()
  })

  it('sends strict security headers and a content security policy that allows only what the app reaches', () => {
    const h = only(web, 'AWS::CloudFront::ResponseHeadersPolicy').Properties.ResponseHeadersPolicyConfig as { SecurityHeadersConfig: Record<string, Record<string, unknown>> }
    const sec = h.SecurityHeadersConfig
    expect(sec.StrictTransportSecurity).toMatchObject({ AccessControlMaxAgeSec: 63_072_000, IncludeSubdomains: true, Preload: true, Override: true })
    expect(sec.ContentTypeOptions).toEqual({ Override: true })
    expect(sec.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true })
    expect(sec.ReferrerPolicy).toEqual({ ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true })
    const csp = JSON.stringify(sec.ContentSecurityPolicy?.ContentSecurityPolicy)
    for (const part of [
      "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "frame-ancestors 'none'", "object-src 'none'",
      'wss://transcribestreaming.us-east-1.amazonaws.com:8443', 'https://raw.githubusercontent.com https://objects.githubusercontent.com',
      'data: blob:', "worker-src 'self' blob:",
    ]) expect(csp).toContain(part)
    // the live events: that API's own two hosts, no wildcard
    expect(csp).not.toContain('*.appsync')
    expect(csp).toContain('connect-src \'self\' https://",{"Fn::GetAtt":["Events')
    expect(csp).toMatch(/"Dns\.Http"\]\}," wss:\/\/",\{"Fn::GetAtt":\["Events\w+","Dns\.Realtime"/)
    // the voice bucket's host, for the signed speech URLs
    expect(csp).toMatch(/media-src 'self' blob: https:\/\/".*Voice.*RegionalDomainName/)
    // scripts never inline, never eval
    expect(contentSecurityPolicy('us-east-1', 'v.s3.amazonaws.com', { http: 'a.appsync-api.us-east-1.amazonaws.com', realtime: 'a.appsync-realtime-api.us-east-1.amazonaws.com' })).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/)
    // and the app has no inline script for it to need: the theme script is a file
    const html = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'index.html'), 'utf8')
    expect(html).not.toMatch(/<script>(?!<)/)
    expect(html).toContain('<script src="/theme.js"></script>')
    expect(existsSync(join(import.meta.dirname, '..', '..', 'web', 'public', 'theme.js'))).toBe(true)
  })

  it('has a web client of its own: choice-based sign-in and refresh, no secret, no hosted pages', () => {
    const clients = Object.values(on.parent.findResources('AWS::Cognito::UserPoolClient')) as Res[]
    const c = clients.find((x) => x.Properties.ClientName === 'trace-web')?.Properties
    expect(c).toMatchObject({
      GenerateSecret: false, ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'], PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true,
      AccessTokenValidity: 60, IdTokenValidity: 60, RefreshTokenValidity: 43_200,
    })
    expect(c?.AllowedOAuthFlows).toBeUndefined()
    expect(c?.CallbackURLs).toBeUndefined()
    // the CLI's client is unchanged
    expect(clients.find((x) => x.Properties.ClientName === 'trace-cli')?.Properties.ExplicitAuthFlows).toEqual(['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'])
    // the API accepts both clients' tokens, and the web backend's own (web.hooks: hook.members only)
    const api = (Object.values(on.parent.findResources('AWS::BedrockAgentCore::Runtime')) as Res[]).find((r) => r.Properties.AgentRuntimeName === 'trace_api')
    expect((api?.Properties.AuthorizerConfiguration as { CustomJWTAuthorizer: { AllowedClients: unknown[] } }).CustomJWTAuthorizer.AllowedClients).toHaveLength(3)
  })

  it('offers passkeys and passwords first, with the app\'s address as relying party, and email codes only with SES', () => {
    const pool = only(on.parent, 'AWS::Cognito::UserPool').Properties
    expect((pool.Policies as { SignInPolicy: unknown }).SignInPolicy).toEqual({ AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] })
    expect(pool.WebAuthnUserVerification).toBe('preferred')
    expect(JSON.stringify(pool.WebAuthnRelyingPartyID)).toMatch(/WebStack.*DistributionDomainName|Distribution.*DomainName/)
    expect(pool.EmailConfiguration).toBeUndefined()
    expect(pool.UserPoolTier).toBe('ESSENTIALS')
    // the invitation points at the app's /invite page (the temporary password is typed there: no secret in a link), and
    // still at `tracectl login`
    const body = JSON.stringify((pool.AdminCreateUserConfig as { InviteMessageTemplate: { EmailMessage: unknown } }).InviteMessageTemplate.EmailMessage)
    expect(body).toMatch(/open https:\/\/".*\/invite and enter this email address and the temporary password/)
    expect(body).toContain('`tracectl login`')

    const ses = synth(InfraPropsSchema.parse({ ...base, web: { sesFrom: 'trace@example.com', domainName: 'trace.example.com', certificateArn: CERT } }), 'WebSes')
    const p2 = only(ses.parent, 'AWS::Cognito::UserPool').Properties
    expect((p2.Policies as { SignInPolicy: unknown }).SignInPolicy).toEqual({ AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP', 'WEB_AUTHN'] })
    expect(p2.EmailConfiguration).toMatchObject({ EmailSendingAccount: 'DEVELOPER', From: 'trace <trace@example.com>' })
    expect(p2.WebAuthnRelyingPartyID).toBe('trace.example.com')
    const d = only(ses.web ?? on.parent, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as { Aliases: string[]; ViewerCertificate: Record<string, unknown> }
    expect(d.Aliases).toEqual(['trace.example.com'])
    expect(d.ViewerCertificate).toMatchObject({ AcmCertificateArn: CERT, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' })
    expect(JSON.stringify(ses.parent.findOutputs(WEB_OUTPUTS.url))).toContain('https://trace.example.com')
    const cfg = JSON.stringify(only(ses.parent, 'AWS::SSM::Parameter').Properties.Value)
    expect(cfg).toContain('\\"email\\":true')
  }, 300_000)

  it('has live events in the web stack: the Lambda authorizer checks the id token, a person subscribes to their own channel only, IAM publishes', () => {
    const api = only(web, 'AWS::AppSync::Api').Properties
    expect(api.Name).toBe('trace-events')
    expect(api.EventConfig).toMatchObject({
      AuthProviders: [{ AuthType: 'AWS_LAMBDA', LambdaAuthorizerConfig: { AuthorizerUri: { 'Fn::GetAtt': [expect.stringMatching(/^EventsAuthorizer/), 'Arn'] }, AuthorizerResultTtlInSeconds: 60 } }, { AuthType: 'AWS_IAM' }],
      DefaultPublishAuthModes: [{ AuthType: 'AWS_IAM' }], DefaultSubscribeAuthModes: [{ AuthType: 'AWS_LAMBDA' }],
    })
    const ns = only(web, 'AWS::AppSync::ChannelNamespace').Properties
    expect(ns).toMatchObject({ Name: 'trace', CodeHandlers: SUBSCRIBE_HANDLER, PublishAuthModes: [{ AuthType: 'AWS_IAM' }], SubscribeAuthModes: [{ AuthType: 'AWS_LAMBDA' }] })
    on.parent.resourceCountIs('AWS::AppSync::Api', 0)
    // the authorizer reads the settings parameter and nothing else
    const auth = statements(web, 'EventsAuthorizerRole')
    expect(auth.flatMap(actions).sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents', 'ssm:GetParameter'])
    // the handler's rule, run against AppSync's context (the authorizer's handlerContext)
    const handler = new Function('util', `${SUBSCRIBE_HANDLER.replace(/^import .*$/m, '').replace('export function', 'function')}; return onSubscribe`)
    const check = (sub: string | undefined, path: string): boolean => {
      let refused = false
      handler({ unauthorized: () => { refused = true } })({ identity: sub ? { handlerContext: { sub } } : undefined, info: { channel: { path } } })
      return !refused
    }
    expect(check('abc', '/trace/users/abc')).toBe(true)
    expect(check('abc', '/trace/users/xyz')).toBe(false)
    expect(check('abc', '/trace/users/abc/more')).toBe(false)
    expect(check('abc', '/trace/users/*')).toBe(false)
    expect(check('abc', '/trace/projects/x')).toBe(false)
    expect(check(undefined, '/trace/users/abc')).toBe(false)
  })

  it('keeps the backend\'s settings in one SSM parameter with everything it reads', () => {
    const p = only(on.parent, 'AWS::SSM::Parameter').Properties
    expect(p.Name).toBe(webConfigParameter('trace'))
    expect(p.Type).toBe('String')
    const parts = (p.Value as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1]
    const text = parts.map((x) => (typeof x === 'string' ? x : `<${JSON.stringify(x)}>`)).join('')
    const shape = JSON.parse(text.replace(/<[^>]*>/g, 'X')) as Record<string, unknown>
    expect(shape).toEqual({
      region: 'us-east-1', prefix: 'trace', userPoolId: 'X', clientId: 'X', apiRuntimeArn: 'X', apiBuild: `${imageContentTag(REPO_ROOT)}.X`,
      events: { http: 'X', realtime: 'X', apiId: 'X' }, voiceBucket: 'X', voicePrefix: VOICE_PREFIX,
      dashboards: ['trace-agents'], model: 'us.anthropic.claude-sonnet-4-6', appUrl: 'https://X',
      features: { passkeys: true, email: false, voice: true, ops: true },
      waf: { enabled: true, own: false, apiRequestsPer5Minutes: 1000, authRequestsPer5Minutes: 100 },
      hooks: { secret: 'trace/web/github-hooks', clientSecret: 'trace/web/hooks-client', tokenUrl: 'https://X.auth.us-east-1.amazoncognito.com/oauth2/token', clientId: 'X', scope: 'trace-internal/members', table: 'X' },
    })
    // the web client, not the CLI's; the events' host names, no scheme
    expect(text).toMatch(/"clientId":"<\{"Ref":"UsersWeb/)
    expect(text).toMatch(/"http":"<\{"Fn::GetAtt":\["WebWebStack\w+","Outputs\.\w*Events\w*DnsHttp"\]\}>"/)
    expect(text).toMatch(/"realtime":"<\{"Fn::GetAtt":\["WebWebStack\w+","Outputs\.\w*Events\w*DnsRealtime"\]\}>"/)
  })

  it('gives the backend exactly what it needs: nothing of the access store, any project, or Cognito', () => {
    const all = statements(web, 'BackendRole')
    expect(all.flatMap(actions).sort()).toEqual([
      'appsync:EventPublish', 'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:DescribeAlarms', 'cloudwatch:GetDashboard', 'cloudwatch:GetMetricData',
      'logs:CreateLogStream', 'logs:PutLogEvents', 'polly:DescribeVoices', 'polly:SynthesizeSpeech', 's3:GetObject', 's3:ListBucket', 's3:PutObject', 'ssm:GetParameter',
      'transcribe:StartStreamTranscriptionWebSocket',
    ])
    const text = JSON.stringify(all)
    for (const never of ['cognito', '/access/', '/projects/', '/central/', 'secretsmanager', 'bedrock-agentcore', 'iam:', 's3:DeleteObject']) expect(text).not.toContain(never)
    const by = (sid: string): Statement | undefined => all.find((s) => s.Sid === sid)
    expect(by('WebConfig')?.Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:us-east-1:123456789012:parameter/trace/web/config']] })
    expect(JSON.stringify(by('VoiceCache')?.Resource)).toContain(`/${VOICE_PREFIX}/*`)
    expect(by('VoiceCacheList')?.Condition).toEqual({ StringLike: { 's3:prefix': [`${VOICE_PREFIX}/*`] } })
    expect(JSON.stringify(by('OpsDashboards')?.Resource)).toContain(':cloudwatch::123456789012:dashboard/trace-agents')
    // the configured model only: the profile in this account, and the foundation model it routes to
    const model = JSON.stringify(by('ChatModel')?.Resource)
    expect(model).toContain(':bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6')
    expect(model).toContain(':bedrock:*::foundation-model/anthropic.claude-sonnet-4-6')
    expect(model).not.toMatch(/anthropic\.\*|inference-profile\/\*/)
    expect(JSON.stringify(by('PublishLiveEvents')?.Resource)).toMatch(/Events\w+","ApiArn"\]\},"\/channelNamespace\/trace"/)
  })

  it('turns the agents\' facts and job index writes into live events: the bucket\'s events, one rule, a Lambda that reads only who is on the project and that object', () => {
    // the central bucket sends its object events to EventBridge (the bucket's own property: no custom resource)
    const central = Object.entries(on.parent.findResources('AWS::S3::Bucket')).find(([id]) => id.startsWith('Central'))?.[1] as Res
    expect(central.Properties.NotificationConfiguration).toEqual({ EventBridgeConfiguration: { EventBridgeEnabled: true } })
    on.parent.resourceCountIs('Custom::S3BucketNotifications', 0)
    // the rule: Object Created of the agents' facts objects in that bucket only (not the journey record: the backend
    // publishes people's writes, so they are not sent twice)
    const rule = only(web, 'AWS::Events::Rule').Properties as { Name: string; EventPattern: unknown; Targets: { Arn: unknown; RetryPolicy: unknown }[] }
    expect(rule.Name).toBe('trace-journey-events')
    expect(rule.EventPattern).toEqual({
      source: ['aws.s3'], 'detail-type': ['Object Created'],
      detail: { bucket: { name: [{ Ref: expect.stringMatching(/Central/) }] }, object: { key: [{ wildcard: 'projects/*/journey-agent/facts.db' }, { wildcard: 'projects/*/journey-agent/bench.db' }, { wildcard: 'projects/*/journey-agent/jobs.db' }] } },
    })
    expect(rule.Targets).toEqual([expect.objectContaining({ Arn: { 'Fn::GetAtt': [expect.stringMatching(/^JourneyEvents[0-9A-F]{8}$/), 'Arn'] }, RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 } })])
    web.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'trace-journey-events', Handler: 'journey-events.handler', Runtime: 'nodejs22.x', Architectures: ['arm64'],
      Environment: { Variables: Match.objectLike({ TRACE_CENTRAL_BUCKET: { Ref: Match.stringLikeRegexp('Central') }, TRACE_EVENTS_HTTP: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Events'), 'Dns.Http'] } }) },
    })
    // its role: read access/* and the agents' facts objects, publish to the namespace, its log group. Nothing else
    const all = statements(web, 'JourneyEventsRole')
    expect(all.flatMap(actions).sort()).toEqual(['appsync:EventPublish', 'logs:CreateLogStream', 'logs:PutLogEvents', 's3:GetObject', 's3:GetObject', 's3:GetObject', 's3:ListBucket'])
    const by = (sid: string): Statement | undefined => all.find((x) => x.Sid === sid)
    expect(JSON.stringify(by('AccessStoreRead')?.Resource)).toMatch(/"\/access\/\*"/)
    expect(by('AccessStoreList')?.Condition).toEqual({ StringLike: { 's3:prefix': ['access/*'] } })
    expect(JSON.stringify(by('AgentFactsRead')?.Resource)).toMatch(/"\/projects\/\*\/journey-agent\/facts\.db"/)
    // and the job index that changed (job.updated): that one object of each project
    expect(JSON.stringify(by('JobIndexRead')?.Resource)).toMatch(/"\/projects\/\*\/journey-agent\/jobs\.db"/)
    expect(JSON.stringify(by('PublishLiveEvents')?.Resource)).toMatch(/Events\w+","ApiArn"\]\},"\/channelNamespace\/trace"/)
    const text = JSON.stringify(all)
    for (const never of ['s3:PutObject', 's3:DeleteObject', '/central/', '/journey/', '/chats/', 'cognito', 'bedrock', 'ssm:']) expect(text).not.toContain(never)
  })

  it('scopes the chat model to the configured model, and attaches a given WAF web ACL', () => {
    const o = { partition: 'aws', region: 'eu-west-1', account: '111122223333' }
    expect(modelResources('global.anthropic.claude-sonnet-4-5-20250929-v1:0', o)).toEqual([
      'arn:aws:bedrock:eu-west-1:111122223333:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
    ])
    expect(modelResources('eu.anthropic.claude-x', { ...o, regions: ['eu-west-1', 'eu-central-1'] })).toEqual([
      'arn:aws:bedrock:eu-west-1:111122223333:inference-profile/eu.anthropic.claude-x',
      'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-x', 'arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-x',
    ])
    expect(modelResources('anthropic.claude-x', o)).toEqual(['arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-x'])
    const acl = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/trace-web/00000000-0000-0000-0000-000000000000'
    expect(InfraPropsSchema.safeParse({ ...base, web: { webAclArn: acl.replace('us-east-1', 'eu-west-1') } }).success).toBe(false)
    const w = synth(InfraPropsSchema.parse({ ...base, web: { webAclArn: acl } }), 'WebWaf')
    expect((only(w.web!, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as { WebACLId: string }).WebACLId).toBe(acl)
    // without one of the person's own: this installation's (base is in us-east-1, so made in the web app's stack)
    expect((only(web, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as { WebACLId?: unknown }).WebACLId).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^WafAcl/), 'Arn'] })
    // and with the WAF off, none
    const off = synth(InfraPropsSchema.parse({ ...base, web: { waf: { enabled: false } } }), 'WebNoWaf')
    expect((only(off.web!, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as { WebACLId?: string }).WebACLId).toBeUndefined()
    off.web!.resourceCountIs('AWS::WAFv2::WebACL', 0)
  }, 300_000)

  it('outputs the address, the distribution, the events endpoint and the web client', () => {
    for (const o of Object.values(WEB_OUTPUTS)) expect(Object.keys(on.parent.findOutputs(o))).toEqual([o])
    expect(JSON.stringify(on.parent.findOutputs(WEB_OUTPUTS.url))).toMatch(/https:\/\/.*DomainName/)
  })

  it('names the API\'s build and runtime version in the settings, written after the runtime, so no session starts on the old version', () => {
    const value = (Object.values(on.parent.findResources('AWS::SSM::Parameter')) as Res[]).map((r) => JSON.stringify(r.Properties.Value)).find((v) => v.includes('apiRuntimeArn')) ?? ''
    expect(value).toContain(imageContentTag(REPO_ROOT))
    expect(value).toContain('AgentRuntimeVersion')
  })

  it('makes no dependency cycle, and nothing in the web stack names the pool', () => {
    // a cycle would make synthesis (and Template.fromStack) throw; check the full app synthesizes
    const app = new App()
    const s = new TraceStack(app, 'CycleCheck', InfraPropsSchema.parse(base))
    expect(() => app.synth()).not.toThrow()
    const nested = s.node.findAll().find((c) => c instanceof Stack && c !== s && c.node.id === 'WebStack') as Stack | undefined
    expect(nested).toBeDefined()
    const t = JSON.stringify(Template.fromStack(nested as Stack).toJSON())
    expect(t).not.toMatch(/Users[0-9A-F]{8}|UserPool|ApiRuntime/)
    // the parent gives the web stack the central bucket only (its agents' facts become live events): it names nothing
    // else of the parent's, and nothing in the parent names the web stack's resources but its outputs' consumers
    const webRes = Object.entries(on.parent.findResources('AWS::CloudFormation::Stack')).find(([id]) => id.startsWith('WebWebStack'))?.[1] as Res | undefined
    expect(webRes).toBeDefined()
    expect(Object.values(webRes?.Properties.Parameters as Record<string, unknown>)).toEqual([{ 'Fn::GetAtt': [expect.stringMatching(/^Central/), 'Arn'] }, { Ref: expect.stringMatching(/^Central/) }])
  }, 300_000)

  it('bundles the backend with src/web/bundle.ts bundleWebBackend(root, out), and says when it is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'trace-web-root-'))
    const out = mkdtempSync(join(tmpdir(), 'trace-web-out-'))
    try {
      expect(() => bundleBackend(root, out)).toThrow(/bundler is missing.*TRACE_WEB_SKIP_BUNDLE/)
      mkdirSync(join(root, 'src', 'web'), { recursive: true })
      writeFileSync(join(root, 'src', 'web', 'bundle.ts'), "import { writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nexport function bundleWebBackend(root: string, out: string): void { writeFileSync(join(out, 'index.mjs'), '// from ' + root) }\n")
      bundleBackend(root, out)
      expect(readFileSync(join(out, 'index.mjs'), 'utf8')).toContain(root)
      // the compiled bundler wins when there is one (an installed trace)
      mkdirSync(join(root, 'dist', 'web'), { recursive: true })
      writeFileSync(join(root, 'dist', 'web', 'bundle.js'), "import { writeFileSync } from 'node:fs'\nexport function bundleWebBackend(root, out) { writeFileSync(out + '/index.mjs', '// compiled') }\n")
      bundleBackend(root, out)
      expect(readFileSync(join(out, 'index.mjs'), 'utf8')).toBe('// compiled')
    } finally {
      for (const d of [root, out]) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    }
  })

  it('can be turned off: nothing of it, and the pool as before', () => {
    const off = synth(InfraPropsSchema.parse({ ...base, web: { enabled: false } }), 'WebOff')
    expect(off.web).toBeNull()
    for (const r of ['AWS::AppSync::Api', 'AWS::SSM::Parameter', 'AWS::CloudFront::Distribution']) off.parent.resourceCountIs(r, 0)
    expect(off.web).toBeNull()
    const pool = only(off.parent, 'AWS::Cognito::UserPool').Properties
    expect(pool.WebAuthnRelyingPartyID).toBeUndefined()
    expect((pool.Policies as Record<string, unknown>).SignInPolicy).toBeUndefined()
    expect(JSON.stringify(pool.AdminCreateUserConfig)).toContain('Sign in with `tracectl login`.')
    expect(off.parent.findOutputs(WEB_OUTPUTS.url)).toEqual({})
  }, 300_000)
})

describe('GitHub\'s webhook (web.hooks)', () => {
  it('has a function of its own on /api/hooks/*, ahead of /api/*, reached without origin access control, passing every header and the body', () => {
    const d = only(web, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as { Origins: { Id: string; OriginAccessControlId?: unknown; CustomOriginConfig?: Record<string, unknown> }[]; CacheBehaviors: Record<string, unknown>[] }
    expect(d.CacheBehaviors.map((b) => b.PathPattern)).toEqual([HOOKS_PATH, '/api/*'])
    const hooks = d.CacheBehaviors[0]!
    expect(hooks).toMatchObject({
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'], ViewerProtocolPolicy: 'https-only',
      CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CachingDisabled
      OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // AllViewerExceptHostHeader: X-Hub-Signature-256, X-GitHub-Event
    })
    // no viewer-request function: the delivery reaches the function as GitHub sent it
    expect(hooks.FunctionAssociations).toBeUndefined()
    const origin = d.Origins.find((o) => o.Id === hooks.TargetOriginId)
    expect(origin?.OriginAccessControlId).toBeUndefined()
    expect(origin?.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'https-only' })
    // CloudFront adds the stack's random value; the function is given the same, and drops requests without it
    const header = (origin as { OriginCustomHeaders?: { HeaderName: string; HeaderValue: unknown }[] }).OriginCustomHeaders
    expect(header?.map((h) => h.HeaderName)).toEqual([HOOKS_ORIGIN_HEADER])
    expect(JSON.stringify(header?.[0]?.HeaderValue)).toMatch(/resolve:secretsmanager:.*HooksOrigin/)
    web.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'trace/web/hooks-origin', GenerateSecretString: Match.objectLike({ PasswordLength: 48, ExcludePunctuation: true }) })
    const fn = (Object.values(web.findResources('AWS::Lambda::Function')) as Res[]).find((f) => f.Properties.FunctionName === 'trace-web-hooks')
    expect(fn?.Properties).toMatchObject({ Runtime: 'nodejs22.x', Architectures: ['arm64'], Handler: 'hooks.handler', Timeout: 60, ReservedConcurrentExecutions: HOOKS_CONCURRENCY, Environment: { Variables: { TRACE_WEB_CONFIG_PARAM: '/trace/web/config' } } })
    expect(HOOKS_CONCURRENCY).toBe(10)
    expect(JSON.stringify((fn?.Properties.Environment as { Variables: Record<string, unknown> }).Variables.TRACE_HOOKS_ORIGIN)).toMatch(/resolve:secretsmanager:.*HooksOrigin/)
    const urls = (Object.values(web.findResources('AWS::Lambda::Url')) as Res[]).map((u) => u.Properties)
    expect(urls.find((u) => JSON.stringify(u.TargetFunctionArn).includes('Hooks'))).toMatchObject({ AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM' })
  })

  it('gives its function only its settings, the hooks secret (read), its debounce table and publishing; the backend gains nothing', () => {
    const all = statements(web, 'HooksRole')
    expect(all.flatMap(actions).sort()).toEqual(['appsync:EventPublish', 'dynamodb:UpdateItem', 'logs:CreateLogStream', 'logs:PutLogEvents', 'secretsmanager:GetSecretValue', 'ssm:GetParameter'])
    const by = (sid: string): Statement | undefined => all.find((s) => s.Sid === sid)
    expect(JSON.stringify(by('HooksSecret')?.Resource)).toContain(':secretsmanager:us-east-1:123456789012:secret:trace/web/github-hooks-??????')
    expect(JSON.stringify(by('HooksSecret')?.Resource)).toContain(':secretsmanager:us-east-1:123456789012:secret:trace/web/hooks-client-??????')
    expect(JSON.stringify(by('HooksDebounce')?.Resource)).toMatch(/HooksDebounce\w+","Arn"/)
    const text = JSON.stringify(all)
    for (const never of ['cognito', '/access/', '/projects/', 'bedrock', 's3:']) expect(text).not.toContain(never)
    web.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'trace-web-hooks', BillingMode: 'PAY_PER_REQUEST', TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } })
  })

  it('gives the backend its own client: client credentials with one scope of its own, and the API runtime lists it', () => {
    const clients = Object.values(on.parent.findResources('AWS::Cognito::UserPoolClient')) as Res[]
    const c = clients.find((x) => x.Properties.ClientName === 'trace-web-hooks')?.Properties
    expect(c).toMatchObject({ GenerateSecret: true, AllowedOAuthFlows: ['client_credentials'], AllowedOAuthFlowsUserPoolClient: true, AccessTokenValidity: 60 })
    // no sign-in flow of a person's (Cognito's defaults, SRP and custom, would apply were it left out)
    expect(c?.ExplicitAuthFlows).toEqual(['ALLOW_REFRESH_TOKEN_AUTH'])
    expect(JSON.stringify(c?.AllowedOAuthScopes)).toContain('/members')
    on.parent.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', { Identifier: 'trace-internal', Scopes: [Match.objectLike({ ScopeName: 'members' })] })
    const api = (Object.values(on.parent.findResources('AWS::BedrockAgentCore::Runtime')) as Res[]).find((r) => r.Properties.AgentRuntimeName === 'trace_api')
    expect(JSON.stringify((api?.Properties.EnvironmentVariables as Record<string, unknown>).TRACE_COGNITO_HOOKS_CLIENT_ID)).toMatch(/UsersWebHooks/)
    expect(Object.keys(on.parent.findOutputs(WEB_HOOKS_OUTPUTS.address))).toEqual([WEB_HOOKS_OUTPUTS.address])
    expect(JSON.stringify(on.parent.findOutputs(WEB_HOOKS_OUTPUTS.address))).toContain(HOOKS_ROUTE)
  })

  it('can be turned off: no function, no behaviour, no client, no hooks in the settings', () => {
    const off = synth(InfraPropsSchema.parse({ ...base, web: { hooks: { enabled: false } } }), 'HooksOff')
    const d = only(off.web!, 'AWS::CloudFront::Distribution').Properties.DistributionConfig as { CacheBehaviors: Record<string, unknown>[] }
    expect(d.CacheBehaviors.map((b) => b.PathPattern)).toEqual(['/api/*'])
    expect((Object.values(off.web!.findResources('AWS::Lambda::Function')) as Res[]).some((f) => f.Properties.FunctionName === 'trace-web-hooks')).toBe(false)
    expect((Object.values(off.parent.findResources('AWS::Cognito::UserPoolClient')) as Res[]).some((x) => x.Properties.ClientName === 'trace-web-hooks')).toBe(false)
    expect(JSON.stringify(only(off.parent, 'AWS::SSM::Parameter').Properties.Value)).not.toContain('github-hooks')
  }, 300_000)
})
