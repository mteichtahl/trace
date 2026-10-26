/**
 * The firmware tools: the loop an agent runs on embedded code — detect the project, build it, see its size, flash it,
 * read what it prints.
 *
 * build and size run on the host (no hardware). flash and logs drive a target (hardware: true). Each is recorded in
 * the project database: the build log, flash output and captured logs are artifacts, sizes and counts are
 * measurements, and `run_id` comes back for trace.run / trace.artifact. A missing program is a ToolError naming its
 * install command; a stale or missing image is refused for flashing, with the build to run.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { printable, tail } from '../hil/bytes.js'
import { record } from '../hil/record.js'
import { serialPort, settings } from '../hil/resources.js'
import { capture, faultLines, SerialSession } from '../hil/serial.js'
import { detectWithEvidence } from './detect.js'
import { PRESETS } from './presets.js'
import { diagnostics, memoryRegions, parseSize, run, sizeTool, type Size } from './run.js'
import { artifactPath, command, freshness, repoRoot, requirePrograms, resolveTarget, type Resolved } from './target.js'

const targetArgs = {
  target: z.string().optional().describe('a target name from firmware.targets'),
  path: z.string().optional().describe('or a project folder (detected, or with preset)'),
  preset: z.enum(['cargo', 'pico-sdk', 'platformio', 'zephyr', 'esp-idf', 'arduino', 'make', 'custom']).optional(),
}

export const detect = defineTool({
  name: 'firmware.detect',
  description: 'Find firmware projects under a folder (cargo/embedded Rust, pico-sdk, PlatformIO, Zephyr, ESP-IDF, Arduino, make) and propose firmware.targets entries, with the evidence for each.',
  input: z.object({ path: z.string().default('.').describe('folder to search, relative to the repository'), depth: z.number().int().min(0).max(8).default(4) }),
  run: ({ path, depth }) => {
    const root = repoRoot()
    const dir = path.startsWith('/') ? path : join(root, path)
    if (!existsSync(dir)) throw new ToolError(`${path} does not exist`)
    const found = detectWithEvidence(dir, depth).map((d) => ({ ...d, target: { ...d.target, path: relative(root, join(dir, d.target.path)) || '.' } }))
    return {
      found: found.length,
      targets: found.map((d) => d.target),
      evidence: Object.fromEntries(found.map((d) => [d.target.name, d.evidence])),
      ...(found.length ? { configure: `trace config set firmware.targets '${JSON.stringify(found.map((d) => d.target))}'` } : {}),
    }
  },
})

export const targets = defineTool({
  name: 'firmware.targets',
  description: 'The configured firmware targets with their resolved build/flash/logs commands, artifact, and whether the artifact is current.',
  input: z.object({}),
  run: () => {
    const cfg = settings()
    return {
      targets: cfg.firmware.targets.map((t) => {
        const r = resolveTarget(t.name, undefined)
        const safe = (step: 'build' | 'flash' | 'logs'): string | null => {
          try {
            return command(r, step)
          } catch (e) {
            return `(${e instanceof Error ? e.message : String(e)})`
          }
        }
        return { name: t.name, preset: t.preset, path: t.path, chip: t.chip ?? null, build: safe('build'), flash: safe('flash'), logs: safe('logs') ?? (t.serial ? `serial: ${t.serial}` : null), artifact: freshness(r) }
      }),
    }
  },
})

// ------------------------------------------------------------------ size

async function measureSize(r: Resolved, artifact: string): Promise<{ size: Size; tool: string; regions: Record<string, number> } | null> {
  const tool = sizeTool()
  if (!tool) return null
  const res = await run(`${tool} ${JSON.stringify(artifact)}`, { cwd: r.dir, timeoutMs: 30_000 })
  const rows = parseSize(res.output)
  const size = rows[0]
  if (!size) return null
  const regions = memoryRegionsFor(r)
  return { size, tool, regions }
}

function memoryRegionsFor(r: Resolved): Record<string, number> {
  for (const f of ['memory.x', 'memmap.ld', 'link.ld', 'linker.ld']) {
    const p = join(r.dir, f)
    if (existsSync(p)) {
      try {
        return memoryRegions(readFileSync(p, 'utf8'))
      } catch { /* unreadable */ }
    }
  }
  return {}
}

function sizeSummary(s: { size: Size; tool: string; regions: Record<string, number> }): Record<string, unknown> {
  const flash = s.regions.FLASH ?? s.regions.ROM ?? s.regions.FLASH_TEXT
  const ram = s.regions.RAM ?? s.regions.SRAM
  return {
    text: s.size.text, data: s.size.data, bss: s.size.bss,
    flash_bytes: s.size.flash_bytes, ram_bytes: s.size.ram_bytes,
    ...(flash ? { flash_pct: Number(((s.size.flash_bytes / flash) * 100).toFixed(1)), flash_total: flash } : {}),
    ...(ram ? { ram_pct: Number(((s.size.ram_bytes / ram) * 100).toFixed(1)), ram_total: ram } : {}),
    tool: s.tool,
  }
}

// ------------------------------------------------------------------ build

export const build = defineTool({
  name: 'firmware.build',
  description: 'Build a firmware target: runs its build command with a timeout, keeps the full log in the run record, and returns status, duration, warning/error counts with the first errors (rustc, gcc/clang, ld), the artifact and its flash/RAM size.',
  input: z.object({
    ...targetArgs,
    command: z.string().optional().describe('override the build command for this run'),
    timeout_s: z.number().positive().max(7200).optional(),
    tail_lines: z.number().int().min(0).max(400).default(20),
  }),
  run: async (a) => {
    const r = resolveTarget(a.target, a.path, a.preset)
    const cmd = a.command ?? command(r, 'build')
    if (!cmd) throw new ToolError(`${r.target.name} has no build command; set build`)
    requirePrograms(r, 'build', cmd)
    return record('firmware.build', { subject: r.target.name, args: { ...a, command: cmd } }, async (rec) => {
      const res = await run(cmd, { cwd: r.dir, env: r.env, timeoutMs: (a.timeout_s ?? r.target.build_timeout_s) * 1000 })
      rec.artifact('build.log', res.output)
      const diag = diagnostics(res.output)
      const ok = res.code === 0 && !res.timed_out
      const fresh = freshness(r)
      let size: Record<string, unknown> | undefined
      const art = artifactPath(r)
      if (ok && art && existsSync(art)) {
        const s = await measureSize(r, art)
        if (s) {
          size = sizeSummary(s)
          rec.measure('flash_bytes', s.size.flash_bytes, 'B')
          rec.measure('ram_bytes', s.size.ram_bytes, 'B')
        }
      }
      rec.measure('seconds', res.seconds, 's')
      rec.measure('errors', diag.errors)
      rec.measure('warnings', diag.warnings)
      const status = ok ? 'pass' : diag.environment && !diag.errors ? 'error' : 'fail'
      const why = res.timed_out ? `timed out after ${res.seconds} s` : !ok ? `exit ${res.code ?? res.signal}` : 'ok'
      return {
        status,
        summary: `${r.target.name}: ${why}, ${diag.errors} errors, ${diag.warnings} warnings${size ? `, flash ${size.flash_bytes} B` : ''}`,
        result: {
          target: r.target.name, ok, command: cmd, exit_code: res.code, timed_out: res.timed_out, seconds: res.seconds,
          errors: diag.errors, warnings: diag.warnings, first_errors: diag.first_errors, first_warnings: diag.first_warnings,
          ...(diag.environment ? { environment: diag.environment } : {}),
          artifact: ok ? fresh.artifact : null, ...(ok && art && !existsSync(art) ? { note: `the build passed but ${relative(r.root, art)} was not found; set artifact` } : {}),
          ...(size ? { size } : {}),
          ...(a.tail_lines && (!ok || diag.errors) ? { tail: tail(res.output, a.tail_lines) } : {}),
        },
      }
    })
  },
})

export const size = defineTool({
  name: 'firmware.size',
  description: 'Flash and RAM use of a firmware image (text/data/bss from arm-none-eabi-size / llvm-size / size), as a share of FLASH/RAM when memory.x or the linker script gives them.',
  input: z.object({ ...targetArgs, artifact: z.string().optional().describe('an image path instead of the target’s') }),
  run: async (a) => {
    const r = a.artifact && !a.target && !a.path ? { target: { name: 'image', path: '.', preset: 'custom' as const, env: {}, build_timeout_s: 0, flash_timeout_s: 0 }, dir: repoRoot(), root: repoRoot(), env: {} } as Resolved : resolveTarget(a.target, a.path, a.preset)
    const art = a.artifact ? (a.artifact.startsWith('/') ? a.artifact : join(r.root, a.artifact)) : artifactPath(r)
    if (!art || !existsSync(art)) throw new ToolError(`${r.target.name}: no image at ${art ? relative(r.root, art) : '(unknown path)'}; run firmware.build first`)
    if (!sizeTool()) throw new ToolError('no size program: apt install binutils-arm-none-eabi (arm-none-eabi-size), or llvm (llvm-size), or cargo install cargo-binutils')
    return record('firmware.size', { subject: r.target.name, args: a }, async (rec) => {
      const s = await measureSize(r, art)
      if (!s) throw new ToolError(`${relative(r.root, art)}: the size program gave no text/data/bss (is it an ELF?)`)
      rec.measure('flash_bytes', s.size.flash_bytes, 'B')
      rec.measure('ram_bytes', s.size.ram_bytes, 'B')
      rec.measure('text', s.size.text, 'B')
      rec.measure('data', s.size.data, 'B')
      rec.measure('bss', s.size.bss, 'B')
      const out = sizeSummary(s)
      return { status: 'pass', summary: `flash ${s.size.flash_bytes} B, RAM ${s.size.ram_bytes} B`, result: { target: r.target.name, artifact: relative(r.root, art), ...out } }
    })
  },
})

// ------------------------------------------------------------------ flash

const PROBE_LINE = /error|fail|verif|erase|program|flash|finished|done|wrote|written|chip|probe|target|reset|hash|bytes|kib|%|warn/i

export const flash = defineTool({
  name: 'firmware.flash',
  description: 'Flash a firmware target with its flash command (probe-rs, openocd, picotool, pio, west, idf.py, arduino-cli, make flash), verifying where the tool supports it. Refused if the image is missing or older than the sources (run firmware.build).',
  hardware: true,
  input: z.object({
    ...targetArgs,
    command: z.string().optional().describe('override the flash command for this run'),
    allow_stale: z.boolean().default(false).describe('flash an image older than its sources anyway'),
    timeout_s: z.number().positive().max(3600).optional(),
  }),
  run: async (a) => {
    const r = resolveTarget(a.target, a.path, a.preset)
    const fresh = freshness(r)
    if (!fresh.exists) throw new ToolError(`${r.target.name}: no image to flash${fresh.artifact ? ` (${fresh.artifact} does not exist)` : ''}; run firmware.build target=${r.target.name} first`)
    if (fresh.stale && !a.allow_stale) throw new ToolError(`${r.target.name}: ${fresh.artifact} is older than ${fresh.newer_source}; run firmware.build target=${r.target.name} first (or allow_stale)`)
    const cmd = a.command ?? command(r, 'flash')
    if (!cmd) throw new ToolError(`${r.target.name} has no flash command; set flash`)
    requirePrograms(r, 'flash', cmd)
    return record('firmware.flash', { subject: r.target.name, args: { ...a, command: cmd } }, async (rec) => {
      const res = await run(cmd, { cwd: r.dir, env: r.env, timeoutMs: (a.timeout_s ?? r.target.flash_timeout_s) * 1000 })
      rec.artifact('flash.log', res.output)
      const ok = res.code === 0 && !res.timed_out
      const lines = res.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && PROBE_LINE.test(l))
      const verified = PRESETS[r.target.preset].verifies && !a.command
        ? ok
        : /verif(ied|y(ing)? (ok|succe|pass))|\bverified\b|hash of data verified/i.test(res.output) ? ok : null
      rec.measure('seconds', res.seconds, 's')
      const faults = res.output.split(/\r?\n/).filter((l) => /error|fail|no probe|not found|timed out|could not/i.test(l)).slice(0, 8)
      return {
        status: ok ? 'pass' : 'fail',
        summary: `${r.target.name}: ${ok ? 'flashed' : res.timed_out ? `timed out after ${res.seconds} s` : `failed (exit ${res.code ?? res.signal})`}${verified ? ', verified' : ''}`,
        result: {
          target: r.target.name, ok, verified, command: cmd, artifact: fresh.artifact, exit_code: res.code, timed_out: res.timed_out, seconds: res.seconds,
          probe_output: lines.slice(-12), ...(ok ? {} : { problems: faults, tail: tail(res.output, 15) }),
        },
      }
    })
  },
})

// ------------------------------------------------------------------ logs

export const logs = defineTool({
  name: 'firmware.logs',
  description: "Capture a target's logs for N seconds or until a regex: from its serial port (hil.serial) or over RTT/defmt with its logs command (probe-rs attach). The capture is recorded; returns the tail and any panic/HardFault/assert lines.",
  hardware: true,
  input: z.object({
    ...targetArgs,
    seconds: z.number().positive().max(3600).default(10),
    until: z.string().optional().describe('stop early when this regex matches'),
    source: z.enum(['auto', 'serial', 'rtt']).default('auto').describe('auto: the target’s serial port if it has one, else its logs command'),
    serial: z.string().optional().describe('a hil.serial name (overrides the target’s)'),
    command: z.string().optional().describe('override the logs command'),
    tail_lines: z.number().int().min(1).max(500).default(30),
  }),
  run: async (a) => {
    const r = resolveTarget(a.target, a.path, a.preset)
    let until: RegExp | undefined
    try { until = a.until ? new RegExp(a.until, 'm') : undefined } catch (e) { throw new ToolError(`until: ${e instanceof Error ? e.message : String(e)}`) }
    const serialName = a.serial ?? r.target.serial
    const useSerial = a.source === 'serial' || (a.source === 'auto' && !!serialName && !a.command)
    if (useSerial) {
      if (!serialName) throw new ToolError(`${r.target.name} has no serial port; set serial on the target (a hil.serial name) or pass serial`)
      const cfg = serialPort(serialName)
      return record('firmware.logs', { subject: r.target.name, args: a }, async (rec) => {
        const s = await SerialSession.open(cfg)
        try {
          const c = await capture(s, a.seconds, until)
          const text = printable(c.data)
          rec.artifact('logs.txt', c.data, 'text/plain')
          const faults = faultLines(text)
          rec.measure('faults', faults.length)
          return {
            status: faults.length ? 'fail' : 'pass',
            summary: `${r.target.name}: ${text.split('\n').length} lines over ${s.path}${faults.length ? `, ${faults.length} fault lines` : ''}`,
            result: { target: r.target.name, source: `serial ${s.path}`, seconds: c.seconds, stopped_on_match: c.stopped, bytes: c.data.length, faults, tail: tail(text, a.tail_lines) },
          }
        } finally {
          await s.close()
        }
      })
    }
    const cmd = a.command ?? command(r, 'logs')
    if (!cmd) throw new ToolError(`${r.target.name}: no logs command for preset ${r.target.preset} and no serial port; set logs (e.g. probe-rs attach --chip <chip> <elf>) or serial`)
    requirePrograms(r, 'logs', cmd)
    if (/\{artifact\}/.test(r.target.logs ?? PRESETS[r.target.preset].logs ?? '')) {
      const f = freshness(r)
      if (!f.exists) throw new ToolError(`${r.target.name}: defmt decoding needs the image (${f.artifact ?? 'artifact'}); run firmware.build first`)
    }
    return record('firmware.logs', { subject: r.target.name, args: { ...a, command: cmd } }, async (rec) => {
      const res = await run(cmd, { cwd: r.dir, env: r.env, timeoutMs: a.seconds * 1000, until })
      rec.artifact('logs.txt', res.output)
      const faults = faultLines(res.output)
      // a monitor normally runs until we stop it: exiting on its own before the time is up means it failed to attach
      const early = !res.timed_out && !res.matched && res.code !== 0
      rec.measure('faults', faults.length)
      return {
        status: early ? 'error' : faults.length ? 'fail' : 'pass',
        summary: `${r.target.name}: ${early ? `logs command exited (${res.code ?? res.signal})` : `${res.output.split('\n').length} lines over RTT`}${faults.length ? `, ${faults.length} fault lines` : ''}`,
        result: {
          target: r.target.name, source: 'command', command: cmd, seconds: res.seconds, stopped_on_match: res.matched,
          ...(early ? { exited: res.code ?? res.signal } : {}), faults, tail: tail(res.output, a.tail_lines),
        },
      }
    })
  },
})

/** The firmware tools. */
export const tools: AnyTool[] = [detect, targets, build, size, flash, logs] as unknown as AnyTool[]
