/**
 * Driving Blender. Blender's scripting API (bpy) is Python-only, so the scripts that run inside Blender live in
 * python/blender/ (plain bpy + the standard library, nothing to install); everything that drives them is here.
 *
 * Every invocation goes through runJob() (src/gpu/jobs.ts), so the same call renders on this machine or, when there is
 * no local GPU and TRACE_GPU_QUEUE names a GPU queue (an AgentCore runtime), on that queue:
 *
 *   blender -b --factory-startup --python-exit-code 1 -P {in:script.py} -- {in:job.json} [{in:model}] {out:a.png} ...
 *
 * The job (a JSON file in a scratch directory, removed afterwards) carries the settings; the script prints exactly one
 * line `TRACE_RESULT {...}` last, which is parsed here with zod. A script failure prints `{"ok": false, "error"}`.
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ToolError } from '../core/registry.js'
import { scratchDir } from '../core/store.js'
import { backendFor, runJob, type JobResult } from '../gpu/jobs.js'

export const RESULT_PREFIX = 'TRACE_RESULT '
export const SCRIPTS = ['render_board.py', 'render_model.py', 'probe.py'] as const
export type Script = (typeof SCRIPTS)[number]

const INSTALL_PATHS = [
  '/usr/bin/blender',
  '/usr/local/bin/blender',
  '/snap/bin/blender',
  '/opt/blender/blender',
  '/Applications/Blender.app/Contents/MacOS/Blender',
  'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
  'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe',
]

function onPath(cmd: string): string | null {
  const win = process.platform === 'win32'
  for (const d of (process.env.PATH ?? '').split(win ? ';' : ':')) {
    if (!d) continue
    for (const e of win ? ['.exe', ''] : ['']) {
      const p = join(d, cmd + e)
      try {
        if (statSync(p).isFile()) return p
      } catch {
        // not here
      }
    }
  }
  return null
}

/** Blender on this machine: $TRACE_BLENDER, then PATH, then the usual install locations; null when there is none. */
export function findBlender(): string | null {
  const env = process.env.TRACE_BLENDER
  if (env) return existsSync(env) ? env : null
  return onPath('blender') ?? INSTALL_PATHS.find((p) => existsSync(p)) ?? null
}

/** ffmpeg on this machine (for turntable movies), or null. */
export function findFfmpeg(): string | null {
  return process.env.TRACE_FFMPEG && existsSync(process.env.TRACE_FFMPEG) ? process.env.TRACE_FFMPEG : onPath('ffmpeg')
}

/** The bpy scripts: $TRACE_BLENDER_SCRIPTS, else python/blender in this package (from src/render or dist/render). */
export function scriptsDir(): string {
  if (process.env.TRACE_BLENDER_SCRIPTS) return resolve(process.env.TRACE_BLENDER_SCRIPTS)
  return fileURLToPath(new URL('../../python/blender/', import.meta.url))
}

/** Where a Blender job would run now, and the program to name in its argv. */
export function blenderTarget(gpu = true): { where: 'local' | 'batch'; bin: string | null } {
  const where = backendFor({ gpu })
  return { where, bin: where === 'local' ? findBlender() : 'blender' }
}

/** The last `TRACE_RESULT {...}` line in a script's output, parsed as JSON; null when there is none. */
export function parseResultLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] as string).trim()
    if (l.startsWith(RESULT_PREFIX)) {
      try {
        return JSON.parse(l.slice(RESULT_PREFIX.length)) as unknown
      } catch {
        throw new ToolError(`Blender printed a malformed result line: ${l.slice(0, 200)}`)
      }
    }
  }
  return null
}

const Envelope = z.object({ ok: z.boolean(), error: z.string().optional() }).loose()

/** The last lines of a program's output, for an error message. */
export function tail(text: string, lines = 12): string {
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('Fra:')).slice(-lines).join('\n')
}

/** Turn a finished job into the script's result: timeouts, crashes and script errors become ToolErrors. */
export function readResult<T>(r: Pick<JobResult, 'exitCode' | 'stdout' | 'stderr' | 'seconds'>, schema: z.ZodType<T>, timeoutSeconds: number): T {
  const raw = parseResultLine(r.stdout)
  if (raw === null) {
    if (r.exitCode !== 0 && r.seconds >= timeoutSeconds - 1) {
      throw new ToolError(`Blender timed out after ${timeoutSeconds} s and was stopped; ask for fewer samples, a smaller size or a longer timeout_s`)
    }
    throw new ToolError(`Blender exited ${r.exitCode} without a result:\n${tail(r.stderr + '\n' + r.stdout)}`)
  }
  const env = Envelope.safeParse(raw)
  if (!env.success) throw new ToolError(`Blender's result line is not an object: ${JSON.stringify(raw).slice(0, 200)}`)
  if (!env.data.ok) throw new ToolError(`Blender: ${env.data.error ?? 'failed'}`)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ToolError(`Blender's result did not have the expected shape: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return parsed.data
}

export interface BlenderCall<T> {
  script: Script
  /** settings for the script, written to job.json */
  job: unknown
  /** name → local file sent with the job (the model) */
  inputs?: Record<string, string>
  /** arguments after job.json; may hold {in:NAME} and {out:NAME} */
  args?: string[]
  /** names of the files the script writes */
  outputs?: string[]
  schema: z.ZodType<T>
  timeoutSeconds?: number
  gpu?: boolean
}

export interface BlenderRun<T> {
  result: T
  /** output name → local path (read them, then call cleanup) */
  outputs: Record<string, string>
  where: 'local' | 'batch'
  jobId?: string
  seconds: number
  cleanup: () => void
}

/** Run one bpy script through runJob and return its parsed result. */
export async function runBlender<T>(call: BlenderCall<T>): Promise<BlenderRun<T>> {
  const gpu = call.gpu ?? true
  const { where, bin } = blenderTarget(gpu)
  if (!bin) {
    throw new ToolError('Blender is not installed here (install it, or set TRACE_BLENDER to its path; with TRACE_GPU_QUEUE set, renders run on the GPU queue)')
  }
  const dir = scriptsDir()
  const script = join(dir, call.script)
  if (!existsSync(script)) throw new ToolError(`the bpy script ${script} is missing (TRACE_BLENDER_SCRIPTS?)`)
  const tmp = scratchDir('trace-blender-')
  const jobPath = join(tmp, 'job.json')
  writeFileSync(jobPath, JSON.stringify(call.job))
  const timeoutSeconds = Math.max(10, Math.round(call.timeoutSeconds ?? 1800))
  try {
    const r = await runJob({
      kind: 'blender',
      gpu,
      timeoutSeconds,
      argv: [bin, '-b', '--factory-startup', '--python-exit-code', '1', '-P', `{in:${call.script}}`, '--', '{in:job.json}', ...(call.args ?? [])],
      inputs: { [call.script]: script, 'common.py': join(dir, 'common.py'), 'job.json': jobPath, ...(call.inputs ?? {}) },
      outputs: call.outputs ?? [],
    })
    const result = readResult(r, call.schema, timeoutSeconds)
    const outputs = r.outputs
    return {
      result, outputs, where: r.where, seconds: r.seconds,
      ...(r.jobId ? { jobId: r.jobId } : {}),
      cleanup: () => removeOutputs(outputs),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Remove a job's output files and, when it is a scratch job directory (…/<kind>-xxxx/out), the directory too. */
export function removeOutputs(outputs: Record<string, string>): void {
  const dirs = new Set<string>()
  for (const p of Object.values(outputs)) {
    rmSync(p, { force: true })
    const out = dirname(p)
    if (basename(out) === 'out') dirs.add(dirname(out))
  }
  for (const d of dirs) {
    if (!resolve(d).startsWith(resolve(tmpdir())) || !/^blender-/.test(basename(d))) continue
    rmSync(d, { recursive: true, force: true })
    const parent = dirname(d)
    try {
      if (/^trace-/.test(basename(parent)) && readdirSync(parent).length === 0) rmdirSync(parent)
    } catch {
      // already gone
    }
  }
}

/** Width and height from a PNG's IHDR chunk, or null when it is not a PNG. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

export function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true })
  return d
}
