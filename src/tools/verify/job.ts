/**
 * Running the verification and FPGA programs (verilator, cocotb, yosys, yosys-smtbmc, sby, nextpnr, the packers)
 * through runJob, so a tool answers the same whether the job runs here or on the AWS Batch queue. These are CPU jobs
 * (gpu: false): runJob keeps them on this machine unless TRACE_GPU_REMOTE=always sends every job to the queue.
 *
 * A job gets its inputs under `{dir}/in/`, by name. HDL sources keep their relative layout (`hdlStage`): every file is
 * named by its path relative to the deepest folder holding all of them (the sources, the include folders, and the
 * files the sources `include), so `include "sub/x.vh"` finds sub/x.vh wherever the job runs, and two sources that
 * share a basename in different folders are both kept. Include folders become `-I{dir}/in/<their path>`. Files the
 * tools write themselves (a generated main(), a driver script) are staged by basename at the top. Each job is a short
 * POSIX shell script (`sh -c`), with every caller-supplied string single-quoted, that writes its logs and results to
 * `{out:NAME}` files; the tools parse those files.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { backendFor, isInputName, runJob, type JobKind, type JobResult } from '../../gpu/jobs.js'
import { which } from '../sim/proc.js'

/** Single-quote for sh. */
export function sq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

const NAME = /^[\w.-]+$/

export interface Staged {
  /** input name (a relative path) → local path, for runJob */
  inputs: Record<string, string>
  /** the staged names, in the order given */
  names: string[]
}

const posix = (p: string): string => p.split(sep).join('/')

function addInput(into: Staged, name: string, p: string): string {
  if (!isInputName(name)) throw new ToolError(`${p}: staged as ${JSON.stringify(name)}, but input names use letters, digits, '.', '_' and '-' in each folder and file name`)
  const prev = into.inputs[name]
  if (prev !== undefined) {
    if (resolve(prev) === p) return name
    throw new ToolError(`two inputs are both called ${name} (${prev} and ${p}); jobs see inputs by name`)
  }
  for (const other of into.names) {
    if (other.startsWith(`${name}/`) || name.startsWith(`${other}/`)) throw new ToolError(`${name} and ${other} cannot both be staged (one is a folder of the other)`)
  }
  into.inputs[name] = p
  into.names.push(name)
  return name
}

function needFile(p0: string): string {
  const p = resolve(p0)
  if (!existsSync(p) || !statSync(p).isFile()) throw new ToolError(`no file ${p}`)
  return p
}

/** Stage files as job inputs. By basename (flat); with `root`, by their path relative to it (a tree). Refuses a
 * missing file, a file outside root, and two different files given the same name. */
export function stage(paths: readonly string[], into: Staged = { inputs: {}, names: [] }, root?: string): Staged {
  for (const p0 of paths) {
    const p = needFile(p0)
    if (root === undefined) {
      const name = basename(p)
      if (!NAME.test(name)) throw new ToolError(`${p}: file names may use letters, digits, '.', '_' and '-' only`)
      addInput(into, name, p)
      continue
    }
    const rel = relative(resolve(root), p)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`${p} is not under ${root}`)
    addInput(into, posix(rel), p)
  }
  return into
}

const INCLUDE_EXT = /\.(vh|svh|v|sv|vinc|inc|h|hpp)$/i
const MAX_INCLUDE_FILES = 2000
const MAX_INCLUDE_DEPTH = 8

/** Every HDL include-type file in the given folders and their sub-folders (to 8 levels, skipping hidden folders),
 * for -I: an include can name a file in a sub-folder of an include dir. */
export function includeFiles(dirs: readonly string[]): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    for (const f of readdirSync(d).sort()) {
      if (f.startsWith('.') || f === 'node_modules') continue
      const p = join(d, f)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (depth < MAX_INCLUDE_DEPTH) walk(p, depth + 1)
      } else if (INCLUDE_EXT.test(f) && st.isFile()) {
        out.push(p)
        if (out.length > MAX_INCLUDE_FILES) throw new ToolError(`include dirs ${dirs.join(', ')} hold more than ${MAX_INCLUDE_FILES} HDL files: give the folder the includes are in`)
      }
    }
  }
  for (const d0 of dirs) {
    const d = resolve(d0)
    if (!existsSync(d) || !statSync(d).isDirectory()) throw new ToolError(`include dir ${d} is not a folder`)
    walk(d, 0)
  }
  return out
}

/** The deepest folder holding every path given (files' folders and folders themselves). */
export function commonRoot(dirs: readonly string[]): string {
  if (!dirs.length) return process.cwd()
  let parts = resolve(dirs[0] as string).split(sep)
  for (const d of dirs.slice(1)) {
    const q = resolve(d).split(sep)
    let i = 0
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++
    parts = parts.slice(0, i)
  }
  return parts.join(sep) || sep
}

/** `include "file"` directives in Verilog/SystemVerilog text (comments removed first). */
export function includesOf(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...code.matchAll(/`include\s+"([^"\n]+)"/g)].map((m) => m[1] as string)
}

export interface HdlStage extends Staged {
  /** the source names, in the order given */
  sources: string[]
  /** each include folder's name in the tree ('.' for the top), for -I / +incdir+ */
  incdirs: string[]
  /** the files found by following `include directives (not given, not in an include folder) */
  followed: string[]
  /** the names of the other files given (testbench C++, Python modules), in order */
  extra: string[]
  root: string
}

/**
 * Stage HDL sources with their layout kept: the sources, every include-type file in the include folders, the files
 * the sources (and those files) `include` relative to their own folder or an include folder, and `extra` files, all
 * named relative to the deepest folder holding them.
 */
export function hdlStage(o: { files: readonly string[]; include_dirs?: readonly string[] | undefined; extra?: readonly string[] | undefined }): HdlStage {
  const files = o.files.map(needFile)
  const extra = (o.extra ?? []).map(needFile)
  const dirs = (o.include_dirs ?? []).map((d) => resolve(d))
  const incFiles = includeFiles(dirs)
  // follow `include from the sources: a file next to the source (or under an include dir) is staged with it
  const followed: string[] = []
  const seen = new Set<string>([...files, ...incFiles])
  const queue = [...files, ...incFiles]
  while (queue.length) {
    const f = queue.shift() as string
    if (!/\.(v|sv|vh|svh|vinc|inc)$/i.test(f)) continue
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const inc of includesOf(text)) {
      if (isAbsolute(inc)) continue
      const hit = [dirname(f), ...dirs].map((d) => resolve(d, inc)).find((c) => existsSync(c) && statSync(c).isFile())
      if (!hit || seen.has(hit)) continue
      seen.add(hit)
      followed.push(hit)
      queue.push(hit)
      if (seen.size > MAX_INCLUDE_FILES) throw new ToolError(`more than ${MAX_INCLUDE_FILES} included files`)
    }
  }
  const root = commonRoot([...[...files, ...incFiles, ...followed, ...extra].map((f) => dirname(f)), ...dirs])
  const st: Staged = { inputs: {}, names: [] }
  stage(files, st, root)
  const sources = files.map((f) => posix(relative(root, f)))
  stage([...incFiles, ...followed], st, root)
  stage(extra, st, root)
  const incdirs = dirs.map((d) => posix(relative(root, d)) || '.')
  return { ...st, sources, incdirs, followed: followed.map((f) => posix(relative(root, f))), extra: extra.map((f) => posix(relative(root, f))), root }
}

/** `-I{dir}/in/<incdir>` for each include folder, then for the folder of each source and each followed include (so
 * an include written relative to the including file resolves under any tool, Icarus without -grelative-include
 * included). */
export function includeArgs(h: Pick<HdlStage, 'incdirs' | 'sources' | 'followed'>, flag = '-I'): string[] {
  const dirOf = (s: string): string => (s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : '.')
  const dirs = [...h.incdirs, ...h.sources.map(dirOf), ...h.followed.map(dirOf)]
  return [...new Set(dirs)].map((d) => `${flag}{dir}/in${d === '.' ? '' : `/${d}`}`)
}

/**
 * The verification and FPGA programs of the tools image (agent/Dockerfile.tools), where these jobs run when the
 * project has its tools function: what haveProgram answers then. test/installer/images.test.ts checks the image
 * installs each.
 */
export const TOOLS_IMAGE_PROGRAMS: ReadonlySet<string> = new Set([
  'yosys', 'yosys-smtbmc', 'yosys-abc', 'z3', 'verilator', 'iverilog', 'vvp', 'cocotb-config',
  'nextpnr-ice40', 'nextpnr-ecp5', 'nextpnr-gowin', 'icepack', 'ecppack', 'gowin_pack', 'ccx',
])

/** Where this module's jobs run: every verification and FPGA kind is a FUNCTION_KINDS kind, so all go where one does. */
const jobsWhere = () => backendFor({ kind: 'verilator', gpu: false })

/** A program is needed here only when the job runs here; on the function or the queue the job's image provides it. */
export function needProgram(name: string, hint: string, envVar?: string): string {
  if (jobsWhere() !== 'local') return name
  const p = which(name, envVar)
  if (!p) throw new ToolError(`${name} is not installed here: ${hint}`)
  return p
}

/** Whether a program is there where the jobs run: this machine, or the tools image's (TOOLS_IMAGE_PROGRAMS; the GPU
 * image has the same set). */
export function haveProgram(name: string, envVar?: string): boolean {
  if (jobsWhere() !== 'local') return TOOLS_IMAGE_PROGRAMS.has(name)
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
