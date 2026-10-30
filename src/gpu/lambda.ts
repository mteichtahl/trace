/**
 * The tools function's handler, and the cad function's (agent/Dockerfile.tools runs `node /app/dist/gpu/lambda.js`
 * in both; src/infra/tools.ts): a Lambda custom runtime in a few lines of node:http, so the image needs no runtime
 * client package (and nothing to compile for it). Each invocation is one job, run by the same runner as a Batch job
 * (./runner.ts observedMain): the event names the job's spec in S3 (./function.ts FunctionEvent), the runner
 * downloads the inputs, runs the program, uploads the outputs and the exit record, and the reply is the exit code. On
 * the cad function (TRACE_CAD_FUNCTION_ROLE=1, no S3 access) the event carries presigned URLs instead (./urls.ts), and
 * only a case script (kind `cad-script`) runs there: see handle().
 *
 * The Lambda Runtime API (AWS_LAMBDA_RUNTIME_API): GET …/runtime/invocation/next waits for the next event (with no
 * timeout of ours: Lambda freezes the process between events, and a timer counting through a freeze would misfire),
 * then POST …/<request id>/response or …/<request id>/error. Each job works in its own folder under /tmp, removed
 * after it: a warm container keeps /tmp between invocations, where the shared inputs (./protocol.ts: a KiCad project's
 * archive, the same from one call to the next) stay, up to ./runner.ts SHARED_CACHE_BYTES.
 */
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { flush, startSdkIfConfigured } from '../core/telemetry.js'
import type { FunctionEvent, FunctionReply } from './function.js'
import { observedMain } from './runner.js'
import { JobUrlsSchema, UrlStore, type UrlsEvent } from './urls.js'

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

/** Whether this is the cad function (src/infra/tools.ts CadFunction sets TRACE_CAD_FUNCTION_ROLE=1): no S3, scripts only. */
export const isCadFunction = (env: NodeJS.ProcessEnv = process.env): boolean => env.TRACE_CAD_FUNCTION_ROLE === '1'

/**
 * One job, in a fresh folder under `workRoot`, removed after. Two events (docs/enclosure-build.md "Trust"):
 *
 *   {"spec": "s3://…"}   a job in S3, run by the runner with this function's credentials: the tools function. The cad
 *                        function refuses it: it has no S3, and a script must not be able to name an object to read
 *   {"urls": {…}}        a `cad-script` job's files as presigned URLs (./urls.ts), run by the same runner on a UrlStore
 *                        with no credentials at all. Only a `cad-script` spec is taken through URLs: trace's own code
 *                        (kind `cad`) runs on the tools function, where the script never does
 */
export async function handle(event: unknown, o: { workRoot?: string; run?: typeof observedMain; sharedCache?: string; env?: NodeJS.ProcessEnv; fetch?: ConstructorParameters<typeof UrlStore>[2] } = {}): Promise<FunctionReply> {
  const e = (event ?? {}) as Partial<FunctionEvent & UrlsEvent>
  const base = o.env ?? process.env
  const dir = mkdtempSync(join(o.workRoot ?? tmpdir(), 'job-'))
  try {
    const env: NodeJS.ProcessEnv = { ...base, TRACE_JOB_BACKEND: 'function' }
    if (typeof e.traceparent === 'string') env.TRACEPARENT = e.traceparent
    else delete env.TRACEPARENT
    if (e.urls !== undefined) {
      if (!isCadFunction(base)) throw new Error('a job through URLs is a case script, which runs on the cad function only ({"urls": {…}} on the tools function is refused: it runs no script)')
      const urls = JobUrlsSchema.safeParse(e.urls)
      if (!urls.success) throw new Error(`the event's urls are invalid: ${urls.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      const spec = await UrlStore.readSpec(urls.data, o.fetch)
      if (spec.kind !== 'cad-script') throw new Error(`a job through URLs is a case script (kind cad-script), not ${spec.kind}`)
      delete env.TRACE_GPU_JOB_URI
      const exitCode = await (o.run ?? observedMain)({ env, workRoot: dir, store: new UrlStore(spec.id, urls.data, o.fetch) }, spec)
      return { exitCode }
    }
    if (typeof e.spec !== 'string' || !e.spec.startsWith('s3://')) throw new Error('the event names no job spec (expected {"spec": "s3://…"} or {"urls": {…}})')
    if (isCadFunction(base)) throw new Error('the cad function runs case scripts through URLs only ({"urls": {…}}): it has no S3 access, so an event naming a spec in S3 is refused')
    env.TRACE_GPU_JOB_URI = e.spec
    // a case script never runs here: the runner refuses a cad-script spec (./runner.ts), whoever staged it
    // shared inputs (a project archive sent again) kept in /tmp between the calls a warm container takes
    const exitCode = await (o.run ?? observedMain)({ env, workRoot: dir, sharedCache: o.sharedCache ?? join(tmpdir(), 'trace-shared') })
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
  // an init error is reported as one (the Runtime API takes /runtime/init/error only before the first /next); a
  // failure of the loop after that just ends the process, and Lambda starts a new one for the next invocation
  void startSdkIfConfigured()
    .then(
      () => serve({ api }).catch((e: unknown) => {
        console.error(`trace tools function: ${e instanceof Error ? e.message : String(e)}`)
        process.exit(1)
      }),
      async (e: unknown) => {
        console.error(`trace tools function: ${e instanceof Error ? e.message : String(e)}`)
        await call(api, 'POST', '/runtime/init/error', errorBody(e), { 'Lambda-Runtime-Function-Error-Type': 'Runtime.InitError' }).catch(() => undefined)
        process.exit(1)
      },
    )
}
