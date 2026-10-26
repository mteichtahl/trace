/**
 * The physical bus as a SPICE netlist, and what its waveform says about timing.
 *
 *   open_drain  (I2C)  VDD - Rp - bus node with Cb to ground; the driver a switch to ground with Ron = VOL / IOL
 *                      when not given; receivers at VIL / VIH (default 0.3 and 0.7 VDD, UM10204 Table 9).
 *   push_pull   (SPI, UART at logic level)  an ideal source with an edge time behind the driver's output resistance,
 *                      the trace as RC (R in series, C at the far end) or a transmission line (ideal T, or LTRA when
 *                      it has series loss), the receiver's input capacitance; thresholds VIL / VIH in volts.
 *   rs232              the line driver's ±V levels with its slew rate, its output resistance, the cable's capacitance
 *                      and the receiver's 3 to 7 kΩ load (TIA-232-F).
 *
 * The stimulus is a bit pattern, or a signal of an earlier protocol.model / sim.logic run (its edges become the PWL).
 * Measured on the receiving node, per edge: rise and fall time between the given fractions (30-70 % for I2C as
 * UM10204 defines tr and tf, 10-90 % otherwise), overshoot and undershoot, settling, the low and high levels, and the
 * delay from the driver's switching instant to the receiver's threshold (VIH rising, VIL falling): `rise_delay` and
 * `fall_delay`, the effective timing protocol.check applies to a digital capture's edges.
 */
import { ToolError } from '../../core/registry.js'
import { crossings } from '../sim/measure.js'
import { RC_10_90, RC_30_70 } from './standards.js'

export interface Pwl { t: number; v: number }

export type BusKind = 'open_drain' | 'push_pull' | 'rs232'

export interface TraceModel {
  model: 'none' | 'rc' | 'tline'
  r?: number | undefined
  c?: number | undefined
  z0?: number | undefined
  delay_per_m?: number | undefined
  length_m?: number | undefined
  r_per_m?: number | undefined
}

export interface BusSetup {
  kind: BusKind
  vdd: number
  rp?: number | undefined
  cb?: number | undefined
  ron?: number | undefined
  r_drv?: number | undefined
  t_edge: number
  trace: TraceModel
  c_in: number
  rs232?: { v_mark: number; v_space: number; slew: number; r_out: number; r_load: number; c_cable: number } | undefined
  /** the driver's logic level over time: [t, 0 | 1] changes, 1 = high (released for open drain, mark for RS-232) */
  logic: [number, 0 | 1][]
  stop: number
}

const num = (v: number): string => Number(v.toPrecision(9)).toExponential()

/** The netlist and the node the receiver sees. */
export function busNetlist(b: BusSetup): { netlist: string; node: string; step: number; analysis: string } {
  const lines = [`* protocol.bus_analog: ${b.kind} bus`]
  // RS-232's edge is the driver's slew-limited swing
  const edge = b.kind === 'rs232' && b.rs232 ? Math.abs(b.rs232.v_space - b.rs232.v_mark) / b.rs232.slew : Math.max(b.t_edge, 1e-12)
  const pwl = (lo: number, hi: number, invert = false, e = edge): string => {
    const pts: string[] = []
    const first = b.logic[0]?.[1] ?? 1
    const lv = (l: 0 | 1): number => ((invert ? 1 - l : l) ? hi : lo)
    pts.push(`0 ${num(lv(first))}`)
    for (let k = 1; k < b.logic.length; k++) {
      const [t, l] = b.logic[k] as [number, 0 | 1]
      const prev = (b.logic[k - 1] as [number, 0 | 1])[1]
      // the ramp is centred on the switching instant
      pts.push(`${num(Math.max(0, t - e / 2))} ${num(lv(prev))}`, `${num(t + e / 2)} ${num(lv(l))}`)
    }
    return `PWL(${pts.join(' ')})`
  }
  let node = 'rx'
  if (b.kind === 'open_drain') {
    if (!(b.rp && b.rp > 0) || !(b.cb && b.cb > 0)) throw new ToolError('open_drain needs rp and cb')
    lines.push(`VDD vdd 0 DC ${num(b.vdd)}`, `RP vdd bus ${num(b.rp)}`, `CB bus 0 ${num(b.cb)}`,
      // ctl high = pull low: logic 0 drives the switch on
      `VCTL ctl 0 ${pwl(0, 1, true)}`, `SDRV bus 0 ctl 0 swod`, `.model swod SW(VT=0.5 VH=0 RON=${num(b.ron ?? 133)} ROFF=1e12)`)
    node = 'bus'
  } else {
    let lo = 0
    let hi = b.vdd
    let rOut = b.r_drv ?? 25
    if (b.kind === 'rs232') {
      const r = b.rs232
      if (!r) throw new ToolError('rs232 needs its levels')
      lo = r.v_space // logic 0 = space = positive
      hi = r.v_mark
      rOut = r.r_out
    }
    // the RS-232 ramp is the slew-limited swing
    const ramp = b.kind === 'rs232' && b.rs232 ? Math.abs(b.rs232.v_space - b.rs232.v_mark) / b.rs232.slew : edge
    lines.push(`VDRV drv 0 ${pwl(lo, hi, false, ramp)}`, `RDRV drv near ${num(rOut)}`)
    const tr = b.trace
    if (tr.model === 'rc') {
      lines.push(`RTR near far ${num(tr.r ?? 0.001)}`, `CTR far 0 ${num(tr.c ?? 1e-12)}`)
    } else if (tr.model === 'tline') {
      const z0 = tr.z0
      const dpm = tr.delay_per_m
      const len = tr.length_m
      if (!z0 || !dpm || !len) throw new ToolError('a transmission line needs z0, delay_per_m and length_m (or a board net and calc.impedance)')
      if (tr.r_per_m && tr.r_per_m > 0) {
        // LTRA per unit length: L = Z0 · td, C = td / Z0 (td in s/m)
        lines.push(`O1 near 0 far 0 ltra1`, `.model ltra1 LTRA R=${num(tr.r_per_m)} L=${num(z0 * dpm)} G=0 C=${num(dpm / z0)} LEN=${num(len)}`)
      } else lines.push(`T1 near 0 far 0 Z0=${num(z0)} TD=${num(dpm * len)}`)
    } else lines.push('RTR near far 1e-3')
    if (b.kind === 'rs232' && b.rs232) lines.push(`CCAB far 0 ${num(b.rs232.c_cable)}`, `RLOAD far 0 ${num(b.rs232.r_load)}`)
    lines.push(`CIN far 0 ${num(Math.max(b.c_in, 1e-15))}`)
    node = 'far'
  }
  // a step fine enough for the fastest feature: the edge, the line delay, or the RC
  const tau = b.kind === 'open_drain' ? (b.rp ?? 1) * (b.cb ?? 1e-12) : Math.min((b.r_drv ?? 25) * (b.c_in + (b.trace.c ?? 0)), 1)
  const td = b.trace.model === 'tline' ? (b.trace.delay_per_m ?? 0) * (b.trace.length_m ?? 0) : Infinity
  const step = Math.max(1e-13, b.stop / 50_000, Math.min(edge / 10, td / 20, tau / 50, b.stop / 5000))
  return { netlist: `${lines.join('\n')}\n`, node, step, analysis: `.tran ${num(step)} ${num(b.stop)} 0 ${num(step)}` }
}

export interface EdgeMeasure {
  /** the voltage's direction */
  kind: 'rise' | 'fall'
  t_switch: number
  transition: number | null
  delay: number | null
  overshoot: number
  settle: number | null
}

export interface BusMeasures {
  edges: EdgeMeasure[]
  /** worst (longest) transition and threshold delay, by the voltage's direction */
  t_r: number | null
  t_f: number | null
  rise_delay: number | null
  fall_delay: number | null
  overshoot_v: number
  undershoot_v: number
  /** the settled levels: the highest low and the lowest high (by voltage) */
  v_low: number | null
  v_high: number | null
  settle: number | null
}

/**
 * Per change of the driver's logic, on the receiving node's waveform: the transition between the fractions lo and hi
 * of the swing from the old level to the new (level1 for logic 1, level0 for logic 0), the delay from the switching
 * instant to the receiver threshold the voltage crosses on the way (thr_up when rising, thr_down when falling), the
 * overshoot beyond the new level, and the settling time to within `band` (of the swing) of it. Worst over the edges.
 */
export function measureBus(time: readonly number[], v: readonly number[], logic: readonly [number, 0 | 1][], o: { lo: number; hi: number; thrUp: number; thrDown: number; level0: number; level1: number; band?: number; /** the driver's ramp starts this long before a switching instant */ lead?: number }): BusMeasures {
  const swing = Math.abs(o.level1 - o.level0)
  const band = (o.band ?? 0.05) * swing
  const edges: EdgeMeasure[] = []
  for (let k = 1; k < logic.length; k++) {
    const [t, l] = logic[k] as [number, 0 | 1]
    const prev = (logic[k - 1] as [number, 0 | 1])[1]
    if (l === prev) continue
    const end = logic[k + 1]?.[0] ?? time[time.length - 1] ?? t
    const from = prev ? o.level1 : o.level0
    const target = l ? o.level1 : o.level0
    const up = target > from
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < time.length; i++) {
      const ti = time[i] as number
      if (ti >= t - 1e-15 && ti <= end) { xs.push(ti); ys.push(v[i] as number) }
    }
    if (xs.length < 3) continue
    const dir = up ? 'rising' : 'falling'
    const ca = crossings(xs, ys, from + o.lo * (target - from), dir)[0]
    const cz = crossings(xs, ys, from + o.hi * (target - from), dir)[0]
    const ct = crossings(xs, ys, up ? o.thrUp : o.thrDown, dir)[0]
    let over = 0
    for (const y of ys) over = Math.max(over, up ? y - target : target - y)
    let settle: number | null = 0
    for (let i = ys.length - 1; i >= 0; i--) {
      if (Math.abs((ys[i] as number) - target) > band) { settle = i === ys.length - 1 ? null : (xs[i + 1] as number) - t; break }
    }
    edges.push({ kind: up ? 'rise' : 'fall', t_switch: t, transition: ca !== undefined && cz !== undefined ? cz - ca : null, delay: ct !== undefined ? ct - t : null, overshoot: Math.max(0, over), settle })
  }
  const worst = (kind: 'rise' | 'fall', f: (e: EdgeMeasure) => number | null): number | null => {
    const vals = edges.filter((e) => e.kind === kind).map(f).filter((x): x is number => x !== null)
    return vals.length ? Math.max(...vals) : null
  }
  const hiLevel = Math.max(o.level0, o.level1)
  const loLevel = Math.min(o.level0, o.level1)
  let vmax = -Infinity
  let vmin = Infinity
  for (const y of v) { if (y > vmax) vmax = y; if (y < vmin) vmin = y }
  // the settled levels: the value just before each change's ramp starts (and at the end)
  const lead = (o.lead ?? 0) * 1.05
  const lows: number[] = []
  const highs: number[] = []
  for (let k = 0; k < logic.length; k++) {
    const endT = logic[k + 1]?.[0] ?? time[time.length - 1]
    if (endT === undefined) continue
    let idx = -1
    const at = k + 1 < logic.length ? endT - lead : endT
    for (let i = 0; i < time.length; i++) if ((time[i] as number) < at - 1e-15) idx = i
    if (idx < 0) continue
    const lvl = (logic[k] as [number, 0 | 1])[1] ? o.level1 : o.level0
    ;(lvl === hiLevel ? highs : lows).push(v[idx] as number)
  }
  const allSettle = edges.map((e) => e.settle).filter((x): x is number => x !== null)
  return {
    edges,
    t_r: worst('rise', (e) => e.transition), t_f: worst('fall', (e) => e.transition),
    rise_delay: worst('rise', (e) => e.delay), fall_delay: worst('fall', (e) => e.delay),
    overshoot_v: Math.max(0, vmax - hiLevel), undershoot_v: Math.max(0, loLevel - vmin),
    v_low: lows.length ? Math.max(...lows) : null, v_high: highs.length ? Math.min(...highs) : null,
    settle: allSettle.length ? Math.max(...allSettle) : null,
  }
}

/** The RC closed forms the SPICE run is checked against: 0.8473 RC (30-70 %) and 2.1972 RC (10-90 %). */
export function rcRise(r: number, c: number): { t_30_70: number; t_10_90: number } {
  return { t_30_70: RC_30_70 * r * c, t_10_90: RC_10_90 * r * c }
}

/** A bit pattern ("0101", LSB of time first) at a bit time, as logic changes (idle high before and after). */
export function patternLogic(bits: string, bitTime: number, idleBits = 2): { logic: [number, 0 | 1][]; stop: number } {
  if (!/^[01]+$/.test(bits)) throw new ToolError('pattern: a string of 0 and 1')
  const out: [number, 0 | 1][] = [[0, 1]]
  let t = idleBits * bitTime
  for (const ch of bits) {
    const l = (ch === '1' ? 1 : 0) as 0 | 1
    if ((out[out.length - 1] as [number, 0 | 1])[1] !== l) out.push([t, l])
    t += bitTime
  }
  if ((out[out.length - 1] as [number, 0 | 1])[1] !== 1) out.push([t, 1])
  return { logic: out, stop: t + idleBits * bitTime }
}
