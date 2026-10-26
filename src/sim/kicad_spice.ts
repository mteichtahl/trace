/**
 * A KiCad schematic as a SPICE netlist, simulated.
 *
 * `kicad-cli sch export netlist --format spice` writes the schematic's netlist using each symbol's simulation model
 * fields (Sim.Device, Sim.Params, …). Symbols without a usable model come out as lines ngspice cannot read (a bare
 * "U101 __U101"), so they are listed, and either dropped (commented out, with `dropUnmodelled`) or replaced. The caller
 * can then replace any component's line, remove components, and add lines (sources, loads, models, directives), so a
 * board schematic becomes a test bench without editing the schematic. KiCad names the ground net GND, which ngspice
 * reads as node 0.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { scratchDir } from '../core/store.js'
import { run, which } from './proc.js'
import { SpiceError } from './spice.js'

export function kicadCli(): string | null {
  return which('kicad-cli', 'KICAD_CLI')
}

export interface KicadNetlistOptions {
  schematic: string
  /** Component reference → its replacement line ("V1 VIN 0 DC 12") or null to remove it. */
  replace?: Readonly<Record<string, string | null>>
  /** Lines appended (sources, loads, .model, .include, .param, .options). */
  add?: readonly string[]
  /** Comment out components that have no simulation model. */
  dropUnmodelled?: boolean
  timeoutMs?: number
}

export interface KicadNetlist {
  netlist: string
  exported: string
  components: number
  unmodelled: string[]
  replaced: string[]
  removed: string[]
  log: string
}

/** A line names a component ngspice cannot simulate: too few fields, or KiCad's "__REF" placeholder model. */
function unmodelled(line: string): boolean {
  const toks = line.trim().split(/\s+/)
  const ref = toks[0] ?? ''
  if (!/^[a-z]/i.test(ref)) return false
  if (toks.some((t) => /^__/.test(t))) return true
  // a two-terminal R/C/L/V/I/D needs at least ref, two nodes, value/model
  return toks.length < 4 && /^[rclvidq]/i.test(ref)
}

export async function exportSpice(o: KicadNetlistOptions): Promise<KicadNetlist> {
  const exe = kicadCli()
  if (!exe) throw new SpiceError('kicad-cli not found (install KiCad 8 or later, or set KICAD_CLI)')
  const sch = resolve(o.schematic)
  if (!existsSync(sch)) throw new SpiceError(`no schematic ${sch}`)
  const dir = scratchDir('trace-kicad-')
  try {
    const out = join(dir, 'export.cir')
    const p = await run(exe, ['sch', 'export', 'netlist', '--format', 'spice', '-o', out, sch], { timeoutMs: o.timeoutMs ?? 120_000 })
    const log = p.stdout + p.stderr
    if (p.timedOut) throw new SpiceError('kicad-cli ran over its time limit', log)
    if (p.code !== 0 || !existsSync(out)) throw new SpiceError(`kicad-cli failed: ${log.trim().split('\n').pop() ?? ''}`, log)
    const exported = readFileSync(out, 'utf8')
    return transform(exported, o, log)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The overrides applied to an exported netlist (pure: tested without kicad-cli). */
export function transform(exported: string, o: Omit<KicadNetlistOptions, 'schematic'>, log = ''): KicadNetlist {
  const replace = new Map(Object.entries(o.replace ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const seen = new Set<string>()
  const unmod: string[] = []
  const replaced: string[] = []
  const removed: string[] = []
  let components = 0
  const lines: string[] = []
  let title = 'KiCad schematic'
  for (const ln of exported.replace(/\r\n?/g, '\n').split('\n')) {
    const t = ln.trim()
    if (!t) continue
    if (/^\.title\b/i.test(t)) {
      title = t.slice(6).trim() || title
      continue
    }
    if (/^\.end\s*$/i.test(t)) continue
    if (t.startsWith('*') || t.startsWith('.') || t.startsWith('+')) {
      lines.push(ln)
      continue
    }
    const ref = (t.split(/\s+/)[0] ?? '').toLowerCase()
    components++
    if (replace.has(ref)) {
      seen.add(ref)
      const r = replace.get(ref)
      if (r === null || r === undefined) {
        removed.push(ref.toUpperCase())
        lines.push(`* removed: ${t}`)
      } else {
        replaced.push(ref.toUpperCase())
        lines.push(r)
      }
      continue
    }
    if (unmodelled(t)) {
      unmod.push(t.split(/\s+/)[0] ?? t)
      lines.push(o.dropUnmodelled ? `* no simulation model: ${t}` : ln)
      continue
    }
    lines.push(ln)
  }
  const missing = [...replace.keys()].filter((k) => !seen.has(k))
  if (missing.length) throw new SpiceError(`not in the schematic: ${missing.map((m) => m.toUpperCase()).join(', ')}`)
  if (unmod.length && !o.dropUnmodelled) {
    throw new SpiceError(`components without a simulation model: ${unmod.slice(0, 30).join(', ')}${unmod.length > 30 ? ` (+${unmod.length - 30})` : ''}; replace them, or set drop_unmodelled`)
  }
  const netlist = [title, ...lines, ...(o.add ?? [])].join('\n')
  return { netlist, exported, components, unmodelled: unmod, replaced, removed, log }
}
