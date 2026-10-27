/**
 * `trace install`: a local web page that collects what installing trace needs, checks each answer as it is given,
 * shows the plan, then runs it and streams progress.
 *
 * Local only, and guarded:
 *   - it listens on 127.0.0.1 and refuses requests whose Host is not localhost (no DNS rebinding);
 *   - every request carries the one-time key printed in the URL (the page sends it as a header), so another local
 *     process or browser tab can't drive it;
 *   - the one wait it cannot hear the end of (the GPU image build: AWS cannot send this computer its events) is a
 *     timer; the page shows when it checks next and can ask for a check now (POST /api/check-now);
 *   - secrets typed into the page stay in this process's memory: they are written only to AWS Secrets Manager and
 *     to GitHub (encrypted with the repository's key), and are never sent back to the page or saved to disk.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'
import { answers as savedAnswers, installation } from '../core/client.js'
import { checkNow } from '../core/wait.js'
import { stackName } from '../infra/props.js'
import { REPO_ROOT } from '../infra/stack.js'
import { IntegrationNameSchema, checkIntegration, valuesFor } from '../core/integrations.js'
import { type Answers, AnswersSchema, AwsAnswers, type InstallEvent, SecretsSchema } from './answers.js'
import { type Hooks, apply, changesSince, plan, timeline } from './bootstrap.js'
import { checkAws, credentials, profiles } from './aws.js'
import { DEFAULT_REGION } from './derive.js'
import { FixRequest, fix } from './fix.js'
import { canConfigure, checkToken } from './github.js'
import { traceRepository } from './source.js'
import { page } from './page.js'
import { type OnProgress, type PreflightInput, type PreflightResult, liveDeps, preflight } from './preflight.js'

export interface InstallerOptions {
  port?: number
  host?: string
  uiScript?: string
  /** tests: the preflight, the fixes, the integration checks and the install's hooks */
  preflight?: (i: PreflightInput, token: string, onProgress?: OnProgress) => Promise<PreflightResult>
  fix?: typeof fix
  checkIntegration?: typeof checkIntegration
  hooks?: Hooks
  /** trace's own GitHub repository (default: src/installer/source.ts traceRepository) */
  traceRepository?: () => string | null
}

const PreflightBody = z.object({
  aws: z.object({ mode: z.enum(['profile', 'keys']).default('profile'), profile: z.string().default('default'), region: z.string().regex(/^([a-z]{2}(-[a-z]+)+-\d)?$/).default('') }).strict(),
  secrets: SecretsSchema.pick({ awsAccessKeyId: true, awsSecretAccessKey: true, awsSessionToken: true }).partial().default({}),
  token: z.string().min(20, 'a GitHub token'),
  adminToken: z.string().default(''),
  prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/).default('trace'),
  model: z.string().default(''),
  gpuEnabled: z.boolean().nullable().default(null),
  gpuSpot: z.boolean().default(false),
  cpuSpot: z.boolean().default(false),
  cpuVcpus: z.number().int().min(1).max(192).default(16),
  runnerAuth: z.enum(['auto', 'token', 'connection']).default('auto'),
  repos: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')).max(60).default([]),
  create: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')).max(20).default([]),
}).strict()

/** The answers of the last installation from this machine, when they still parse. */
function previous(): Answers | null {
  const r = AnswersSchema.safeParse(savedAnswers().answers)
  return r.success ? r.data : null
}

interface RunState { events: InstallEvent[]; listeners: Set<ServerResponse>; done: boolean }

const MAX_BODY = 1_000_000

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'request too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as unknown) : {}
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

/** The AWS credentials the page chose, or an error that says what to do about it. */
async function resolveCredentials(aws: { mode: 'profile' | 'keys'; profile: string }, secrets: Parameters<typeof credentials>[1]): Promise<Awaited<ReturnType<typeof credentials>>> {
  try {
    return await credentials(aws, secrets)
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (aws.mode === 'keys') throw new HttpError(400, `The AWS access keys can't be used: ${m}`)
    const sso = /sso|token.*(expired|refresh)|expired/i.test(m)
    throw new HttpError(400, `The AWS profile "${aws.profile}" can't be used: ${m}. ${sso ? `Its sign-in has probably expired: run \`aws sso login --profile ${aws.profile}\` and check again.` : `Check it works with \`aws sts get-caller-identity --profile ${aws.profile}\`, or choose another profile.`}`)
  }
}

const errorText = (e: unknown): string => (e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e instanceof Error ? e.message : String(e))

export function createInstaller(opts: InstallerOptions = {}): { server: ReturnType<typeof createServer>; key: string } {
  const key = randomBytes(24).toString('base64url')
  const ui = opts.uiScript ?? readFileSync(join(REPO_ROOT, 'dist', 'installer', 'ui.js'), 'utf8')
  let run: RunState | null = null

  // The key travels in the query only where a browser can't set a header (opening the page, EventSource); the API
  // takes it as a header, so it never sits in a URL the page fetches.
  const authorised = (req: IncomingMessage, url: URL): boolean => {
    const queryOk = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/events')
    const given = String(req.headers['x-trace-key'] ?? (queryOk ? url.searchParams.get('k') : '') ?? '')
    const a = Buffer.from(given)
    const b = Buffer.from(key)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // everything at once, before anything is created (src/installer/preflight.ts): what is derived, and each finding;
  // onProgress hears each check start and end (the page shows them while it waits)
  const runPreflight = async (raw: unknown, onProgress: OnProgress = () => undefined): Promise<unknown> => {
    const b = PreflightBody.parse(raw)
    onProgress({ id: 'credentials', label: b.aws.mode === 'profile' ? `Reading the AWS profile "${b.aws.profile}"` : 'Reading the AWS access keys', state: 'running' })
    const creds = await resolveCredentials(b.aws, { awsAccessKeyId: '', awsSecretAccessKey: '', awsSessionToken: '', ...b.secrets })
      .catch((e: unknown) => { onProgress({ id: 'credentials', label: 'Reading the AWS credentials', state: 'failed', detail: errorText(e) }); throw e })
    onProgress({ id: 'credentials', label: 'Reading the AWS credentials', state: 'done' })
    const prof = b.aws.mode === 'profile' ? (await profiles()).regions[b.aws.profile] ?? '' : ''
    const region = b.aws.region || prof || DEFAULT_REGION
    const r = await (opts.preflight ?? (async (i: PreflightInput, t: string, p?: OnProgress) => preflight(i, await liveDeps(creds, region, t), p)))({
      region, prefix: b.prefix, model: b.model, gpuSpot: b.gpuSpot, cpuSpot: b.cpuSpot, cpuVcpus: b.cpuVcpus, gpuEnabled: b.gpuEnabled,
      runnerAuth: b.runnerAuth, repos: b.repos, create: b.create, hasAdminToken: Boolean(b.adminToken),
    }, b.token, onProgress)
    // trace's own repository, and whether the token that configures repositories can set its variables (the page's
    // "build trace's own repository on AWS too", on by default when it can)
    const own = (opts.traceRepository ?? (() => traceRepository({ root: REPO_ROOT })))()
    const self = own ? { repo: own, ...(await canConfigure(b.adminToken || b.token, own).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }))) } : null
    return { ...r, region, profileRegion: prof, self }
  }

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    'GET /api/env': async () => ({
      profiles: await profiles(),
      saved: (savedAnswers().answers ?? null) as unknown,
      installed: installation(),
      node: process.version,
      defaultRegion: DEFAULT_REGION,
    }),
    'POST /api/github/check': async (req) => {
      const { token, repos } = z.object({ token: z.string().min(20), repos: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')).max(200).default([]) }).parse(await body(req))
      const info = await checkToken(token)
      const access = await Promise.all(repos.map(async (r) => ({ repo: r, ...(await canConfigure(token, r)) })))
      // trace's own repository, and whether this token can set its variables (the page's "build trace's own repository
      // on AWS too", on by default when it can)
      const own = (opts.traceRepository ?? (() => traceRepository({ root: REPO_ROOT })))()
      const self = own ? { repo: own, ...(await canConfigure(token, own)) } : null
      return { ...info, access, self }
    },
    'POST /api/aws/check': async (req) => {
      const b = z.object({ aws: AwsAnswers.unwrap().pick({ mode: true, profile: true, region: true }), secrets: SecretsSchema.pick({ awsAccessKeyId: true, awsSecretAccessKey: true, awsSessionToken: true }).partial(), prefix: z.string().default('trace') }).parse(await body(req))
      const creds = await resolveCredentials(b.aws, { awsAccessKeyId: '', awsSecretAccessKey: '', awsSessionToken: '', ...b.secrets })
      return checkAws(creds, b.aws.region, stackName(b.prefix))
    },
    // everything at once, before anything is created (src/installer/preflight.ts): what is derived, and each finding
    'POST /api/preflight': async (req) => runPreflight(await body(req)),
    // what the preflight offered to fix, when the person asks
    'POST /api/fix': async (req) => {
      const b = z.object({ aws: AwsAnswers.unwrap().pick({ mode: true, profile: true, region: true }), secrets: SecretsSchema.pick({ awsAccessKeyId: true, awsSecretAccessKey: true, awsSessionToken: true }).partial().default({}), token: z.string().default(''), fix: FixRequest }).parse(await body(req))
      const creds = await resolveCredentials(b.aws, { awsAccessKeyId: '', awsSecretAccessKey: '', awsSessionToken: '', ...b.secrets })
      const region = b.aws.region || (await profiles()).regions[b.aws.profile] || DEFAULT_REGION
      return { detail: await (opts.fix ?? fix)(b.fix, { creds, region, token: b.token }) }
    },
    // an integration's keys, checked with its service (never stored here: that is the install's)
    'POST /api/integrations/check': async (req) => {
      const b = z.object({ name: IntegrationNameSchema, values: z.record(z.string(), z.string().max(4096)) }).parse(await body(req))
      return (opts.checkIntegration ?? checkIntegration)(b.name, valuesFor(b.name, b.values))
    },
    'POST /api/plan': async (req) => {
      const b = z.object({ answers: z.unknown(), existing: z.object({ outputs: z.record(z.string(), z.string()) }).loose().nullable().default(null), cdkBootstrapped: z.boolean().default(false) }).parse(await body(req))
      const a = AnswersSchema.parse(b.answers)
      // the account comes from the checks: without them there is nothing to plan for
      if (!a.aws.account) throw new HttpError(409, 'The AWS account is not known yet: the checks have to pass first (Connect → Check).')
      const prev = previous()
      return { steps: plan(a, b.existing, prev), timeline: timeline(a, b.existing, { cdkBootstrapped: b.cdkBootstrapped }), changes: b.existing ? changesSince(prev, a) : [] }
    },
    'POST /api/apply': async (req) => {
      if (run && !run.done) throw new HttpError(409, 'an installation is already running')
      const b = z.object({ answers: z.unknown(), secrets: z.unknown() }).parse(await body(req))
      const a = AnswersSchema.parse(b.answers)
      const s = SecretsSchema.parse(b.secrets)
      const state: RunState = { events: [], listeners: new Set(), done: false }
      run = state
      const emit = (e: InstallEvent): void => {
        state.events.push(e)
        for (const l of state.listeners) l.write(`data: ${JSON.stringify(e)}\n\n`)
        if (e.type === 'done') { state.done = true; for (const l of state.listeners) l.end() }
        // 'ready' keeps the stream open: the GPU image's wait goes on after it
      }
      void apply(a, s, emit, opts.hooks ?? {}, { prev: previous() })
      return { started: true }
    },
    // a timer wait the page shows (a `wait` event): check now instead of at its next check
    'POST /api/check-now': async (req) => {
      const { waitId } = z.object({ waitId: z.string().regex(/^wait-[0-9a-f]{1,32}$/, 'expected a wait id') }).strict().parse(await body(req))
      return { ok: checkNow(waitId) }
    },
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 421, { error: 'wrong host' })
      // A browser marks a request another site started: refuse it whatever it carries (no cross-site driving).
      const site = String(req.headers['sec-fetch-site'] ?? '')
      if (site && !['same-origin', 'none'].includes(site)) return send(res, 403, { error: 'cross-site request' })
      const origin = req.headers.origin
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, { error: 'cross-site request' })
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      if (req.method === 'GET' && url.pathname === '/') {
        if (!authorised(req, url)) return send(res, 401, { error: 'open the address printed by `trace install`' })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        return res.end(page(key))
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
      if (req.method === 'GET' && url.pathname === '/ui.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(ui)
      }
      if (!authorised(req, url)) return send(res, 401, { error: 'missing or wrong installer key' })
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (!run) return send(res, 404, { error: 'nothing is running' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`)
        if (run.done) return res.end()
        run.listeners.add(res)
        req.on('close', () => run?.listeners.delete(res))
        return
      }
      // the checks, streamed: one line per check as it starts and ends, then the result (or the error)
      if (req.method === 'POST' && url.pathname === '/api/preflight' && String(req.headers.accept ?? '').includes('application/x-ndjson')) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
        const line = (o: unknown): void => { if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`) }
        try {
          const result = await runPreflight(await body(req), (p) => line({ type: 'progress', ...p }))
          line({ type: 'result', result })
        } catch (e) {
          line({ type: 'error', error: errorText(e) })
        }
        return res.end()
      }
            const route = routes[`${req.method} ${url.pathname}`]
      if (!route) return send(res, 404, { error: 'not found' })
      if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' })
      try {
        send(res, 200, await route(req))
      } catch (e) {
        send(res, e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 502, { error: errorText(e) })
      }
    })()
  })
  return { server, key }
}

/** Start the installer, print its address and open the browser. */
export async function startInstaller(opts: InstallerOptions & { open?: boolean } = {}): Promise<{ url: string; close: () => void }> {
  const { server, key } = createInstaller(opts)
  await new Promise<void>((resolveP, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolveP())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 0
  const url = `http://localhost:${port}/?k=${key}`
  if (opts.open !== false) {
    const { spawn } = await import('node:child_process')
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref() } catch { /* print only */ }
  }
  return { url, close: () => server.close() }
}
