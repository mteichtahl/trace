/**
 * The tools function's handler (agent/Dockerfile.tools runs `node /app/dist/gpu/lambda.js`): a Lambda custom runtime
 * in a few lines of node:http, so the image needs no runtime client package (and nothing to compile for it). Each
 * invocation is one job, run by the same runner as a Batch job (./runner.ts observedMain): the event names the job's
 * spec in S3 (./function.ts FunctionEvent), the runner downloads the inputs, runs the program, uploads the outputs and
 * the exit record, and the reply is the exit code.
 *
 * The Lambda Runtime API (AWS_LAMBDA_RUNTIME_API): GET …/runtime/invocation/next waits for the next event (with no
 * timeout of ours: Lambda freezes the process between events, and a timer counting through a freeze would misfire),
 * then POST …/<request id>/response or …/<request id>/error. Each job works in its own folder under /tmp, removed
 * after it: a warm container keeps /tmp between invocations.
 */
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { flush, startSdkIfConfigured } from '../core/telemetry.js'
import type { FunctionEvent, FunctionReply } from './function.js'
import { observedMain } from './runner.js'

const VERSION = '2018-06-01'

interface HttpReply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function call(api: string, method: 'GET' | 'POST', path: string, body?: string, headers: Record<string, string> = {}): Promise<HttpReply> {
  const [host, port] = api.split(':') as [string, string | undefined]
  return new Promise((resolve, reject) => {
    const req = request({ host, port: Number(port ?? 80), method, path: `/${VERSION}${path}`, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const errorBody = (e: unknown): string => JSON.stringify({
  errorMessage: e instanceof Error ? e.message : String(e),
  errorType: e instanceof Error ? e.name : 'Error',
})

/** One job: the runner on the event's spec, in a fresh folder under `workRoot`, removed after. */
export async function handle(event: unknown, o: { workRoot?: string; run?: typeof observedMain } = {}): Promise<FunctionReply> {
  const e = (event ?? {}) as Partial<FunctionEvent>
  if (typeof e.spec !== 'string' || !e.spec.startsWith('s3://')) throw new Error('the event names no job spec (expected {"spec": "s3://…"})')
  const dir = mkdtempSync(join(o.workRoot ?? tmpdir(), 'job-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TRACE_GPU_JOB_URI: e.spec }
    if (typeof e.traceparent === 'string') env.TRACEPARENT = e.traceparent
    else delete env.TRACEPARENT
    const exitCode = await (o.run ?? observedMain)({ env, workRoot: dir })
    return { exitCode }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The runtime loop: next event, handle it, reply; for ever (or `max` events, for tests). A failed job is still a
 * reply (its exit code); only a job that could not be run at all is an invocation error.
 */
export async function serve(o: { api: string; handler?: (event: unknown) => Promise<FunctionReply>; max?: number }): Promise<void> {
  const handler = o.handler ?? ((ev: unknown) => handle(ev))
  for (let n = 0; o.max === undefined || n < o.max; n++) {
    const next = await call(o.api, 'GET', '/runtime/invocation/next')
    const id = String(next.headers['lambda-runtime-aws-request-id'] ?? '')
    if (!id) throw new Error(`the runtime API gave no request id (HTTP ${next.status})`)
    let event: unknown
    try {
      event = JSON.parse(next.body)
      const reply = await handler(event)
      await call(o.api, 'POST', `/runtime/invocation/${id}/response`, JSON.stringify(reply))
    } catch (e) {
      console.error(`trace tools function: ${e instanceof Error ? e.message : String(e)}`)
      await call(o.api, 'POST', `/runtime/invocation/${id}/error`, errorBody(e), { 'Lambda-Runtime-Function-Error-Type': 'Runtime.HandlerError' })
    }
    await flush()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = process.env.AWS_LAMBDA_RUNTIME_API
  if (!api) {
    console.error('trace tools function: AWS_LAMBDA_RUNTIME_API is not set: this runs only as a Lambda function')
    process.exit(2)
  }
  void startSdkIfConfigured()
    .then(() => serve({ api }))
    .catch(async (e: unknown) => {
      console.error(`trace tools function: ${e instanceof Error ? e.message : String(e)}`)
      await call(api, 'POST', '/runtime/init/error', errorBody(e), { 'Lambda-Runtime-Function-Error-Type': 'Runtime.InitError' }).catch(() => undefined)
      process.exit(1)
    })
}
