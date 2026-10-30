/**
 * Heavy jobs (KiCad's command line, Blender renders, the PCB autorouter, the FPGA and verification programs, field and
 * thermal solvers, the enclosure engine) run through here, so the same MCP tool works on a laptop and from an AgentCore agent. Each job runs
 * in one of three places (backendFor):
 *
 *   local      a child process here: a laptop, the CI runner, or the Batch and function containers themselves
 *   function   the project's tools function (TRACE_TOOLS_FUNCTION, set by the stack on its worker runtime): an AWS
 *              Lambda function from the tools image (agent/Dockerfile.tools, src/gpu/lambda.ts), for the kinds in
 *              FUNCTION_KINDS. AgentCore takes images up to 2 GB, so KiCad, Blender, the FPGA toolchain and CalculiX
 *              live in that image instead of the runtime's; a call is synchronous, at most FUNCTION_MAX_SECONDS, and
 *              warm in about a second (./function.ts)
 *   batch      the AWS Batch GPU queue (TRACE_GPU_QUEUE) for a job that wants a GPU this machine lacks, and the CPU
 *              queue for a job the caller marks `remote` (too big for here, or for the function's time limit): the
 *              GPU image, minutes to start from an idle queue (./batch.ts)
 *
 * Either remote way, the inputs go to S3, the job runs, the outputs come back (./protocol.ts has the layout).
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
import { ATTR, type Outcome, fail, recordProjectMetric, setAttrs, span } from '../core/telemetry.js'
import { scratchDir } from '../core/store.js'

export const JobKind = z.enum(['blender', 'freerouting', 'orthoroute',
  // KiCad's command line (src/tools/kicad/project.ts runCli): exports, ERC, DRC and netlists, the project folder sent
  // as one archive and run by src/gpu/kicad-job.ts
  'kicad',
  // encoding a render's frames into a video (src/tools/render/tools.ts)
  'ffmpeg',
  // CPU jobs (gpu: false, so local unless TRACE_GPU_REMOTE=always): verification and FPGA implementation
  'verilator', 'cocotb', 'formal', 'yosys', 'nextpnr', 'fpga-pack',
  // the openEMS FDTD field solver (CPU, multithreaded): local, or the queue's many-core hosts when the caller asks (remote)
  'openems',
  // thermal (src/tools/thermal), all CPU: the 2.5D board solver for grids too big for the caller (thermal), CalculiX
  // ccx for the 3D finite-element path (calculix), and OpenFOAM conjugate heat transfer for airflow (openfoam)
  'thermal', 'calculix', 'openfoam',
  // the enclosure engine (src/tools/mech/engine.ts, docs/enclosure-build.md "Trust"), two kinds:
  //   cad         trace's own code only: the built-in template, the parts a cad-script job built (--built), or a
  //               handed-in STEP; then the fit, the rules, the exports and the records. On the tools function
  //   cad-script  the case script (mechanical/case.py: user code, `python -m tracebridge.mech build-only`), the board
  //               facts and settings in, one STEP per part and claims.json out. On the project's cad function
  //               (TRACE_CAD_FUNCTION: no credentials, no S3), else a local child process; never the queue
  'cad', 'cad-script'])
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
  /**
   * The program is untrusted code (a project's case script): it runs with a scrubbed environment (isolatedEnv: no
   * credentials, no tokens, nothing of the Lambda runtime), in a process group of its own that is killed whole when
   * the job ends. Default: true for kinds `cad` and `cad-script`, false otherwise.
   */
  isolate: z.boolean().optional(),
}).strict().superRefine((j, ctx) => {
  for (const m of nameClashes(Object.keys(j.inputs))) ctx.addIssue({ code: 'custom', path: ['inputs'], message: m })
}).transform((j) => ({ ...j, isolate: j.isolate ?? ISOLATED_KINDS.has(j.kind) }))

/** The kinds whose program is a project's own code: isolated by default. */
export const ISOLATED_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['cad', 'cad-script'])

/**
 * What a `cad-script` job hands back (python/tracebridge/mech/child.py): one STEP per case part (`part-1.step` …
 * `part-16.step`, numbered from 1, at most 16; the ones not written are simply absent) and `claims.json` (parts,
 * joints, fasteners, notes, or {"error"}). The `cad` job that follows reads them strictly (`--built`); they are
 * claims, never a pass.
 */
export const CAD_SCRIPT_OUTPUTS: readonly string[] = [...Array.from({ length: 16 }, (_, i) => `part-${i + 1}.step`), 'claims.json']
export type GpuJob = z.input<typeof GpuJobSchema>

export interface JobResult {
  exitCode: number
  stdout: string
  stderr: string
  /** output name → local path (missing when the job did not write it) */
  outputs: Record<string, string>
  where: Backend
  /** the Batch job id when it ran there (the function's request id when it ran there) */
  jobId?: string
  seconds: number
}

export type Backend = 'local' | 'function' | 'batch'

/** The kinds the tools function runs: what the tools image has (agent/Dockerfile.tools). */
export const FUNCTION_KINDS: ReadonlySet<JobKind> = new Set<JobKind>([
  'kicad', 'ffmpeg', 'blender', 'verilator', 'cocotb', 'formal', 'yosys', 'nextpnr', 'fpga-pack', 'calculix', 'cad',
])
/** The longest a job runs on the function: Lambda ends a call at 900 s, and the runner still uploads after the program. */
export const FUNCTION_MAX_SECONDS = 840

/**
 * Where a job would run now (the header's three places), first match:
 *   TRACE_GPU_REMOTE=never                          local
 *   TRACE_GPU_REMOTE=always, with a queue           batch
 *   a queue, and the job wants a GPU this machine
 *   lacks, or is marked `remote`                    batch
 *   the tools function, and a kind it runs          function (a GPU job too, with no GPU here or queue: rendered on
 *                                                   its CPU; a `remote` one with no queue: within its time limit)
 *   TRACE_TOOLS_ELSEWHERE=1 (the agent image, which
 *   has none of those programs), a queue, and one
 *   of those kinds                                  batch (a project without the tools function: the flat layout)
 *   otherwise                                       local
 * Without the tools function and a queue this is local, as on a laptop.
 *
 * A `cad-script` job (a project's case script) is apart from all that: the project's cad function (TRACE_CAD_FUNCTION,
 * nested layout) when there is one, else local; never the queue or the tools function, which hold credentials
 * (docs/enclosure-build.md "Trust"). TRACE_GPU_REMOTE=never still means local.
 */
export function backendFor(job: { kind?: JobKind | undefined; gpu?: boolean | undefined; remote?: boolean | undefined }, env: NodeJS.ProcessEnv = process.env): Backend {
  const queue = env.TRACE_GPU_QUEUE
  const mode = env.TRACE_GPU_REMOTE ?? 'auto'
  if (mode === 'never') return 'local'
  if (job.kind === 'cad-script') return env.TRACE_CAD_FUNCTION ? 'function' : 'local'
  if (queue && mode === 'always') return 'batch'
  if (queue && ((job.gpu && !localGpu(env)) || job.remote)) return 'batch'
  const tools = !!job.kind && FUNCTION_KINDS.has(job.kind)
  if (env.TRACE_TOOLS_FUNCTION && tools && !(job.gpu && localGpu(env))) return 'function'
  if (queue && tools && ['1', 'true', 'yes'].includes(env.TRACE_TOOLS_ELSEWHERE ?? '')) return 'batch'
  return 'local'
}

/** A GPU this process can use: an NVIDIA device node, or TRACE_GPU=1 set by the GPU image. */
export function localGpu(env: NodeJS.ProcessEnv = process.env): boolean {
  if (['1', 'true', 'yes'].includes(env.TRACE_GPU ?? '')) return true
  if (['0', 'false', 'no'].includes(env.TRACE_GPU ?? '')) return false
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

/**
 * What an isolated job's program may see of its parent's environment: the names below and nothing else, so no AWS
 * credentials (AWS_*, the Lambda runtime's AWS_LAMBDA_* and _HANDLER, the container credentials endpoint
 * AWS_CONTAINER_*), no tokens (GITHUB_*, TRACE_TOKEN, ANTHROPIC_*) and no trace settings reach it. The job's own `env`
 * (set by the tool that built the job, not by the project) is laid over it. `home`: a folder that replaces HOME, the
 * XDG folders and TMPDIR (the runner's per-job folder, so nothing a job leaves in a warm container's HOME, a Python
 * user site among it, is seen by the next job).
 */
export const ISOLATED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONHOME', 'PYTHONDONTWRITEBYTECODE', 'VIRTUAL_ENV', 'PYENV_ROOT', 'PYENV_VERSION', 'CONDA_PREFIX',
  'LD_LIBRARY_PATH', 'OMP_NUM_THREADS', 'SYSTEMROOT', 'COMSPEC', 'WINDIR',
] as const

export function isolatedEnv(env: NodeJS.ProcessEnv, own: Record<string, string> = {}, home?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if ((ISOLATED_ENV as readonly string[]).includes(k) || k.startsWith('LC_')) out[k] = v
  }
  if (home) {
    Object.assign(out, {
      HOME: home, TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), PYTHONNOUSERSITE: '1',
    })
    delete out.XDG_RUNTIME_DIR
    delete out.TMP
    delete out.TEMP
    mkdirSync(join(home, 'tmp'), { recursive: true })
  }
  return { ...out, ...own }
}

/** Kill a detached child's whole process group (it leads it), quietly when it is gone already. */
export function killGroup(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch { /* the group is gone */ }
}

/**
 * Spawn a job's program and collect its output. An isolated one (`isolate`) is detached into a process group of its
 * own; when its main process exits (success, failure or the time limit), the group is killed, so nothing it started in
 * the background lives on (a warm function's next job included). Output is read until the pipes close.
 */
export function spawnJob(cmd: string, args: string[], o: {
  cwd: string; env: NodeJS.ProcessEnv; isolate: boolean; timeoutSeconds: number
  onStdout: (d: Buffer) => void; onStderr: (d: Buffer) => void
}): Promise<{ code: number | null; killed: boolean; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: o.isolate })
    let killed = false
    let exitCode: number | null = null
    const kill = (): void => {
      if (o.isolate) killGroup(p.pid)
      else p.kill('SIGKILL')
    }
    const timer = setTimeout(() => { killed = true; kill() }, o.timeoutSeconds * 1000)
    p.stdout.on('data', o.onStdout)
    p.stderr.on('data', o.onStderr)
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (o.isolate) killGroup(p.pid)
      resolve({ code: null, killed, error: e })
    })
    // the main process is done: what it left running goes with it (its pipes then close, and 'close' follows)
    p.on('exit', (code) => {
      exitCode = code
      if (o.isolate) killGroup(p.pid)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (o.isolate) killGroup(p.pid)
      resolve({ code: exitCode ?? code, killed })
    })
  })
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
  let stdout = ''
  let stderr = ''
  // an isolated job keeps this machine's HOME (a laptop's Python may live under it) but nothing else of its environment
  const env = job.isolate ? isolatedEnv(process.env, job.env) : { ...process.env, ...job.env }
  const r = await spawnJob(cmd, args, {
    cwd: dir, env, isolate: job.isolate, timeoutSeconds: job.timeoutSeconds,
    onStdout: (d) => { stdout = (stdout + d.toString()).slice(-200_000) },
    onStderr: (d) => { stderr = (stderr + d.toString()).slice(-200_000) },
  })
  if (r.error) throw r.error.code === 'ENOENT' ? new ToolError(`${cmd} is not installed here${process.env.TRACE_GPU_QUEUE || process.env.TRACE_TOOLS_FUNCTION ? '' : ' (set TRACE_GPU_QUEUE to run it on the GPU queue)'}`) : r.error
  const outputs = Object.fromEntries(Object.entries(outs).filter(([, f]) => existsSync(f)))
  return { exitCode: r.code ?? -1, stdout, stderr, outputs, where: 'local', seconds: (Date.now() - t0) / 1000 }
}

/**
 * Run a job where it fits (see backendFor). The Batch backend lives in ./batch.ts and is loaded only when used.
 * Each job is a span (`trace.gpu_job <kind>`: kind, backend, job ids, seconds, exit code) and counts trace.gpu.jobs and
 * trace.gpu.duration; a Batch job gets the span's trace context (TRACEPARENT), so its runner's span joins the trace.
 */
/** The message for a case script where nothing may run it: the agent image (TRACE_TOOLS_ELSEWHERE) without a cad function. */
export const NO_CAD_FUNCTION = "a custom case script builds only with the project's cad function (nested layout) or on a laptop; the cloud builds the template or a handed-in STEP"

export async function runJob(spec: GpuJob): Promise<JobResult> {
  const backend = backendFor(spec)
  // the agent image has no build123d and no cad function to send the script to (the flat layout): a local run would
  // only fail later and less clearly
  if (spec.kind === 'cad-script' && backend === 'local' && ['1', 'true', 'yes'].includes(process.env.TRACE_TOOLS_ELSEWHERE ?? '')) throw new ToolError(NO_CAD_FUNCTION)
  let outcome: Outcome = 'ok'
  const t0 = performance.now()
  try {
    return await span(`trace.gpu_job ${spec.kind}`, {
      [ATTR.gpuKind]: spec.kind, [ATTR.gpuBackend]: backend, [ATTR.gpuWanted]: spec.gpu ?? false,
      [ATTR.gpuInputs]: Object.keys(spec.inputs ?? {}).length, [ATTR.gpuOutputs]: (spec.outputs ?? []).length,
    }, async (s) => {
      const r = backend === 'local' ? await runLocal(spec)
        : backend === 'function' ? await (await import('./function.js')).runFunction(GpuJobSchema.parse(spec))
        : await (await import('./batch.js')).runBatch(GpuJobSchema.parse(spec))
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
    recordProjectMetric('trace.gpu.jobs', 1, dims)
    recordProjectMetric('trace.gpu.duration', (performance.now() - t0) / 1000, dims)
  }
}
