/**
 * Which KiCad project a tool works on, where its files are, and where kicad-cli is.
 *
 * A KiCad project is a `name.kicad_pro` with `name.kicad_sch` (the root sheet) and `name.kicad_pcb` beside it. The
 * tools accept a path to any of the three (or to a directory holding exactly one project). With no path they use the
 * projects listed in the repository's settings (`electronics.projects`, relative to the repository root) or, when
 * that list is empty, every `*.kicad_pro` found under the repository. More than one candidate and no choice is an
 * error that lists them: a tool never picks one silently.
 *
 * The KiCad version that last wrote a file comes from its header: newer files carry `(generator_version "9.0")`;
 * older ones only the file-format date `(version 20231120)`, which maps to the release that introduced it.
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { ToolError } from '../core/registry.js'

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'build', 'dist', '.trace'])

/** file-format version (YYYYMMDD) → the first KiCad release writing it, newest first */
const FORMAT_RELEASES: readonly [number, string][] = [[20250000, '9'], [20231120, '8'], [20221018, '7'], [20211014, '6'], [0, '5 or older']]

export interface Project {
  readonly name: string
  readonly pro: string | null
  readonly sch: string | null
  readonly pcb: string | null
  readonly dir: string
}

export function needSch(p: Project): string {
  if (!p.sch) throw new ToolError(`project ${p.name} has no schematic (${join(p.dir, `${p.name}.kicad_sch`)} is missing)`)
  return p.sch
}

export function needPcb(p: Project): string {
  if (!p.pcb) throw new ToolError(`project ${p.name} has no board (${join(p.dir, `${p.name}.kicad_pcb`)} is missing)`)
  return p.pcb
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** A project from a .kicad_pro, .kicad_sch, .kicad_pcb, or a directory holding exactly one .kicad_pro. */
export function fromPath(path: string): Project {
  let p = resolve(path)
  if (!existsSync(p)) throw new ToolError(`${p} does not exist`)
  if (isDir(p)) {
    const pros = readdirSync(p).filter((f) => f.endsWith('.kicad_pro')).sort()
    if (pros.length !== 1) {
      throw new ToolError(`${p} holds ${pros.length} .kicad_pro files; name one${pros.length ? `: ${pros.join(', ')}` : ''}`)
    }
    p = join(p, pros[0] as string)
  }
  const ext = extname(p)
  if (!['.kicad_pro', '.kicad_sch', '.kicad_pcb'].includes(ext)) throw new ToolError(`${p} is not a KiCad project, schematic or board file`)
  const stem = p.slice(0, -ext.length)
  const at = (e: string): string | null => (existsSync(stem + e) ? stem + e : null)
  return {
    name: basename(stem),
    pro: at('.kicad_pro'),
    sch: ext === '.kicad_sch' ? p : at('.kicad_sch'), // a sub-sheet named explicitly is read as its own root
    pcb: at('.kicad_pcb'),
    dir: dirname(p),
  }
}

/** Every *.kicad_pro under root, skipping VCS, dependency, build and KiCad backup folders. */
export function discover(root: string): string[] {
  const out: string[] = []
  const visit = (d: string, depth: number): void => {
    if (depth > 12) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.kicad_pro')) out.push(join(d, e.name))
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !e.name.endsWith('-backups')) visit(join(d, e.name), depth + 1)
    }
  }
  visit(root, 0)
  return out
}

/** The repository root and the project files a tool may choose from. */
export async function candidates(): Promise<{ root: string; files: string[] }> {
  let root = process.cwd()
  let listed: string[] = []
  try {
    const { load } = await import('../core/config.js')
    const cfg = load(undefined, { strict: false })
    root = cfg.root ?? root
    listed = cfg.electronics.projects
  } catch {
    // no readable settings: discover from the working directory
  }
  if (listed.length) return { root, files: listed.map((p) => resolve(root, p)) }
  return { root, files: discover(root) }
}

/** The project a tool should use: the given path, or the single configured/discovered one. */
export async function resolveProject(project?: string): Promise<Project> {
  const { root, files } = await candidates()
  if (project) {
    const p = isAbsolute(project) || existsSync(project) ? project : resolve(root, project)
    return fromPath(p)
  }
  if (!files.length) {
    throw new ToolError(`no KiCad project found under ${root}; pass project=<path to .kicad_pro/.kicad_sch/.kicad_pcb> or list it in electronics.projects`)
  }
  if (files.length > 1) {
    const names = files.slice(0, 20).map((f) => relative(root, f) || f)
    throw new ToolError(`${files.length} KiCad projects found; pass project=<one of>: ${names.join(', ')}${files.length > 20 ? ', …' : ''}`)
  }
  return fromPath(files[0] as string)
}

export function relTo(root: string | null, p: string | null): string | null {
  if (p === null) return null
  if (!root) return p
  const r = relative(root, p)
  return r.startsWith('..') ? p : r
}

export interface FileVersion {
  format: number | null
  generator: string | null
  generator_version: string | null
  kicad: string | null
}

/** The version information in a KiCad file's header (its first 4 kB). */
export function fileVersion(path: string): FileVersion {
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(4096)
  let n = 0
  try {
    n = readSync(fd, buf, 0, 4096, 0)
  } finally {
    closeSync(fd)
  }
  const hdr = buf.subarray(0, n).toString('utf8')
  const v = /\(version\s+(\d+)\)/.exec(hdr)
  const g = /\(generator_version\s+"([^"]+)"\)/.exec(hdr)
  const gen = /\(generator\s+"?([^\s")]+)"?\)/.exec(hdr)
  const format = v ? Number(v[1]) : null
  let kicad: string | null = null
  if (g?.[1]) kicad = g[1].split('.')[0] ?? null
  else if (format !== null) kicad = FORMAT_RELEASES.find(([d]) => format >= d)?.[1] ?? null
  return { format, generator: gen?.[1] ?? null, generator_version: g?.[1] ?? null, kicad }
}

export function summary(p: Project, root: string | null): Record<string, string | null> {
  return {
    name: p.name,
    pro: relTo(root, p.pro),
    sch: relTo(root, p.sch),
    pcb: relTo(root, p.pcb),
    sch_kicad_version: p.sch ? fileVersion(p.sch).kicad : null,
    pcb_kicad_version: p.pcb ? fileVersion(p.pcb).kicad : null,
  }
}

// ------------------------------------------------------------------ kicad-cli

const INSTALL_PATHS = [
  '/usr/bin/kicad-cli',
  '/usr/local/bin/kicad-cli',
  '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli',
  'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe',
  'C:\\Program Files\\KiCad\\9.0\\bin\\kicad-cli.exe',
  'C:\\Program Files\\KiCad\\8.0\\bin\\kicad-cli.exe',
]

function onPath(cmd: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const d of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!d) continue
    for (const e of exts) {
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

/** Path to kicad-cli: $KICAD_CLI, then PATH, then the usual install locations; null when none is found. */
export function findKicadCli(): string | null {
  const env = process.env.KICAD_CLI
  if (env && existsSync(env)) return env
  return onPath('kicad-cli') ?? INSTALL_PATHS.find((p) => existsSync(p)) ?? null
}

export function kicadCli(): string {
  const cli = findKicadCli()
  if (!cli) {
    throw new ToolError('this needs kicad-cli (KiCad 7 or newer), which is not installed or not on PATH (set KICAD_CLI to its path)')
  }
  return cli
}

export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run a program with a timeout, never throwing for a non-zero exit (the caller decides). */
export function runProgram(cmd: string, args: readonly string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<CliResult> {
  const timeout = opts.timeoutMs ?? 600_000
  return new Promise((done, fail) => {
    execFile(cmd, [...args], { timeout, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return fail(new ToolError(`${cmd} is not installed`))
        if (err && (err as { killed?: boolean }).killed) {
          return fail(new ToolError(`${basename(cmd)} ${args.slice(0, 3).join(' ')} timed out after ${Math.round(timeout / 1000)} s`))
        }
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
        done({ code, stdout: String(stdout), stderr: String(stderr) })
      })
  })
}

/** Run kicad-cli; an exit code outside `okCodes` becomes a ToolError carrying its output. */
export async function runCli(args: readonly string[], opts: { timeoutMs?: number; okCodes?: readonly number[]; cwd?: string } = {}): Promise<CliResult> {
  const r = await runProgram(kicadCli(), args, opts)
  if (!(opts.okCodes ?? [0]).includes(r.code)) {
    const msg = (r.stderr || r.stdout).trim().slice(-1500)
    throw new ToolError(`kicad-cli ${args.slice(0, 3).join(' ')} failed (exit ${r.code}): ${msg}`)
  }
  return r
}

let versionCache: { cli: string; version: string | null } | null = null

/** kicad-cli's version ("10.0.7"), or null when it is missing or does not answer. */
export async function kicadCliVersion(): Promise<string | null> {
  const cli = findKicadCli()
  if (!cli) return null
  if (versionCache?.cli === cli) return versionCache.version
  let version: string | null = null
  try {
    const r = await runProgram(cli, ['version'], { timeoutMs: 60_000 })
    version = r.code === 0 ? r.stdout.trim() || null : null
  } catch {
    version = null
  }
  versionCache = { cli, version }
  return version
}
