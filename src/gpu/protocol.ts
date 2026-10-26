/**
 * What passes between the submitting side (./batch.ts) and the job runner inside the GPU image (./runner.ts), and
 * where in S3 a job's files live. One job is one folder under its project's prefix, jobs/<slug>/ (slug: owner/repo,
 * lower case, src/core/project.ts), so each project's runtime and job role reach only their own project's jobs:
 *
 *   jobs/<slug>/<id>/in/<name>          inputs, uploaded before the job is submitted (a name may be a relative path,
 *                                       a/b/c.v: the keys mirror the tree the job sees)
 *   jobs/<slug>/<id>/out/<name>         outputs the program wrote ({out:NAME}), uploaded by the runner
 *   jobs/<slug>/<id>/log/stdout.txt     the program's output, uploaded by the runner
 *   jobs/<slug>/<id>/log/stderr.txt
 *   jobs/<slug>/<id>/exit               the exit record (ExitRecord), written last: its presence means the runner finished
 *   jobs/<slug>/<id>/spec               the spec (RemoteSpec, JSON), written before the job is submitted
 *
 * The project is TRACE_PROJECT (set on each project's worker runtime). Without it (a laptop with admin credentials)
 * jobs go under jobs/_local/, which is never a project's.
 *
 * The container gets only TRACE_GPU_JOB_URI (s3://… of `spec`) and TRACEPARENT: AWS Batch's DescribeJobs has no
 * resource-level permission, so whatever is in a job's command or environment can be read by any project's role. The
 * spec (argv, file names, the program's env) therefore lives only in the project's own prefix, and the command is
 * the job definition's generic `node /app/dist/gpu/runner.js`. The objects are transient (the stack expires `jobs/`
 * after a week); they are not data files.
 */
import { z } from 'zod'
import { ToolError } from '../core/registry.js'
import { InputName, JobKind, OutputName, nameClashes } from './jobs.js'
import { JOBS_PREFIX, LOCAL_JOBS, ProjectNameError, projectSlug } from '../core/project.js'

export const RemoteSpecSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[\w-]{1,100}$/),
  bucket: z.string().min(3),
  prefix: z.string(),
  kind: JobKind,
  argv: z.array(z.string()).min(1),
  inputs: z.array(InputName),
  outputs: z.array(OutputName),
  env: z.record(z.string(), z.string()),
  gpu: z.boolean(),
  timeoutSeconds: z.number().int().positive(),
}).strict().superRefine((s, ctx) => {
  for (const m of nameClashes(s.inputs)) ctx.addIssue({ code: 'custom', path: ['inputs'], message: m })
})
export type RemoteSpec = z.output<typeof RemoteSpecSchema>

export const ExitRecordSchema = z.object({
  exitCode: z.number().int(),
  seconds: z.number(),
  /** set when the program could not be run at all (not installed, an input missing) or was killed for time */
  error: z.string().optional(),
  /** outputs the program wrote and the runner uploaded */
  outputs: z.array(OutputName).default([]),
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

/** The spec as stored at `spec`. */
export const encodeSpec = (s: RemoteSpec): string => JSON.stringify(s)

/** The only environment variables a submitted job is given (see the header): nothing in them names a file. */
export const JOB_ENV = ['TRACE_GPU_JOB_URI', 'TRACEPARENT'] as const

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
