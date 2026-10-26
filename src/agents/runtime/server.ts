/**
 * The trace agent's HTTP contract on Bedrock AgentCore Runtime (0.0.0.0:8080):
 *
 *   GET  /ping          {"status": "Healthy"}, or "HealthyBusy" while any job runs (keeps the session alive)
 *   POST /invocations   a JSON invocation (schemas.ts):
 *        { kind: "work-item", repository, item, runUrl? }  → { accepted, jobId }   (the item's job starts in the background)
 *        { kind: "sweep", repositories }                    → { accepted, jobId }   (worker-pick per repository)
 *        { kind: "task", repository, request, requestedBy, branch?, issue? } → { accepted, jobId }
 *        { kind: "status", jobId? }                         → { jobs: [...] }
 *        { kind: "tool", repository, name, args }           → { ok, result | error }  (a tool call the API forwarded:
 *                                                              run here, on this runtime's clone, no model; tool.ts)
 *   Every invocation may carry `trace` (the caller's traceparent, tracestate, baggage): see observe.ts invocationHeaders.
 *
 * One job per item at a time: a second invocation for a running item answers accepted: false with the running job's
 * id. SIGTERM aborts the running jobs, waits briefly for them to report, and closes.
 *
 * Delegation (delegation.ts), loopback callers only (a specialist's own MCP server, in this container):
 *   POST /delegate          { token, brief, acceptance, branch? }  → { accepted, jobId }  (a worker job)
 *   POST /delegate/status   { token, jobId }                       → { job }               (that specialist's own child)
 *   POST /delegate/cancel   { token, jobId, reason? }              → { jobId, delegation } (abort it: a timed-out wait)
 *
 * Single-project mode (TRACE_PROJECT=owner/repo, set on each project's worker runtime): an invocation for any other
 * repository answers 403 { error } and is logged. The runtime's role could not reach that project anyway.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { ATTR, flush } from '../../core/telemetry.js'
import { DelegateCancelRequest, DelegateRequest, DelegateStatusRequest, DelegationError, type Delegations, defaultDelegations } from './delegation.js'
import { type Jobs, defaultJobs } from './jobs.js'
import { invocationHeaders, observeInvocation } from './observe.js'
import { InvocationSchema, WrongProject, checkProject } from './schemas.js'
import { ToolRefused, type ToolRunner } from './tool.js'

const MAX_BODY = 1024 * 1024

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
    size += b.length
    if (size > MAX_BODY) throw Object.assign(new Error('the body is larger than 1 MB'), { status: 413 })
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface HandlerOptions {
  /** The one project this runtime serves (TRACE_PROJECT); unset: any. */
  project?: string | undefined
  log?: (line: string) => void
  /** The delegations of this process (default: the process's own). */
  delegations?: Delegations
  /** Runs a forwarded tool call (invocation kind `tool`; default: the registry on this runtime's clone, tool.ts). */
  tool?: ToolRunner
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

async function delegate(req: IncomingMessage, res: ServerResponse, path: string, jobs: Jobs, delegations: Delegations): Promise<void> {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return send(res, 403, { error: 'delegation is for this runtime\'s own specialists' })
  let raw: unknown
  try {
    raw = JSON.parse(await readBody(req))
  } catch {
    return send(res, 400, { error: 'the body is not JSON' })
  }
  try {
    const status = (id: string): ReturnType<Jobs['jobStatus']> => jobs.jobStatus(id)
    if (path === '/delegate') {
      const r = DelegateRequest.safeParse(raw)
      if (!r.success) return send(res, 400, { error: 'invalid delegation', issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) })
      return send(res, 200, delegations.start(r.data, (p) => jobs.startJob(p), status))
    }
    if (path === '/delegate/cancel') {
      const r = DelegateCancelRequest.safeParse(raw)
      if (!r.success) return send(res, 400, { error: 'invalid cancel request' })
      const state = await delegations.cancel(r.data.token, r.data.jobId, r.data.reason ?? 'the specialist cancelled it', (id, why) => jobs.abort(id, why), status)
      return send(res, 200, { jobId: r.data.jobId, delegation: state })
    }
    const r = DelegateStatusRequest.safeParse(raw)
    if (!r.success) return send(res, 400, { error: 'invalid status request' })
    const j = delegations.status(r.data.token, r.data.jobId, status)
    return send(res, 200, { job: { id: j.id, state: j.state, delegation: j.delegation, startedAt: j.startedAt, endedAt: j.endedAt, summary: j.summary, error: j.error, log: j.log.slice(-20) } })
  } catch (e) {
    if (e instanceof DelegationError) return send(res, e.status, { error: e.message })
    throw e
  }
}

export function handler(jobs: Jobs, o: HandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const log = o.log ?? ((l: string) => { process.stdout.write(`${l}\n`) })
  let tool: ToolRunner | null = o.tool ?? null
  let toolsRunning = 0
  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/ping') {
      return send(res, 200, { status: jobs.busy() || toolsRunning > 0 ? 'HealthyBusy' : 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) })
    }
    if (req.method === 'POST' && (path === '/delegate' || path === '/delegate/status' || path === '/delegate/cancel')) {
      void delegate(req, res, path, jobs, o.delegations ?? defaultDelegations())
        .catch((e: unknown) => { if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) }) })
      return
    }
    if (req.method === 'POST' && path === '/invocations') {
      void (async () => {
        let raw: unknown
        try {
          raw = JSON.parse(await readBody(req))
        } catch (e) {
          const status = (e as { status?: number }).status ?? 400
          return send(res, status, { error: status === 413 ? 'the body is larger than 1 MB' : 'the body is not JSON' })
        }
        const parsed = InvocationSchema.safeParse(raw)
        if (!parsed.success) {
          return send(res, 400, { error: 'invalid invocation', issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) })
        }
        const p = parsed.data
        try {
          checkProject(p, o.project)
        } catch (e) {
          if (!(e instanceof WrongProject)) throw e
          log(JSON.stringify({ at: new Date().toISOString(), refused: p.kind, reason: e.message }))
          return send(res, e.status, { error: e.message })
        }
        return observeInvocation('worker', invocationHeaders(req.headers, p.trace), { [ATTR.invocationKind]: p.kind, ...('repository' in p ? { [ATTR.repository]: p.repository } : {}) }, async (_s, outcome) => {
          if (p.kind === 'status') { outcome('ok'); return send(res, 200, { jobs: jobs.jobStatus(p.jobId), busy: jobs.busy() }) }
          if (p.kind === 'tool') {
            // a forwarded tool call: no model, no job; the answer is the tool's (ok: false for a refusal or a ToolError)
            toolsRunning++
            try {
              tool ??= await (await import('./tool.js')).realToolRunner()
              const result = await tool(p)
              outcome('ok')
              return send(res, 200, { ok: true, result })
            } catch (e) {
              const refused = e instanceof ToolRefused || (e instanceof Error && e.name === 'ToolError')
              outcome(refused ? 'rejected' : 'error')
              return send(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e), ...(refused ? {} : { internal: true }) })
            } finally {
              toolsRunning--
            }
          }
          // the job's span starts here, under this invocation (and its session)
          const r = jobs.startJob(p)
          outcome(r.accepted ? 'ok' : 'rejected', { [ATTR.jobId]: r.jobId })
          return send(res, 200, r)
        })
      })().catch((e: unknown) => { if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) }) })
      return
    }
    send(res, 404, { error: 'not found' })
  }
}

export function createAgentServer(jobs: Jobs, o: HandlerOptions = {}): Server {
  return createServer(handler(jobs, o))
}

export async function start(opts: { port?: number; host?: string; jobs?: Jobs; project?: string } = {}): Promise<Server> {
  const jobs = opts.jobs ?? defaultJobs()
  const project = opts.project ?? (process.env.TRACE_PROJECT || undefined)
  const server = createAgentServer(jobs, { project })
  if (project) process.stdout.write(`trace agent: serving ${project} only\n`)
  const port = opts.port ?? Number(process.env.PORT || 8080)
  await new Promise<void>((res) => server.listen(port, opts.host ?? '0.0.0.0', res))
  process.stdout.write(`trace agent listening on ${opts.host ?? '0.0.0.0'}:${port}\n`)
  let stopping = false
  // ADOT (loaded with --require) shuts the OpenTelemetry SDK down as soon as SIGTERM arrives, which would drop the
  // spans of the jobs that end during the grace period. Its listener, and any other registered before this one, run
  // after the jobs have reported and the telemetry has been flushed.
  const earlier = process.listeners('SIGTERM')
  for (const l of earlier) process.removeListener('SIGTERM', l)
  const stop = (sig: string): void => {
    if (stopping) return
    stopping = true
    process.stdout.write(`${sig}: stopping the running jobs\n`)
    server.close()
    void jobs.shutdown(20_000)
      .then(() => flush())
      .then(() => { for (const l of earlier) { try { l('SIGTERM') } catch { /* theirs */ } } })
      .finally(() => process.exit(0))
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
  return server
}
