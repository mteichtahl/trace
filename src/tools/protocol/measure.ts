/**
 * Interface timing measured on a capture, per parameter: the worst value over the whole capture (the smallest for a
 * minimum-limited parameter, the largest for a maximum-limited one), the two events it was measured between, the
 * signals they are on and the transaction it is in. These are the numbers protocol.check judges and protocol.diagram
 * draws as arrows. Everything is measured at the capture's pins; flight time and thresholds come in through edge
 * delays (protocol.bus_analog) applied before measuring.
 *
 *   I2C      sim/wave.ts i2cDecode's UM10204 Table 10 timing (with where each worst value was), and fSCL from the
 *            shortest SCL period in a transfer.
 *   SPI      fSCK, SCK high/low, tCSS, tCSH, tCSD, MOSI set-up/hold at the sampling edge (the responder's input),
 *            MISO valid (tV) and hold (tHO) after the launching edge (the responder's output; CS active is the first
 *            launch in CPHA 0), MISO set-up/hold at the master's sampling edge.
 *   UART     the bit time of each frame from its edges (the latest edge gives the most bits to average over), as a
 *            baud error in percent against the nominal; framing and parity error counts.
 *   1-Wire   reset low, presence high/low, slot, write-1/write-0 low times and recovery (sim/decode.ts).
 *   CAN      the bit time from the edges, frames with stuff, CRC or form errors, frames not acknowledged.
 */
import { canDecode, onewireDecode } from '../sim/decode.js'
import { i2cDecode, Signal, uartDecode, type UartOptions } from '../sim/wave.js'

export interface Measured {
  parameter: string
  value: number | null
  unit: string
  /** which end is the worst: the smallest value (a minimum limit) or the largest (a maximum) */
  worst: 'min' | 'max'
  t0?: number
  t1?: number
  from?: string
  to?: string
  tx?: number
  count: number
  /** both extremes, when every sample was seen (so a two-sided limit can be judged on each side) */
  range?: { min: number; max: number; at_min: [number, number]; at_max: [number, number] }
}

class Worst {
  private readonly m = new Map<string, Measured>()
  constructor(private readonly windows: readonly [number, number][] = []) {}

  add(parameter: string, unit: string, worst: 'min' | 'max', value: number, t0: number, t1: number, from: string, to: string): void {
    const cur = this.m.get(parameter)
    if (!cur) {
      this.m.set(parameter, { parameter, unit, worst, value, t0, t1, from, to, tx: this.txOf(t0), count: 1, range: { min: value, max: value, at_min: [t0, t1], at_max: [t0, t1] } })
      return
    }
    cur.count++
    if (cur.range) {
      const e = (x: number): number => 1e-9 * Math.abs(x) + 1e-18
      if (value < cur.range.min - e(cur.range.min)) { cur.range.min = value; cur.range.at_min = [t0, t1] }
      if (value > cur.range.max + e(cur.range.max)) { cur.range.max = value; cur.range.at_max = [t0, t1] }
    }
    // the first occurrence of the worst value is kept: a later one must be worse by more than rounding (1e-9 relative)
    const eps = cur.value === null ? 0 : 1e-9 * Math.abs(cur.value) + 1e-18
    if (cur.value === null || (worst === 'min' ? value < cur.value - eps : value > cur.value + eps)) Object.assign(cur, { value, t0, t1, from, to, tx: this.txOf(t0) })
  }

  set(m: Measured): void {
    this.m.set(m.parameter, { ...m, ...(m.t0 !== undefined && m.tx === undefined ? { tx: this.txOf(m.t0) } : {}) })
  }

  private txOf(t: number): number | undefined {
    const k = this.windows.findIndex(([a, b]) => t >= a - 1e-15 && t <= b + 1e-15)
    return k >= 0 ? k : undefined
  }

  all(): Measured[] {
    return [...this.m.values()]
  }
}

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null)

// ------------------------------------------------------------------ I2C

export function measureI2c(sig: { scl: Signal; sda: Signal }): { measured: Measured[]; frames: number; windows: [number, number][] } {
  const d = i2cDecode(sig.scl, sig.sda)
  const windows = d.frames.map((f) => [f.t, Number.isFinite(f.end) ? f.end : f.t] as [number, number])
  const w = new Worst(windows)
  const names: [keyof typeof d.timing, string, 'min' | 'max', string, string][] = [
    ['t_low', 't_low', 'min', 'scl', 'scl'], ['t_high', 't_high', 'min', 'scl', 'scl'], ['tsu_dat', 'tsu_dat', 'min', 'sda', 'scl'],
    ['thd_dat', 'thd_dat', 'min', 'scl', 'sda'], ['tvd_dat_max', 'tvd_dat', 'max', 'scl', 'sda'], ['thd_sta', 'thd_sta', 'min', 'sda', 'scl'],
    ['tsu_sta', 'tsu_sta', 'min', 'scl', 'sda'], ['tsu_sto', 'tsu_sto', 'min', 'scl', 'sda'], ['t_buf', 't_buf', 'min', 'sda', 'sda'],
  ]
  for (const [k, name, worst, from, to] of names) {
    const v = d.timing[k]
    const at = d.worst_at[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || (k === 'tvd_dat_max' && !at)) continue
    w.set({ parameter: name, value: v, unit: 's', worst, ...(at ? { t0: at[0], t1: at[1] } : {}), from, to, count: d.frames.length })
  }
  if (Number.isFinite(d.period_min)) {
    const at = d.worst_at.period
    w.set({ parameter: 'f_scl', value: 1 / d.period_min, unit: 'Hz', worst: 'max', ...(at ? { t0: at[0], t1: at[1] } : {}), from: 'scl', to: 'scl', count: d.frames.length })
  }
  w.set({ parameter: 'framing_errors', value: d.timing.framing, unit: '', worst: 'max', count: d.frames.length })
  w.set({ parameter: 'unknown_bits', value: d.timing.unknown, unit: '', worst: 'max', count: d.frames.length })
  return { measured: w.all(), frames: d.frames.length, windows }
}

// ------------------------------------------------------------------ SPI

export function measureSpi(sig: { sck: Signal; cs?: Signal | undefined; mosi?: Signal | undefined; miso?: Signal | undefined }, o: { mode: 0 | 1 | 2 | 3; csActiveHigh?: boolean }): { measured: Measured[]; transfers: number; windows: [number, number][] } {
  const cpol = o.mode >= 2
  const cpha = o.mode % 2 === 1
  const sampleRising = cpol === cpha
  const csOn = o.csActiveHigh ? '1' : '0'
  const all = sig.sck.edges('any')
  const samples = sig.sck.edges(sampleRising ? 'rising' : 'falling')
  const launches = sig.sck.edges(sampleRising ? 'falling' : 'rising')
  const windows: [number, number][] = sig.cs
    ? sig.cs.intervals(csOn).filter(([a]) => a !== sig.cs?.t[0]).map(([a, b]) => [a, b === Infinity ? Math.max(a, ...all) : b])
    : all.length ? [[all[0] as number, all[all.length - 1] as number]] : []
  const w = new Worst(windows)
  const inside = (t: number, a: number, b: number): boolean => t > a && t < b
  const idleLevel = cpol ? '1' : '0'
  let prevEnd: number | null = null
  for (const [a, b] of windows) {
    const es = all.filter((t) => inside(t, a, b))
    if (!es.length) continue
    if (sig.cs) {
      w.add('tcss', 's', 'min', (es[0] as number) - a, a, es[0] as number, 'cs', 'sck')
      w.add('tcsh', 's', 'min', b - (es[es.length - 1] as number), es[es.length - 1] as number, b, 'sck', 'cs')
      if (prevEnd !== null) w.add('tcsd', 's', 'min', a - prevEnd, prevEnd, a, 'cs', 'cs')
      prevEnd = b
    }
    // SCK phases inside the window
    for (let k = 1; k < es.length; k++) {
      const t0 = es[k - 1] as number
      const t1 = es[k] as number
      const lvl = sig.sck.at(t0)
      w.add(lvl === idleLevel ? 't_sck_low' : 't_sck_high', 's', 'min', t1 - t0, t0, t1, 'sck', 'sck')
    }
    const ss = samples.filter((t) => inside(t, a, b))
    for (let k = 1; k < ss.length; k++) w.add('f_sck', 'Hz', 'max', 1 / ((ss[k] as number) - (ss[k - 1] as number)), ss[k - 1] as number, ss[k] as number, 'sck', 'sck')
    const ls = [...(cpha ? [] : [a]), ...launches.filter((t) => inside(t, a, b))]
    // data in (MOSI) at the responder's sampling edge
    if (sig.mosi) {
      const ch = sig.mosi.changes()
      for (const t of ss) {
        const before = lastBefore(ch, t)
        const after = firstAfter(ch, t)
        if (before !== null && before > a - 1e-15) w.add('tsu', 's', 'min', t - before, before, t, 'mosi', 'sck')
        if (after !== null && after <= b) w.add('th', 's', 'min', after - t, t, after, 'sck', 'mosi')
      }
    }
    if (sig.miso) {
      const ch = sig.miso.changes()
      for (const t of ls) {
        const next = ss.find((x) => x > t) ?? b
        const changes = ch.filter((x) => x >= t && x < next)
        if (!changes.length) continue
        const valid = changes.filter((x) => { const v = (sig.miso as Signal).at(x); return v === '0' || v === '1' })
        const from = t === a && !cpha ? 'cs' : 'sck'
        w.add('tho', 's', 'min', (changes[0] as number) - t, t, changes[0] as number, from, 'miso')
        if (valid.length) w.add('tv', 's', 'max', (valid[valid.length - 1] as number) - t, t, valid[valid.length - 1] as number, from, 'miso')
      }
      for (const t of ss) {
        const before = lastBefore(ch, t)
        const after = firstAfter(ch, t)
        if (before !== null && before >= a) w.add('tsu_mi', 's', 'min', t - before, before, t, 'miso', 'sck')
        if (after !== null && after <= b) w.add('th_mi', 's', 'min', after - t, t, after, 'sck', 'miso')
      }
    }
  }
  return { measured: w.all(), transfers: windows.length, windows }
}

function lastBefore(ch: readonly number[], t: number): number | null {
  let lo = 0
  let hi = ch.length
  while (lo < hi) { const m = (lo + hi) >> 1; if ((ch[m] as number) < t) lo = m + 1; else hi = m }
  return lo > 0 ? (ch[lo - 1] as number) : null
}

function firstAfter(ch: readonly number[], t: number): number | null {
  let lo = 0
  let hi = ch.length
  while (lo < hi) { const m = (lo + hi) >> 1; if ((ch[m] as number) <= t) lo = m + 1; else hi = m }
  return lo < ch.length ? (ch[lo] as number) : null
}

// ------------------------------------------------------------------ UART

export function measureUart(line: Signal, o: UartOptions, end: number): { measured: Measured[]; frames: number; windows: [number, number][] } {
  const fr = uartDecode(line, o, end)
  const nominal = 1 / o.baud
  const bits = 1 + (o.dataBits ?? 8) + (o.parity && o.parity !== 'none' ? 1 : 0)
  const windows = fr.map((f) => [f.t, f.t + nominal * (bits + (o.stopBits ?? 1))] as [number, number])
  const w = new Worst(windows)
  const edges = line.edges('any')
  fr.forEach((f, i) => {
    const [a, b] = windows[i] as [number, number]
    const inFrame = edges.filter((t) => t > a && t < b - nominal * 0.5)
    const last = inFrame[inFrame.length - 1]
    if (last === undefined) return
    const n = Math.round((last - a) / nominal)
    if (n < 1) return
    const err = ((nominal / ((last - a) / n)) - 1) * 100
    w.add('baud_error', '%', 'max', Math.abs(err), a, last, 'rx', 'rx')
    w.add('baud_measured', 'Hz', 'max', n / (last - a), a, last, 'rx', 'rx')
  })
  w.set({ parameter: 'framing_errors', value: fr.filter((f) => f.framing_error && f.value !== 0).length, unit: '', worst: 'max', count: fr.length })
  w.set({ parameter: 'parity_errors', value: fr.filter((f) => f.parity_error).length, unit: '', worst: 'max', count: fr.length })
  w.set({ parameter: 'breaks', value: fr.filter((f) => f.framing_error && f.value === 0).length, unit: '', worst: 'max', count: fr.length })
  return { measured: w.all(), frames: fr.length, windows }
}

// ------------------------------------------------------------------ 1-Wire

export function measureOnewire(dq: Signal, speed: 'standard' | 'overdrive'): { measured: Measured[]; events: number; windows: [number, number][] } {
  const d = onewireDecode(dq, { speed })
  const w = new Worst()
  const map: [keyof typeof d.timing, string, 'min' | 'max'][] = [['t_rstl_min', 't_rstl', 'min'], ['t_pdh_max', 't_pdh', 'max'], ['t_pdl_min', 't_pdl', 'min'], ['t_slot_min', 't_slot', 'min'], ['t_low1_max', 't_low1', 'max'], ['t_low0_min', 't_low0', 'min'], ['t_rec_min', 't_rec', 'min']]
  // a responder's read-0 low: both ends matter (past the sample instant, released before the slot ends)
  if (d.timing.t_rd0_min && d.timing.t_rd0_max) {
    const [lo, a0, b0] = d.timing.t_rd0_min
    const [hi, a1, b1] = d.timing.t_rd0_max
    w.set({ parameter: 't_rd0', value: lo, unit: 's', worst: 'min', t0: a0, t1: b0, from: 'dq', to: 'dq', count: d.events.length, range: { min: lo, max: hi, at_min: [a0, b0], at_max: [a1, b1] } })
  }
  for (const [k, name, worst] of map) {
    const v = d.timing[k]
    if (v) w.set({ parameter: name, value: v[0], unit: 's', worst, t0: v[1], t1: v[2], from: 'dq', to: 'dq', count: d.events.length })
  }
  return { measured: w.all(), events: d.events.length, windows: [] }
}

// ------------------------------------------------------------------ CAN

export function measureCan(line: Signal, o: { bitrate: number; samplePoint?: number }, end: number): { measured: Measured[]; frames: number; windows: [number, number][] } {
  const fr = canDecode(line, { bitrate: o.bitrate, samplePoint: o.samplePoint }, end)
  const windows = fr.map((f) => [f.t, f.end] as [number, number])
  const w = new Worst(windows)
  const nominal = 1 / o.bitrate
  const edges = line.edges('any')
  fr.forEach((f) => {
    const es = edges.filter((t) => t >= f.t && t <= f.end)
    const last = es[es.length - 1]
    if (last === undefined || last === f.t) return
    const n = Math.round((last - f.t) / nominal)
    if (n < 1) return
    w.add('bitrate_error', '%', 'max', Math.abs((nominal / ((last - f.t) / n) - 1) * 100), f.t, last, 'can', 'can')
  })
  w.set({ parameter: 'frame_errors', value: fr.filter((f) => f.errors.length).length, unit: '', worst: 'max', count: fr.length })
  w.set({ parameter: 'not_acknowledged', value: fr.filter((f) => !f.ack).length, unit: '', worst: 'max', count: fr.length })
  return { measured: w.all(), frames: fr.length, windows }
}

export { finite }
