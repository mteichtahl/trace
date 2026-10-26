/**
 * Running the verification and FPGA programs (verilator, cocotb, yosys, yosys-smtbmc, sby, nextpnr, the packers)
 * through runJob, so a tool answers the same whether the job runs here or on the AWS Batch queue. These are CPU jobs
 * (gpu: false): runJob keeps them on this machine unless TRACE_GPU_REMOTE=always sends every job to the queue.
 *
 * A job gets its inputs as flat files (`{dir}/in/<name>`), so sources are staged by basename: two sources with the
 * same basename are refused rather than silently shadowing each other, and `include files must be found through
 * `-I{dir}/in` (an include written with a sub-folder, `include "sub/x.vh"`, is not found). Each job is a short POSIX
 * shell script (`sh -c`), with every caller-supplied string single-quoted, that writes its logs and results to
 * `{out:NAME}` files; the tools parse those files.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { backendFor, runJob, type JobKind, type JobResult } from '../../gpu/jobs.js'
import { which } from '../sim/proc.js'

/** Single-quote for sh. */
export function sq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

const NAME = /^[\w.-]+$/

export interface Staged {
  /** input name → local path, for runJob */
  inputs: Record<string, string>
  /** the staged names, in the order given */
  names: string[]
}

/** Stage files as job inputs by basename. Refuses a missing file and two files sharing a basename. */
export function stage(paths: readonly string[], into: Staged = { inputs: {}, names: [] }): Staged {
  for (const p0 of paths) {
    const p = resolve(p0)
    if (!existsSync(p) || !statSync(p).isFile()) throw new ToolError(`no file ${p}`)
    const name = basename(p)
    if (!NAME.test(name)) throw new ToolError(`${p}: file names may use letters, digits, '.', '_' and '-' only`)
    const prev = into.inputs[name]
    if (prev !== undefined) {
      if (resolve(prev) === p) continue
      throw new ToolError(`two inputs are both called ${name} (${prev} and ${p}); jobs see inputs by file name`)
    }
    into.inputs[name] = p
    into.names.push(name)
  }
  return into
}

/** Every HDL include-type file in the given folders (not recursive), for -I. */
export function includeFiles(dirs: readonly string[]): string[] {
  const out: string[] = []
  for (const d0 of dirs) {
    const d = resolve(d0)
    if (!existsSync(d) || !statSync(d).isDirectory()) throw new ToolError(`include dir ${d} is not a folder`)
    for (const f of readdirSync(d).sort()) {
      if (/\.(vh|svh|v|sv|vinc|inc|h|hpp)$/i.test(f) && statSync(join(d, f)).isFile()) out.push(join(d, f))
    }
  }
  return out
}

/** A program is needed here only when the job runs here; on the queue the job image provides it. */
export function needProgram(name: string, hint: string, envVar?: string): string {
  if (backendFor({ gpu: false }) !== 'local') return name
  const p = which(name, envVar)
  if (!p) throw new ToolError(`${name} is not installed here: ${hint}`)
  return p
}

export function haveProgram(name: string, envVar?: string): boolean {
  return which(name, envVar) !== null
}

export interface ShellJob {
  kind: JobKind
  script: string
  inputs: Record<string, string>
  outputs: string[]
  timeoutSeconds: number
  env?: Record<string, string>
}

export interface ShellResult {
  job: JobResult
  /** output name → text ('' when the job did not write it) */
  text: (name: string) => string
  bytes: (name: string) => Uint8Array | null
  has: (name: string) => boolean
  /** remove the job's local folder (runLocal leaves it for the caller) */
  cleanup: () => void
}

const MARK = 'trace-job.started'

/** Run a shell script as a job. The script sees {in:NAME}, {out:NAME} and {dir} replaced by paths. */
export async function shellJob(j: ShellJob): Promise<ShellResult> {
  // the marker is written first, so a job that fails at once still has an output to find its folder by
  const job = await runJob({
    kind: j.kind, gpu: false, timeoutSeconds: j.timeoutSeconds, argv: ['sh', '-c', `: > {out:${MARK}}\n${j.script}`],
    inputs: j.inputs, outputs: [MARK, ...j.outputs.filter((o) => o !== MARK)], env: j.env ?? {},
  })
  const bytes = (n: string): Uint8Array | null => {
    const f = job.outputs[n]
    return f && existsSync(f) ? new Uint8Array(readFileSync(f)) : null
  }
  return {
    job,
    bytes,
    text: (n) => {
      const b = bytes(n)
      return b ? new TextDecoder().decode(b) : ''
    },
    has: (n) => bytes(n) !== null,
    cleanup: () => {
      // runLocal puts outputs in <job dir>/out/<name>; the job dir is the out dir's parent
      const any = Object.values(job.outputs)[0]
      if (any && job.where === 'local') rmSync(dirname(dirname(any)), { recursive: true, force: true })
    },
  }
}

/** The last `n` characters, for logs kept as artifacts or returned. */
export function tail(s: string, n: number): string {
  return s.length > n ? `… ${s.length - n} characters cut …\n${s.slice(-n)}` : s
}

/** Lines of `text` matching `TRACE_COVER <name> [count]`: the functional-coverage convention every simulator's output
 * may use (a $display in Verilog, a print in cocotb). A repeated name adds up. */
export function coverLines(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of text.matchAll(/TRACE_COVER\s+([\w.:$[\]/-]+)(?:[ \t]+(\d+))?/g)) {
    const name = m[1] as string
    out.set(name, (out.get(name) ?? 0) + (m[2] !== undefined ? Number(m[2]) : 1))
  }
  return out
}
