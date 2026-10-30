/**
 * The tools-function backend of runJob (./jobs.ts): a job of a kind in FUNCTION_KINDS runs on the project's tools
 * function (TRACE_TOOLS_FUNCTION), an AWS Lambda function from the tools image (agent/Dockerfile.tools,
 * src/infra/project.ts). AgentCore Runtime takes images up to 2 GB, so the large programs (KiCad and its libraries,
 * Blender, the FPGA toolchain, CalculiX, ffmpeg) are there and not in the runtime's image.
 *
 *   1. inputs and spec to s3://<bucket>/jobs/<slug>/<id>/ (./staging.ts), the job's time limit capped at
 *      FUNCTION_MAX_SECONDS (Lambda ends a call at 900 s; the runner still uploads after the program)
 *   2. one synchronous Invoke of the function with {"spec": <s3 uri of the spec>, "traceparent"?}: the call returns
 *      when the job is done, so there is nothing to wait on and nothing to poll. The function's role reaches only the
 *      project's own jobs/<slug>/ prefix, and the project's runtime may invoke only its own function
 *   3. the exit record, the outputs, stdout and stderr back from S3, as from a Batch job (./staging.ts)
 *
 * A first call after an idle spell starts a new container from a large image (several seconds to tens of seconds);
 * later calls within minutes find it warm. Lambda calls cannot be cancelled: one whose caller goes away runs to its end.
 *
 * What the call cost goes into the project's ledger (src/core/cost.ts, kind tools): Lambda's billed duration (its REPORT
 * line, in the log tail the call returns; a cold start's init is billed with it) x the function's memory and /tmp,
 * and the call. Without the line, the call's own time and TRACE_TOOLS_FUNCTION_MEMORY_MB.
 *
 * A `cad-script` job (the project's case script: docs/enclosure-build.md "Trust") goes the same way to the project's
 * cad function (TRACE_CAD_FUNCTION, runCadScript), whose role has no S3 access: after staging, the worker signs a URL
 * for each of the job's files with its own credentials (./urls.ts, URL_EXPIRES_SECONDS) and the event carries those
 * instead of the spec's address; the results are read back from S3 as for any job.
 */
import { type S3Api } from '../core/central.js'
import { ToolError } from '../core/registry.js'
import { ATTR, annotate, traceEnv } from '../core/telemetry.js'
import { type UsageRow, ledgerFromEnv, recordUsage, toolsRow } from '../core/cost.js'
import { type PriceTable, pricesFromEnv } from '../core/prices.js'
import { pricesFor } from '../core/prices-store.js'
import { FUNCTION_MAX_SECONDS, type JobResult } from './jobs.js'
import { type ParsedJob, type StagedJob, fetchOutputs, readResult, stageJob } from './staging.js'
import { type JobUrls, URL_EXPIRES_SECONDS, type UrlsEvent } from './urls.js'

/** The Invoke call, in the SDK's shape (only the fields used here). */
export interface FunctionApi {
  invoke(i: { FunctionName: string; Payload: Uint8Array; LogType: 'Tail' }): Promise<{
    StatusCode?: number | undefined
    FunctionError?: string | undefined
    Payload?: Uint8Array | undefined
    /** the end of the call's log, base64 (LogType Tail) */
    LogResult?: string | undefined
    $metadata?: { requestId?: string | undefined } | undefined
  }>
}

/** Signs one S3 GET or PUT for `expiresIn` seconds with this process's credentials (@aws-sdk/s3-request-presigner). */
export interface Presigner {
  sign(i: { bucket: string; key: string; method: 'GET' | 'PUT'; expiresIn: number }): Promise<string>
}

export interface FunctionDeps {
  lambda?: FunctionApi
  s3?: S3Api
  /** for a cad-script job: the URL signer (default: the SDK's presigner on a fresh S3 client) */
  presign?: Presigner
  env?: NodeJS.ProcessEnv
  now?: () => number
  log?: (line: string) => void
  /** record what the call cost in the project's ledger; default: recordUsage into the session's ledger */
  recordCost?: (row: UsageRow) => Promise<unknown>
  /** the price table; default: the one in use (src/core/prices-store.ts pricesFor) */
  prices?: PriceTable
}

/** Lambda's REPORT line in a call's log: its billed duration (s) and memory (MB), or null when the tail has none. */
export function billedFromLog(tail: string): { seconds: number; memoryMb: number } | null {
  const line = tail.split('\n').reverse().find((l) => l.startsWith('REPORT '))
  if (!line) return null
  const billed = /Billed Duration: ([\d.]+) ms/.exec(line)
  const mem = /Memory Size: (\d+) MB/.exec(line)
  if (!billed || !mem) return null
  return { seconds: Number(billed[1]) / 1000, memoryMb: Number(mem[1]) }
}

/** The ledger's row for one call. Pure. */
export function functionCostRow(o: { tail: string; wallSeconds: number; id: string; kind: string; env: NodeJS.ProcessEnv; at: number; prices: PriceTable }): UsageRow {
  const b = billedFromLog(o.tail)
  const memoryMb = b?.memoryMb ?? (Number(o.env.TRACE_TOOLS_FUNCTION_MEMORY_MB) || 4096)
  const storageMb = Number(o.env.TRACE_TOOLS_FUNCTION_STORAGE_MB) || 512
  return toolsRow(o.prices, { seconds: b?.seconds ?? o.wallSeconds, memoryMb, storageMb, at: o.at, jobId: o.id, kind: o.kind, region: o.env.AWS_REGION ?? null })
}

/** What a function's handler sends back: its exit code. The exit record in S3 is what counts. */
export interface FunctionReply { exitCode: number }

/** What Invoke sends: the spec's location, and the trace context so the runner's span joins the caller's trace. */
export interface FunctionEvent { spec: string; traceparent?: string }

async function awsPresigner(): Promise<Presigner> {
  const [s3, p] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')])
  const client = new s3.S3Client({})
  // a PUT signed without ContentType: the runner sends none (./urls.ts), so the header is not in the signature
  return { sign: (i) => p.getSignedUrl(client, i.method === 'GET' ? new s3.GetObjectCommand({ Bucket: i.bucket, Key: i.key }) : new s3.PutObjectCommand({ Bucket: i.bucket, Key: i.key }), { expiresIn: i.expiresIn }) }
}

/** The URLs of a staged job: GET for its spec and inputs, PUT for its outputs, logs and exit record. */
export async function signJobUrls(staged: StagedJob, job: ParsedJob, presign: Presigner, expiresIn = URL_EXPIRES_SECONDS): Promise<JobUrls> {
  const { bucket, prefix } = staged.store
  const sign = (key: string, method: 'GET' | 'PUT') => presign.sign({ bucket, key: prefix ? `${prefix}/${key}` : key, method, expiresIn })
  const k = staged.keys
  return {
    spec: await sign(k.spec, 'GET'),
    inputs: Object.fromEntries(await Promise.all(Object.keys(job.inputs).map(async (n) => [n, await sign(k.input(n), 'GET')]))),
    outputs: Object.fromEntries(await Promise.all(job.outputs.map(async (n) => [n, await sign(k.output(n), 'PUT')]))),
    stdout: await sign(k.stdout, 'PUT'), stderr: await sign(k.stderr, 'PUT'), exit: await sign(k.exit, 'PUT'),
  }
}

async function awsLambda(): Promise<FunctionApi> {
  const l = await import('@aws-sdk/client-lambda')
  // a call lasts as long as its job: no request timeout shorter than the function's own
  const client = new l.LambdaClient({
    // one attempt: a retried invoke would run the job a second time, beside the first, on the same S3 keys
    maxAttempts: 1,
    requestHandler: { requestTimeout: (FUNCTION_MAX_SECONDS + 120) * 1000, connectionTimeout: 10_000 } })
  return { invoke: (i) => client.send(new l.InvokeCommand({ ...i, InvocationType: 'RequestResponse' })) }
}

/** The message of a function error (Lambda's {"errorMessage", "errorType"}), or the payload as text. */
export function functionErrorMessage(payload: Uint8Array | undefined): string {
  const t = payload ? new TextDecoder().decode(payload) : ''
  try {
    const j = JSON.parse(t) as { errorMessage?: unknown; errorType?: unknown }
    if (typeof j.errorMessage === 'string') return `${typeof j.errorType === 'string' ? `${j.errorType}: ` : ''}${j.errorMessage}`
  } catch { /* not JSON */ }
  return t.slice(0, 1500) || 'no message'
}

export async function runFunction(job: ParsedJob, deps: FunctionDeps = {}): Promise<JobResult> {
  if (job.kind === 'cad-script') return runCadScript(job, deps)
  const env = deps.env ?? process.env
  const fn = env.TRACE_TOOLS_FUNCTION
  if (!fn) throw new ToolError('the tools function needs TRACE_TOOLS_FUNCTION (set by the stack on the runtimes)')
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const t0 = now()
  const timeoutSeconds = Math.min(job.timeoutSeconds, FUNCTION_MAX_SECONDS)
  if (timeoutSeconds < job.timeoutSeconds) log(`${job.kind}: the tools function runs a job for at most ${FUNCTION_MAX_SECONDS} s, so this one is limited to that (it asked for ${job.timeoutSeconds} s)`)
  const lambda = deps.lambda ?? (await awsLambda())
  const staged = await stageJob(job, { env, s3: deps.s3, now: t0, timeoutSeconds, share: true })
  annotate({ [ATTR.gpuJobId]: staged.id })
  const event: FunctionEvent = { spec: staged.specUri }
  // only TRACEPARENT, as for a Batch job: baggage carries the session id
  const parent = traceEnv().TRACEPARENT
  if (parent) event.traceparent = parent
  log(`${staged.id}: running on the tools function`)
  return invokeAndCollect({ fn, what: 'the tools function', event, staged, job, deps, lambda, env, t0 })
}

/**
 * A case script on the project's cad function (TRACE_CAD_FUNCTION; src/infra/tools.ts CadFunction): staged as any
 * job, but the event carries presigned URLs of its files (signJobUrls) and nothing else, since the function's role has
 * no S3. Its calls cost as the tools function's (TRACE_CAD_FUNCTION_MEMORY_MB; the same /tmp), rows of kind tools.
 */
export async function runCadScript(job: ParsedJob, deps: FunctionDeps = {}): Promise<JobResult> {
  const env = deps.env ?? process.env
  const fn = env.TRACE_CAD_FUNCTION
  if (!fn) throw new ToolError('a case script runs in the cloud only on the project\'s cad function (TRACE_CAD_FUNCTION, set by the stack in the nested layout)')
  if (job.kind !== 'cad-script') throw new ToolError(`the cad function runs case scripts only, not a ${job.kind} job`)
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const t0 = now()
  const timeoutSeconds = Math.min(job.timeoutSeconds, FUNCTION_MAX_SECONDS)
  if (timeoutSeconds < job.timeoutSeconds) log(`${job.kind}: the cad function runs a script for at most ${FUNCTION_MAX_SECONDS} s, so this one is limited to that (it asked for ${job.timeoutSeconds} s)`)
  const [lambda, presign] = await Promise.all([deps.lambda ?? awsLambda(), deps.presign ?? awsPresigner()])
  // no shared cache: the function has no key for it, and a script's inputs are small
  const staged = await stageJob(job, { env, s3: deps.s3, now: t0, timeoutSeconds, share: false })
  annotate({ [ATTR.gpuJobId]: staged.id })
  const event: UrlsEvent = { urls: await signJobUrls(staged, job, presign) }
  const parent = traceEnv().TRACEPARENT
  if (parent) event.traceparent = parent
  log(`${staged.id}: running the case script on the cad function`)
  const costEnv = env.TRACE_CAD_FUNCTION_MEMORY_MB ? { ...env, TRACE_TOOLS_FUNCTION_MEMORY_MB: env.TRACE_CAD_FUNCTION_MEMORY_MB } : env
  return invokeAndCollect({ fn, what: 'the cad function', event, staged, job, deps, lambda, env: costEnv, t0 })
}

/** Invoke, record the cost, read the exit record and the outputs back from S3: the shared end of both functions. */
async function invokeAndCollect(o: { fn: string; what: string; event: FunctionEvent | UrlsEvent; staged: StagedJob; job: ParsedJob; deps: FunctionDeps; lambda: FunctionApi; env: NodeJS.ProcessEnv; t0: number }): Promise<JobResult> {
  const { staged, job, deps, env, t0 } = o
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const r = await o.lambda.invoke({ FunctionName: o.fn, Payload: new TextEncoder().encode(JSON.stringify(o.event)), LogType: 'Tail' })
  const requestId = r.$metadata?.requestId
  const logTail = r.LogResult ? Buffer.from(r.LogResult, 'base64').toString('utf8') : ''
  // the call ran (and was billed) whether the job succeeded or not: recorded first, never failing the job
  const prices = deps.prices ?? (await pricesFor(env).catch(() => null))?.table ?? pricesFromEnv(env)
  const row = functionCostRow({ tail: logTail, wallSeconds: (now() - t0) / 1000, id: staged.id, kind: job.kind, env, at: now() / 1000, prices })
  await (deps.recordCost ?? ((x: UsageRow) => recordUsage([x], { ledger: ledgerFromEnv(env), log })))(row).catch(() => undefined)
  if (r.FunctionError) {
    const tail = logTail.trim().slice(-1500)
    const { stderr } = await readResult(staged).catch(() => ({ stderr: '' }))
    throw new ToolError(`${o.what} could not run ${staged.id}: ${functionErrorMessage(r.Payload)}`
      + (stderr ? `\n${stderr.slice(-1500)}` : tail ? `\n${tail}` : ''))
  }
  const { exit, stdout, stderr } = await readResult(staged)
  if (!exit) throw new ToolError(`${o.what} returned from ${staged.id} before its runner finished` + (stderr ? `\n${stderr.slice(-1500)}` : ''))
  if (exit.error && exit.exitCode === 127) throw new ToolError(`the job ${staged.id}: ${exit.error}`)
  const outputs = await fetchOutputs(staged, job, { stdout, stderr })
  return {
    exitCode: exit.exitCode,
    stdout,
    stderr: exit.error ? `${stderr}\n[trace] ${exit.error}`.trim() : stderr,
    outputs,
    where: 'function',
    ...(requestId ? { jobId: requestId } : {}),
    seconds: (now() - t0) / 1000,
  }
}
