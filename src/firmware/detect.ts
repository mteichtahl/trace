/**
 * Detecting firmware projects in a directory tree, so onboarding (and firmware.detect) can propose firmware.targets
 * entries without anyone typing them.
 *
 * What is recognised, most specific first, per directory:
 *   cargo       Cargo.toml with an embedded target: .cargo/config.toml with a thumb/riscv32/xtensa `[build] target`
 *               or a probe-rs runner, or memory.x / an embassy/cortex-m/esp-hal dependency. The runner's --chip is
 *               the chip; the target triple and binary name give the artifact path.
 *   platformio  platformio.ini (its environments; the first is chosen, all are listed)
 *   zephyr      prj.conf with CMakeLists.txt naming find_package(Zephyr), or west.yml (a workspace manifest)
 *   esp-idf     CMakeLists.txt including $ENV{IDF_PATH}/tools/cmake/project.cmake, or sdkconfig(.defaults)
 *   pico-sdk    CMakeLists.txt with pico_sdk_import / pico_sdk_init
 *   arduino     a sketch: <dir>/<dir>.ino (or any *.ino)
 *   make        a Makefile with a `flash:` target or an arm-none-eabi toolchain
 *
 * Detection only reads files; it never runs a build tool.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { FirmwareTargetSchema, type FirmwareTarget } from '../core/config.js'

export interface Detected {
  target: FirmwareTarget
  /** why it was recognised, and what to check */
  evidence: string[]
}

const SKIP = new Set(['node_modules', '.git', 'target', 'build', '.pio', '.venv', 'venv', '__pycache__', 'dist', '.trace', 'out', 'cmake-build-debug', 'cmake-build-release', '.embuild', 'managed_components'])

const read = (p: string): string => {
  try {
    return statSync(p).size < 2_000_000 ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

const EMBEDDED_TRIPLE = /^(thumbv\d|riscv32|xtensa|armv\d|avr)/

/** A tiny TOML reader for what detection needs: [table] headers and `key = "string"` / `key = 'string'`. */
export function tomlStrings(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let table = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line) continue
    const t = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line)
    if (t?.[1]) { table = t[1].replace(/\s*\.\s*/g, '.'); continue }
    const kv = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line)
    if (kv?.[1]) out.set(`${table ? `${table}.` : ''}${kv[1].replace(/^["']|["']$/g, '')}`, kv[2] ?? kv[3] ?? '')
  }
  return out
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'firmware'
}

function cargo(dir: string, rel: string): Detected | null {
  const manifest = read(join(dir, 'Cargo.toml'))
  if (!manifest) return null
  const cfgText = read(join(dir, '.cargo', 'config.toml')) || read(join(dir, '.cargo', 'config'))
  const cfg = tomlStrings(cfgText)
  const triple = cfg.get('build.target')
  let runner: string | undefined
  for (const [k, v] of cfg) if (/^target\..*\.runner$/.test(k)) runner = v
  const embeddedDeps = /^\s*(embassy-[a-z0-9-]+|cortex-m(-rt)?|rp2040-hal|rp235x-hal|stm32[a-z0-9]*-hal|nrf52[0-9]*-hal|esp-hal|riscv-rt|defmt)\s*=/m.test(manifest)
  const evidence: string[] = []
  if (triple && EMBEDDED_TRIPLE.test(triple)) evidence.push(`.cargo/config.toml [build] target = ${triple}`)
  if (runner) evidence.push(`runner = ${runner}`)
  if (existsSync(join(dir, 'memory.x'))) evidence.push('memory.x')
  if (embeddedDeps) evidence.push('embedded crates in Cargo.toml')
  if (!evidence.length) return null
  const pkg = tomlStrings(manifest)
  const name = pkg.get('package.name') ?? basename(dir)
  // [[bin]] name wins over the package name
  const binMatch = /\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/s.exec(manifest)
  const bin = binMatch?.[1] ?? name
  const chip = runner ? /--chip[ =](\S+)/.exec(runner)?.[1] : undefined
  const target: Record<string, unknown> = { name: slug(name), path: rel || '.', preset: 'cargo' }
  if (chip) target.chip = chip
  if (triple) target.artifact = `target/${triple}/release/${bin}`
  else evidence.push(`no [build] target: the artifact defaults to target/release/${bin}`)
  if (runner && /probe-rs\s+run/.test(runner)) {
    // the runner flashes then streams RTT; keep it as the logs command, flash with download+verify
    evidence.push('flash: probe-rs download --verify; logs: probe-rs attach (defmt/RTT)')
  } else if (runner && /picotool|elf2uf2/.test(runner)) {
    target.flash = runner.includes('picotool') ? `${runner.trim()} {artifact}` : runner
    evidence.push('runner is picotool/elf2uf2: flash uses it (BOOTSEL over USB)')
  }
  if (!chip) evidence.push('no --chip in the runner: set chip for probe-rs')
  return { target: FirmwareTargetSchema.parse(target), evidence }
}

function platformio(dir: string, rel: string): Detected | null {
  const ini = read(join(dir, 'platformio.ini'))
  if (!ini) return null
  const envs = [...ini.matchAll(/^\[env:([^\]]+)\]/gm)].map((m) => m[1]!).filter(Boolean)
  const def = /^\s*default_envs\s*=\s*([^\s,]+)/m.exec(ini)?.[1]
  const env = def ?? envs[0]
  const t: Record<string, unknown> = { name: slug(basename(dir === '.' ? process.cwd() : dir)), path: rel || '.', preset: 'platformio' }
  if (env) { t.pio_env = env; t.artifact = `.pio/build/${env}/firmware.elf` }
  const board = env ? new RegExp(`\\[env:${env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^[]*?^\\s*board\\s*=\\s*(\\S+)`, 'ms').exec(ini)?.[1] : undefined
  if (board) t.chip = board
  return { target: FirmwareTargetSchema.parse(t), evidence: [`platformio.ini, environments: ${envs.join(', ') || 'none'}${def ? ` (default ${def})` : ''}`] }
}

function zephyr(dir: string, rel: string): Detected | null {
  const cm = read(join(dir, 'CMakeLists.txt'))
  const isApp = existsSync(join(dir, 'prj.conf')) && /find_package\s*\(\s*Zephyr/i.test(cm)
  const isWs = existsSync(join(dir, 'west.yml')) && /zephyr/i.test(read(join(dir, 'west.yml')))
  if (!isApp && !isWs) return null
  const t: Record<string, unknown> = { name: slug(basename(dir)), path: rel || '.', preset: 'zephyr' }
  const board = /set\s*\(\s*BOARD\s+(\S+?)\s*\)/i.exec(cm)?.[1]
  if (board) t.chip = board
  const ev = [isApp ? 'prj.conf and find_package(Zephyr)' : 'west.yml naming zephyr']
  if (!board) ev.push('set chip to the Zephyr board (west build -b <board>)')
  return { target: FirmwareTargetSchema.parse(t), evidence: ev }
}

function espIdf(dir: string, rel: string): Detected | null {
  const cm = read(join(dir, 'CMakeLists.txt'))
  const proj = /IDF_PATH[^\n]*project\.cmake/.test(cm)
  const sdk = existsSync(join(dir, 'sdkconfig')) || existsSync(join(dir, 'sdkconfig.defaults'))
  if (!proj && !(sdk && cm)) return null
  const name = /project\s*\(\s*([A-Za-z0-9_-]+)/.exec(cm)?.[1] ?? basename(dir)
  const t: Record<string, unknown> = { name: slug(name), path: rel || '.', preset: 'esp-idf', artifact: `build/${name}.elf` }
  const target = /CONFIG_IDF_TARGET="([^"]+)"/.exec(read(join(dir, 'sdkconfig')) || read(join(dir, 'sdkconfig.defaults')))?.[1]
  if (target) t.chip = target
  return { target: FirmwareTargetSchema.parse(t), evidence: [proj ? 'CMakeLists.txt includes IDF project.cmake' : 'sdkconfig with CMakeLists.txt'] }
}

function picoSdk(dir: string, rel: string): Detected | null {
  const cm = read(join(dir, 'CMakeLists.txt'))
  if (!/pico_sdk_import|pico_sdk_init/.test(cm)) return null
  const exe = /add_executable\s*\(\s*([A-Za-z0-9_-]+)/.exec(cm)?.[1]
  const project = /project\s*\(\s*([A-Za-z0-9_-]+)/.exec(cm)?.[1]
  const name = exe ?? project ?? basename(dir)
  const t: Record<string, unknown> = { name: slug(name), path: rel || '.', preset: 'pico-sdk', artifact: `build/${name}.elf` }
  const board = /set\s*\(\s*PICO_BOARD\s+(\S+?)\s*\)/.exec(cm)?.[1]
  const platform = /set\s*\(\s*PICO_PLATFORM\s+(\S+?)\s*\)/.exec(cm)?.[1]
  if (platform) t.chip = platform
  else if (board) t.chip = board
  return { target: FirmwareTargetSchema.parse(t), evidence: ['CMakeLists.txt uses pico_sdk_import', 'flash: picotool load (BOOTSEL over USB); with a debug probe use openocd "program … verify reset exit"'] }
}

function arduino(dir: string, rel: string): Detected | null {
  let inos: string[]
  try {
    inos = readdirSync(dir).filter((f) => f.endsWith('.ino'))
  } catch {
    return null
  }
  if (!inos.length) return null
  const main = inos.find((f) => f === `${basename(dir)}.ino`) ?? inos[0]!
  const t: Record<string, unknown> = { name: slug(main.replace(/\.ino$/, '')), path: rel || '.', preset: 'arduino' }
  const proj = read(join(dir, 'sketch.yaml'))
  const fqbn = /default_fqbn:\s*(\S+)/.exec(proj)?.[1] ?? /fqbn:\s*(\S+)/.exec(proj)?.[1]
  if (fqbn) t.chip = fqbn
  return { target: FirmwareTargetSchema.parse(t), evidence: [`sketch ${main}`, ...(fqbn ? [] : ['set chip to the board FQBN (arduino-cli board listall)'])] }
}

function make(dir: string, rel: string): Detected | null {
  const mk = read(join(dir, 'Makefile')) || read(join(dir, 'makefile')) || read(join(dir, 'GNUmakefile'))
  if (!mk) return null
  const flash = /^flash\s*:/m.test(mk)
  const cross = /arm-none-eabi-|riscv\d*-[a-z-]*-gcc|avr-gcc|xtensa-/.test(mk)
  if (!flash && !cross) return null
  const t: Record<string, unknown> = { name: slug(/^\s*(TARGET|PROJECT)\s*[:?]?=\s*(\S+)/m.exec(mk)?.[2] ?? basename(dir)), path: rel || '.', preset: 'make' }
  return { target: FirmwareTargetSchema.parse(t), evidence: [`Makefile${flash ? ' with a flash target' : ''}${cross ? ', cross toolchain' : ''}`, ...(flash ? [] : ['no flash: target in the Makefile; set flash'])] }
}

const DETECTORS = [cargo, platformio, espIdf, zephyr, picoSdk, arduino, make]

/** What one directory is, or null. */
export function detectDir(dir: string, root = dir): Detected | null {
  const rel = relative(root, dir) || '.'
  for (const d of DETECTORS) {
    const r = d(dir, rel)
    if (r) return r
  }
  return null
}

/** Every firmware project under `root` (to `depth` levels), with unique names. */
export function detectWithEvidence(root: string, depth = 4): Detected[] {
  const out: Detected[] = []
  const walk = (dir: string, level: number): void => {
    const hit = detectDir(dir, root)
    if (hit) {
      out.push(hit)
      // a Zephyr/west workspace or a cargo workspace member can nest; a found project's own tree is not searched
      return
    }
    if (level >= depth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries.sort()) {
      if (SKIP.has(e) || e.startsWith('.')) continue
      const p = join(dir, e)
      try {
        if (statSync(p).isDirectory()) walk(p, level + 1)
      } catch { /* unreadable */ }
    }
  }
  walk(root, 0)
  const seen = new Map<string, number>()
  for (const d of out) {
    const n = (seen.get(d.target.name) ?? 0) + 1
    seen.set(d.target.name, n)
    if (n > 1) d.target = { ...d.target, name: `${d.target.name}-${n}` }
  }
  return out
}

/** Onboarding's entry point: proposed firmware.targets for a repository. */
export function detectAll(repoRoot: string): FirmwareTarget[] {
  return detectWithEvidence(repoRoot).map((d) => d.target)
}
