/**
 * The API runtime: what people do with their projects (TRACE_AGENT_MODE=api), on Bedrock AgentCore Runtime.
 *
 *   GET  /ping          {"status": "Healthy"}
 *   POST /invocations   { action, ...args } with `Authorization: Bearer <Cognito access token>`
 *                       → 200 { ok: true, result } | 200 { ok: false, error }
 *                       → 401 { ok: false, error }  no token, or one that does not verify
 *                       → 403 { ok: false, error: "no access" }  the project is not yours (or does not exist), or
 *                         the action needs admin
 *
 * AgentCore has already validated the token (customJwtAuthorizer) and forwards the Authorization header; it is
 * verified again here (jwt.ts) before anything else. This is the one runtime that spans projects (the shared GitHub
 * token, every project's memory's records, InvokeAgentRuntime on every project's worker), and everything it does for
 * a project follows the access check. It runs no model, no agent and no tool: tasks and tool calls go to the
 * project's worker (src/api/workers.ts). Every request is logged as one JSON line: who, action, repo,
 * outcome, duration. Tokens are never logged.
 *
 * The same server is the external runtime (TRACE_AGENT_MODE=external, docs/external-access.md), for connected
 * systems: `startExternal` gives it the connected systems' verifier (src/api/service-auth.ts) in place of the people's,
 * a per-system soft limit (10 requests a second, bursting to 20, per container: over it, 429 with Retry-After), and
 * last_used in place of `seen`. perform applies the systems' allow-list (src/api/service-policy.ts) for any service
 * principal, wherever it comes from. Who is logged as service:<name>.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { z } from 'zod'
import { projectMemoriesFromEnv } from '../agents/runtime/memory.js'
import { AccessDenied, type Principal, isService, seen, touchLastUsed, who } from '../core/access.js'
import { ConfigError } from '../core/config.js'
import { ToolError } from '../core/registry.js'
import { ATTR, type Attrs, type Outcome, type Span, flush, personHash, setAttrs } from '../core/telemetry.js'
import { observeInvocation } from '../agents/runtime/observe.js'
import { ActionError, type ActionDeps, NO_ACCESS, defaultScratch, perform, projectKbsFromEnv } from './actions.js'
import { type CognitoAdmin, HttpCognito, githubToken } from './aws.js'
import { HttpGitHub } from './github.js'
import { AuthError, Verifier, bearer } from './jwt.js'
import { externalFromEnv } from './actions-services.js'
import { ServiceVerifier } from './service-auth.js'
import { parseWorkerRuntimes, remoteJobs } from './workers.js'

const MAX_BODY = 2 * 1024 * 1024

const Body = z.object({ action: z.string().min(1).max(64) }).catchall(z.unknown())

export interface ServerOptions {
  /** the people's verifier (the CLI's and the web app's app clients) */
  verifier?: Verifier
  /** who a token is, in place of the people's verifier (the external runtime: connected systems); throws AuthError */
  principal?: (token: string) => Promise<Principal>
  deps: ActionDeps
  /** Email for a sub when the token has none (AdminGetUser), cached by the caller. */
  emailOf?: (sub: string, username: string | undefined) => Promise<string | null>
  log?: (line: Record<string, unknown>) => void
  /** a per-caller soft limit: over it, 429 with Retry-After (the external runtime's) */
  limiter?: RateLimiter
  /** the runtime's name in telemetry */
  runtime?: 'api' | 'external'
}

/**
 * A token bucket per caller (by sub), in this container only: `rate` requests a second, bursting to `burst`. A soft
 * limit: it keeps one busy system from crowding out the rest, not a quota.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  constructor(private readonly rate = 10, private readonly burst = 20, private readonly now: () => number = Date.now) {}

  /** 0 when the call may go ahead (and it is counted), else the seconds to wait. */
  take(key: string): number {
    const t = this.now()
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate)
    b.at = t
    this.buckets.set(key, b)
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value as string)
    if (b.tokens >= 1) { b.tokens -= 1; return 0 }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.rate))
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
    size += b.length
    if (size > MAX_BODY) throw new ActionError('the body is larger than 2 MB')
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function handler(o: ServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const log = o.log ?? ((l) => { process.stdout.write(`${JSON.stringify(l)}\n`) })
  const seenOnce = new Set<string>()
  const emails = new Map<string, string | null>()

  const principalOf = async (token: string): Promise<Principal> => {
    if (o.principal) return o.principal(token)
    if (!o.verifier) throw new AuthError('no verifier')
    const c = await o.verifier.verify(token)
    let email: string | null = c.username && c.username.includes('@') ? c.username : null
    if (!email && o.emailOf) {
      if (!emails.has(c.sub)) emails.set(c.sub, await o.emailOf(c.sub, c.username).catch(() => null))
      email = emails.get(c.sub) ?? null
    }
    return { sub: c.sub, email, groups: c['cognito:groups'] ?? [] }
  }

  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/ping') return send(res, 200, { status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) })
    if (req.method !== 'POST' || path !== '/invocations') return send(res, 404, { ok: false, error: 'not found' })
    const t0 = Date.now()
    const entry: Record<string, unknown> = { at: new Date(t0).toISOString(), who: null, action: null, repo: null }
    let obs: { span: Span; outcome: (o: Outcome, more?: Attrs) => void } | null = null
    const done = (status: number, body: { ok: boolean; result?: unknown; error?: string }, outcome: string, headers?: Record<string, string>): void => {
      log({ ...entry, outcome, status, ms: Date.now() - t0, ...(body.ok ? {} : { error: body.error }) })
      obs?.outcome(apiOutcome(outcome), {
        [ATTR.status]: status,
        ...(typeof entry.action === 'string' ? { [ATTR.action]: entry.action } : {}),
        ...(typeof entry.repo === 'string' ? { [ATTR.repository]: entry.repo } : {}),
      })
      send(res, status, body, headers)
    }
    // One span per request, continuing the caller's trace with the AgentCore session in baggage (src/agents/runtime/observe.ts).
    void observeInvocation(o.runtime ?? 'api', req.headers, {}, async (span, outcome) => {
      obs = { span, outcome }
      let principal: Principal
      try {
        const token = bearer(req.headers.authorization)
        if (!token) throw new AuthError('missing bearer token')
        principal = await principalOf(token)
      } catch (e) {
        return done(401, { ok: false, error: e instanceof AuthError ? `not signed in: ${e.message}` : 'not signed in' }, 'unauthenticated')
      }
      entry.who = who(principal)
      // who, as a hash (never the email), and their class
      if (obs) setAttrs(obs.span, { [ATTR.principal]: personHash(principal.sub), [ATTR.principalClass]: principal.groups.join(',') })
      if (isService(principal)) {
        // a connected system: when it last called (at most once a minute), never the people's table
        void touchLastUsed(principal.sub)
      } else if (!seenOnce.has(principal.sub)) {
        seenOnce.add(principal.sub)
        seen(principal).catch((e: unknown) => { log({ ...entry, warning: `seen: ${message(e)}` }) })
      }
      const wait = o.limiter?.take(principal.sub) ?? 0
      if (wait > 0) return done(429, { ok: false, error: `too many requests: try again in ${wait} s` }, 'limited', { 'retry-after': String(wait) })
      let body: z.output<typeof Body>
      try {
        const text = await readBody(req)
        const parsed = Body.safeParse(JSON.parse(text || '{}'))
        if (!parsed.success) throw new ActionError('expected {"action": "...", ...args}')
        body = parsed.data
      } catch (e) {
        return done(200, { ok: false, error: e instanceof ActionError ? e.message : 'the body is not JSON' }, 'bad-request')
      }
      const { action, ...args } = body
      entry.action = action
      if (typeof args.repo === 'string') entry.repo = args.repo.toLowerCase()
      try {
        // a held call (job, tools.waits) stops holding the worker when its caller goes away
        const left = new AbortController()
        res.once('close', () => { if (!res.writableFinished) left.abort(new Error('the caller went away')) })
        const r = await perform(action, args, { principal, deps: o.deps, signal: left.signal })
        if (r.repo) entry.repo = r.repo
        return done(200, { ok: true, result: r.result }, 'ok')
      } catch (e) {
        if (e instanceof AccessDenied) return done(403, { ok: false, error: NO_ACCESS }, `denied: ${e.message}`)
        if (e instanceof ActionError || e instanceof ToolError || e instanceof ConfigError || e instanceof z.ZodError) {
          return done(200, { ok: false, error: message(e) }, 'error')
        }
        return done(200, { ok: false, error: `internal error: ${message(e)}` }, 'failed')
      }
    }).catch(() => undefined)
  }
}

/** The request log's outcome as a telemetry outcome. */
function apiOutcome(o: string): Outcome {
  if (o === 'ok') return 'ok'
  if (o === 'unauthenticated' || o.startsWith('denied')) return 'denied'
  if (o === 'bad-request' || o === 'limited') return 'rejected'
  return 'error'
}

export function listen(o: ServerOptions, port = 8080, host = '0.0.0.0'): Promise<Server> {
  const server = createServer(handler(o))
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, () => ok(server))
  })
}

const Env = z.object({
  AWS_REGION: z.string().min(1),
  TRACE_COGNITO_POOL_ID: z.string().min(1),
  TRACE_COGNITO_CLIENT_ID: z.string().min(1),
  /** The web app's client (src/infra/web.ts): its people's tokens are accepted too. */
  TRACE_COGNITO_WEB_CLIENT_ID: z.string().optional(),
  TRACE_COGNITO_ISSUER: z.string().url(),
  TRACE_GITHUB_SECRET_ARN: z.string().min(1),
  TRACE_AWS_ACCOUNT: z.string().regex(/^\d{12}$/),
  TRACE_WORKER_RUNTIMES: z.string().default(''),
  PORT: z.coerce.number().int().default(8080),
})

/** The API runtime's dependencies from its environment (the people's runtime and the external one share them). */
async function depsFromEnv(env: z.output<typeof Env>): Promise<{ deps: ActionDeps; cog: () => CognitoAdmin }> {
  const { allTools } = await import('../tools/index.js')
  let cognito: CognitoAdmin | null = null
  const cog = (): CognitoAdmin => (cognito ??= new HttpCognito({ region: env.AWS_REGION, poolId: env.TRACE_COGNITO_POOL_ID }))
  const scratch = defaultScratch()
  const token = (): Promise<string> => githubToken(env.TRACE_GITHUB_SECRET_ARN)
  const jobs = remoteJobs({ runtimes: parseWorkerRuntimes(env.TRACE_WORKER_RUNTIMES), region: env.AWS_REGION, account: env.TRACE_AWS_ACCOUNT })
  const deps: ActionDeps = {
    github: async () => new HttpGitHub(await token()),
    cognito: cog,
    jobs: async () => jobs,
    tools: () => allTools(),
    memory: () => projectMemoriesFromEnv(process.env),
    kbs: () => projectKbsFromEnv(process.env),
    retrieve: async () => (await import('../tools/kb/search.js')).awsRetrieve(process.env.AWS_REGION),
    ...(process.env.TRACE_PREFIX ? { installationPrefix: process.env.TRACE_PREFIX } : {}),
    vocabularies: async () => (await import('./actions-voice.js')).awsVocabularies(process.env.AWS_REGION),
    ...(process.env.TRACE_INTEGRATIONS_PREFIX ? {
      integrations: async () => {
        const { IntegrationStore, secretsManagerApi } = await import('../core/integrations.js')
        const prefix = (process.env.TRACE_INTEGRATIONS_PREFIX ?? '').replace(/\/integrations\/$/, '')
        return new IntegrationStore(prefix, await secretsManagerApi({ region: env.AWS_REGION }))
      },
    } : {}),
    scratch,
    // order.check_now: the order watch Lambda, invoked for one order (src/infra/order-watch.ts)
    ...(process.env.TRACE_ORDER_WATCH ? {
      orderWatch: async (repo: string, orderId: string) => {
        const l = await import('@aws-sdk/client-lambda')
        const out = await new l.LambdaClient({ region: env.AWS_REGION }).send(new l.InvokeCommand({ FunctionName: process.env.TRACE_ORDER_WATCH, Payload: new TextEncoder().encode(JSON.stringify({ repo, orderId })) }))
        if (out.FunctionError) throw new Error(`the order watch failed: ${out.FunctionError}`)
      },
    } : {}),
    // projects.create: the installer's onboarding (src/installer/onboard-api.ts) with this runtime's GitHub token; git
    // is in the image (the agents' image), and the token reaches it only through git's environment
    onboard: async (repo, o) => {
      const [{ onboardViaApi }, { Github }] = await Promise.all([import('../installer/onboard-api.js'), import('../installer/github.js')])
      const t = await token()
      const { data } = await new Github(t).request('GET', '/user', z.object({ login: z.string() }).loose())
      return onboardViaApi(repo, { token: t, login: data.login, apply: o.apply, create: o.create })
    },
    // connected systems' addresses (services.*): null when external access is off
    external: externalFromEnv(process.env),
  }
  return { deps, cog }
}

function stopOnSignal(server: Server): void {
  const stop = (): void => { server.close(); void flush().finally(() => process.exit(0)) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

/** The API runtime's entry (src/agents/runtime/main.ts, TRACE_AGENT_MODE=api). */
export async function start(): Promise<void> {
  const env = Env.parse(process.env)
  const { deps, cog } = await depsFromEnv(env)
  const server = await listen({
    verifier: new Verifier({ issuer: env.TRACE_COGNITO_ISSUER, clientId: [env.TRACE_COGNITO_CLIENT_ID, ...(env.TRACE_COGNITO_WEB_CLIENT_ID ? [env.TRACE_COGNITO_WEB_CLIENT_ID] : [])] }),
    deps,
    emailOf: async (sub, username) => (await cog().getUser(username ?? sub))?.email ?? null,
  }, env.PORT)
  process.stdout.write(`trace api listening on 0.0.0.0:${env.PORT}\n`)
  stopOnSignal(server)
}

/**
 * The external runtime's entry (TRACE_AGENT_MODE=external): the same server and actions, for connected systems only.
 * It reads the API runtime's environment, plus TRACE_EXTERNAL_RESOURCE_SERVER (default trace-external). A person's
 * token is refused (it has a username); the people's client ids are not used here.
 */
export async function startExternal(): Promise<void> {
  const env = Env.parse(process.env)
  const { deps } = await depsFromEnv(env)
  const services = new ServiceVerifier({
    verifier: new Verifier({ issuer: env.TRACE_COGNITO_ISSUER, clientId: [], anyClient: true }),
    resourceServer: process.env.TRACE_EXTERNAL_RESOURCE_SERVER,
  })
  // a system never manages systems, but the external runtime has no addresses of its own to give either
  const server = await listen({ principal: (t) => services.principal(t), deps: { ...deps, external: null }, limiter: new RateLimiter(10, 20), runtime: 'external' }, env.PORT)
  process.stdout.write(`trace external api listening on 0.0.0.0:${env.PORT}\n`)
  stopOnSignal(server)
}
