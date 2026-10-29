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
 */
import { type S3Api } from '../core/central.js'
import { ToolError } from '../core/registry.js'
import { ATTR, annotate, traceEnv } from '../core/telemetry.js'
import { FUNCTION_MAX_SECONDS, type JobResult } from './jobs.js'
import { type ParsedJob, fetchOutputs, readResult, stageJob } from './staging.js'

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

export interface FunctionDeps {
  lambda?: FunctionApi
  s3?: S3Api
  env?: NodeJS.ProcessEnv
  now?: () => number
  log?: (line: string) => void
}

/** What a function's handler sends back: its exit code. The exit record in S3 is what counts. */
export interface FunctionReply { exitCode: number }

/** What Invoke sends: the spec's location, and the trace context so the runner's span joins the caller's trace. */
export interface FunctionEvent { spec: string; traceparent?: string }

async function awsLambda(): Promise<FunctionApi> {
  const l = await import('@aws-sdk/client-lambda')
  // a call lasts as long as its job: no request timeout shorter than the function's own
  const client = new l.LambdaClient({ requestHandler: { requestTimeout: (FUNCTION_MAX_SECONDS + 120) * 1000, connectionTimeout: 10_000 } })
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
  const env = deps.env ?? process.env
  const fn = env.TRACE_TOOLS_FUNCTION
  if (!fn) throw new ToolError('the tools function needs TRACE_TOOLS_FUNCTION (set by the stack on the runtimes)')
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const t0 = now()
  const timeoutSeconds = Math.min(job.timeoutSeconds, FUNCTION_MAX_SECONDS)
  if (timeoutSeconds < job.timeoutSeconds) log(`${job.kind}: the tools function runs a job for at most ${FUNCTION_MAX_SECONDS} s, so this one is limited to that (it asked for ${job.timeoutSeconds} s)`)
  const lambda = deps.lambda ?? (await awsLambda())
  const staged = await stageJob(job, { env, s3: deps.s3, now: t0, timeoutSeconds })
  annotate({ [ATTR.gpuJobId]: staged.id })
  const event: FunctionEvent = { spec: staged.specUri }
  // only TRACEPARENT, as for a Batch job: baggage carries the session id
  const parent = traceEnv().TRACEPARENT
  if (parent) event.traceparent = parent
  log(`${staged.id}: running on the tools function`)
  const r = await lambda.invoke({ FunctionName: fn, Payload: new TextEncoder().encode(JSON.stringify(event)), LogType: 'Tail' })
  const requestId = r.$metadata?.requestId
  if (r.FunctionError) {
    const tail = r.LogResult ? Buffer.from(r.LogResult, 'base64').toString('utf8').trim().slice(-1500) : ''
    const { stderr } = await readResult(staged).catch(() => ({ stderr: '' }))
    throw new ToolError(`the tools function could not run ${staged.id}: ${functionErrorMessage(r.Payload)}`
      + (stderr ? `\n${stderr.slice(-1500)}` : tail ? `\n${tail}` : ''))
  }
  const { exit, stdout, stderr } = await readResult(staged)
  if (!exit) throw new ToolError(`the tools function returned from ${staged.id} before its runner finished` + (stderr ? `\n${stderr.slice(-1500)}` : ''))
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
