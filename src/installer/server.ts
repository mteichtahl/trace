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
import { AnswersSchema, AwsAnswers, type InstallEvent, SecretsSchema } from './answers.js'
import { apply, plan } from './bootstrap.js'
import { checkAws, credentials, profiles } from './aws.js'
import { canConfigure, checkToken } from './github.js'
import { page } from './page.js'

export interface InstallerOptions { port?: number; host?: string; uiScript?: string }

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

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    'GET /api/env': async () => ({
      profiles: await profiles(),
      saved: (savedAnswers().answers ?? null) as unknown,
      installed: installation(),
      node: process.version,
    }),
    'POST /api/github/check': async (req) => {
      const { token, repos } = z.object({ token: z.string().min(20), repos: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')).max(200).default([]) }).parse(await body(req))
      const info = await checkToken(token)
      const access = await Promise.all(repos.map(async (r) => ({ repo: r, ...(await canConfigure(token, r)) })))
      return { ...info, access }
    },
    'POST /api/aws/check': async (req) => {
      const b = z.object({ aws: AwsAnswers.pick({ mode: true, profile: true, region: true }), secrets: SecretsSchema.pick({ awsAccessKeyId: true, awsSecretAccessKey: true, awsSessionToken: true }).partial(), prefix: z.string().default('trace') }).parse(await body(req))
      const creds = await credentials(b.aws, { awsAccessKeyId: '', awsSecretAccessKey: '', awsSessionToken: '', ...b.secrets })
      return checkAws(creds, b.aws.region, stackName(b.prefix))
    },
    'POST /api/plan': async (req) => {
      const b = z.object({ answers: z.unknown(), existing: z.object({ outputs: z.record(z.string(), z.string()) }).loose().nullable().default(null) }).parse(await body(req))
      const a = AnswersSchema.parse(b.answers)
      return { steps: plan(a, b.existing) }
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
      }
      void apply(a, s, emit)
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
