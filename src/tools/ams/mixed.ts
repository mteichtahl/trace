/**
 * Mixed-signal co-simulation in one ngspice run: the analog netlist, a behavioural ADC built from XSPICE parts, and a
 * Verilog block compiled by Verilator into a shared library that ngspice's `d_cosim` code model (ngspice 42 and
 * later) loads and steps.
 *
 * How the Verilog gets into ngspice. ngspice ships a script, vlnggen (share/ngspice/scripts), that runs Verilator
 * with the shim sources next to it (scripts/src/verilator_shim.cpp, verilator_main.cpp) and links a .so for
 * d_cosim. Its argument handling passes everything after the script name through ngspice's own option parser, so
 * Verilator options such as --top-module or -Wno-fatal cannot be given through it. This module performs the same
 * three steps itself, with the same shim sources: (1) `verilator --cc --prefix Vlng` on the design; (2) the port
 * lists inputs.h / outputs.h / inouts.h generated from Vlng.h exactly as vlnggen's loop does (VL_IN8(&clk,0,0) ->
 * VL_DATA(8,clk,0,0)); (3) `verilator --build --exe` with the shim, then `g++ --shared` of the shim, Verilator's
 * runtime and the model archive. The library is cached by content (machine cache database, namespace ams.cosim).
 *
 * ngspice lower-cases the netlist, the d_cosim `simulation` path included, so the library is written to a folder
 * whose path is lower case (cosimDir).
 *
 * The top level is wrapped. ngspice 42's shim sets a bit of a multi-bit *input* port with `|=` but clears it with
 * `&= (1 << bit)` (no `~`), which wipes the port's other bits; one-bit ports take a separate, correct path. The
 * generated wrapper therefore gives every input bit its own one-bit port and reassembles the vectors for the
 * user's module. Output vectors are read bit by bit by the shim and are left as they are. The d_cosim port order is
 * the order of the ports in Verilator's Vlng.h (which need not be the declaration order), read back after step 1,
 * and each multi-bit port is MSB first.
 *
 * Semantics and limits (what the co-simulation is, and is not):
 *   - Verilator is two-state and cycle-based: X/Z do not exist (an UNKNOWN input is ignored), `#` delays and
 *     timing controls in the Verilog are not simulated, and the model is evaluated whenever an input changes
 *     (d_cosim "After_input" method). Synchronous logic driven by a clock input behaves exactly; anything relying on
 *     Verilog delays does not.
 *   - The ADC is ideal and behavioural: code = clamp(floor((V(in) - V(ref)) / (vref_v / 2^bits)), 0, 2^bits - 1),
 *     evaluated continuously (B-sources, one per bit) and sampled by the design at its clock edge through XSPICE
 *     adc_bridge parts. There is no sample-and-hold aperture, conversion latency, INL/DNL or input loading beyond
 *     what the analog netlist itself models; add those to the netlist when they matter.
 *   - Digital outputs return through dac_bridge parts (0 / 1 V) and are summed into an analog "code" vector per
 *     port, so they appear in the raw output like any node and every sim.* measurement works on them.
 *   - Without Verilator (or without the ngspice shim sources), the tool still runs the analog netlist and the ADC
 *     (XSPICE parts only), reports `cosim: false`, and the Verilog is not simulated.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { Cache, scratchDir } from '../../core/store.js'
import { run, which } from '../../sim/proc.js'
import { SpiceError } from '../../sim/spice.js'

export class CosimError extends Error {
  override name = 'CosimError'
}

export interface Port { dir: 'in' | 'out' | 'inout'; name: string; msb: number; lsb: number; size: number }

export function verilator(): string | null {
  return which('verilator', 'TRACE_VERILATOR')
}

/** The folder with verilator_shim.cpp, verilator_main.cpp and ngspice/cosim.h, or null. */
export function shimDir(): string | null {
  const cands = [process.env.TRACE_NGSPICE_SHIM, '/usr/share/ngspice/scripts/src', '/usr/local/share/ngspice/scripts/src', '/opt/homebrew/share/ngspice/scripts/src']
  for (const c of cands) if (c && existsSync(join(c, 'verilator_shim.cpp')) && existsSync(join(c, 'ngspice', 'cosim.h'))) return c
  return null
}

/** Ports from Verilator's model header, in its order (vlnggen's parse: VL_IN8(&clk,0,0) and friends). */
export function parseModelHeader(h: string): Port[] {
  const out: Port[] = []
  for (const m of h.matchAll(/VL_(INOUT|IN|OUT)(\d*)\(&(\w+),(\d+),(\d+)\)/g)) {
    const dir = m[1] === 'INOUT' ? 'inout' : m[1] === 'IN' ? 'in' : 'out'
    const msb = Number(m[4])
    const lsb = Number(m[5])
    out.push({ dir, name: m[3] as string, msb, lsb, size: Number(m[2] || 1) })
  }
  return out
}

export function vlData(ports: readonly Port[], dir: Port['dir']): string {
  return ['/* Generated code: do not edit. */', ...ports.filter((p) => p.dir === dir).map((p) => `VL_DATA(${p.size},${p.name},${p.msb},${p.lsb})`)].join('\n') + '\n'
}

export const WRAP_TOP = 'trace_cosim_top'

/** One-bit input ports (name, or name_trbit<k> for bit k of a vector: Verilator mangles a double underscore), outputs as they are. */
export function wrapper(top: string, ports: readonly Port[], params: Readonly<Record<string, number | string>>): string {
  const decl: string[] = []
  const conn: string[] = []
  for (const p of ports) {
    const width = p.msb - p.lsb + 1
    if (p.dir === 'in') {
      if (width === 1 && p.msb === 0) {
        decl.push(`input wire ${p.name}`)
        conn.push(`.${p.name}(${p.name})`)
      } else {
        const bits: string[] = []
        for (let k = p.msb; k >= p.lsb; k--) {
          decl.push(`input wire ${p.name}_trbit${k}`)
          bits.push(`${p.name}_trbit${k}`)
        }
        conn.push(`.${p.name}({${bits.join(', ')}})`)
      }
    } else {
      if (p.dir === 'inout') throw new CosimError(`inout port ${p.name}: not supported by the generated wrapper`)
      decl.push(width === 1 && p.msb === 0 ? `output wire ${p.name}` : `output wire [${p.msb}:${p.lsb}] ${p.name}`)
      conn.push(`.${p.name}(${p.name})`)
    }
  }
  const ps = Object.entries(params)
  return [
    '// Generated by trace ams.mixed: one-bit inputs for ngspice 42\'s d_cosim shim (see src/tools/ams/mixed.ts).',
    `module ${WRAP_TOP} (`,
    decl.map((d) => `    ${d}`).join(',\n'),
    ');',
    `    ${top} ${ps.length ? `#(${ps.map(([k, v]) => `.${k}(${v})`).join(', ')}) ` : ''}u_dut (${conn.join(', ')});`,
    'endmodule',
    '',
  ].join('\n')
}

const VFLAGS = ['-Wno-fatal', '-Wno-lint', '-Wno-style', '-Wno-TIMESCALEMOD']

async function verilate(exe: string, dir: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const r = await run(exe, args, { cwd: dir, timeoutMs })
  const log = r.stdout + r.stderr
  if (r.timedOut) throw new CosimError(`verilator ran longer than ${timeoutMs / 1000} s`)
  if (r.code !== 0) throw new CosimError(`verilator failed: ${(log.split('\n').find((l) => /%Error/.test(l)) ?? log.trim().split('\n').slice(-1)[0] ?? '').slice(0, 300)}`)
  return log
}

/** The ports of `top` (parameters applied), from a Verilator pass over the sources. */
export async function topPorts(sources: readonly string[], top: string, params: Readonly<Record<string, number | string>>, timeoutMs = 300_000): Promise<Port[]> {
  const exe = verilator()
  if (!exe) throw new CosimError('verilator not found')
  const dir = scratchDir('trace-vports-')
  try {
    await verilate(exe, dir, ['--Mdir', 'obj', '--prefix', 'Vlng', '--cc', ...VFLAGS, '--top-module', top, ...Object.entries(params).map(([k, v]) => `-G${k}=${v}`), ...sources], timeoutMs)
    return parseModelHeader(readFileSync(join(dir, 'obj', 'Vlng.h'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A fresh folder for the library whose path is all lower case: ngspice lower-cases the netlist, the quoted
 * `simulation="…"` path of a d_cosim model included, so a path with capitals is not found. $TRACE_COSIM_DIR, else
 * the system temp folder when its path is lower case, else /tmp.
 */
export function cosimDir(): string {
  const base = process.env.TRACE_COSIM_DIR ?? (tmpdir() === tmpdir().toLowerCase() ? tmpdir() : '/tmp')
  const dir = join(base, `trace-cosim-${randomBytes(6).toString('hex')}`)
  if (dir !== dir.toLowerCase()) throw new CosimError(`ngspice lower-cases the d_cosim library path, and ${dir} has capitals: set TRACE_COSIM_DIR to a lower-case folder`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface CosimLibrary { path: string; ports: Port[]; wrapper: string; cached: boolean; log: string; dir: string }

/** Build (or fetch from the cache) the d_cosim library for `top`; the .so is written into a fresh scratch folder. */
export async function buildCosim(sources: readonly string[], top: string, params: Readonly<Record<string, number | string>>, timeoutMs = 600_000): Promise<CosimLibrary> {
  const exe = verilator()
  if (!exe) throw new CosimError('verilator not found (apt install verilator; or set TRACE_VERILATOR)')
  const shim = shimDir()
  if (!shim) throw new CosimError('the ngspice d_cosim shim sources (share/ngspice/scripts/src/verilator_shim.cpp) were not found; set TRACE_NGSPICE_SHIM')
  if (!which('g++')) throw new CosimError('g++ not found (needed to link the d_cosim library)')
  const userPorts = await topPorts(sources, top, params, timeoutMs)
  const wrap = wrapper(top, userPorts, params)
  const vver = (await run(exe, ['--version'], { timeoutMs: 30_000 })).stdout.trim()
  const h = createHash('sha256').update(vver).update(wrap).update(readFileSync(join(shim, 'verilator_shim.cpp')))
  for (const s of sources) h.update(basename(s)).update(readFileSync(s))
  const key = h.digest('hex')
  const dir = cosimDir()
  const so = join(dir, 'dut.so')
  let cache: Cache | null = null
  try {
    cache = new Cache()
  } catch {
    cache = null
  }
  try {
    const hit = cache?.getBlob('ams.cosim', key)
    const meta = cache?.get<{ ports: Port[] }>('ams.cosim', key)
    if (hit && meta) {
      writeFileSync(so, hit)
      return { path: so, ports: meta.ports, wrapper: wrap, cached: true, log: '', dir }
    }
    writeFileSync(join(dir, `${WRAP_TOP}.v`), wrap)
    const srcs = [join(dir, `${WRAP_TOP}.v`), ...sources.map((s) => resolve(s))]
    const obj = join(dir, 'obj')
    mkdirSync(obj, { recursive: true })
    let log = await verilate(exe, dir, ['--Mdir', 'obj', '--prefix', 'Vlng', '--CFLAGS', '-fpic', '--cc', ...VFLAGS, '--top-module', WRAP_TOP, ...srcs], timeoutMs)
    const ports = parseModelHeader(readFileSync(join(obj, 'Vlng.h'), 'utf8'))
    for (const [dir2, file] of [['in', 'inputs.h'], ['out', 'outputs.h'], ['inout', 'inouts.h']] as const) writeFileSync(join(obj, file), vlData(ports, dir2))
    log += await verilate(exe, dir, ['--Mdir', 'obj', '--prefix', 'Vlng', '--CFLAGS', `-I${shim}`, '--CFLAGS', '-fpic', '--cc', '--build', '--exe', ...VFLAGS,
      '--top-module', WRAP_TOP, join(shim, 'verilator_main.cpp'), join(shim, 'verilator_shim.cpp'), ...srcs], timeoutMs)
    const link = await run('g++', ['--shared', join(obj, 'verilator_shim.o'), join(obj, 'verilated.o'), join(obj, 'verilated_threads.o'), join(obj, 'Vlng__ALL.a'), '-pthread', '-lpthread', '-o', so], { cwd: dir, timeoutMs })
    log += link.stdout + link.stderr
    if (link.code !== 0 || !existsSync(so)) throw new CosimError(`linking the d_cosim library failed: ${(link.stderr || link.stdout).trim().slice(0, 300)}`)
    try {
      cache?.put('ams.cosim', key, { ports }, { blob: readFileSync(so) })
    } catch {
      /* caching is best effort */
    }
    return { path: so, ports, wrapper: wrap, cached: false, log, dir }
  } finally {
    cache?.close()
  }
}

// ------------------------------------------------------------------------------------------- the netlist

export interface AdcSpec {
  /** The analog node the ADC converts (V(input) - V(ref)). */
  input: string
  ref?: string | undefined
  bits: number
  vref_v: number
  /** The design's input port that takes the code. */
  port: string
}

export interface ClockSpec { port: string; freq_hz: number }

/** A digital input's drive: a constant 0/1, or a PWL list of [time, 0|1] steps. */
export type Drive = 0 | 1 | [number, 0 | 1][]

export interface MixedSpec {
  adc: AdcSpec
  clock: ClockSpec
  drive: Readonly<Record<string, Drive>>
  /** Reset ports driven automatically when not in `drive`: name -> active level; held active for `resetCycles`. */
  resetCycles: number
  tstop: number
  tstep?: number | undefined
}

/** Logic levels used by the bridges: digital is 0 / 1 V on the analog side. */
const LOGIC = { adc: '.model trace_abridge adc_bridge(in_low=0.4 in_high=0.6)', dac: '.model trace_dbridge dac_bridge(out_low=0 out_high=1 out_undef=0.5)' }

const node = (s: string): string => `d_${s.replace(/[^\w]/g, '_')}`

/** Which drive each design input gets: the ADC code, the clock, a reset, a given drive, or 0 (listed as tied). */
export function planInputs(ports: readonly Port[], spec: MixedSpec): { bits: { port: string; bit: number | null; src: string }[]; tied: string[]; resets: string[] } {
  const bits: { port: string; bit: number | null; src: string }[] = []
  const tied: string[] = []
  const resets: string[] = []
  const inputs = ports.filter((p) => p.dir === 'in')
  const byName = new Map<string, Port[]>()
  for (const p of inputs) {
    const m = /^(.*)_trbit(\d+)$/.exec(p.name)
    const base = m ? (m[1] as string) : p.name
    byName.set(base, [...(byName.get(base) ?? []), p])
  }
  if (!byName.has(spec.clock.port)) throw new CosimError(`the design has no input ${spec.clock.port} for the clock (inputs: ${[...byName.keys()].join(', ')})`)
  if (!byName.has(spec.adc.port)) throw new CosimError(`the design has no input ${spec.adc.port} for the ADC code (inputs: ${[...byName.keys()].join(', ')})`)
  for (const p of inputs) {
    const m = /^(.*)_trbit(\d+)$/.exec(p.name)
    const base = m ? (m[1] as string) : p.name
    const bit = m ? Number(m[2]) : null
    if (base === spec.adc.port) bits.push({ port: p.name, bit, src: `adcbit_${bit ?? 0}` })
    else if (base === spec.clock.port) bits.push({ port: p.name, bit, src: 'clk' })
    else if (spec.drive[base] !== undefined) bits.push({ port: p.name, bit, src: `drv_${base}${bit === null ? '' : `_${bit}`}` })
    else if (/^(rst|reset|rst_n|reset_n|rstn|resetn|nrst)$/i.test(base)) {
      resets.push(base)
      bits.push({ port: p.name, bit, src: `drv_${base}` })
    } else {
      tied.push(p.name)
      bits.push({ port: p.name, bit, src: 'tie0' })
    }
  }
  const adcBits = byName.get(spec.adc.port)?.length ?? 0
  if (adcBits !== spec.adc.bits) throw new CosimError(`input ${spec.adc.port} is ${adcBits} bits wide; the ADC has ${spec.adc.bits}`)
  return { bits, tied, resets }
}

function pwl(points: readonly [number, 0 | 1][], edge: number): string {
  const out: string[] = []
  let prev: number | null = null
  for (const [t, v] of points) {
    if (prev !== null && t > 0) out.push(`${Math.max(0, t - edge)} ${prev}`)
    out.push(`${t} ${v}`)
    prev = v
  }
  if (!out.length) out.push('0 0')
  return `PWL(${out.join(' ')})`
}

export interface MixedNetlist { netlist: string; analysis: string; period: number; edge: number; outputs: { port: string; vector: string; width: number }[]; tied: string[]; resets: string[] }

/**
 * The analog netlist plus the ADC, clock, drives, bridges, the d_cosim instance (when `lib` is given) and the
 * reconstruction of each output port as v(<port>_code). Without `lib`, only the ADC part is added. `analog` is the
 * circuit without analysis lines; the transient to run is returned as `analysis`.
 */
export function mixedNetlist(analog: string, spec: MixedSpec, lib: CosimLibrary | null): MixedNetlist {
  const { adc, clock } = spec
  if (!(adc.bits >= 1 && adc.bits <= 24)) throw new SpiceError('adc.bits must be 1..24')
  const period = 1 / clock.freq_hz
  const edge = Math.min(period / 100, 1e-8)
  const full = 2 ** adc.bits
  const L: string[] = [analog.trimEnd(), '', '* ---- trace ams.mixed: behavioural ADC, clock and digital drives', LOGIC.adc, LOGIC.dac]
  const vin = adc.ref ? `(v(${adc.input})-v(${adc.ref}))` : `v(${adc.input})`
  L.push(`Btrace_code adc_code 0 V = max(0, min(${full - 1}, floor(${vin}/${adc.vref_v}*${full})))`)
  for (let k = 0; k < adc.bits; k++) L.push(`Btrace_b${k} adcbit_${k} 0 V = floor(v(adc_code)/${2 ** k}) - 2*floor(v(adc_code)/${2 ** (k + 1)})`)
  L.push(`Vtrace_clk clk 0 PULSE(0 1 ${period / 2} ${edge} ${edge} ${period / 2 - edge} ${period})`)
  L.push('Vtrace_tie0 tie0 0 DC 0')
  const outputs: MixedNetlist['outputs'] = []
  let tied: string[] = []
  let resets: string[] = []
  if (lib) {
    const plan = planInputs(lib.ports, spec)
    tied = plan.tied
    resets = plan.resets
    const done = new Set<string>()
    for (const b of plan.bits) {
      if (!b.src.startsWith('drv_') || done.has(b.src)) continue
      done.add(b.src)
      const base = b.src.slice(4).replace(/_\d+$/, '')
      const d = spec.drive[base]
      if (typeof d === 'number' && b.bit !== null) continue // a constant on a vector: each bit is tied (srcOf)
      let line: string
      if (d === undefined) {
        // an automatic reset: active for resetCycles clock periods, starting at 0
        const activeLow = /(_n|n)$|^n/i.test(base)
        const on = activeLow ? 0 : 1
        const t = spec.resetCycles * period
        line = `V${b.src} ${b.src} 0 ${pwl([[0, on], [t, (1 - on) as 0 | 1]], edge)}`
      } else if (typeof d === 'number') line = `V${b.src} ${b.src} 0 DC ${d}`
      else {
        if (b.bit !== null) throw new CosimError(`drive ${base}: a waveform drives a one-bit input; give a constant for a vector`)
        line = `V${b.src} ${b.src} 0 ${pwl(d, edge)}`
      }
      L.push(line)
    }
    // bridges in, the design, bridges out
    const ins = lib.ports.filter((p) => p.dir === 'in')
    const srcOf = (name: string): string => {
      const b = plan.bits.find((x) => x.port === name)
      if (!b) throw new CosimError(`no drive for ${name}`)
      if (b.src.startsWith('drv_') && b.bit !== null) {
        const base = b.src.slice(4).replace(/_\d+$/, '')
        const d = spec.drive[base]
        return typeof d === 'number' ? (((d >> b.bit) & 1) ? 'tie1' : 'tie0') : b.src
      }
      return b.src
    }
    L.push('Vtrace_tie1 tie1 0 DC 1')
    L.push(`Atrace_in [${ins.map((p) => srcOf(p.name)).join(' ')}] [${ins.map((p) => node(p.name)).join(' ')}] trace_abridge`)
    const outBits: string[] = []
    for (const p of lib.ports.filter((q) => q.dir === 'out')) {
      const width = p.msb - p.lsb + 1
      const names: string[] = []
      for (let k = p.msb; k >= p.lsb; k--) names.push(width === 1 && p.msb === 0 ? node(p.name) : node(`${p.name}_${k}`))
      outBits.push(...names)
      outputs.push({ port: p.name, vector: `v(${p.name}_code)`, width })
    }
    L.push(`.model trace_dut d_cosim simulation="${lib.path}"`)
    L.push(`Atrace_dut [${ins.map((p) => node(p.name)).join(' ')}] [${outBits.join(' ')}] null trace_dut`)
    L.push(`Atrace_out [${outBits.join(' ')}] [${outBits.map((n) => `a${n}`).join(' ')}] trace_dbridge`)
    for (const p of lib.ports.filter((q) => q.dir === 'out')) {
      const width = p.msb - p.lsb + 1
      const terms: string[] = []
      for (let k = p.msb; k >= p.lsb; k--) {
        const n = width === 1 && p.msb === 0 ? node(p.name) : node(`${p.name}_${k}`)
        terms.push(`${2 ** (k - p.lsb)}*v(a${n})`)
      }
      L.push(`Btrace_o_${p.name} ${p.name}_code 0 V = ${terms.join(' + ')}`)
    }
  }
  const tstep = spec.tstep ?? period / 50
  return { netlist: L.join('\n'), analysis: `.tran ${tstep} ${spec.tstop}`, period, edge, outputs, tied, resets }
}

/**
 * One row per rising clock edge: the ADC input and code at the edge (when the design latches it; the clock crosses
 * its bridge threshold half an edge time after the edge starts), and the design's outputs half a period later
 * (settled after that edge).
 */
export function clockSamples(t: readonly number[], atEdge: Readonly<Record<string, readonly number[]>>, after: Readonly<Record<string, readonly number[]>>, period: number, edge: number, tstop: number): Record<string, number>[] {
  const interp = (v: readonly number[], at: number): number => {
    let lo = 0
    let hi = t.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if ((t[mid] as number) <= at) lo = mid
      else hi = mid
    }
    const a = t[lo] as number
    const b = t[hi] as number
    const ya = v[lo] as number
    const yb = v[hi] as number
    return b === a || at <= a ? ya : at >= b ? yb : ya + ((at - a) / (b - a)) * (yb - ya)
  }
  const rows: Record<string, number>[] = []
  for (let k = 0; (k + 0.5) * period + period / 2 <= tstop; k++) {
    const te = (k + 0.5) * period
    const row: Record<string, number> = { t: te }
    for (const [name, v] of Object.entries(atEdge)) row[name] = interp(v, te + edge / 2)
    for (const [name, v] of Object.entries(after)) row[name] = interp(v, te + period / 2)
    rows.push(row)
  }
  return rows
}
