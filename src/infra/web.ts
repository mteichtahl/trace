/**
 * The web app (web.enabled; README "Web app", docs/web-build.md): one address for the browser, in two parts so that
 * nothing points back at the user pool that points at the address (the passkey relying party):
 *
 *   WebStack (nested)  what the address is made of, none of it naming the pool:
 *     site bucket      the static app (web/dist, built when the stack is synthesized), private (block public access,
 *                      TLS only), reached by CloudFront through origin access control; index.html and the other
 *                      unhashed files no-cache, assets/* (Vite's hashed files) immutable
 *     backend          src/web/lambda.ts, bundled by src/web/bundle.ts bundleWebBackend: Node.js 22 on arm64, 1 GB,
 *                      15 minutes (a chat streams), a function URL with AWS_IAM auth and response streaming. Its
 *                      environment holds only the name of its settings parameter (TRACE_WEB_CONFIG_PARAM)
 *     voice bucket     Polly's speech, kept 30 days under web/voice/ (a replay costs nothing), private
 *     distribution     CloudFront: /* the site bucket (a viewer-request function sends every path without a dot to
 *                      /index.html, so the app's routes load and /api's 404s stay real); /api/* the backend's function
 *                      URL (origin access control, no caching, every viewer header but Host, every method). Strict
 *                      security headers and a content security policy on both. HTTP/2 and HTTP/3, price class 100,
 *                      CloudFront's own address or web.domainName with its certificate
 *     backend role     its settings parameter (by name), Polly, Transcribe streaming, its voice prefix, CloudWatch
 *                      dashboards and metrics (read), the chat model (that model or inference profile only, and the
 *                      foundation models a profile routes to), publishing live events, its own log group. Nothing of
 *                      the access store, any project's data, or Cognito's admin API: per project, it goes through the
 *                      API runtime
 *     events           AppSync Events `<prefix>-events`: connect and subscribe with a Lambda authorizer
 *                      (src/web/events-auth.ts) that checks the app's Cognito id token against the settings parameter,
 *                      so the API names nothing of the pool and lives here; publish with IAM (the backend's role only);
 *                      namespace `trace`, whose onSubscribe handler allows /trace/users/<sub> to that <sub> alone
 *     journey events   `<prefix>-journey-events` (src/web/journey-events.ts) and its EventBridge rule: the central
 *                      bucket's "Object Created" events of each project's journey-agent/facts.db (an agent recorded a fact)
 *                      become `record.changed` (and `notification` for a new question or stuck report) on the channels
 *                      of the people on that project. Its role reads access/* and the agents' facts objects (S3 Get
 *                      only), and publishes to the namespace; nothing else
 *     content policy   names the events API's own two hosts, Transcribe streaming and the voice bucket; scripts only
 *                      from the app (the theme script is web/public/theme.js, not inline)
 *     WAF              web.webAclArn (a WAFv2 web ACL of CLOUDFRONT scope, made in us-east-1) attached when given: rate
 *                      limits per address belong there, since this stack's region is rarely us-east-1. The backend's
 *                      own per-person limit (src/web/agui.ts) is a soft one
 *   in the parent      what names the pool (TraceWeb.attach):
 *     app client       `<prefix>-web`: choice-based sign-in (USER_AUTH) and refresh, no secret
 *     settings         the SSM parameter `/<prefix>/web/config` (webConfigParameter): the JSON the backend reads
 *
 * The pool itself (src/infra/stack.ts) takes this construct's `domain` as its passkey relying party and offers
 * passkeys and passwords first (email codes too with web.sesFrom: Cognito sends them only through SES).
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AssetHashType, CfnOutput, DockerImage, Duration, NestedStack, RemovalPolicy, Stack } from 'aws-cdk-lib'
import * as appsync from 'aws-cdk-lib/aws-appsync'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'
import { AGENT_FACTS_DB, AGENT_FACTS_FOLDER } from '../core/agent-facts.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { ACCESS_PREFIX } from './project.js'
import { agentsDashboardName } from './observability.js'
import { type InfraProps, WEB_OUTPUTS, webConfigParameter, webModel } from './props.js'

/** The backend's voice cache, in the voice bucket of its own (docs/web-build.md /api/voice/speak). */
export const VOICE_PREFIX = 'voice'
/** The live events' namespace and each person's channel in it: /trace/users/<sub>. */
export const EVENTS_NAMESPACE = 'trace'
/** The header the /api/* viewer-request function copies the viewer's Authorization into: origin access control signs
 * the request to the function URL in Authorization, overwriting the viewer's bearer token. */
export const FORWARDED_AUTH_HEADER = 'x-trace-authorization'
/** Skip building the app and bundling the backend (tests; a synth without web/ or src/web/): a placeholder of each. */
export const SKIP_BUNDLE_ENV = 'TRACE_WEB_SKIP_BUNDLE'
/** Days Polly's speech is kept in the voice bucket. */
export const VOICE_DAYS = 30
/** CloudFront's wait for the backend between bytes (seconds): within the default origin response timeout quota. A
 * streamed chat must send something (an SSE comment) at least this often. */
export const API_READ_TIMEOUT_SECONDS = 60

/** The live events' onSubscribe handler (APPSYNC_JS): a person may subscribe to /trace/users/<their own sub> only. The
 * sub is the Lambda authorizer's (src/web/events-auth.ts, handlerContext.sub), which checked the id token. */
export const SUBSCRIBE_HANDLER = `import { util } from '@aws-appsync/utils'

export function onSubscribe(ctx) {
  const sub = ctx.identity && ctx.identity.handlerContext && ctx.identity.handlerContext.sub
  const segments = ctx.info.channel.path.split('/').filter((s) => s.length > 0)
  if (!sub || segments.length !== 3 || segments[0] !== '${EVENTS_NAMESPACE}' || segments[1] !== 'users' || segments[2] !== sub) {
    util.unauthorized()
  }
}
`

/** The default behaviour's viewer-request function: a path whose last segment has no dot is one of the app's routes. */
export const SPA_FUNCTION = `function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (last.indexOf('.') === -1) request.uri = '/index.html';
  return request;
}
`

/** The /api/* viewer-request function: the viewer's bearer token moves to FORWARDED_AUTH_HEADER (a viewer's own value of
 * that header is dropped), because origin access control signs in Authorization. */
export const API_FUNCTION = `function handler(event) {
  var request = event.request;
  var headers = request.headers;
  delete headers['${FORWARDED_AUTH_HEADER}'];
  if (headers.authorization) headers['${FORWARDED_AUTH_HEADER}'] = { value: headers.authorization.value };
  return request;
}
`

/**
 * The content security policy: the app's own files, the live events (that API's two hosts exactly), Transcribe
 * streaming, the voice bucket's signed URLs, data: and blob: for images and workers, WebAssembly for PDF.js and Shiki,
 * and inline styles only. Large repository files are fetched from GitHub's own short-lived links (files.url): its two
 * download hosts are allowed for connect only, never for scripts.
 */
export const GITHUB_DOWNLOAD_HOSTS = ['https://raw.githubusercontent.com', 'https://objects.githubusercontent.com']
export function contentSecurityPolicy(region: string, voiceHost: string, events: { http: string; realtime: string }): string {
  const live = [`https://${events.http}`, `wss://${events.realtime}`]
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://${voiceHost}`,
    "font-src 'self' data:",
    `media-src 'self' blob: https://${voiceHost}`,
    `connect-src 'self' ${live.join(' ')} wss://transcribestreaming.${region}.amazonaws.com:8443 https://${voiceHost} ${GITHUB_DOWNLOAD_HOSTS.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')
}

const run = (cmd: string, args: string[], cwd: string): void => {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} (${r.status ?? r.signal}): ${(r.stderr || r.stdout || r.error?.message || '').slice(-2000)}`)
}

/** Build the app (web/, its own package.json and lockfile) in a copy without node_modules and dist, and put web/dist in
 * `out`: the site bucket's contents. */
export function buildWebApp(root: string, out: string): void {
  const src = join(root, 'web')
  const work = mkdtempSync(join(tmpdir(), 'trace-web-'))
  try {
    cpSync(src, work, { recursive: true, filter: (f) => !/(^|[\\/])(node_modules|dist)([\\/]|$)/.test(relative(src, f)) })
    run('npm', ['ci', '--no-audit', '--no-fund'], work)
    run('npm', ['run', 'build'], work)
    cpSync(join(work, 'dist'), out, { recursive: true })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Bundle the backend into `out` (index.mjs, exporting `handler`) with src/web/bundle.ts bundleWebBackend(root, out):
 * the compiled dist/web/bundle.js when there is one (an installed trace), else the source, in a child process so that
 * an asynchronous bundler works inside CDK's synchronous tryBundle. */
export function bundleBackend(root: string, out: string): void {
  const built = join(root, 'dist', 'web', 'bundle.js')
  const mod = existsSync(built) ? built : join(root, 'src', 'web', 'bundle.ts')
  if (!existsSync(mod)) throw new Error(`the web backend's bundler is missing (${mod}): run \`npm run build\`, or set ${SKIP_BUNDLE_ENV}=1 to synthesize without it`)
  const script = `const m = await import(${JSON.stringify(pathToFileURL(mod).href)}); await m.bundleWebBackend(${JSON.stringify(root)}, ${JSON.stringify(out)})`
  const flags = mod.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings'] : []
  run(process.execPath, [...flags, '--input-type=module', '-e', script], root)
  if (!existsSync(join(out, 'index.mjs'))) throw new Error(`bundleWebBackend wrote no index.mjs into ${out}`)
}

/** A directory holding one placeholder file (SKIP_BUNDLE_ENV). */
function placeholder(file: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'trace-web-placeholder-'))
  writeFileSync(join(dir, file), text)
  return dir
}

export interface WebStackProps {
  prefix: string
  /** the repository root (web/ and src/ are built from it) */
  root: string
  settings: InfraProps['web']
  /** the chat model (webModel) */
  model: string
  /** the CloudWatch dashboards the Operations page may read */
  dashboards: readonly string[]
  /** keep the site bucket when the stack is deleted (retainData) */
  retainData: boolean
  /** the Bedrock regions a global or cross-region inference profile may route the chat model to (default: all) */
  modelRegions?: readonly string[]
  /** build the app and bundle the backend; false: a placeholder of each (default: unless SKIP_BUNDLE_ENV is 1) */
  bundle?: boolean
  /** the central bucket (the parent's): its agents' facts writes become live events (JourneyEvents). Absent: none */
  central?: s3.IBucket | undefined
}

/** What the address is made of (see the file's comment). Names nothing of the parent's. */
export class WebStack extends NestedStack {
  readonly siteBucket: s3.Bucket
  readonly voiceBucket: s3.Bucket
  readonly backend: lambda.Function
  readonly backendRole: iam.Role
  readonly functionUrl: lambda.FunctionUrl
  readonly distribution: cloudfront.Distribution
  readonly events: appsync.EventApi
  readonly authorizer: lambda.Function
  /** `<prefix>-journey-events`: the agents' facts written → live events (with `central` only) */
  readonly journeyEvents: lambda.Function | null = null
  /** the app's host name: web.domainName, else CloudFront's */
  readonly domain: string
  readonly contentSecurityPolicy: string

  constructor(scope: Construct, id: string, p: WebStackProps) {
    super(scope, id, { description: 'trace: the web app (static site, backend Lambda, CloudFront)' })
    const { region, account, partition } = Stack.of(this)
    const keep = p.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY
    const bundle = p.bundle ?? process.env[SKIP_BUNDLE_ENV] !== '1'

    // ------------------------------------------------------------------ buckets
    this.siteBucket = new s3.Bucket(this, 'Site', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: keep,
      autoDeleteObjects: !p.retainData,
    })
    this.voiceBucket = new s3.Bucket(this, 'Voice', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // a cache: nothing in it is kept anywhere else, and nothing in it is needed
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ prefix: `${VOICE_PREFIX}/`, expiration: Duration.days(VOICE_DAYS) }],
      // the app may fetch the speech it was handed a signed URL for (the signature is the access)
      cors: [{ allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD], allowedOrigins: ['*'], maxAge: 3600 }],
    })

    // ------------------------------------------------------------------ the backend
    this.backendRole = new iam.Role(this, 'BackendRole', {
      roleName: `${p.prefix}-web-${region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'The trace web app\'s backend: its settings, Polly, Transcribe, its voice cache, CloudWatch (read), the chat model; per project, only through the API runtime',
    })
    const role = this.backendRole
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WebConfig', actions: ['ssm:GetParameter'],
      resources: [`arn:${partition}:ssm:${region}:${account}:parameter${webConfigParameter(p.prefix)}`],
    }))
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Speech', actions: ['polly:DescribeVoices', 'polly:SynthesizeSpeech'], resources: ['*'] }))
    // the browser streams to the signed URL the backend hands it: signed for this action (no resource type, so "*"); it
    // may name a project's custom vocabulary, which needs nothing more of this role (src/infra/voice.ts)
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Transcription', actions: ['transcribe:StartStreamTranscriptionWebSocket'], resources: ['*'] }))
    role.addToPolicy(new iam.PolicyStatement({ sid: 'VoiceCache', actions: ['s3:GetObject', 's3:PutObject'], resources: [this.voiceBucket.arnForObjects(`${VOICE_PREFIX}/*`)] }))
    // a cache miss is a 404, not a 403, only with ListBucket
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'VoiceCacheList', actions: ['s3:ListBucket'], resources: [this.voiceBucket.bucketArn], conditions: { StringLike: { 's3:prefix': [`${VOICE_PREFIX}/*`] } },
    }))
    // no resource-level permissions exist for these two; dashboards are read by name below
    role.addToPolicy(new iam.PolicyStatement({ sid: 'OpsRead', actions: ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'], resources: ['*'] }))
    if (p.dashboards.length) {
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'OpsDashboards', actions: ['cloudwatch:GetDashboard'], resources: p.dashboards.map((d) => `arn:${partition}:cloudwatch::${account}:dashboard/${d}`),
      }))
    }
    // the chat model: that model or inference profile, and the foundation model a profile routes to (in any region it
    // may route to); a model change is a stack update
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ChatModel', actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: modelResources(p.model, { partition, region, account, regions: p.modelRegions }),
    }))
    const logGroup = new logs.LogGroup(this, 'BackendLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    logGroup.grantWrite(role)

    const code = bundle
      ? lambda.Code.fromAsset(join(p.root, 'src', 'web'), {
          assetHashType: AssetHashType.OUTPUT,
          bundling: {
            image: DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs22.x'),
            local: { tryBundle: (out) => { bundleBackend(p.root, out); return true } },
          },
        })
      : lambda.Code.fromAsset(placeholder('index.mjs', 'export const handler = async () => ({ statusCode: 503, body: \'the web backend was not bundled\' })\n'))
    this.backend = new lambda.Function(this, 'Backend', {
      functionName: `${p.prefix}-web`,
      description: 'trace: the web app\'s backend (src/web/lambda.ts): sign-in, API calls, chat, voice, operations',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code,
      role,
      memorySize: 1024,
      timeout: Duration.minutes(15),
      logGroup,
      environment: { TRACE_WEB_CONFIG_PARAM: webConfigParameter(p.prefix), NODE_OPTIONS: '--enable-source-maps' },
    })
    this.functionUrl = this.backend.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, invokeMode: lambda.InvokeMode.RESPONSE_STREAM })

    // ------------------------------------------------------------------ live events
    // Lambda authorization (the app's id token, checked against the settings parameter) so the API names nothing of
    // the pool: it lives here, and the content security policy can name its hosts
    const authRole = new iam.Role(this, 'EventsAuthorizerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'The trace live events\' authorizer: reads the web app\'s settings parameter, nothing else',
    })
    authRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WebConfig', actions: ['ssm:GetParameter'], resources: [`arn:${partition}:ssm:${region}:${account}:parameter${webConfigParameter(p.prefix)}`],
    }))
    const authLogs = new logs.LogGroup(this, 'EventsAuthorizerLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    authLogs.grantWrite(authRole)
    this.authorizer = new lambda.Function(this, 'EventsAuthorizer', {
      functionName: `${p.prefix}-events-auth`,
      description: 'trace: the live events\' authorizer (src/web/events-auth.ts): a person subscribes to their own channel only',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'authorizer.handler',
      code: bundle ? code : lambda.Code.fromAsset(placeholder('authorizer.mjs', 'export const handler = async () => ({ isAuthorized: false })\n')),
      role: authRole,
      memorySize: 256,
      timeout: Duration.seconds(5),
      logGroup: authLogs,
      environment: { TRACE_WEB_CONFIG_PARAM: webConfigParameter(p.prefix) },
    })
    this.events = new appsync.EventApi(this, 'Events', {
      apiName: `${p.prefix}-events`,
      authorizationConfig: {
        authProviders: [
          { authorizationType: appsync.AppSyncAuthorizationType.LAMBDA, lambdaAuthorizerConfig: { handler: this.authorizer, resultsCacheTtl: Duration.seconds(60) } },
          { authorizationType: appsync.AppSyncAuthorizationType.IAM },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA, appsync.AppSyncAuthorizationType.IAM],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
      },
    })
    this.events.addChannelNamespace('Namespace', {
      channelNamespaceName: EVENTS_NAMESPACE,
      code: appsync.Code.fromInline(SUBSCRIBE_HANDLER),
      authorizationConfig: {
        publishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        subscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
      },
    })
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'PublishLiveEvents', actions: ['appsync:EventPublish'], resources: [`${this.events.apiArn}/channelNamespace/${EVENTS_NAMESPACE}`],
    }))

    // ------------------------------------------------------------------ the agents' facts, as live events
    // src/web/journey-events.ts: an agent's write of projects/<slug>/journey-agent/facts.db reaches no backend, so the
    // bucket's own "Object Created" event (EventBridge, src/infra/stack.ts) does. The journey record itself is not
    // matched: people change it through the API, and the backend publishes those (src/web/call.ts)
    if (p.central) this.journeyEvents = this.addJourneyEvents(p, p.central, code, bundle)

    // ------------------------------------------------------------------ the static app
    const site = bundle
      ? deploy.Source.asset(join(p.root, 'web'), {
          assetHashType: AssetHashType.SOURCE,
          exclude: ['node_modules', 'dist'],
          bundling: {
            image: DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs22.x'),
            command: ['bash', '-c', 'cp -r /asset-input /tmp/web && cd /tmp/web && rm -rf node_modules dist && npm ci --no-audit --no-fund && npm run build && cp -r dist/. /asset-output/'],
            local: { tryBundle: (out) => { buildWebApp(p.root, out); return true } },
          },
        })
      : deploy.Source.asset(placeholder('index.html', '<!doctype html><title>trace</title><p>The web app was not built.</p>\n'))

    // ------------------------------------------------------------------ CloudFront
    this.contentSecurityPolicy = contentSecurityPolicy(region, this.voiceBucket.bucketRegionalDomainName, { http: this.events.httpDns, realtime: this.events.realtimeDns })
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${p.prefix}-web-security`,
      comment: 'trace web app: strict security headers and its content security policy',
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(730), includeSubdomains: true, preload: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: this.contentSecurityPolicy, override: true },
      },
    })
    const spa = new cloudfront.Function(this, 'SpaRoutes', {
      comment: 'trace web app: paths without a dot are the app\'s routes (index.html)',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(SPA_FUNCTION),
    })
    const apiAuth = new cloudfront.Function(this, 'ApiAuth', {
      comment: `trace web app: the viewer's Authorization to ${FORWARDED_AUTH_HEADER} (origin access control signs in Authorization)`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(API_FUNCTION),
    })
    const custom = p.settings.domainName && p.settings.certificateArn
      ? { domainNames: [p.settings.domainName], certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', p.settings.certificateArn) }
      : {}
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `trace web app (${p.prefix})`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...custom,
      ...(p.settings.webAclArn ? { webAclId: p.settings.webAclArn } : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [{ function: spa, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(this.functionUrl, { readTimeout: Duration.seconds(API_READ_TIMEOUT_SECONDS) }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
          compress: true,
          functionAssociations: [{ function: apiAuth, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        },
      },
    })
    this.domain = p.settings.domainName ?? this.distribution.distributionDomainName

    // Vite's hashed files never change under their name; everything else (index.html, the icons, the manifest) is
    // asked for again each time. Neither prunes: a page loaded before a deploy still finds its assets
    new deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [site], destinationBucket: this.siteBucket, prune: false, memoryLimit: 512,
      exclude: ['*'], include: ['assets/*'],
      cacheControl: [deploy.CacheControl.setPublic(), deploy.CacheControl.maxAge(Duration.days(365)), deploy.CacheControl.immutable()],
    })
    new deploy.BucketDeployment(this, 'DeployPages', {
      sources: [site], destinationBucket: this.siteBucket, prune: false, memoryLimit: 512,
      exclude: ['assets/*'],
      cacheControl: [deploy.CacheControl.noCache()],
      distribution: this.distribution, distributionPaths: ['/', '/index.html'],
    })
  }

  /** The Lambda `<prefix>-journey-events` and the rule that sends it the agents' facts writes (see the file's comment). */
  private addJourneyEvents(p: WebStackProps, central: s3.IBucket, code: lambda.Code, bundle: boolean): lambda.Function {
    const fnRole = new iam.Role(this, 'JourneyEventsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'trace: live events for the agents\' facts: reads the access store and the facts that changed, publishes live events',
    })
    // who is on the project: the access store, read only (S3 answers a missing object 404 only with ListBucket there)
    fnRole.addToPolicy(new iam.PolicyStatement({ sid: 'AccessStoreRead', actions: ['s3:GetObject'], resources: [central.arnForObjects(`${ACCESS_PREFIX}/*`)] }))
    fnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AccessStoreList', actions: ['s3:ListBucket'], resources: [central.bucketArn], conditions: { StringLike: { 's3:prefix': [`${ACCESS_PREFIX}/*`] } },
    }))
    // the facts object that changed (a new question or stuck report is told apart from a check), nothing else of a project
    fnRole.addToPolicy(new iam.PolicyStatement({ sid: 'AgentFactsRead', actions: ['s3:GetObject'], resources: [central.arnForObjects(AGENT_FACTS_KEYS)] }))
    fnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PublishLiveEvents', actions: ['appsync:EventPublish'], resources: [`${this.events.apiArn}/channelNamespace/${EVENTS_NAMESPACE}`],
    }))
    const fnLogs = new logs.LogGroup(this, 'JourneyEventsLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    fnLogs.grantWrite(fnRole)
    const fn = new lambda.Function(this, 'JourneyEvents', {
      functionName: `${p.prefix}-journey-events`,
      description: 'trace: an agent recorded a journey fact; tells the people on the project (src/web/journey-events.ts)',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'journey-events.handler',
      code: bundle ? code : lambda.Code.fromAsset(placeholder('journey-events.mjs', 'export const handler = async () => undefined\n')),
      role: fnRole,
      memorySize: 512,
      timeout: Duration.seconds(30),
      logGroup: fnLogs,
      environment: {
        TRACE_CENTRAL_BUCKET: central.bucketName,
        TRACE_EVENTS_HTTP: this.events.httpDns,
        // the access store's read copy is cached in the one writable folder
        XDG_CACHE_HOME: '/tmp',
        NODE_OPTIONS: '--enable-source-maps',
      },
    })
    const rule = new events.Rule(this, 'JourneyEventsRule', {
      ruleName: `${p.prefix}-journey-events`,
      description: 'trace: the agents\' journey facts written in the central bucket, to live events',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [central.bucketName] }, object: { key: events.Match.wildcard(AGENT_FACTS_KEYS) } },
      },
    })
    rule.addTarget(new targets.LambdaFunction(fn, { retryAttempts: 2, maxEventAge: Duration.hours(1) }))
    return fn
  }
}

export interface TraceWebProps extends WebStackProps {}

/** The agents' facts objects, as the JourneyEvents rule matches them (EventBridge wildcard). */
export const AGENT_FACTS_KEYS = `${PROJECTS_PREFIX}/*/${AGENT_FACTS_FOLDER}/${AGENT_FACTS_DB}`

/** What attach needs of the parent: the pool and the web client, the API runtime, and the parent's outputs' stack. */
export interface WebAttachProps {
  pool: cognito.IUserPool
  client: cognito.UserPoolClient
  apiRuntimeArn: string
  /** whether email one-time codes are a first factor (web.sesFrom) */
  email: boolean
}

/** The web app's settings as the backend reads them (src/web/, from TRACE_WEB_CONFIG_PARAM). */
export interface WebConfig {
  region: string
  prefix: string
  userPoolId: string
  clientId: string
  apiRuntimeArn: string
  /** host names, without a scheme */
  events: { http: string; realtime: string; apiId: string }
  voiceBucket: string
  voicePrefix: string
  dashboards: string[]
  model: string
  appUrl: string
  features: { passkeys: boolean; email: boolean; voice: boolean; ops: boolean }
}

/** What a person may write of their own Cognito profile through an app client: their email alone (a required
 * attribute must be writable), and a change to it waits for verification (the pool's keepOriginal). */
export const SELF_WRITABLE = new cognito.ClientAttributes().withStandardAttributes({ email: true })

/** The web app's app client of the pool: our own sign-in pages (USER_AUTH: passkeys, email codes, passwords) and
 * refresh, no secret; tokens as the CLI's. Refresh-token rotation stays off (sign-out revokes). */
export function addWebClient(pool: cognito.UserPool, prefix: string): cognito.UserPoolClient {
  return pool.addClient('Web', {
    userPoolClientName: `${prefix}-web`,
    generateSecret: false,
    authFlows: { user: true },
    writeAttributes: SELF_WRITABLE,
    // no hosted pages, no redirects: the app's own pages only
    disableOAuth: true,
    preventUserExistenceErrors: true,
    enableTokenRevocation: true,
    accessTokenValidity: Duration.hours(1),
    idTokenValidity: Duration.hours(1),
    refreshTokenValidity: Duration.days(30),
  })
}

/**
 * The web app: its nested stack (made here, so its address is known before the pool), then attach() in the parent
 * once the pool, its web client and the API runtime exist.
 */
export class TraceWeb extends Construct {
  readonly stack: WebStack
  /** the app's host name (the pool's passkey relying party) */
  readonly domain: string
  readonly url: string
  config: ssm.StringParameter | null = null
  private readonly p: TraceWebProps

  constructor(scope: Construct, id: string, p: TraceWebProps) {
    super(scope, id)
    this.p = p
    this.stack = new WebStack(this, 'WebStack', p)
    this.domain = this.stack.domain
    this.url = `https://${this.domain}`
  }

  attach(a: WebAttachProps): void {
    const parent = Stack.of(this)
    const { region } = parent
    void a.pool

    // ------------------------------------------------------------------ the backend's settings
    const config: WebConfig = {
      region,
      prefix: this.p.prefix,
      userPoolId: a.pool.userPoolId,
      clientId: a.client.userPoolClientId,
      apiRuntimeArn: a.apiRuntimeArn,
      events: { http: this.stack.events.httpDns, realtime: this.stack.events.realtimeDns, apiId: this.stack.events.apiId },
      voiceBucket: this.stack.voiceBucket.bucketName,
      voicePrefix: VOICE_PREFIX,
      dashboards: [...this.p.dashboards],
      model: this.p.model,
      appUrl: this.url,
      features: { passkeys: true, email: a.email, voice: true, ops: true },
    }
    this.config = new ssm.StringParameter(this, 'Config', {
      parameterName: webConfigParameter(this.p.prefix),
      description: 'trace web app: the settings its backend reads (no secrets)',
      stringValue: parent.toJsonString(config),
    })

    new CfnOutput(parent, WEB_OUTPUTS.url, { value: this.url, description: 'The web app: the address people sign in at' })
    new CfnOutput(parent, WEB_OUTPUTS.distributionId, { value: this.stack.distribution.distributionId, description: 'The web app\'s CloudFront distribution' })
    new CfnOutput(parent, WEB_OUTPUTS.eventsEndpoint, { value: `https://${this.stack.events.httpDns}/event`, description: 'The live events\' HTTP endpoint (AppSync Events)' })
    new CfnOutput(parent, WEB_OUTPUTS.clientId, { value: a.client.userPoolClientId, description: 'The web app\'s Cognito app client' })
  }
}

/** The dashboards the Operations page may read: the agents' (when there is one) and web.dashboards. */
export function webDashboards(cfg: Pick<InfraProps, 'prefix' | 'observability' | 'web'>): string[] {
  const own = cfg.observability.enabled && cfg.observability.dashboard ? [agentsDashboardName(cfg.prefix)] : []
  return [...new Set([...own, ...cfg.web.dashboards])]
}

/**
 * The resources the chat model is invoked on: the model id as given (a foundation model, or an inference profile in
 * this account), and for a profile (`global.`, `us.`, `eu.`, `apac.` …) the foundation model it routes to, in the
 * regions it may route to (`regions`, default all: a global profile may route anywhere).
 */
export function modelResources(model: string, o: { partition: string; region: string; account: string; regions?: readonly string[] | undefined }): string[] {
  if (model.startsWith('arn:')) return [model]
  const profile = /^(global|us|eu|apac|us-gov|ca|jp|au)\.(.+)$/.exec(model)
  const where = (o.regions?.length ? o.regions : ['*'])
  if (!profile) return [`arn:${o.partition}:bedrock:${o.region}::foundation-model/${model}`]
  const base = profile[2] as string
  return [
    `arn:${o.partition}:bedrock:${o.region}:${o.account}:inference-profile/${model}`,
    ...where.map((r) => `arn:${o.partition}:bedrock:${r}::foundation-model/${base}`),
  ]
}

/** The props of TraceWeb from the stack's settings. */
export const traceWebProps = (cfg: InfraProps, root: string): TraceWebProps => ({
  prefix: cfg.prefix, root, settings: cfg.web, model: webModel(cfg), dashboards: webDashboards(cfg), retainData: cfg.retainData,
  ...(cfg.web.modelRegions ? { modelRegions: cfg.web.modelRegions } : {}),
})
