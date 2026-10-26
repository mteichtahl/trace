/**
 * What passes between the submitting side (./batch.ts) and the job runner inside the GPU image (./runner.ts), and
 * where in S3 a job's files live. One job is one folder under its project's prefix, jobs/<slug>/ (slug: owner/repo,
 * lower case, src/core/project.ts), so each project's runtime and job role reach only their own project's jobs:
 *
 *   jobs/<slug>/<id>/in/<name>          inputs, uploaded before the job is submitted
 *   jobs/<slug>/<id>/out/<name>         outputs the program wrote ({out:NAME}), uploaded by the runner
 *   jobs/<slug>/<id>/log/stdout.txt     the program's output, uploaded by the runner
 *   jobs/<slug>/<id>/log/stderr.txt
 *   jobs/<slug>/<id>/exit               the exit record (ExitRecord), written last: its presence means the runner finished
 *   jobs/<slug>/<id>/spec               the spec, only when it is too large for the container's environment
 *
 * The project is TRACE_PROJECT (set on each project's worker runtime). Without it (a laptop with admin credentials)
 * jobs go under jobs/_local/, which is never a project's.
 *
 * The spec reaches the container in TRACE_GPU_JOB (base64url JSON), or TRACE_GPU_JOB_URI (s3://… of `spec`) when it
 * is large. The objects are transient (the stack expires `jobs/` after a week); they are not data files.
 */
import { z } from 'zod'
import { ToolError } from '../core/registry.js'
import { JobKind } from './jobs.js'
import { JOBS_PREFIX, LOCAL_JOBS, ProjectNameError, projectSlug } from '../core/project.js'

const Name = z.string().regex(/^[\w.-]+$/)

export const RemoteSpecSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[\w-]{1,100}$/),
  bucket: z.string().min(3),
  prefix: z.string(),
  kind: JobKind,
  argv: z.array(z.string()).min(1),
  inputs: z.array(Name),
  outputs: z.array(Name),
  env: z.record(z.string(), z.string()),
  gpu: z.boolean(),
  timeoutSeconds: z.number().int().positive(),
}).strict()
export type RemoteSpec = z.output<typeof RemoteSpecSchema>

export const ExitRecordSchema = z.object({
  exitCode: z.number().int(),
  seconds: z.number(),
  /** set when the program could not be run at all (not installed, an input missing) or was killed for time */
  error: z.string().optional(),
  /** outputs the program wrote and the runner uploaded */
  outputs: z.array(Name).default([]),
}).loose()
export type ExitRecord = z.output<typeof ExitRecordSchema>

/** Keys relative to the job's prefix (jobs/<slug>). */
export const jobKeys = (id: string) => ({
  input: (n: string) => `${id}/in/${n}`,
  output: (n: string) => `${id}/out/${n}`,
  stdout: `${id}/log/stdout.txt`,
  stderr: `${id}/log/stderr.txt`,
  exit: `${id}/exit`,
  spec: `${id}/spec`,
})

/** Specs at most this long travel in the environment (Batch caps all container overrides together at 8 KiB). */
export const INLINE_SPEC_LIMIT = 6000

export const encodeSpec = (s: RemoteSpec): string => Buffer.from(JSON.stringify(s), 'utf8').toString('base64url')

export function decodeSpec(text: string): RemoteSpec {
  let raw: unknown
  try {
    const t = text.trim()
    raw = JSON.parse(t.startsWith('{') ? t : Buffer.from(t, 'base64url').toString('utf8'))
  } catch {
    throw new ToolError('the GPU job spec is not readable JSON')
  }
  const r = RemoteSpecSchema.safeParse(raw)
  if (!r.success) throw new ToolError(`the GPU job spec is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return r.data
}

/** The project jobs are staged for (TRACE_PROJECT), or `_local`. */
export function jobsProject(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.TRACE_PROJECT?.trim()
  if (!p) return LOCAL_JOBS
  try {
    return projectSlug(p)
  } catch (e) {
    if (e instanceof ProjectNameError) throw new ToolError(`TRACE_PROJECT: ${e.message}`)
    throw e
  }
}

/**
 * Where jobs are staged: TRACE_GPU_BUCKET (a bucket name, or s3://bucket/base), else TRACE_HOME's bucket; under
 * `<base>/<slug>` (base: `jobs` unless the URL names another).
 */
export function jobsLocation(env: NodeJS.ProcessEnv = process.env): { bucket: string; prefix: string; project: string } {
  const project = jobsProject(env)
  const fromUrl = (u: string, base: string | null): { bucket: string; prefix: string; project: string } => {
    const url = new URL(u)
    if (!url.hostname) throw new ToolError(`${u}: no bucket`)
    const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '')
    return { bucket: url.hostname, prefix: `${base ?? (path || JOBS_PREFIX)}/${project}`, project }
  }
  const b = env.TRACE_GPU_BUCKET?.trim()
  if (b) return b.startsWith('s3://') ? fromUrl(b, null) : { bucket: b, prefix: `${JOBS_PREFIX}/${project}`, project }
  const home = env.TRACE_HOME?.trim()
  if (home?.startsWith('s3://')) return fromUrl(home, JOBS_PREFIX)
  throw new ToolError('nowhere to stage GPU jobs: set TRACE_GPU_BUCKET (or TRACE_HOME to s3://bucket/central)')
}
