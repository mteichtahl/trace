/**
 * Heavy jobs (Blender renders, the PCB autorouter) run through here, so the same MCP tool works on a laptop and from
 * an AgentCore agent. AgentCore runtimes have no GPU, so when TRACE_GPU_QUEUE names an AWS Batch GPU job queue and
 * this machine has no usable GPU of its own, the job is shipped there: inputs go to S3, the job runs in the GPU image,
 * outputs come back. Otherwise the job runs here as a child process.
 *
 *   const r = await runJob({ kind: 'blender', argv: ['blender', '-b', '-P', '{in:scene.py}', '--', '{out:frame.png}'],
 *     inputs: { 'scene.py': '/tmp/x/scene.py' }, outputs: ['frame.png'], gpu: true, timeoutSeconds: 1800 })
 *   r.outputs['frame.png']   // a local path, wherever the job ran
 *
 * argv placeholders: {in:NAME} is replaced by the input's path where the job runs, {out:NAME} by the path an output
 * must be written to, {dir} by the job's working directory.
 *
 * Input names may be relative paths (`rtl/core/alu.v`): the job sees them in that tree under `{dir}/in/`, so files
 * that refer to each other by relative path (a Verilog `include "sub/x.vh"`) find each other wherever the job runs.
 * Output names are plain file names.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { ToolError } from '../core/registry.js'
import { ATTR, type Outcome, fail, recordMetric, setAttrs, span } from '../core/telemetry.js'
import { scratchDir } from '../core/store.js'

export const JobKind = z.enum(['blender', 'freerouting', 'orthoroute',
  // CPU jobs (gpu: false, so local unless TRACE_GPU_REMOTE=always): verification and FPGA implementation
  'verilator', 'cocotb', 'formal', 'yosys', 'nextpnr', 'fpga-pack',
  // the openEMS FDTD field solver (CPU, multithreaded): local, or the queue's many-core hosts when the caller asks (remote)
  'openems'])
export type JobKind = z.output<typeof JobKind>

const SEGMENT = /^[\w.-]+$/

/** Whether `s` is an input name: a relative path `a/b/c.v` of letters, digits, '.', '_' and '-' (no '.' or '..'
 * segment, no leading '/', no backslash, no empty segment). */
export function isInputName(s: string): boolean {
  if (!s || s.length > 512 || s.includes('\\') || s.startsWith('/')) return false
  return s.split('/').every((seg) => SEGMENT.test(seg) && seg !== '.' && seg !== '..')
}

export const InputName = z.string().refine(isInputName, {
  message: "an input name is a relative path a/b/c of letters, digits, '.', '_' and '-' (no '..', no leading '/', no backslash)",
})
export const OutputName = z.string().regex(SEGMENT)

/** Input names where one is a folder of another (`a` and `a/b`): they cannot both be staged. */
export function nameClashes(names: readonly string[]): string[] {
  const set = new Set(names)
  const out: string[] = []
  for (const n of names) {
    const parts = n.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (set.has(dir)) out.push(`${dir} is both an input and the folder of ${n}`)
    }
  }
  return out
}

export const GpuJobSchema = z.object({
  kind: JobKind,
  argv: z.array(z.string()).min(1),
  /** name (a relative path) → local file to send with the job */
  inputs: z.record(InputName, z.string()).default({}),
  /** names of files the job writes (via {out:NAME}) to bring back */
  outputs: z.array(OutputName).default([]),
  /** wants a GPU: picks the GPU queue; locally only a hint for the program */
  gpu: z.boolean().default(false),
  /** prefer the queue (when TRACE_GPU_QUEUE is set) even without needing a GPU: a CPU job too big for this machine */
  remote: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(10).max(8 * 3600).default(3600),
  env: z.record(z.string(), z.string()).default({}),
  /** on the queue: the vCPUs to ask for (a resource override, capped at the job definition's limit); ignored locally */
  vcpus: z.number().int().min(1).max(256).optional(),
}).strict().superRefine((j, ctx) => {
  for (const m of nameClashes(Object.keys(j.inputs))) ctx.addIssue({ code: 'custom', path: ['inputs'], message: m })
})
export type GpuJob = z.input<typeof GpuJobSchema>

export interface JobResult {
  exitCode: number
  stdout: string
  stderr: string
  /** output name → local path (missing when the job did not write it) */
  outputs: Record<string, string>
  where: 'local' | 'batch'
  /** the Batch job id when it ran there */
  jobId?: string
  seconds: number
}

/** Where a job would run now. TRACE_GPU_REMOTE=always|never overrides the default (remote only without a local GPU,
 * or when the job asks for the queue with `remote`). */
export function backendFor(job: { gpu?: boolean | undefined; remote?: boolean | undefined }): 'local' | 'batch' {
  const queue = process.env.TRACE_GPU_QUEUE
  const mode = process.env.TRACE_GPU_REMOTE ?? 'auto'
  if (!queue || mode === 'never') return 'local'
  if (mode === 'always') return 'batch'
  return (job.gpu && !localGpu()) || job.remote ? 'batch' : 'local'
}

/** A GPU this process can use: an NVIDIA device node, or TRACE_GPU=1 set by the GPU image. */
export function localGpu(): boolean {
  if (['1', 'true', 'yes'].includes(process.env.TRACE_GPU ?? '')) return true
  if (['0', 'false', 'no'].includes(process.env.TRACE_GPU ?? '')) return false
  return existsSync('/dev/nvidia0') || existsSync('/proc/driver/nvidia/version')
}

export function substitute(argv: readonly string[], ins: Record<string, string>, outs: Record<string, string>, dir: string): string[] {
  return argv.map((a) => a.replace(/\{(in|out):([\w./-]+)\}|\{dir\}/g, (m, k: string | undefined, n: string | undefined) => {
    if (m === '{dir}') return dir
    const table = k === 'in' ? ins : outs
    const v = n === undefined ? undefined : table[n]
    if (v === undefined) throw new ToolError(`${m} names no ${k === 'in' ? 'input' : 'output'} of the job`)
    return v
  }))
}

export async function runLocal(spec: GpuJob): Promise<JobResult> {
  const job = GpuJobSchema.parse(spec)
  const dir = scratchDir(`trace-${job.kind}-`) // one fresh directory per job; the caller removes it when done
  const ins: Record<string, string> = {}
  for (const [n, p] of Object.entries(job.inputs)) {
    if (!existsSync(p)) throw new ToolError(`input ${n}: ${p} does not exist`)
    ins[n] = join(dir, 'in', ...n.split('/'))
    mkdirSync(dirname(ins[n]), { recursive: true })
    copyFileSync(p, ins[n])
  }
  mkdirSync(join(dir, 'out'), { recursive: true })
  const outs = Object.fromEntries(job.outputs.map((n) => [n, join(dir, 'out', basename(n))]))
  const argv = substitute(job.argv, ins, outs, dir)
  const t0 = Date.now()
  const [cmd, ...args] = argv as [string, ...string[]]
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...job.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d: Buffer) => { stdout = (stdout + d.toString()).slice(-200_000) })
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-200_000) })
    const timer = setTimeout(() => p.kill('SIGKILL'), job.timeoutSeconds * 1000)
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(e.code === 'ENOENT' ? new ToolError(`${cmd} is not installed here${process.env.TRACE_GPU_QUEUE ? '' : ' (set TRACE_GPU_QUEUE to run it on the GPU queue)'}`) : e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      const outputs = Object.fromEntries(Object.entries(outs).filter(([, f]) => existsSync(f)))
      resolve({ exitCode: code ?? -1, stdout, stderr, outputs, where: 'local', seconds: (Date.now() - t0) / 1000 })
    })
  })
}

/**
 * Run a job where it fits (see backendFor). The Batch backend lives in ./batch.ts and is loaded only when used.
 * Each job is a span (`trace.gpu_job <kind>`: kind, backend, job ids, seconds, exit code) and counts trace.gpu.jobs and
 * trace.gpu.duration; a Batch job gets the span's trace context (TRACEPARENT), so its runner's span joins the trace.
 */
export async function runJob(spec: GpuJob): Promise<JobResult> {
  const backend = backendFor(spec)
  let outcome: Outcome = 'ok'
  const t0 = performance.now()
  try {
    return await span(`trace.gpu_job ${spec.kind}`, {
      [ATTR.gpuKind]: spec.kind, [ATTR.gpuBackend]: backend, [ATTR.gpuWanted]: spec.gpu ?? false,
      [ATTR.gpuInputs]: Object.keys(spec.inputs ?? {}).length, [ATTR.gpuOutputs]: (spec.outputs ?? []).length,
    }, async (s) => {
      const r = backend === 'local' ? await runLocal(spec) : await (await import('./batch.js')).runBatch(GpuJobSchema.parse(spec))
      outcome = r.exitCode === 0 ? 'ok' : 'error'
      setAttrs(s, {
        [ATTR.gpuExitCode]: r.exitCode, [ATTR.gpuSeconds]: r.seconds, [ATTR.outcome]: outcome,
        ...(r.jobId ? { [ATTR.gpuBatchJobId]: r.jobId } : {}),
      })
      if (outcome !== 'ok') fail(s, new Error(`exit code ${r.exitCode}`), 'exit_code')
      return r
    })
  } catch (e) {
    outcome = 'error'
    throw e
  } finally {
    const dims = { [ATTR.gpuKind]: spec.kind, [ATTR.gpuBackend]: backend, [ATTR.outcome]: outcome }
    recordMetric('trace.gpu.jobs', 1, dims)
    recordMetric('trace.gpu.duration', (performance.now() - t0) / 1000, dims)
  }
}
