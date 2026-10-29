/**
 * The two ends of a remote job that do not depend on where it runs (./batch.ts on AWS Batch, ./function.ts on the
 * tools function), in the layout of ./protocol.ts:
 *
 *   stageJob     a new job id, its inputs uploaded to jobs/<slug>/<id>/in/, and its spec to jobs/<slug>/<id>/spec,
 *                whose s3:// URI is all the job is given (TRACE_GPU_JOB_URI)
 *   readResult   the runner's exit record (null when it never finished) and its stdout and stderr
 *   fetchOutputs the outputs it wrote, into a fresh local scratch folder (with its stdout.txt and stderr.txt)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { S3Backend, type S3Api } from '../core/central.js'
import { ToolError } from '../core/registry.js'
import { scratchDir } from '../core/store.js'
import type { GpuJobSchema } from './jobs.js'
import type { z } from 'zod'
import { encodeSpec, ExitRecordSchema, jobKeys, jobsLocation, type ExitRecord, type RemoteSpec } from './protocol.js'

export type ParsedJob = z.output<typeof GpuJobSchema>

/** A job id: its kind, the UTC time to the second, and 8 random hex digits. */
export function newJobId(kind: string, now = Date.now()): string {
  const t = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return `${kind}-${t}-${randomBytes(4).toString('hex')}`
}

export interface StagedJob {
  id: string
  keys: ReturnType<typeof jobKeys>
  store: S3Backend
  /** the project (slug) whose prefix holds the job */
  project: string
  /** s3://… of the job's spec: TRACE_GPU_JOB_URI */
  specUri: string
}

/** Upload the inputs and the spec; `timeoutSeconds` replaces the job's own (the function's time limit). */
export async function stageJob(job: ParsedJob, o: { env: NodeJS.ProcessEnv; s3?: S3Api | undefined; now: number; timeoutSeconds?: number }): Promise<StagedJob> {
  const { bucket, prefix, project } = jobsLocation(o.env)
  const store = new S3Backend(bucket, prefix, o.s3)
  const id = newJobId(job.kind, o.now)
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
    env: job.env, gpu: job.gpu, timeoutSeconds: o.timeoutSeconds ?? job.timeoutSeconds,
  }
  // the spec stays in the project's prefix: the job is given only where it is (./protocol.ts)
  await store.put(keys.spec, new TextEncoder().encode(encodeSpec(spec)), { contentType: 'application/json' })
  return { id, keys, store, project, specUri: `${store.url}/${keys.spec}` }
}

const text = (b: Uint8Array | undefined): string => (b ? new TextDecoder().decode(b) : '')

/** The exit record (null: the runner never wrote one) and the program's output, its last 200 kB. */
export async function readResult(st: StagedJob): Promise<{ exit: ExitRecord | null; stdout: string; stderr: string }> {
  const exitBody = await st.store.get(st.keys.exit)
  let exit: ExitRecord | null = null
  if (exitBody) {
    const r = ExitRecordSchema.safeParse((() => { try { return JSON.parse(text(exitBody.body)) } catch { return null } })())
    exit = r.success ? r.data : null
  }
  const stdout = text((await st.store.get(st.keys.stdout))?.body).slice(-200_000)
  const stderr = text((await st.store.get(st.keys.stderr))?.body).slice(-200_000)
  return { exit, stdout, stderr }
}

/** Download the outputs the job wrote into a new scratch folder; output name → local path. */
export async function fetchOutputs(st: StagedJob, job: ParsedJob, logs: { stdout: string; stderr: string }): Promise<Record<string, string>> {
  const dir = scratchDir(`gpu-${job.kind}-`)
  mkdirSync(join(dir, 'out'), { recursive: true })
  const outputs: Record<string, string> = {}
  for (const name of job.outputs) {
    const o = await st.store.get(st.keys.output(name))
    if (!o) continue
    const p = join(dir, 'out', name)
    writeFileSync(p, o.body)
    outputs[name] = p
  }
  writeFileSync(join(dir, 'stdout.txt'), logs.stdout)
  writeFileSync(join(dir, 'stderr.txt'), logs.stderr)
  return outputs
}
