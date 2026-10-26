/**
 * The AWS Batch backend of runJob (./jobs.ts): a job that wants a GPU, asked for where there is none (an AgentCore
 * runtime, a laptop), runs on the stack's GPU job queue instead.
 *
 *   1. its inputs go to s3://<bucket>/jobs/<slug>/<id>/in/ (./protocol.ts has the layout; slug: TRACE_PROJECT)
 *   2. SubmitJob to TRACE_GPU_QUEUE with TRACE_GPU_JOB_DEFINITION (the project's own: its job role reaches only
 *      jobs/<slug>/), tagged trace:project=<slug>; the spec travels in the container's environment
 *   3. DescribeJobs, backing off from 5 s to 30 s, until SUCCEEDED or FAILED — or the deadline (the job's own time
 *      limit plus TRACE_GPU_QUEUE_WAIT_S, default 1800 s, for the queue to scale a GPU instance up from zero and pull
 *      the image), when the job is terminated
 *   4. the outputs, stdout and stderr come back to a local scratch folder, and the runner's exit record gives the code
 *
 * The SDK clients are injected for tests; the real ones are loaded only when a job is shipped.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { S3Backend, type S3Api } from '../core/central.js'
import { PROJECT_TAG } from '../core/project.js'
import { ToolError } from '../core/registry.js'
import { ATTR, annotate, traceEnv } from '../core/telemetry.js'
import { scratchDir } from '../core/store.js'
import type { GpuJobSchema, JobResult } from './jobs.js'
import type { z } from 'zod'
import { encodeSpec, ExitRecordSchema, INLINE_SPEC_LIMIT, jobKeys, jobsLocation, type ExitRecord, type RemoteSpec } from './protocol.js'

export type ParsedJob = z.output<typeof GpuJobSchema>

/** The three Batch calls used, in the SDK's own shapes (only the fields read here). */
export interface BatchApi {
  submitJob(i: {
    jobName: string
    jobQueue: string
    jobDefinition: string
    containerOverrides: { environment: { name: string; value: string }[] }
    timeout: { attemptDurationSeconds: number }
    tags?: Record<string, string>
  }): Promise<{ jobId?: string | undefined }>
  describeJobs(i: { jobs: string[] }): Promise<{ jobs?: BatchJobDetail[] | undefined }>
  terminateJob(i: { jobId: string; reason: string }): Promise<unknown>
}

export interface BatchJobDetail {
  jobId?: string | undefined
  status?: string | undefined
  statusReason?: string | undefined
  container?: { reason?: string | undefined; exitCode?: number | undefined; logStreamName?: string | undefined } | undefined
}

export interface BatchDeps {
  batch?: BatchApi
  s3?: S3Api
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  env?: NodeJS.ProcessEnv
  /** progress lines (status changes), e.g. for a CLI */
  log?: (line: string) => void
}

async function awsBatch(): Promise<BatchApi> {
  const b = await import('@aws-sdk/client-batch')
  const client = new b.BatchClient({})
  return {
    submitJob: (i) => client.send(new b.SubmitJobCommand(i)),
    describeJobs: (i) => client.send(new b.DescribeJobsCommand(i)),
    terminateJob: (i) => client.send(new b.TerminateJobCommand(i)),
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A job id that sorts by time and is safe in S3 keys and Batch job names. */
export function newJobId(kind: string, now = Date.now()): string {
  const t = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return `${kind}-${t}-${randomBytes(4).toString('hex')}`
}

const text = (b: Uint8Array | undefined): string => (b ? new TextDecoder().decode(b) : '')

export async function runBatch(job: ParsedJob, deps: BatchDeps = {}): Promise<JobResult> {
  const env = deps.env ?? process.env
  const queue = env.TRACE_GPU_QUEUE
  const definition = env.TRACE_GPU_JOB_DEFINITION
  if (!queue || !definition) throw new ToolError('the GPU queue needs TRACE_GPU_QUEUE and TRACE_GPU_JOB_DEFINITION (set by the stack on the runtimes)')
  const { bucket, prefix, project } = jobsLocation(env)
  const store = new S3Backend(bucket, prefix, deps.s3)
  const batch = deps.batch ?? (await awsBatch())
  const sleep = deps.sleep ?? sleepMs
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const t0 = now()

  const id = newJobId(job.kind, t0)
  const keys = jobKeys(id)
  for (const [name, path] of Object.entries(job.inputs)) {
    let body: Uint8Array
    try {
      body = readFileSync(path)
    } catch {
      throw new ToolError(`input ${name}: ${path} cannot be read`)
    }
    await store.put(keys.input(name), body)
  }
  const spec: RemoteSpec = {
    v: 1, id, bucket, prefix, kind: job.kind, argv: job.argv, inputs: Object.keys(job.inputs), outputs: job.outputs,
    env: job.env, gpu: job.gpu, timeoutSeconds: job.timeoutSeconds,
  }
  const encoded = encodeSpec(spec)
  const environment = encoded.length <= INLINE_SPEC_LIMIT
    ? [{ name: 'TRACE_GPU_JOB', value: encoded }]
    : (await store.put(keys.spec, new TextEncoder().encode(JSON.stringify(spec)), { contentType: 'application/json' }),
      [{ name: 'TRACE_GPU_JOB_URI', value: `${store.url}/${keys.spec}` }])

  const submitted = await batch.submitJob({
    jobName: `trace-${id}`.slice(0, 128),
    jobQueue: queue,
    jobDefinition: definition,
    // the trace context, so the runner's span continues this trace (src/core/telemetry.ts; nothing without a span)
    containerOverrides: { environment: [...environment, ...Object.entries(traceEnv()).map(([name, value]) => ({ name, value }))] },
    // the runner enforces the job's own limit; Batch's is a backstop for a runner that hangs
    timeout: { attemptDurationSeconds: Math.max(60, job.timeoutSeconds + 600) },
    // the project's role may submit, tag and stop only jobs carrying its own trace:project tag
    tags: { [PROJECT_TAG]: project, 'trace:job': id, 'trace:kind': job.kind },
  })
  const jobId = submitted.jobId
  if (!jobId) throw new ToolError('AWS Batch accepted the job but returned no job id')
  log(`submitted ${id} as Batch job ${jobId}`)
  annotate({ [ATTR.gpuJobId]: id, [ATTR.gpuBatchJobId]: jobId })

  const queueWait = Number(env.TRACE_GPU_QUEUE_WAIT_S ?? 1800)
  const deadline = t0 + (job.timeoutSeconds + (Number.isFinite(queueWait) && queueWait >= 0 ? queueWait : 1800)) * 1000
  let delay = 5000
  let last = ''
  let detail: BatchJobDetail | undefined
  for (;;) {
    detail = (await batch.describeJobs({ jobs: [jobId] })).jobs?.[0]
    const status = detail?.status ?? 'UNKNOWN'
    if (status !== last) {
      log(`${jobId}: ${status}`)
      last = status
    }
    if (status === 'SUCCEEDED' || status === 'FAILED') break
    if (now() >= deadline) {
      await batch.terminateJob({ jobId, reason: `trace: no result within ${Math.round((deadline - t0) / 1000)} s` }).catch(() => undefined)
      throw new ToolError(`the GPU job ${id} (Batch ${jobId}) was still ${status} after ${Math.round((now() - t0) / 1000)} s and was terminated`
        + (status === 'RUNNABLE' ? ': no GPU instance came up (check the compute environment\'s instance types, vCPU quota and Spot capacity)' : ''))
    }
    await sleep(delay)
    delay = Math.min(30_000, Math.round(delay * 1.5))
  }

  const exitBody = await store.get(keys.exit)
  let exit: ExitRecord | null = null
  if (exitBody) {
    const r = ExitRecordSchema.safeParse((() => { try { return JSON.parse(text(exitBody.body)) } catch { return null } })())
    exit = r.success ? r.data : null
  }
  const stdout = text((await store.get(keys.stdout))?.body).slice(-200_000)
  const stderr = text((await store.get(keys.stderr))?.body).slice(-200_000)
  if (!exit) {
    const why = [detail?.statusReason, detail?.container?.reason].filter(Boolean).join('; ')
    throw new ToolError(`the GPU job ${id} (Batch ${jobId}) ${(detail?.status ?? 'ended').toLowerCase()} before its runner finished${why ? `: ${why}` : ''}`
      + (stderr ? `\n${stderr.slice(-1500)}` : ''))
  }
  if (exit.error && exit.exitCode === 127) throw new ToolError(`the GPU job ${id}: ${exit.error}`)

  const dir = scratchDir(`gpu-${job.kind}-`)
  mkdirSync(join(dir, 'out'), { recursive: true })
  const outputs: Record<string, string> = {}
  for (const name of job.outputs) {
    const o = await store.get(keys.output(name))
    if (!o) continue
    const p = join(dir, 'out', name)
    writeFileSync(p, o.body)
    outputs[name] = p
  }
  writeFileSync(join(dir, 'stdout.txt'), stdout)
  writeFileSync(join(dir, 'stderr.txt'), stderr)
  return {
    exitCode: exit.exitCode,
    stdout,
    stderr: exit.error ? `${stderr}\n[trace] ${exit.error}`.trim() : stderr,
    outputs,
    where: 'batch',
    jobId,
    seconds: (now() - t0) / 1000,
  }
}
