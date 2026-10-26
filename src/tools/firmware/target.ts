/**
 * A firmware target, resolved: its folder, its commands (its own or its preset's, placeholders filled), its artifact,
 * and whether that artifact is current.
 *
 * "Current" means the artifact is newer than every source file in the target's folder (sources: .rs .c .h .cpp .hpp
 * .S .s .ino .ld .x .toml .cmake CMakeLists.txt Makefile prj.conf sdkconfig platformio.ini Kconfig*, outside build
 * output folders). Flashing a stale image is the classic way to debug the wrong code, so flash refuses it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { FirmwareTargetSchema, type FirmwareTarget } from '../../core/config.js'
import { ToolError } from '../../core/registry.js'
import { detectDir, tomlStrings } from './detect.js'
import { PRESETS, fill, type Step } from './presets.js'
import { abs, programsIn, which } from './run.js'
import { serialPort, settings } from '../hil/resources.js'

export interface Resolved {
  target: FirmwareTarget
  /** absolute folder */
  dir: string
  root: string
  env: Record<string, string>
}

export function repoRoot(): string {
  return settings().root ?? process.cwd()
}

/** A target by name from firmware.targets, or one detected/declared at `path`. */
export function resolveTarget(name: string | undefined, path: string | undefined, preset?: FirmwareTarget['preset']): Resolved {
  const cfg = settings()
  const root = cfg.root ?? process.cwd()
  let target: FirmwareTarget | undefined
  if (name) {
    target = cfg.firmware.targets.find((t) => t.name === name)
    if (!target) throw new ToolError(`no firmware target ${JSON.stringify(name)} in firmware.targets (have: ${cfg.firmware.targets.map((t) => t.name).join(', ') || 'none'}; firmware.detect proposes some)`)
  } else if (path) {
    const dir = abs(root, path)
    if (!existsSync(dir)) throw new ToolError(`${path} does not exist`)
    if (preset) target = FirmwareTargetSchema.parse({ name: basename(dir).replace(/[^A-Za-z0-9_.-]/g, '-') || 'firmware', path: relative(root, dir) || '.', preset })
    else {
      const d = detectDir(dir, root)
      if (!d) throw new ToolError(`${path}: not a firmware project trace recognises (cargo, pico-sdk, platformio, zephyr, esp-idf, arduino, make); give preset`)
      target = d.target
    }
  } else {
    const only = cfg.firmware.targets
    if (only.length === 1 && only[0]) target = only[0]
    else throw new ToolError(only.length ? `name a target: ${only.map((t) => t.name).join(', ')}` : 'name a target or give path (firmware.targets is empty; firmware.detect proposes entries)')
  }
  const dir = abs(root, target.path)
  if (!existsSync(dir)) throw new ToolError(`${target.name}: folder ${target.path} does not exist`)
  return { target, dir, root, env: { ...target.env } }
}

/** cargo: the [build] target triple and the binary name, for the default artifact path. */
function cargoFacts(dir: string): { triple?: string; bin?: string } {
  const out: { triple?: string; bin?: string } = {}
  for (const f of [join(dir, '.cargo', 'config.toml'), join(dir, '.cargo', 'config')]) {
    if (existsSync(f)) {
      const t = tomlStrings(readText(f)).get('build.target')
      if (t) out.triple = t
      break
    }
  }
  const manifest = readText(join(dir, 'Cargo.toml'))
  const bin = /\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/s.exec(manifest)?.[1] ?? tomlStrings(manifest).get('package.name')
  if (bin) out.bin = bin
  return out
}

function readText(p: string): string {
  try {
    return statSync(p).isFile() ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

/** Expand a pattern with one `*` in its last segment against the filesystem; newest match first. */
function glob(dir: string, pattern: string): string[] {
  const full = join(dir, pattern)
  if (!full.includes('*')) return existsSync(full) ? [full] : []
  const slash = full.lastIndexOf('/', full.indexOf('*'))
  const parent = full.slice(0, slash)
  const rest = full.slice(slash + 1)
  const [seg, ...more] = rest.split('/')
  const re = new RegExp(`^${(seg ?? '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return []
  }
  const hits = names.filter((n) => re.test(n)).map((n) => join(parent, n, ...more)).filter((p) => existsSync(p))
  return hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/** The artifact's absolute path (it may not exist yet), or null when none can be worked out. */
export function artifactPath(r: Resolved): string | null {
  const t = r.target
  if (t.artifact) return abs(r.dir, t.artifact)
  const facts = t.preset === 'cargo' ? cargoFacts(r.dir) : {}
  for (const pat of PRESETS[t.preset].artifact) {
    let p = pat
    if (p.includes('{triple}')) { if (!facts.triple) continue; p = p.replace('{triple}', facts.triple) }
    if (p.includes('{bin}')) { if (!facts.bin) continue; p = p.replace('{bin}', facts.bin) }
    if (p.includes('{pio_env}')) { if (!t.pio_env) continue; p = p.replace('{pio_env}', t.pio_env) }
    const hits = glob(r.dir, p)
    if (hits[0]) return hits[0]
    if (!p.includes('*')) return join(r.dir, p)
  }
  return null
}

const SOURCE = /\.(rs|c|h|cc|cpp|cxx|hpp|hh|S|s|asm|ino|ld|x|toml|cmake|conf|overlay|dts|dtsi|yml|yaml|lock)$|^(CMakeLists\.txt|Makefile|makefile|GNUmakefile|Kconfig.*|sdkconfig(\.defaults)?|platformio\.ini|prj\.conf|memory\.x|build\.rs)$/
const OUTPUT_DIRS = new Set(['target', 'build', '.pio', 'node_modules', '.git', 'dist', 'out', '.trace', '.embuild', 'managed_components', 'cmake-build-debug', 'cmake-build-release'])

/** The newest source file under `dir` (bounded walk). */
export function newestSource(dir: string, limit = 20_000): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null
  let seen = 0
  const walk = (d: string, depth: number): void => {
    if (depth > 8 || seen > limit) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const e of entries) {
      if (OUTPUT_DIRS.has(e) || (e.startsWith('.') && e !== '.cargo')) continue
      const p = join(d, e)
      let st
      try { st = statSync(p) } catch { continue }
      seen++
      if (st.isDirectory()) walk(p, depth + 1)
      else if (SOURCE.test(e) && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs }
    }
  }
  walk(dir, 0)
  return best
}

export interface Freshness {
  artifact: string | null
  exists: boolean
  stale: boolean
  newer_source?: string
  age_s?: number
}

export function freshness(r: Resolved): Freshness {
  const a = artifactPath(r)
  if (!a || !existsSync(a)) return { artifact: a ? relative(r.root, a) : null, exists: false, stale: true }
  const at = statSync(a).mtimeMs
  const src = newestSource(r.dir)
  const stale = src !== null && src.mtime > at + 1
  return { artifact: relative(r.root, a), exists: true, stale, ...(stale && src ? { newer_source: relative(r.root, src.path) } : {}), age_s: Math.round((Date.now() - at) / 1000) }
}

/** The command for a step, filled in; null when the target has none for that step. */
export function command(r: Resolved, step: Step, extra: Record<string, string | undefined> = {}): string | null {
  const t = r.target
  const own = step === 'build' ? t.build : step === 'flash' ? t.flash : t.logs
  const tmpl = own ?? (step === 'build' ? PRESETS[t.preset].build : step === 'flash' ? PRESETS[t.preset].flash : PRESETS[t.preset].logs)
  if (tmpl === null || tmpl === undefined || tmpl === '') return null
  let port: string | undefined
  if (t.serial && /\{port\}|_port_arg\}/.test(tmpl)) port = serialPort(t.serial).port
  const art = /\{artifact\}/.test(tmpl) ? artifactPath(r) ?? undefined : undefined
  const q = (s: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
  const values: Record<string, string | undefined> = {
    chip: t.chip,
    probe: t.probe,
    probe_arg: t.probe ? ` --probe ${q(t.probe)}` : '',
    artifact: art ? q(art) : undefined,
    port,
    path: q(r.dir),
    pio_env: t.pio_env,
    pio_env_arg: t.pio_env ? ` -e ${q(t.pio_env)}` : '',
    upload_port_arg: port ? ` --upload-port ${q(port)}` : '',
    monitor_port_arg: port ? ` -p ${q(port)}` : '',
    idf_port_arg: port ? ` -p ${q(port)}` : '',
    ...extra,
  }
  return fill(tmpl, values, t.name)
}

/** Every program the command needs that is not on PATH → a ToolError naming the install command. */
export function requirePrograms(r: Resolved, step: Step, cmd: string): void {
  const known = new Map(Object.values(PRESETS).flatMap((p) => Object.values(p.programs).flat()).map((x) => [x.name, x.install]))
  const missing = programsIn(cmd).filter((p) => !which(p, r.env.PATH ?? process.env.PATH))
  if (missing.length) {
    const how = missing.map((m) => `${m}: ${known.get(m) ?? 'install it, or put it on PATH'}`)
    throw new ToolError(`${r.target.name} ${step} needs ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not on PATH — ${how.join('; ')}`)
  }
}
