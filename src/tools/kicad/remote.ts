/**
 * kicad-cli where it is not installed: the call runs as a job (kind kicad) on the tools function, or the queue (runJob,
 * src/gpu/jobs.ts), and comes back as if it had run here. Used by ./project.ts kicadRun when this machine has no
 * kicad-cli (an AgentCore runtime: KiCad is in the tools image, not the runtime's: agent/Dockerfile.tools).
 *
 * Every trace call of kicad-cli is `kicad-cli <command> … -o <output> <input file>`. KiCad reads more than the input
 * (the project's other sheets, its rules and settings, its library tables and the libraries they name, its 3D and
 * SPICE models), so what travels is the project's KiCad files, in one archive (an archive keeps names as they are:
 * KiCad files often have spaces in theirs):
 *
 *   base     the repository the project is in (its nearest folder holding .git), else the project's own folder: a
 *            library table's ${KIPRJMOD}/../lib/… resolves inside it
 *   files    under base, those KiCad reads (PACK_EXTENSIONS, PACK_NAMES), skipping hidden folders, node_modules and
 *            KiCad's own *-backups; at most PACK_MAX_BYTES
 *   args     an argument that is a path under base becomes @PROJECT@/<its path in base>; the output becomes
 *            @OUT@/<its name> (src/gpu/kicad-job.ts)
 *   back     the output (a file, or a folder: written into the folder given, as here) where the caller named it, with
 *            the job's folders replaced by the caller's own in its text files (a netlist names its schematic, a
 *            SPICE netlist its model files)
 *
 * A library outside base (an absolute path in a library table) is not sent: in the tools image KiCad's own libraries
 * are where KiCad expects them, anything else is reported by kicad-cli as missing.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { scratchDir } from '../../core/store.js'
import { runJob } from '../../gpu/jobs.js'
import { OUT_TOKEN, PROJECT_TOKEN, SIDECAR } from '../../gpu/kicad-job.js'
import type { CliResult } from './project.js'

/** Where src/gpu/kicad-job.ts is in the tools and GPU images. */
export const KICAD_JOB_SCRIPT = '/app/dist/gpu/kicad-job.js'
/** The files KiCad reads for a project: its own formats, 3D models, SPICE models and the images a sheet may embed. */
export const PACK_EXTENSIONS: ReadonlySet<string> = new Set([
  '.kicad_pro', '.kicad_prl', '.kicad_sch', '.kicad_pcb', '.kicad_sym', '.kicad_mod', '.kicad_dru', '.kicad_wks', '.kicad_jobset',
  '.step', '.stp', '.stpz', '.wrl', '.wrz',
  '.lib', '.sub', '.mod', '.cir', '.spice', '.inc', '.model',
])
export const PACK_NAMES: ReadonlySet<string> = new Set(['sym-lib-table', 'fp-lib-table', 'design-block-lib-table'])
export const PACK_MAX_BYTES = 1024 ** 3

const skipDir = (name: string): boolean => name.startsWith('.') || name === 'node_modules' || name === '__pycache__' || name.endsWith('-backups')

/** The folder whose KiCad files travel: the nearest folder above the project holding .git, else the project's. */
export function packBase(projectFile: string): string {
  const own = dirname(resolve(projectFile))
  for (let d = own, i = 0; i < 12; i++) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return own
}

/** The KiCad files under `base`, as paths relative to it ('/'-separated), sorted; refuses more than `max` bytes. */
export function packFiles(base: string, max = PACK_MAX_BYTES): string[] {
  const out: string[] = []
  let bytes = 0
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel ? join(base, rel) : base).sort()) {
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(base, r))
      if (st.isDirectory()) { if (!skipDir(name)) walk(r); continue }
      if (!st.isFile() || !(PACK_EXTENSIONS.has(extname(name).toLowerCase()) || PACK_NAMES.has(name))) continue
      bytes += st.size
      if (bytes > max) throw new ToolError(`the KiCad files under ${base} are over ${Math.round(max / 1024 ** 2)} MB, too much to send with the job`)
      out.push(r)
    }
  }
  walk('')
  return out
}

function tar(args: string[], what: string): void {
  const r = spawnSync('tar', args, { encoding: 'utf8' })
  if (r.error || r.status !== 0) throw new ToolError(`could not ${what}: ${(r.stderr || r.error?.message || '').trim().slice(-500)}`)
}

/** The project's archive at `tarPath`. */
export function packProject(base: string, tarPath: string): number {
  const files = packFiles(base)
  const list = `${tarPath}.list`
  writeFileSync(list, files.map((f) => `${f}\0`).join(''))
  try {
    tar(['-cf', tarPath, '-C', base, '--null', '-T', list], 'pack the KiCad project')
  } finally {
    rmSync(list, { force: true })
  }
  return files.length
}

export interface RemotePlan {
  /** the folder sent; null when no argument is a file (kicad-cli version) */
  base: string | null
  /** kicad-cli's arguments, with @PROJECT@ and @OUT@ */
  args: string[]
  /** where the caller wants the output, its name in @OUT@, and whether it is a folder; null: no output */
  out: { local: string; name: string; kind: 'file' | 'dir' } | null
}

const under = (base: string, p: string): boolean => p === base || p.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)

/** How kicad-cli's arguments are sent (the header's base, args and back), relative paths taken from `cwd`. */
export function plan(args: readonly string[], cwd?: string): RemotePlan {
  const abs = (a: string): string | null => {
    if (a.startsWith('-')) return null
    const p = isAbsolute(a) ? a : cwd ? resolve(cwd, a) : null
    return p && existsSync(p) ? p : null
  }
  const oi = args.findIndex((a) => a === '-o' || a === '--output')
  const outArg = oi >= 0 ? args[oi + 1] : undefined
  const outLocal = outArg === undefined ? null : resolve(cwd ?? '.', outArg)
  const last = args.length ? args[args.length - 1] as string : undefined
  const input = last !== undefined && args.length - 1 !== oi + 1 ? abs(last) : null
  const base = input && statSync(input).isFile() ? packBase(input) : null
  const out = outLocal ? { local: outLocal, name: basename(outLocal), kind: (existsSync(outLocal) && statSync(outLocal).isDirectory() ? 'dir' : 'file') as 'file' | 'dir' } : null
  const mapped = args.map((a, i) => {
    if (out && i === oi + 1) return `${OUT_TOKEN}/${out.name}`
    const p = base ? abs(a) : null
    return p && base && under(base, p) ? `${PROJECT_TOKEN}/${relative(base, p).split(sep).join('/')}` : a
  })
  return { base, args: mapped, out }
}

/** Put the caller's folders back where the job's appear, in the text files under `root` (a file with a NUL in its
 * first 8 kB, or over 64 MB, is left as it is). */
export function restorePaths(root: string, swaps: readonly [string, string][]): void {
  const fix = (p: string): void => {
    const st = statSync(p)
    if (st.isDirectory()) { for (const n of readdirSync(p)) fix(join(p, n)); return }
    if (st.size > 64 * 1024 ** 2) return
    const b = readFileSync(p)
    if (b.subarray(0, 8192).includes(0)) return
    let t = b.toString('utf8')
    let changed = false
    for (const [from, to] of swaps) if (from && t.includes(from)) { t = t.split(from).join(to); changed = true }
    if (changed) writeFileSync(p, t)
  }
  if (existsSync(root)) fix(root)
}

/** kicad-cli's run as a job, its output put where the caller asked, as runProgram answers. */
export async function runKicadRemote(args: readonly string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<CliResult> {
  const p = plan(args, opts.cwd)
  const timeoutSeconds = Math.max(10, Math.ceil((opts.timeoutMs ?? 600_000) / 1000))
  if (!p.base && !p.out) {
    const r = await runJob({ kind: 'kicad', argv: ['kicad-cli', ...p.args], timeoutSeconds })
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
  const work = scratchDir('trace-kicad-job-')
  try {
    const inputs: Record<string, string> = {}
    if (p.base) {
      const t = join(work, 'project.tar')
      packProject(p.base, t)
      inputs['project.tar'] = t
    } else {
      // nothing of a project to send (an output only): an empty archive
      const empty = join(work, 'empty')
      mkdirSync(empty)
      tar(['-cf', join(work, 'project.tar'), '-C', empty, '.'], 'make an empty archive')
      inputs['project.tar'] = join(work, 'project.tar')
    }
    const out = p.out ?? { local: '', name: 'none', kind: 'file' as const }
    const r = await runJob({
      kind: 'kicad', timeoutSeconds, inputs, outputs: ['out.tar'],
      argv: ['node', KICAD_JOB_SCRIPT, '{in:project.tar}', '{out:out.tar}', '{dir}', out.name, out.kind, '--', ...p.args],
    })
    const got = r.outputs['out.tar']
    if (p.out && got) {
      const x = join(work, 'out')
      mkdirSync(x)
      tar(['-xf', got, '-C', x], 'unpack the KiCad job\'s output')
      let used: { project?: string; out?: string } = {}
      try { used = JSON.parse(readFileSync(join(x, SIDECAR), 'utf8')) as typeof used } catch { /* none: nothing to put back */ }
      const swaps: [string, string][] = []
      if (used.project && p.base) swaps.push([used.project, p.base])
      if (used.out) swaps.push([used.out, dirname(p.out.local)])
      const made = join(x, p.out.name)
      if (existsSync(made)) {
        restorePaths(made, swaps)
        mkdirSync(dirname(p.out.local), { recursive: true })
        if (statSync(made).isDirectory()) cpSync(made, p.out.local, { recursive: true, force: true })
        else copyFileSync(made, p.out.local)
      }
    }
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
