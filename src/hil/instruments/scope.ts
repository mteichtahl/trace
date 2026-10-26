/**
 * Oscilloscopes: channel setup (scale, offset, coupling, probe), timebase, edge trigger, run / stop / single, waveform
 * fetch scaled to volts and seconds from the instrument's preamble, and built-in measurements.
 *
 * Dialects: Rigol DS1000Z and MSO5000, Siglent SDS, Keysight InfiniiVision, Tektronix MSO, and a generic
 * InfiniiVision-style fallback. Each dialect turns raw sample codes into volts with its own preamble arithmetic; those
 * functions are pure (scaleRigol, scaleKeysight, scaleTek, scaleSiglent) so they are tested without an instrument.
 *
 * A fetched waveform is kept whole in the run record (CSV text) and returned decimated, with statistics computed over
 * every sample, so a caller sees the shape without receiving a megabyte of numbers.
 */
import { ToolError } from '../../core/registry.js'
import { num, type Transport } from '../scpi.js'
import { round, type DialectMatch } from './base.js'
import { sleep } from '../bytes.js'

export type Coupling = 'dc' | 'ac' | 'gnd'
export type Slope = 'rising' | 'falling' | 'either'
export type MeasureKind = 'vpp' | 'vmax' | 'vmin' | 'vavg' | 'vrms' | 'freq' | 'period' | 'rise' | 'fall' | 'duty'

export interface ChannelSetup {
  channel: number
  scale_v?: number | undefined
  offset_v?: number | undefined
  coupling?: Coupling | undefined
  probe?: number | undefined
  enabled?: boolean | undefined
}

export interface TriggerSetup {
  source: number
  level_v: number
  slope?: Slope | undefined
}

export interface Waveform {
  t0: number
  dt: number
  v: Float64Array
}

export interface ScopeDialect extends DialectMatch {
  channel(c: ChannelSetup): string[]
  timebase(scale_s: number, position_s?: number): string[]
  trigger(tr: TriggerSetup): string[]
  run(): string[]
  stop(): string[]
  single(): string[]
  /** true once a single acquisition has completed */
  done(t: Transport): Promise<boolean>
  fetch(t: Transport, ch: number, maxPoints: number): Promise<Waveform>
  /** a built-in measurement, or null if the dialect has no such item */
  measure(t: Transport, ch: number, kind: MeasureKind): Promise<number | null>
}

// ------------------------------------------------------------------ scaling (pure)

export interface Preamble10 {
  points: number
  xinc: number
  xorig: number
  xref: number
  yinc: number
  yorig: number
  yref: number
}

/** "<format>,<type>,<points>,<count>,<xinc>,<xorig>,<xref>,<yinc>,<yorig>,<yref>" (Rigol and Keysight share it). */
export function parsePreamble10(s: string): Preamble10 {
  const p = s.split(',').map((x) => Number(x.trim()))
  if (p.length < 10 || p.some((x) => !Number.isFinite(x))) throw new ToolError(`unexpected waveform preamble ${JSON.stringify(s.slice(0, 120))}`)
  const [, , points, , xinc, xorig, xref, yinc, yorig, yref] = p as [number, number, number, number, number, number, number, number, number, number]
  return { points, xinc, xorig, xref, yinc, yorig, yref }
}

/** Rigol: V = (code − yorigin − yreference) × yincrement; t = (i − xreference) × xincrement + xorigin. */
export function scaleRigol(codes: Uint8Array, p: Preamble10): Waveform {
  const v = new Float64Array(codes.length)
  for (let i = 0; i < codes.length; i++) v[i] = (codes[i]! - p.yorig - p.yref) * p.yinc
  return { t0: (0 - p.xref) * p.xinc + p.xorig, dt: p.xinc, v }
}

/** Keysight InfiniiVision (unsigned bytes): V = (code − yreference) × yincrement + yorigin. */
export function scaleKeysight(codes: Uint8Array, p: Preamble10): Waveform {
  const v = new Float64Array(codes.length)
  for (let i = 0; i < codes.length; i++) v[i] = (codes[i]! - p.yref) * p.yinc + p.yorig
  return { t0: (0 - p.xref) * p.xinc + p.xorig, dt: p.xinc, v }
}

export interface TekPreamble {
  xincr: number
  xzero: number
  pt_off: number
  ymult: number
  yoff: number
  yzero: number
}

/** Tek (RIBinary, 1 byte signed): V = (code − YOFf) × YMUlt + YZEro; t = XZEro + (i − PT_Off) × XINcr. */
export function scaleTek(codes: Uint8Array, p: TekPreamble): Waveform {
  const s = new Int8Array(codes.buffer, codes.byteOffset, codes.length)
  const v = new Float64Array(s.length)
  for (let i = 0; i < s.length; i++) v[i] = (s[i]! - p.yoff) * p.ymult + p.yzero
  return { t0: p.xzero - p.pt_off * p.xincr, dt: p.xincr, v }
}

export interface SiglentPreamble {
  vdiv: number
  offset: number
  tdiv: number
  sample_rate: number
  delay: number
  /** codes per division: 25 on SDS1000X-E / 2000X; 30 on SDS2000X Plus and later */
  codes_per_div: number
  /** horizontal divisions: 14 on SDS1000X-E, 10 on later models */
  hdivs: number
}

/** Siglent (signed bytes): V = code × vdiv / codes_per_div − offset; t = −(tdiv × hdivs / 2) − delay + i / sample_rate. */
export function scaleSiglent(codes: Uint8Array, p: SiglentPreamble): Waveform {
  const s = new Int8Array(codes.buffer, codes.byteOffset, codes.length)
  const v = new Float64Array(s.length)
  for (let i = 0; i < s.length; i++) v[i] = (s[i]! * p.vdiv) / p.codes_per_div - p.offset
  return { t0: -(p.tdiv * p.hdivs) / 2 - p.delay, dt: 1 / p.sample_rate, v }
}

// ------------------------------------------------------------------ statistics over a waveform

export interface WaveStats {
  points: number
  vmin: number
  vmax: number
  vpp: number
  vavg: number
  vrms: number
  freq_hz: number | null
  period_s: number | null
  rise_s: number | null
  fall_s: number | null
  duty_pct: number | null
}

/** Statistics over every sample: amplitude, and edge timing measured between 10 % and 90 % of the swing. */
export function stats(w: Waveform): WaveStats {
  const v = w.v
  const n = v.length
  if (!n) return { points: 0, vmin: NaN, vmax: NaN, vpp: NaN, vavg: NaN, vrms: NaN, freq_hz: null, period_s: null, rise_s: null, fall_s: null, duty_pct: null }
  let lo = Infinity, hi = -Infinity, sum = 0, sq = 0
  for (let i = 0; i < n; i++) {
    const x = v[i]!
    if (x < lo) lo = x
    if (x > hi) hi = x
    sum += x
    sq += x * x
  }
  const out: WaveStats = { points: n, vmin: lo, vmax: hi, vpp: hi - lo, vavg: sum / n, vrms: Math.sqrt(sq / n), freq_hz: null, period_s: null, rise_s: null, fall_s: null, duty_pct: null }
  const swing = hi - lo
  if (!(swing > 0)) return out
  const mid = lo + swing / 2, l10 = lo + swing * 0.1, l90 = lo + swing * 0.9
  // hysteresis around the midpoint, so noise does not count as edges
  const hyst = swing * 0.05
  const at = (i: number, level: number): number => {
    // linear interpolation of the crossing between samples i-1 and i
    const a = v[i - 1]!, b = v[i]!
    return w.t0 + (i - 1 + (b === a ? 0 : (level - a) / (b - a))) * w.dt
  }
  const rising: number[] = [], falling: number[] = []
  let state = v[0]! > mid ? 1 : 0
  for (let i = 1; i < n; i++) {
    const x = v[i]!
    if (state === 0 && x > mid + hyst) { state = 1; rising.push(i) }
    else if (state === 1 && x < mid - hyst) { state = 0; falling.push(i) }
  }
  const crossTimes = (idx: number[], dir: 1 | -1): number[] => idx.map((i) => {
    let j = i
    while (j > 1 && (dir === 1 ? v[j - 1]! > mid : v[j - 1]! < mid)) j--
    return at(j, mid)
  })
  const rt = crossTimes(rising, 1), ft = crossTimes(falling, -1)
  if (rt.length >= 2) {
    const period = (rt.at(-1)! - rt[0]!) / (rt.length - 1)
    out.period_s = period
    out.freq_hz = 1 / period
    const firstFallAfter = ft.find((t) => t > rt[0]!)
    if (firstFallAfter !== undefined) out.duty_pct = ((firstFallAfter - rt[0]!) / period) * 100
  } else if (ft.length >= 2) {
    const period = (ft.at(-1)! - ft[0]!) / (ft.length - 1)
    out.period_s = period
    out.freq_hz = 1 / period
  }
  const edge = (i: number, dir: 1 | -1): number | null => {
    const from = dir === 1 ? l10 : l90, to = dir === 1 ? l90 : l10
    let a = i, b = i
    while (a > 1 && (dir === 1 ? v[a - 1]! > from : v[a - 1]! < from)) a--
    while (b < n - 1 && (dir === 1 ? v[b]! < to : v[b]! > to)) b++
    if (a <= 1 || b >= n - 1) return null
    return at(b, to) - at(a, from)
  }
  const r = rising.map((i) => edge(i, 1)).filter((x): x is number => x !== null)
  const f = falling.map((i) => edge(i, -1)).filter((x): x is number => x !== null)
  if (r.length) out.rise_s = r.reduce((a, b) => a + b, 0) / r.length
  if (f.length) out.fall_s = f.reduce((a, b) => a + b, 0) / f.length
  return out
}

export function statsFor(s: WaveStats, kind: MeasureKind): number | null {
  const m: Record<MeasureKind, number | null> = { vpp: s.vpp, vmax: s.vmax, vmin: s.vmin, vavg: s.vavg, vrms: s.vrms, freq: s.freq_hz, period: s.period_s, rise: s.rise_s, fall: s.fall_s, duty: s.duty_pct }
  const v = m[kind]
  return v !== null && Number.isFinite(v) ? v : null
}

/** Evenly spaced points (at most `max`), with the extremes of each bucket kept so peaks survive. */
export function decimate(w: Waveform, max: number): { t: number[]; v: number[] } {
  const n = w.v.length
  const t: number[] = [], v: number[] = []
  if (n <= max) {
    for (let i = 0; i < n; i++) { t.push(round(w.t0 + i * w.dt, 7)); v.push(round(w.v[i]!, 5)) }
    return { t, v }
  }
  const buckets = Math.max(1, Math.floor(max / 2))
  const size = n / buckets
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size), e = Math.min(n, Math.floor((b + 1) * size))
    let iMin = s, iMax = s
    for (let i = s; i < e; i++) { if (w.v[i]! < w.v[iMin]!) iMin = i; if (w.v[i]! > w.v[iMax]!) iMax = i }
    for (const i of iMin === iMax ? [iMin] : iMin < iMax ? [iMin, iMax] : [iMax, iMin]) {
      t.push(round(w.t0 + i * w.dt, 7)); v.push(round(w.v[i]!, 5))
    }
  }
  return { t, v }
}

export function toCsv(waves: { name: string; w: Waveform }[]): string {
  const first = waves[0]
  if (!first) return ''
  const n = Math.max(...waves.map((x) => x.w.v.length))
  const lines = [`t_s,${waves.map((x) => `${x.name}_v`).join(',')}`]
  for (let i = 0; i < n; i++) {
    lines.push(`${(first.w.t0 + i * first.w.dt).toPrecision(9)},${waves.map((x) => (i < x.w.v.length ? x.w.v[i]!.toPrecision(6) : '')).join(',')}`)
  }
  return `${lines.join('\n')}\n`
}

// ------------------------------------------------------------------ dialects

const g = (v: number): string => String(round(v, 6))

async function preamble10(t: Transport, cmds: string[]): Promise<Preamble10> {
  for (const c of cmds) await t.write(c)
  return parsePreamble10(await t.query(':WAV:PRE?'))
}

const rigolBase = {
  channel: (c: ChannelSetup): string[] => {
    const p = `:CHAN${c.channel}`
    const out: string[] = []
    if (c.enabled !== undefined) out.push(`${p}:DISP ${c.enabled ? 'ON' : 'OFF'}`)
    if (c.probe !== undefined) out.push(`${p}:PROB ${g(c.probe)}`)
    if (c.coupling) out.push(`${p}:COUP ${c.coupling.toUpperCase()}`)
    if (c.scale_v !== undefined) out.push(`${p}:SCAL ${g(c.scale_v)}`)
    if (c.offset_v !== undefined) out.push(`${p}:OFFS ${g(c.offset_v)}`)
    return out
  },
  timebase: (s: number, pos?: number): string[] => [`:TIM:MAIN:SCAL ${g(s)}`, ...(pos !== undefined ? [`:TIM:MAIN:OFFS ${g(pos)}`] : [])],
  trigger: (tr: TriggerSetup): string[] => [':TRIG:MODE EDGE', `:TRIG:EDGE:SOUR CHAN${tr.source}`,
    `:TRIG:EDGE:SLOP ${tr.slope === 'falling' ? 'NEG' : tr.slope === 'either' ? 'RFAL' : 'POS'}`, `:TRIG:EDGE:LEV ${g(tr.level_v)}`],
  run: () => [':RUN'],
  stop: () => [':STOP'],
  single: () => [':SING'],
  done: async (t: Transport) => /STOP/i.test(await t.query(':TRIG:STAT?')),
  fetch: async (t: Transport, ch: number, maxPoints: number) => {
    const p = await preamble10(t, [':STOP', `:WAV:SOUR CHAN${ch}`, ':WAV:MODE NORM', ':WAV:FORM BYTE'])
    // NORM mode returns the screen's points (1200 on a DS1000Z); RAW memory reads need :WAV:STAR/STOP paging
    void maxPoints
    return scaleRigol(await t.queryBinary(':WAV:DATA?', 30_000), p)
  },
}

const RIGOL_ITEMS: Partial<Record<MeasureKind, string>> = { vpp: 'VPP', vmax: 'VMAX', vmin: 'VMIN', vavg: 'VAVG', vrms: 'VRMS', freq: 'FREQ', period: 'PER', rise: 'RTIM', fall: 'FTIM', duty: 'PDUT' }
const KS_ITEMS: Partial<Record<MeasureKind, string>> = { vpp: 'VPP', vmax: 'VMAX', vmin: 'VMIN', vavg: 'VAV', vrms: 'VRMS', freq: 'FREQ', period: 'PER', rise: 'RIS', fall: 'FALL', duty: 'DUTY' }
const SDS_ITEMS: Partial<Record<MeasureKind, string>> = { vpp: 'PKPK', vmax: 'MAX', vmin: 'MIN', vavg: 'MEAN', vrms: 'RMS', freq: 'FREQ', period: 'PER', rise: 'RISE', fall: 'FALL', duty: 'DUTY' }
const TEK_ITEMS: Partial<Record<MeasureKind, string>> = { vpp: 'PK2PK', vmax: 'MAXIMUM', vmin: 'MINIMUM', vavg: 'MEAN', vrms: 'RMS', freq: 'FREQUENCY', period: 'PERIOD', rise: 'RISE', fall: 'FALL', duty: 'PDUTY' }

/** Instruments answer an impossible measurement with 9.9E37 (or a huge number): that is "no value". */
const sane = (x: number): number | null => (Number.isFinite(x) && Math.abs(x) < 9e36 ? x : null)

const keysightBase = {
  channel: (c: ChannelSetup): string[] => {
    const p = `:CHAN${c.channel}`
    const out: string[] = []
    if (c.enabled !== undefined) out.push(`${p}:DISP ${c.enabled ? 1 : 0}`)
    if (c.probe !== undefined) out.push(`${p}:PROB ${g(c.probe)}`)
    if (c.coupling) {
      if (c.coupling === 'gnd') throw new ToolError('InfiniiVision channels have no GND coupling')
      out.push(`${p}:COUP ${c.coupling.toUpperCase()}`)
    }
    if (c.scale_v !== undefined) out.push(`${p}:SCAL ${g(c.scale_v)}`)
    if (c.offset_v !== undefined) out.push(`${p}:OFFS ${g(c.offset_v)}`)
    return out
  },
  timebase: (s: number, pos?: number): string[] => [`:TIM:SCAL ${g(s)}`, ...(pos !== undefined ? [`:TIM:POS ${g(pos)}`] : [])],
  trigger: (tr: TriggerSetup): string[] => [':TRIG:MODE EDGE', `:TRIG:EDGE:SOUR CHAN${tr.source}`,
    `:TRIG:EDGE:SLOP ${tr.slope === 'falling' ? 'NEG' : tr.slope === 'either' ? 'EITH' : 'POS'}`, `:TRIG:EDGE:LEV ${g(tr.level_v)}`],
  run: () => [':RUN'],
  stop: () => [':STOP'],
  single: () => [':SING'],
  // :OPER:COND? bit 3 (8) is "Run"; a single acquisition clears it when done
  done: async (t: Transport) => (Math.trunc(num(await t.query(':OPER:COND?'))) & 8) === 0,
  fetch: async (t: Transport, ch: number, maxPoints: number) => {
    const p = await preamble10(t, [`:WAV:SOUR CHAN${ch}`, ':WAV:FORM BYTE', ':WAV:UNS 1', ':WAV:POIN:MODE RAW', `:WAV:POIN ${maxPoints > 0 ? maxPoints : 'MAX'}`])
    return scaleKeysight(await t.queryBinary(':WAV:DATA?', 30_000), p)
  },
  measure: async (t: Transport, ch: number, kind: MeasureKind) => {
    const item = KS_ITEMS[kind]
    return item ? sane(num(await t.query(`:MEAS:${item}? CHAN${ch}`))) : null
  },
}

export const SCOPE_DIALECTS: readonly ScopeDialect[] = [
  {
    id: 'rigol-ds1000z', idn: /RIGOL.*,\s*(DS1\d{3}Z|MSO1\d{3}Z|DS2\d{3}|DS4\d{3})|^(DS1\d{3}Z|MSO1\d{3}Z)/i,
    ...rigolBase,
    measure: async (t, ch, kind) => {
      const item = RIGOL_ITEMS[kind]
      return item ? sane(num(await t.query(`:MEAS:ITEM? ${item},CHAN${ch}`))) : null
    },
  },
  {
    // MSO5000/MSO7000/MSO8000/DHO: the same waveform system, measurement items via :MEAS:ITEM?
    id: 'rigol-mso5000', idn: /RIGOL.*,\s*(MSO[578]\d{3}|DHO\d+)|^(MSO[578]\d{3}|DHO\d+)/i,
    ...rigolBase,
    measure: async (t, ch, kind) => {
      const item = RIGOL_ITEMS[kind]
      return item ? sane(num(await t.query(`:MEAS:ITEM? ${item},CHAN${ch}`))) : null
    },
  },
  {
    id: 'siglent-sds', idn: /SIGLENT.*,\s*SDS\d+|^SDS\d+/i,
    channel: (c) => {
      const p = `C${c.channel}`
      const out: string[] = []
      if (c.enabled !== undefined) out.push(`${p}:TRA ${c.enabled ? 'ON' : 'OFF'}`)
      if (c.probe !== undefined) out.push(`${p}:ATTN ${g(c.probe)}`)
      if (c.coupling) out.push(`${p}:CPL ${c.coupling === 'ac' ? 'A1M' : c.coupling === 'gnd' ? 'GND' : 'D1M'}`)
      if (c.scale_v !== undefined) out.push(`${p}:VDIV ${g(c.scale_v)}V`)
      if (c.offset_v !== undefined) out.push(`${p}:OFST ${g(c.offset_v)}V`)
      return out
    },
    timebase: (s, pos) => [`TDIV ${g(s)}S`, ...(pos !== undefined ? [`TRDL ${g(pos)}S`] : [])],
    trigger: (tr) => [`TRSE EDGE,SR,C${tr.source},HT,OFF`, `C${tr.source}:TRSL ${tr.slope === 'falling' ? 'NEG' : tr.slope === 'either' ? 'WINDOW' : 'POS'}`, `C${tr.source}:TRLV ${g(tr.level_v)}V`],
    run: () => ['TRMD AUTO'],
    stop: () => ['STOP'],
    single: () => ['TRMD SINGLE', 'ARM'],
    done: async (t) => /stop/i.test(await t.query('SAST?')),
    fetch: async (t, ch) => {
      const vdiv = num(await t.query(`C${ch}:VDIV?`))
      const offset = num(await t.query(`C${ch}:OFST?`))
      const tdiv = num(await t.query('TDIV?'))
      const sample_rate = num(await t.query('SARA?'))
      const delay = num(await t.query('TRDL?'))
      const model = (await t.query('*IDN?')).split(',')[1] ?? ''
      // SDS1000X-E/2000X: 25 codes/div, 14 divisions; SDS2000X Plus, 5000X, 6000: 30 codes/div, 10 divisions
      const newer = /SDS(2\d{3}X\s*(PLUS|\+|HD)|5\d{3}|6\d{3}|7\d{3}|8\d{3}|3\d{3}X\s*HD|1\d{3}X\s*HD)/i.test(model)
      await t.write('WFSU SP,0,NP,0,FP,0')
      const codes = await t.queryBinary(`C${ch}:WF? DAT2`, 30_000)
      return scaleSiglent(codes, { vdiv, offset, tdiv, sample_rate, delay, codes_per_div: newer ? 30 : 25, hdivs: newer ? 10 : 14 })
    },
    measure: async (t, ch, kind) => {
      const item = SDS_ITEMS[kind]
      if (!item) return null
      const r = await t.query(`C${ch}:PAVA? ${item}`) // "C1:PAVA PKPK,3.28E+00V"
      const val = r.split(',')[1] ?? r
      return /\*\*\*|UNDEF/i.test(val) ? null : sane(num(val))
    },
  },
  { id: 'keysight-infiniivision', idn: /(AGILENT|KEYSIGHT).*,\s*(DSO|MSO|DSOX|MSOX|EDUX)[-\s]?\d+/i, ...keysightBase },
  {
    id: 'tek-mso', idn: /TEKTRONIX.*,\s*(MSO|DPO|MDO|TBS|TDS)\d*/i,
    channel: (c) => {
      const p = `CH${c.channel}`
      const out: string[] = []
      if (c.enabled !== undefined) out.push(`SEL:${p} ${c.enabled ? 'ON' : 'OFF'}`)
      if (c.probe !== undefined) out.push(`${p}:PRO:GAIN ${g(1 / c.probe)}`)
      if (c.coupling) out.push(`${p}:COUP ${c.coupling.toUpperCase()}`)
      if (c.scale_v !== undefined) out.push(`${p}:SCA ${g(c.scale_v)}`)
      if (c.offset_v !== undefined) out.push(`${p}:OFFS ${g(c.offset_v)}`)
      return out
    },
    timebase: (s, pos) => [`HOR:SCA ${g(s)}`, ...(pos !== undefined ? ['HOR:DEL:MOD ON', `HOR:DEL:TIM ${g(pos)}`] : [])],
    trigger: (tr) => ['TRIG:A:TYP EDGE', `TRIG:A:EDGE:SOU CH${tr.source}`, `TRIG:A:EDGE:SLO ${tr.slope === 'falling' ? 'FALL' : tr.slope === 'either' ? 'EIT' : 'RIS'}`, `TRIG:A:LEV:CH${tr.source} ${g(tr.level_v)}`],
    run: () => ['ACQ:STOPA RUNST', 'ACQ:STATE RUN'],
    stop: () => ['ACQ:STATE STOP'],
    single: () => ['ACQ:STOPA SEQ', 'ACQ:STATE RUN'],
    done: async (t) => /^\s*0\s*$/.test(await t.query('ACQ:STATE?')),
    fetch: async (t, ch, maxPoints) => {
      const total = Math.trunc(num(await t.query('HOR:RECO?')))
      const stop = maxPoints > 0 ? Math.min(total, maxPoints) : total
      for (const c of [`DAT:SOU CH${ch}`, 'DAT:ENC RIB', 'WFMO:BYT_N 1', 'DAT:STAR 1', `DAT:STOP ${stop}`]) await t.write(c)
      const p: TekPreamble = {
        xincr: num(await t.query('WFMO:XIN?')), xzero: num(await t.query('WFMO:XZE?')), pt_off: num(await t.query('WFMO:PT_O?')),
        ymult: num(await t.query('WFMO:YMU?')), yoff: num(await t.query('WFMO:YOF?')), yzero: num(await t.query('WFMO:YZE?')),
      }
      return scaleTek(await t.queryBinary('CURV?', 30_000), p)
    },
    measure: async (t, ch, kind) => {
      const item = TEK_ITEMS[kind]
      if (!item) return null
      for (const c of [`MEASU:IMM:SOU1 CH${ch}`, `MEASU:IMM:TYP ${item}`]) await t.write(c)
      return sane(num(await t.query('MEASU:IMM:VAL?')))
    },
  },
  { id: 'generic', idn: /$^/, ...keysightBase },
]

/** Arm a single acquisition and wait (polling) until it completes or `timeoutMs` passes. */
export async function single(t: Transport, d: ScopeDialect, timeoutMs: number): Promise<boolean> {
  for (const c of d.single()) await t.write(c)
  const end = Date.now() + timeoutMs
  await sleep(50)
  while (Date.now() < end) {
    if (await d.done(t)) return true
    await sleep(100)
  }
  return false
}
