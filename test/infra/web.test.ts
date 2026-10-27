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
import { InfraPropsSchema, WEB_OUTPUTS, stackName, webConfigParameter } from '../../src/infra/props.js'
import { TraceStack } from '../../src/infra/stack.js'
import { API_FUNCTION, FORWARDED_AUTH_HEADER, bundleBackend, SPA_FUNCTION, SUBSCRIBE_HANDLER, VOICE_PREFIX, contentSecurityPolicy } from '../../src/infra/web.js'
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
    expect(p.web).toEqual({ enabled: true, dashboards: [] })
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
    expect(d.Origins).toHaveLength(2)
    for (const o of d.Origins) expect(o.OriginAccessControlId).toBeDefined()
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

  it('runs the backend on Node.js 22 arm64 behind an IAM function URL with response streaming, told only its settings parameter', () => {
    const fn = (Object.values(web.findResources('AWS::Lambda::Function')) as Res[]).find((f) => f.Properties.FunctionName === 'trace-web')
    expect(fn?.Properties).toMatchObject({
      Runtime: 'nodejs22.x', Architectures: ['arm64'], MemorySize: 1024, Timeout: 900, Handler: 'index.handler',
      Environment: { Variables: { TRACE_WEB_CONFIG_PARAM: '/trace/web/config', NODE_OPTIONS: '--enable-source-maps' } },
    })
    expect(only(web, 'AWS::Lambda::Url').Properties).toMatchObject({ AuthType: 'AWS_IAM', InvokeMode: 'RESPONSE_STREAM' })
    web.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 })
  })

  it('sends the app\'s routes to index.html and leaves files and /api alone', () => {
    expect(spa('/')).toBe('/index.html')
    expect(spa('/p/abc/journey')).toBe('/index.html')
    expect(spa('/assets/index-abc123.js')).toBe('/assets/index-abc123.js')
    expect(spa('/favicon.svg')).toBe('/favicon.svg')
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
      'https://*.appsync-api.us-east-1.amazonaws.com', 'wss://*.appsync-realtime-api.us-east-1.amazonaws.com', 'wss://transcribestreaming.us-east-1.amazonaws.com:8443',
      'data: blob:', "worker-src 'self' blob:",
    ]) expect(csp).toContain(part)
    // the voice bucket's host, for the signed speech URLs
    expect(csp).toMatch(/media-src 'self' blob: https:\/\/".*Voice.*RegionalDomainName/)
    // scripts never inline, never eval
    expect(contentSecurityPolicy('us-east-1', 'v.s3.amazonaws.com')).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/)
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
    // the API accepts both clients' tokens
    const api = (Object.values(on.parent.findResources('AWS::BedrockAgentCore::Runtime')) as Res[]).find((r) => r.Properties.AgentRuntimeName === 'trace_api')
    expect((api?.Properties.AuthorizerConfiguration as { CustomJWTAuthorizer: { AllowedClients: unknown[] } }).CustomJWTAuthorizer.AllowedClients).toHaveLength(2)
  })

  it('offers passkeys and passwords first, with the app\'s address as relying party, and email codes only with SES', () => {
    const pool = only(on.parent, 'AWS::Cognito::UserPool').Properties
    expect((pool.Policies as { SignInPolicy: unknown }).SignInPolicy).toEqual({ AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] })
    expect(pool.WebAuthnUserVerification).toBe('preferred')
    expect(JSON.stringify(pool.WebAuthnRelyingPartyID)).toMatch(/WebStack.*DistributionDomainName|Distribution.*DomainName/)
    expect(pool.EmailConfiguration).toBeUndefined()
    expect(pool.UserPoolTier).toBe('ESSENTIALS')
    // the invitation points at the app's /invite page (the temporary password is typed there: no secret in a link), and
    // still at `trace login`
    const body = JSON.stringify((pool.AdminCreateUserConfig as { InviteMessageTemplate: { EmailMessage: unknown } }).InviteMessageTemplate.EmailMessage)
    expect(body).toMatch(/open https:\/\/".*\/invite and enter this email address and the temporary password/)
    expect(body).toContain('`trace login`')

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

  it('has live events: the pool\'s tokens subscribe to their own channel only, IAM publishes', () => {
    const api = only(on.parent, 'AWS::AppSync::Api').Properties
    expect(api.Name).toBe('trace-events')
    expect(api.EventConfig).toMatchObject({
      AuthProviders: [{ AuthType: 'AMAZON_COGNITO_USER_POOLS', CognitoConfig: { UserPoolId: { Ref: expect.stringMatching(/^Users[0-9A-F]{8}$/) } } }, { AuthType: 'AWS_IAM' }],
      DefaultPublishAuthModes: [{ AuthType: 'AWS_IAM' }], DefaultSubscribeAuthModes: [{ AuthType: 'AMAZON_COGNITO_USER_POOLS' }],
    })
    const ns = only(on.parent, 'AWS::AppSync::ChannelNamespace').Properties
    expect(ns).toMatchObject({ Name: 'trace', CodeHandlers: SUBSCRIBE_HANDLER, PublishAuthModes: [{ AuthType: 'AWS_IAM' }], SubscribeAuthModes: [{ AuthType: 'AMAZON_COGNITO_USER_POOLS' }] })
    // the handler's rule, run against AppSync's context
    const handler = new Function('util', `${SUBSCRIBE_HANDLER.replace(/^import .*$/m, '').replace('export function', 'function')}; return onSubscribe`)
    const check = (sub: string | undefined, path: string): boolean => {
      let refused = false
      handler({ unauthorized: () => { refused = true } })({ identity: sub ? { sub } : undefined, info: { channel: { path } } })
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
      region: 'us-east-1', prefix: 'trace', userPoolId: 'X', clientId: 'X', apiRuntimeArn: 'X',
      events: { http: 'X', realtime: 'X', apiId: 'X' }, voiceBucket: 'X', voicePrefix: VOICE_PREFIX,
      dashboards: ['trace-agents'], model: 'us.anthropic.claude-sonnet-4-6', appUrl: 'https://X',
      features: { passkeys: true, email: false, voice: true, ops: true },
    })
    // the web client, not the CLI's; the events' host names, no scheme
    expect(text).toMatch(/"clientId":"<\{"Ref":"UsersWeb/)
    expect(text).toMatch(/"http":"<\{"Fn::GetAtt":\["WebEvents\w+","Dns.Http"\]\}>"/)
    expect(text).toMatch(/"realtime":"<\{"Fn::GetAtt":\["WebEvents\w+","Dns.Realtime"\]\}>"/)
  })

  it('gives the backend exactly what it needs: nothing of the access store, any project, or Cognito', () => {
    const own = statements(web, 'BackendRole')
    const publish = statements(on.parent, 'WebBackendPublish')
    const all = [...own, ...publish]
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
    expect(JSON.stringify(by('ChatModel')?.Resource)).toMatch(/bedrock:\*::foundation-model\/anthropic\.\*.*inference-profile\/\*/)
    expect(JSON.stringify(by('PublishLiveEvents')?.Resource)).toMatch(/WebEvents\w+","ApiArn"\]\},"\/channelNamespace\/trace"/)
  })

  it('outputs the address, the distribution, the events endpoint and the web client', () => {
    for (const o of Object.values(WEB_OUTPUTS)) expect(Object.keys(on.parent.findOutputs(o))).toEqual([o])
    expect(JSON.stringify(on.parent.findOutputs(WEB_OUTPUTS.url))).toMatch(/https:\/\/.*DomainName/)
  })

  it('makes no dependency cycle, and nothing in the web stack names the pool', () => {
    // a cycle would make synthesis (and Template.fromStack) throw; check the full app synthesizes
    const app = new App()
    const s = new TraceStack(app, 'CycleCheck', InfraPropsSchema.parse(base))
    expect(() => app.synth()).not.toThrow()
    const nested = s.node.findAll().find((c) => c instanceof Stack && c !== s && c.node.id === 'WebStack') as Stack | undefined
    expect(nested).toBeDefined()
    const t = JSON.stringify(Template.fromStack(nested as Stack).toJSON())
    expect(t).not.toMatch(/Users[0-9A-F]{8}|UserPool|ApiRuntime|WebEvents/)
    // the parent gives the web stack no parameters: it names nothing of the parent's
    const res = Object.values(on.parent.findResources('AWS::CloudFormation::Stack')) as Res[]
    const webRes = res.find((r) => JSON.stringify(r).includes('WebStack') || !r.Properties.Parameters)
    expect(webRes?.Properties.Parameters).toBeUndefined()
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
    const pool = only(off.parent, 'AWS::Cognito::UserPool').Properties
    expect(pool.WebAuthnRelyingPartyID).toBeUndefined()
    expect((pool.Policies as Record<string, unknown>).SignInPolicy).toBeUndefined()
    expect(JSON.stringify(pool.AdminCreateUserConfig)).toContain('Sign in with `trace login`.')
    expect(off.parent.findOutputs(WEB_OUTPUTS.url)).toEqual({})
  }, 300_000)
})
