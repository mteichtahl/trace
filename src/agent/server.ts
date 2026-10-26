/**
 * The trace agent's HTTP contract on Bedrock AgentCore Runtime (0.0.0.0:8080):
 *
 *   GET  /ping          {"status": "Healthy"}, or "HealthyBusy" while any job runs (keeps the session alive)
 *   POST /invocations   a JSON invocation (schemas.ts):
 *        { kind: "work-item", repository, item, runUrl? }  → { accepted, jobId }   (the item's job starts in the background)
 *        { kind: "sweep", repositories }                    → { accepted, jobId }   (worker-pick per repository)
 *        { kind: "task", repository, request, requestedBy, branch?, issue? } → { accepted, jobId }
 *        { kind: "status", jobId? }                         → { jobs: [...] }
 *
 * One job per item at a time: a second invocation for a running item answers accepted: false with the running job's
 * id. SIGTERM aborts the running jobs, waits briefly for them to report, and closes.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { type Jobs, defaultJobs } from './jobs.js'
import { InvocationSchema } from './schemas.js'

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

export function handler(jobs: Jobs): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/ping') {
      return send(res, 200, { status: jobs.busy() ? 'HealthyBusy' : 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) })
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
        if (p.kind === 'status') return send(res, 200, { jobs: jobs.jobStatus(p.jobId), busy: jobs.busy() })
        return send(res, 200, jobs.startJob(p))
      })().catch((e: unknown) => { if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) }) })
      return
    }
    send(res, 404, { error: 'not found' })
  }
}

export function createAgentServer(jobs: Jobs): Server {
  return createServer(handler(jobs))
}

export async function start(opts: { port?: number; host?: string; jobs?: Jobs } = {}): Promise<Server> {
  const jobs = opts.jobs ?? defaultJobs()
  const server = createAgentServer(jobs)
  const port = opts.port ?? Number(process.env.PORT || 8080)
  await new Promise<void>((res) => server.listen(port, opts.host ?? '0.0.0.0', res))
  process.stdout.write(`trace agent listening on ${opts.host ?? '0.0.0.0'}:${port}\n`)
  let stopping = false
  const stop = (sig: string): void => {
    if (stopping) return
    stopping = true
    process.stdout.write(`${sig}: stopping the running jobs\n`)
    server.close()
    void jobs.shutdown(20_000).finally(() => process.exit(0))
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
  return server
}
