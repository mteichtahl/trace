/**
 * Waveforms: one set of readers, decoders and timing checks for a simulator's VCD and for a logic analyser's capture.
 *
 * A capture, simulated or measured, is a set of signals, each a list of (time, value) changes. Digital values are
 * strings: "0", "1", "x", "z" for one bit, or a binary string for a bus. Analog CSV columns are kept as samples and
 * turned into logic levels with a threshold (or a vil/vih pair, with hysteresis) when a decoder needs them. So a margin
 * measured on the bench and one simulated in Icarus are the same arithmetic on the same structures.
 *
 * Read: VCD (Icarus, Verilator, sigrok-cli -O vcd, Saleae Logic 2 export; read line by line, so large files stream)
 * and CSV with a time column first and one column per channel (Saleae digital.csv / analog.csv, sigrok -O csv;
 * a "[ms]"-style unit in the time header is honoured). Write: VCD.
 *
 * Signals are found by full hierarchical name (tb.dut.sck), by the name without its top scope (dut.sck), or by the
 * leaf name when that is unique; decoders and checks take a role map ({sck: "D0", mosi: "D1"}).
 *
 * Decoders: SPI (modes 0-3, optional chip select, MSB or LSB first, any word size), I2C (START, repeated START, STOP,
 * address, R/W, ACK/NACK, data, and the bus timing of UM10204 Table 10, checked against a speed mode when one is given),
 * UART (baud, data bits, parity, stop bits, idle level). Timing checks: setup and hold of data around a clock edge,
 * chip select to clock, select spacing, more than one select or driver active at once, pulse widths and period.
 * Results are compact: long lists are capped and always come with their full counts.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'

export class WaveError extends Error {
  override name = 'WaveError'
}

const UNITS: Readonly<Record<string, number>> = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 }

// ------------------------------------------------------------------------------------------- structures

export class Signal {
  readonly t: number[] = []
  readonly v: string[] = []
  constructor(readonly name: string, readonly width = 1) {}

  push(t: number, v: string): void {
    const n = this.v.length
    if (n && this.v[n - 1] === v) return
    if (n && this.t[n - 1] === t) {
      this.v[n - 1] = v
      if (n > 1 && this.v[n - 2] === v) {
        this.v.pop()
        this.t.pop()
      }
      return
    }
    this.t.push(t)
    this.v.push(v)
  }

  /** The index of the last change at or before t (-1 before the first). */
  private idx(t: number, strict: boolean): number {
    let lo = 0
    let hi = this.t.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const tm = this.t[mid] as number
      if (strict ? tm < t : tm <= t) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }

  /** The value at time t (the last change at or before it). */
  at(t: number): string {
    const k = this.idx(t, false)
    return k >= 0 ? (this.v[k] as string) : 'x'
  }

  /** The value just before t: what a flip-flop clocked at t samples. */
  before(t: number): string {
    const k = this.idx(t, true)
    return k >= 0 ? (this.v[k] as string) : 'x'
  }

  edges(dir: 'rising' | 'falling' | 'any'): number[] {
    const out: number[] = []
    for (let k = 1; k < this.t.length; k++) {
      const a = this.v[k - 1]
      const b = this.v[k]
      if (dir === 'any' ? a !== b : dir === 'rising' ? a === '0' && b === '1' : a === '1' && b === '0') out.push(this.t[k] as number)
    }
    return out
  }

  /** The times the value changed (after the first sample). */
  changes(): number[] {
    return this.t.slice(1)
  }

  /** [start, end) intervals while the signal holds `value` (end = Infinity if it still holds at the end). */
  intervals(value: string): [number, number][] {
    const out: [number, number][] = []
    let start: number | null = null
    for (let k = 0; k < this.t.length; k++) {
      const vi = this.v[k]
      const ti = this.t[k] as number
      if (vi === value && start === null) start = ti
      else if (vi !== value && start !== null) {
        out.push([start, ti])
        start = null
      }
    }
    if (start !== null) out.push([start, Infinity])
    return out
  }
}

export class AnalogSignal {
  readonly t: number[] = []
  readonly y: number[] = []
  constructor(readonly name: string) {}

  /** Logic levels: a threshold, or vil/vih with hysteresis (between them the last level holds; "x" until known). */
  digital(o: { threshold?: number; vil?: number; vih?: number }): Signal {
    const s = new Signal(this.name)
    const lo = o.vil ?? o.threshold
    const hi = o.vih ?? o.threshold
    if (lo === undefined || hi === undefined) throw new WaveError(`${this.name} is analog: give a threshold (or vil and vih) to read it as logic`)
    let cur = 'x'
    for (let k = 0; k < this.t.length; k++) {
      const v = this.y[k] as number
      if (v >= hi) cur = '1'
      else if (v <= lo) cur = '0'
      s.push(this.t[k] as number, cur)
    }
    return s
  }
}

export class Capture {
  readonly signals = new Map<string, Signal>()
  readonly analog = new Map<string, AnalogSignal>()
  private readonly alias = new Map<string, string>()
  start = 0
  end = 0
  timescale = 1e-9
  source = ''

  add(sig: Signal): void {
    this.signals.set(sig.name, sig)
  }

  /** Short names (leaf, or without the top scope) for names that are unique that way. */
  index(): void {
    const counts = new Map<string, string[]>()
    for (const n of [...this.signals.keys(), ...this.analog.keys()]) {
      const parts = n.split('.')
      const cands = new Set([parts.slice(1).join('.'), parts[parts.length - 1] ?? n])
      for (const c of cands) if (c && c !== n) counts.set(c, [...(counts.get(c) ?? []), n])
    }
    for (const [c, ns] of counts) if (ns.length === 1 && !this.signals.has(c) && !this.analog.has(c)) this.alias.set(c, ns[0] as string)
  }

  names(): string[] {
    return [...this.signals.keys(), ...this.analog.keys()]
  }

  resolve(name: string): string | undefined {
    if (this.signals.has(name) || this.analog.has(name)) return name
    const a = this.alias.get(name)
    if (a) return a
    const lower = name.toLowerCase()
    const all = this.names().filter((n) => n.toLowerCase() === lower)
    return all.length === 1 ? all[0] : undefined
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined
  }

  /** A digital signal by name; an analog one is digitised with `levels`. */
  get(name: string, levels: { threshold?: number; vil?: number; vih?: number } = {}): Signal {
    const n = this.resolve(name)
    if (n === undefined) {
      const have = this.names()
      throw new WaveError(`the capture has no signal ${JSON.stringify(name)} (it has: ${have.slice(0, 40).join(', ')}${have.length > 40 ? `, … ${have.length} in all` : ''})`)
    }
    const d = this.signals.get(n)
    if (d) return d
    return (this.analog.get(n) as AnalogSignal).digital(levels)
  }
}

/** Roles to signals: {sck: "D0"} → the Signal named D0, for every role given. */
export function remap(cap: Capture, roles: Readonly<Record<string, string>>, levels: { threshold?: number; vil?: number; vih?: number } = {}): Record<string, Signal> {
  const out: Record<string, Signal> = {}
  for (const [role, ch] of Object.entries(roles)) {
    try {
      out[role] = cap.get(ch, levels)
    } catch (e) {
      throw new WaveError(`${role}: ${(e as Error).message}`)
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------- VCD

interface VarDef {
  names: string[]
  width: number
  real: boolean
}

/** A streaming VCD parser: feed it lines, then finish(). */
export class VcdParser {
  private header = ''
  private inHeader = true
  private readonly ids = new Map<string, { sigs: Signal[]; width: number; real: boolean }>()
  private t = 0
  /** The timescale as an integer multiple of 10^-exp seconds, so times are exact decimal values (3 × 10 ns = 3e-8). */
  private tsMul = 1
  private tsExp = 9
  private pendingVector: string | null = null
  private inComment = false
  readonly cap = new Capture()
  private first = true

  constructor(private readonly keep?: ReadonlySet<string>) {}

  line(line: string): void {
    if (this.inHeader) {
      this.header += `${line}\n`
      if (line.includes('$enddefinitions')) {
        this.parseHeader()
        this.inHeader = false
        const rest = line.slice(line.indexOf('$enddefinitions') + 15).replace(/^\s*\$end/, '')
        if (rest.trim()) this.body(rest)
      }
      return
    }
    this.body(line)
  }

  private parseHeader(): void {
    const h = this.header
    const ts = /\$timescale\s+(\d+)\s*([munpf]?s)\s+\$end/.exec(h)
    if (ts) {
      const exp = ({ s: 0, ms: 3, us: 6, ns: 9, ps: 12, fs: 15 } as Record<string, number>)[ts[2] as string] ?? 9
      this.tsMul = Number(ts[1])
      this.tsExp = exp
      this.cap.timescale = this.tsMul / 10 ** exp
    }
    const scope: string[] = []
    const defs = new Map<string, VarDef>()
    const re = /\$scope\s+\w+\s+(\S+)\s+\$end|\$upscope\s+\$end|\$var\s+(\w+)\s+(\d+)\s+(\S+)\s+([\s\S]*?)\s*\$end/g
    for (const m of h.matchAll(re)) {
      if (m[1] !== undefined) scope.push(m[1])
      else if (m[0].startsWith('$upscope')) scope.pop()
      else {
        const type = m[2] as string
        const width = Number(m[3])
        const id = m[4] as string
        // the reference may be "name", "name [7:0]" or (Saleae) a name with spaces
        const ref = (m[5] as string).replace(/\s*\[[^\]]*\]\s*$/, '').trim()
        const full = [...scope, ref].join('.')
        const d = defs.get(id) ?? { names: [], width, real: type === 'real' }
        d.names.push(full)
        defs.set(id, d)
      }
    }
    for (const [id, d] of defs) {
      const sigs: Signal[] = []
      for (const n of d.names) {
        if (this.keep && !this.keep.has(n) && !this.keep.has(n.split('.').pop() ?? n) && !this.keep.has(n.split('.').slice(1).join('.'))) continue
        const s = new Signal(n, d.width)
        this.cap.add(s)
        sigs.push(s)
      }
      if (sigs.length) this.ids.set(id, { sigs, width: d.width, real: d.real })
    }
  }

  private set(id: string, v: string): void {
    const e = this.ids.get(id)
    if (!e) return
    let val = v.toLowerCase()
    if (e.width > 1 && !e.real) {
      // left-extend as IEEE 1364 says: 0/1 extend with 0, x/z with themselves
      if (val.length < e.width) {
        const pad = val[0] === 'x' || val[0] === 'z' ? val[0] : '0'
        val = pad.repeat(e.width - val.length) + val
      }
    }
    for (const s of e.sigs) s.push(this.t, val)
  }

  private body(line: string): void {
    for (const tok of line.split(/\s+/)) {
      if (!tok) continue
      if (this.inComment) {
        if (tok === '$end') this.inComment = false
        continue
      }
      if (this.pendingVector !== null) {
        this.set(tok, this.pendingVector)
        this.pendingVector = null
        continue
      }
      const c = tok[0] as string
      if (c === '#') {
        this.t = (Number(tok.slice(1)) * this.tsMul) / 10 ** this.tsExp
        if (this.first) {
          this.cap.start = this.t
          this.first = false
        }
        if (this.t > this.cap.end) this.cap.end = this.t
      } else if (c === '$') {
        if (tok === '$comment') this.inComment = true
      } else if (c === 'b' || c === 'B' || c === 'r' || c === 'R') {
        this.pendingVector = tok.slice(1)
      } else if ('01xzXZuUwWlLhH-'.includes(c)) {
        const v = c === 'h' || c === 'H' ? '1' : c === 'l' || c === 'L' ? '0' : 'xzXZ01'.includes(c) ? c : 'x'
        this.set(tok.slice(1), v)
      }
    }
  }

  finish(source = ''): Capture {
    if (this.inHeader) throw new WaveError('not a VCD: no $enddefinitions')
    this.cap.source = source
    this.cap.index()
    return this.cap
  }
}

async function lines(input: string | Uint8Array, onLine: (l: string) => void): Promise<void> {
  const stream = typeof input === 'string' ? createReadStream(input, { encoding: 'utf8' }) : Readable.from([Buffer.from(input)])
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const l of rl) onLine(l)
}

/** A VCD from a file (streamed line by line) or from bytes (a run's artifact). */
export async function readVcd(input: string | Uint8Array, keep?: ReadonlySet<string>, source?: string): Promise<Capture> {
  const p = new VcdParser(keep)
  await lines(input, (l) => p.line(l))
  return p.finish(source ?? (typeof input === 'string' ? input : 'vcd'))
}

export function parseVcdText(text: string): Capture {
  const p = new VcdParser()
  for (const l of text.split('\n')) p.line(l)
  return p.finish('text')
}

/** A VCD from signals given as [time s, value] changes. Values are "0"/"1"/"x"/"z" or binary strings for buses. */
export function writeVcd(signals: Readonly<Record<string, readonly (readonly [number, string])[]>>, o: { timescale?: string; scope?: string; widths?: Readonly<Record<string, number>> } = {}): string {
  const tsText = o.timescale ?? '1ps'
  const m = /^(\d+)\s*([munpf]?s)$/.exec(tsText)
  if (!m) throw new WaveError(`bad timescale ${tsText}`)
  const ts = Number(m[1]) * (UNITS[m[2] as string] ?? 1)
  const names = Object.keys(signals)
  const id = (k: number): string => {
    let s = ''
    let n = k
    do {
      s += String.fromCharCode(33 + (n % 94))
      n = Math.floor(n / 94) - 1
    } while (n >= 0)
    return s
  }
  const ids = new Map(names.map((n, k) => [n, id(k)]))
  const width = (n: string): number => o.widths?.[n] ?? Math.max(1, ...(signals[n] ?? []).map(([, v]) => v.length))
  const out = ['$date trace $end', `$timescale ${tsText} $end`, `$scope module ${o.scope ?? 'top'} $end`]
  for (const n of names) {
    const w = width(n)
    out.push(`$var wire ${w} ${ids.get(n)} ${n}${w > 1 ? ` [${w - 1}:0]` : ''} $end`)
  }
  out.push('$upscope $end', '$enddefinitions $end')
  const ev: [number, number, string, string][] = []
  names.forEach((n, order) => {
    for (const [t, v] of signals[n] ?? []) ev.push([Math.round(t / ts), order, n, v])
  })
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur: number | null = null
  for (const [t, , n, v] of ev) {
    if (t !== cur) {
      out.push(`#${t}`)
      cur = t
    }
    out.push(width(n) > 1 ? `b${v} ${ids.get(n)}` : `${v}${ids.get(n)}`)
  }
  return `${out.join('\n')}\n`
}

// ------------------------------------------------------------------------------------------- CSV

function splitCsv(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

const DIGITAL = new Set(['0', '1', 'x', 'z'])

/** A capture's CSV: time first (seconds, or the unit in its header), one column per channel. */
export async function readCsv(input: string | Uint8Array, source?: string): Promise<Capture> {
  const cap = new Capture()
  cap.source = source ?? (typeof input === 'string' ? input : 'csv')
  let head: string[] | null = null
  let scale = 1
  const cols: { t: number[]; v: string[] }[] = []
  let n = 0
  await lines(input, (l) => {
    const s = l.trim()
    if (!s || s.startsWith(';') || s.startsWith('#')) return
    const parts = splitCsv(s)
    if (!head) {
      if (parts.every((p) => p !== '' && !Number.isNaN(Number(p)))) {
        head = ['time', ...parts.slice(1).map((_, k) => `ch${k}`)]
      } else {
        head = parts
        const u = /\[\s*([munpf]?s)\s*\]|\(\s*([munpf]?s)\s*\)/.exec(parts[0] ?? '')
        scale = u ? (UNITS[(u[1] ?? u[2]) as string] ?? 1) : 1
        for (let k = 1; k < head.length; k++) cols.push({ t: [], v: [] })
        return
      }
      for (let k = 1; k < head.length; k++) cols.push({ t: [], v: [] })
    }
    const t = Number(parts[0]) * scale
    if (!Number.isFinite(t)) throw new WaveError(`row ${n + 2}: time ${JSON.stringify(parts[0])} is not a number`)
    if (n === 0) cap.start = t
    cap.end = t
    n++
    for (let k = 1; k < (head as string[]).length; k++) {
      const c = cols[k - 1] as { t: number[]; v: string[] }
      c.t.push(t)
      c.v.push((parts[k] ?? '').toLowerCase())
    }
  })
  if (!head) throw new WaveError('empty CSV')
  const hd: string[] = head
  cols.forEach((c, k) => {
    const name = hd[k + 1] ?? `ch${k}`
    if (c.v.every((v) => DIGITAL.has(v))) {
      const s = new Signal(name)
      c.t.forEach((t, i) => s.push(t, c.v[i] as string))
      cap.add(s)
    } else {
      const a = new AnalogSignal(name)
      c.t.forEach((t, i) => {
        const y = Number(c.v[i])
        if (!Number.isFinite(y)) throw new WaveError(`${name}: ${JSON.stringify(c.v[i])} is neither a logic level nor a number`)
        a.t.push(t)
        a.y.push(y)
      })
      cap.analog.set(name, a)
    }
  })
  cap.index()
  return cap
}

/** VCD or CSV by name (the extension, or the content for a run's artifact). */
export async function read(input: string | Uint8Array, name?: string, keep?: ReadonlySet<string>): Promise<Capture> {
  const label = name ?? (typeof input === 'string' ? input : '')
  if (/\.csv$/i.test(label)) return readCsv(input, label)
  if (/\.vcd$/i.test(label)) return readVcd(input, keep, label)
  if (typeof input !== 'string') {
    const head = Buffer.from(input.subarray(0, 4096)).toString('utf8')
    return /\$(?:timescale|var|scope|enddefinitions|date|version)\b/.test(head) ? readVcd(input, keep, label) : readCsv(input, label)
  }
  return readVcd(input, keep, label)
}

// ------------------------------------------------------------------------------------------- summaries

export const cap = <T>(xs: readonly T[], n: number): T[] => xs.slice(0, n)
const r6 = (v: number): number | null => (Number.isFinite(v) ? Number(v.toPrecision(6)) : null)

export interface PulseStats {
  high_min: number | null
  high_max: number | null
  low_min: number | null
  low_max: number | null
  period_mean: number | null
  period_min: number | null
  period_max: number | null
  frequency: number | null
  duty: number | null
  rising: number
  falling: number
}

/** Pulse widths, period and duty of a one-bit signal over its full high and low intervals. */
export function pulses(s: Signal, end: number): PulseStats {
  const highs = s.intervals('1').filter(([a, b]) => b !== Infinity && a !== s.t[0]).map(([a, b]) => b - a)
  const lows = s.intervals('0').filter(([a, b]) => b !== Infinity && a !== s.t[0]).map(([a, b]) => b - a)
  const r = s.edges('rising')
  const periods = r.slice(1).map((t, k) => t - (r[k] as number))
  const mn = (a: number[]): number | null => (a.length ? r6(Math.min(...a)) : null)
  const mx = (a: number[]): number | null => (a.length ? r6(Math.max(...a)) : null)
  const mean = periods.length ? ((r[r.length - 1] as number) - (r[0] as number)) / periods.length : NaN
  let dutyV: number | null = null
  if (periods.length) {
    const a = r[0] as number
    const b = r[r.length - 1] as number
    let hi = 0
    for (const [x, y] of s.intervals('1')) hi += Math.max(0, Math.min(y === Infinity ? end : y, b) - Math.max(x, a))
    dutyV = r6(hi / (b - a))
  }
  return {
    high_min: mn(highs), high_max: mx(highs), low_min: mn(lows), low_max: mx(lows),
    period_mean: r6(mean), period_min: mn(periods), period_max: mx(periods), frequency: periods.length ? r6(1 / mean) : null,
    duty: dutyV, rising: r.length, falling: s.edges('falling').length,
  }
}

export interface SignalSummary {
  name: string
  width: number
  changes: number
  first: string
  last: string
  values?: string[]
  pulses?: PulseStats
}

export function summarize(c: Capture, o: { limit?: number; only?: readonly string[] } = {}): Record<string, unknown> {
  const limit = o.limit ?? 64
  const names = o.only?.length ? o.only.map((n) => c.resolve(n) ?? n) : [...c.signals.keys()]
  const out: SignalSummary[] = []
  for (const n of names.slice(0, limit)) {
    const s = c.signals.get(n)
    if (!s) {
      if (!c.analog.has(n)) throw new WaveError(`no signal ${JSON.stringify(n)} in the capture`)
      continue
    }
    const sum: SignalSummary = { name: s.name, width: s.width, changes: Math.max(0, s.v.length - 1), first: s.v[0] ?? 'x', last: s.v[s.v.length - 1] ?? 'x' }
    if (s.width === 1) sum.pulses = pulses(s, c.end)
    else {
      const distinct = [...new Set(s.v)]
      sum.values = distinct.slice(0, 16).map((v) => (/^[01]+$/.test(v) ? `0x${BigInt(`0b${v}`).toString(16)}` : v))
    }
    out.push(sum)
  }
  const analog = [...c.analog.values()].filter((a) => !o.only?.length || names.includes(a.name)).slice(0, limit).map((a) => ({
    name: a.name, samples: a.y.length, min: r6(Math.min(...a.y)), max: r6(Math.max(...a.y)), first: r6(a.y[0] ?? NaN), last: r6(a.y[a.y.length - 1] ?? NaN),
  }))
  return {
    source: c.source, start: r6(c.start), end: r6(c.end), timescale: c.timescale,
    signal_count: c.signals.size, analog_count: c.analog.size,
    signals: out, ...(analog.length ? { analog } : {}),
    ...(c.signals.size > limit ? { truncated: `${c.signals.size} signals, ${limit} shown` } : {}),
  }
}

// ------------------------------------------------------------------------------------------- SPI

export interface SpiOptions {
  mode?: 0 | 1 | 2 | 3
  bits?: number
  lsbFirst?: boolean
  csActiveHigh?: boolean
}

export interface SpiTransfer {
  start: number
  end: number
  mosi: (number | null)[]
  miso: (number | null)[]
  /** Clock edges left over after the last whole word. */
  leftover_bits: number
}

function word(bits: string[], lsb: boolean): number | null {
  if (bits.some((b) => b !== '0' && b !== '1')) return null
  const s = lsb ? [...bits].reverse().join('') : bits.join('')
  return parseInt(s, 2)
}

/** SPI transfers: one per chip-select window, or the whole capture as one when there is no CS. */
export function spiDecode(sig: { sck: Signal; mosi?: Signal; miso?: Signal; cs?: Signal }, o: SpiOptions = {}, end = Infinity): SpiTransfer[] {
  const mode = o.mode ?? 0
  const cpol = mode >= 2
  const cpha = mode % 2 === 1
  // the sampling edge: leading edge when CPHA=0, trailing when CPHA=1; the leading edge is rising when CPOL=0
  const sampleRising = cpol === cpha
  const bits = o.bits ?? 8
  if (bits < 1 || bits > 32) throw new WaveError('bits must be 1..32')
  const edges = sig.sck.edges(sampleRising ? 'rising' : 'falling')
  const windows: [number, number][] = sig.cs ? sig.cs.intervals(o.csActiveHigh ? '1' : '0') : [[-Infinity, Infinity]]
  const out: SpiTransfer[] = []
  for (const [a, b] of windows) {
    const es = edges.filter((t) => t > a && t < b)
    if (!es.length) continue
    const take = (s?: Signal): (number | null)[] => {
      if (!s) return []
      const bitsSeen = es.map((t) => s.before(t))
      const words: (number | null)[] = []
      for (let k = 0; k + bits <= bitsSeen.length; k += bits) words.push(word(bitsSeen.slice(k, k + bits), o.lsbFirst ?? false))
      return words
    }
    out.push({ start: Number.isFinite(a) ? a : (es[0] as number), end: Number.isFinite(b) ? b : Math.min(end, es[es.length - 1] as number), mosi: take(sig.mosi), miso: take(sig.miso), leftover_bits: es.length % bits })
  }
  return out
}

// ------------------------------------------------------------------------------------------- I2C

export interface I2cByte {
  value: number | null
  ack: boolean | null
}

export interface I2cFrame {
  t: number
  repeated: boolean
  bytes: I2cByte[]
  end: number
  stopped: boolean
}

export interface I2cTiming {
  t_low: number
  t_high: number
  tsu_dat: number
  thd_dat: number
  tvd_dat_max: number
  thd_sta: number
  tsu_sta: number
  tsu_sto: number
  t_buf: number
  framing: number
  unknown: number
}

/** UM10204 rev. 7, Table 10: minimum times (and tVD;DAT maximum), in seconds, by speed mode. */
export const I2C_LIMITS: Readonly<Record<'standard' | 'fast' | 'fast_plus', Readonly<Partial<Record<keyof I2cTiming, number>>> & { f_max: number }>> = {
  standard: { f_max: 100e3, t_low: 4.7e-6, t_high: 4.0e-6, tsu_dat: 250e-9, thd_dat: 0, tvd_dat_max: 3.45e-6, thd_sta: 4.0e-6, tsu_sta: 4.7e-6, tsu_sto: 4.0e-6, t_buf: 4.7e-6 },
  fast: { f_max: 400e3, t_low: 1.3e-6, t_high: 0.6e-6, tsu_dat: 100e-9, thd_dat: 0, tvd_dat_max: 0.9e-6, thd_sta: 0.6e-6, tsu_sta: 0.6e-6, tsu_sto: 0.6e-6, t_buf: 1.3e-6 },
  fast_plus: { f_max: 1e6, t_low: 0.5e-6, t_high: 0.26e-6, tsu_dat: 50e-9, thd_dat: 0, tvd_dat_max: 0.45e-6, thd_sta: 0.26e-6, tsu_sta: 0.26e-6, tsu_sto: 0.26e-6, t_buf: 0.5e-6 },
}

/**
 * Decode an I2C bus and time it. Every SCL high that ends without a START or STOP in it is a bit, sampled as SCL rose;
 * nine bits make a byte and its ACK (SDA low = ACK). The timing is the worst case of each UM10204 parameter seen inside
 * a transfer, as seen at the capture's pins: t_low/t_high (SCL), tsu_dat (SDA change to SCL rise), thd_dat and
 * tvd_dat_max (SCL fall to SDA's next change), thd_sta, tsu_sta (repeated START), tsu_sto and t_buf (STOP to START);
 * `framing` counts STARTs and STOPs not on a byte boundary, `unknown` the bits sampled as x or z.
 */
export function i2cDecode(scl: Signal, sda: Signal, t0 = -Infinity, t1 = Infinity): { frames: I2cFrame[]; timing: I2cTiming } {
  const times = [...new Set([...scl.t, ...sda.t])].filter((t) => t >= t0 && t <= t1).sort((a, b) => a - b)
  const r: I2cTiming = { t_low: Infinity, t_high: Infinity, tsu_dat: Infinity, thd_dat: Infinity, tvd_dat_max: 0, thd_sta: Infinity, tsu_sta: Infinity, tsu_sto: Infinity, t_buf: Infinity, framing: 0, unknown: 0 }
  const frames: I2cFrame[] = []
  let sclV = scl.at(times[0] ?? 0)
  let sdaV = sda.at(times[0] ?? 0)
  let inTx = false
  let bits = 0
  let frame: I2cFrame | null = null
  let lastFall: number | null = null
  let lastRise: number | null = null
  let lastSdaChange: number | null = null
  let lastStop: number | null = null
  let pendingStart: number | null = null
  let highHasCondition = false
  let cur = 0
  let bad = 0
  let sampled = 'x'
  for (const t of times) {
    const nc = scl.at(t)
    const nd = sda.at(t)
    if (nd !== sdaV) {
      if (sclV === '1' && nc === '1') {
        if (nd === '0' && sdaV === '1') {
          if (inTx && bits % 9 !== 0) r.framing++
          if (inTx && lastRise !== null) r.tsu_sta = Math.min(r.tsu_sta, t - lastRise)
          if (!inTx && lastStop !== null) r.t_buf = Math.min(r.t_buf, t - lastStop)
          if (frame) frame.end = t
          frame = { t, repeated: inTx, bytes: [], end: Infinity, stopped: false }
          frames.push(frame)
          inTx = true
          bits = 0
          cur = 0
          bad = 0
          pendingStart = t
          highHasCondition = true
        } else if (nd === '1' && sdaV === '0' && inTx) {
          if (bits % 9 !== 0) r.framing++
          if (lastRise !== null) r.tsu_sto = Math.min(r.tsu_sto, t - lastRise)
          if (frame) {
            frame.end = t
            frame.stopped = true
          }
          frame = null
          inTx = false
          lastStop = t
          highHasCondition = true
        }
      } else if (inTx && sclV === '0' && lastFall !== null) {
        r.thd_dat = Math.min(r.thd_dat, t - lastFall)
        r.tvd_dat_max = Math.max(r.tvd_dat_max, t - lastFall)
      }
      lastSdaChange = t
      sdaV = nd
    }
    if (nc !== sclV) {
      if (nc === '1' && sclV === '0') {
        if (inTx && lastFall !== null) r.t_low = Math.min(r.t_low, t - lastFall)
        if (inTx && lastSdaChange !== null) r.tsu_dat = Math.min(r.tsu_dat, t - lastSdaChange)
        sampled = sda.at(t)
        lastRise = t
        highHasCondition = false
      } else if (nc === '0' && sclV === '1') {
        if (pendingStart !== null) {
          r.thd_sta = Math.min(r.thd_sta, t - pendingStart)
          pendingStart = null
        } else if (inTx && lastRise !== null && !highHasCondition) {
          r.t_high = Math.min(r.t_high, t - lastRise)
          if (sampled !== '0' && sampled !== '1') r.unknown++
          bits++
          const k = (bits - 1) % 9
          if (k < 8) {
            cur = (cur << 1) | (sampled === '1' ? 1 : 0)
            if (sampled !== '0' && sampled !== '1') bad++
          } else if (frame) {
            frame.bytes.push({ value: bad ? null : cur, ack: sampled === '0' ? true : sampled === '1' ? false : null })
            cur = 0
            bad = 0
          }
        }
        lastFall = t
      }
      sclV = nc
    }
  }
  return { frames, timing: r }
}

export function i2cCheck(t: I2cTiming, mode: keyof typeof I2C_LIMITS): { parameter: string; measured: number | null; limit: number; ok: boolean }[] {
  const lim = I2C_LIMITS[mode]
  const out: { parameter: string; measured: number | null; limit: number; ok: boolean }[] = []
  for (const [k, limit] of Object.entries(lim)) {
    if (k === 'f_max' || limit === undefined) continue
    const v = t[k as keyof I2cTiming]
    if (k === 'tvd_dat_max') out.push({ parameter: k, measured: r6(v), limit, ok: v <= limit })
    else if (Number.isFinite(v)) out.push({ parameter: k, measured: r6(v), limit, ok: v >= limit })
  }
  return out
}

// ------------------------------------------------------------------------------------------- UART

export interface UartOptions {
  baud: number
  dataBits?: number
  parity?: 'none' | 'even' | 'odd'
  stopBits?: 1 | 1.5 | 2
  /** Idle low (an inverted line, as after some level shifters). */
  invert?: boolean
  msbFirst?: boolean
}

export interface UartFrame {
  t: number
  value: number | null
  parity_error?: boolean
  framing_error?: boolean
}

/** UART frames: each start bit found on an idle-to-start edge, every bit sampled at its centre. */
export function uartDecode(line: Signal, o: UartOptions, end = Infinity): UartFrame[] {
  if (!(o.baud > 0)) throw new WaveError('baud must be positive')
  const bit = 1 / o.baud
  const nData = o.dataBits ?? 8
  if (nData < 5 || nData > 9) throw new WaveError('data bits must be 5..9')
  const parity = o.parity ?? 'none'
  const stop = o.stopBits ?? 1
  const idle = o.invert ? '0' : '1'
  const active = o.invert ? '1' : '0'
  const lvl = (t: number): string => {
    const v = line.at(t)
    if (v !== '0' && v !== '1') return v
    return o.invert ? (v === '1' ? '0' : '1') : v
  }
  const starts = line.edges(idle === '1' ? 'falling' : 'rising')
  const out: UartFrame[] = []
  let busyUntil = -Infinity
  for (const t of starts) {
    if (t < busyUntil) continue
    if (line.before(t) !== idle) continue
    const tEnd = t + bit * (1 + nData + (parity === 'none' ? 0 : 1) + stop)
    if (tEnd - bit * stop * 0.5 > end) break
    if (line.at(t + bit / 2) !== active) continue // a glitch, not a start bit
    let value = 0
    let unknown = false
    let ones = 0
    for (let k = 0; k < nData; k++) {
      const b = lvl(t + bit * (1.5 + k))
      if (b !== '0' && b !== '1') unknown = true
      if (b === '1') ones++
      value = o.msbFirst ? (value << 1) | (b === '1' ? 1 : 0) : value | ((b === '1' ? 1 : 0) << k)
    }
    const f: UartFrame = { t, value: unknown ? null : value }
    let pos = 1 + nData
    if (parity !== 'none') {
      const p = lvl(t + bit * (pos + 0.5))
      const total = ones + (p === '1' ? 1 : 0)
      if ((parity === 'even' && total % 2 !== 0) || (parity === 'odd' && total % 2 !== 1)) f.parity_error = true
      pos++
    }
    if (lvl(t + bit * (pos + 0.5)) !== '1') f.framing_error = true
    out.push(f)
    busyUntil = t + bit * (pos + 0.5)
  }
  return out
}

// ------------------------------------------------------------------------------------------- timing checks

export interface Violation {
  t: number
  value: number
}

/** Setup and hold of `data` around each `clock` edge (while `gate` is in its active level, when given). */
export function setupHold(data: Signal, clock: Signal, o: { edge?: 'rising' | 'falling'; gate?: Signal; gateActive?: string; t0?: number; t1?: number; setupMin?: number; holdMin?: number } = {}): Record<string, unknown> {
  const ch = data.changes()
  let setup = Infinity
  let hold = Infinity
  let unknown = 0
  let edges = 0
  const sv: Violation[] = []
  const hv: Violation[] = []
  let sCount = 0
  let hCount = 0
  const gates = o.gate ? o.gate.intervals(o.gateActive ?? '0') : null
  for (const t of clock.edges(o.edge ?? 'rising')) {
    if ((o.t0 !== undefined && t < o.t0) || (o.t1 !== undefined && t > o.t1)) continue
    if (gates && !gates.some(([a, b]) => a < t && t < b)) continue
    edges++
    const v = data.before(t)
    if (v !== '0' && v !== '1' && !/^[01]+$/.test(v)) {
      unknown++
      setup = -Infinity
      sCount++
      if (sv.length < 10) sv.push({ t, value: -Infinity })
      continue
    }
    // the last change strictly before (or at) the edge, and the next one after it
    let lo = 0
    let hi = ch.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((ch[mid] as number) <= t) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) {
      const s = t - (ch[lo - 1] as number)
      setup = Math.min(setup, s)
      if (o.setupMin !== undefined && s < o.setupMin) {
        sCount++
        if (sv.length < 10) sv.push({ t, value: s })
      }
    }
    if (lo < ch.length) {
      const h = (ch[lo] as number) - t
      hold = Math.min(hold, h)
      if (o.holdMin !== undefined && h < o.holdMin) {
        hCount++
        if (hv.length < 10) hv.push({ t, value: h })
      }
    }
  }
  const out: Record<string, unknown> = { edges, setup: fin(setup), hold: fin(hold), unknown }
  if (o.setupMin !== undefined) out.setup_violations = sCount
  if (o.holdMin !== undefined) out.hold_violations = hCount
  if (sv.length) out.first_setup_violations = sv.map((v) => ({ t: r6(v.t), value: fin(v.value) }))
  if (hv.length) out.first_hold_violations = hv.map((v) => ({ t: r6(v.t), value: fin(v.value) }))
  if (o.setupMin !== undefined || o.holdMin !== undefined) out.pass = edges > 0 && sCount === 0 && hCount === 0 && unknown === 0
  return out
}

/** Chip select to clock: CS active to the first clock edge (lead) and the last edge to CS inactive (lag). */
export function csToClock(cs: Signal, sck: Signal, o: { active?: string; leadMin?: number; lagMin?: number } = {}): Record<string, unknown> {
  const edges = sck.edges('any')
  let lead = Infinity
  let lag = Infinity
  let n = 0
  for (const [a, b] of cs.intervals(o.active ?? '0')) {
    if (a === cs.t[0]) continue // active from the start: not a transaction we saw begin
    const es = edges.filter((t) => t > a && t < b)
    if (!es.length) continue
    n++
    lead = Math.min(lead, (es[0] as number) - a)
    if (b !== Infinity) lag = Math.min(lag, b - (es[es.length - 1] as number))
  }
  const out: Record<string, unknown> = { transactions: n, lead: fin(lead), lag: fin(lag) }
  if (o.leadMin !== undefined || o.lagMin !== undefined) out.pass = n > 0 && (o.leadMin === undefined || lead >= o.leadMin) && (o.lagMin === undefined || lag >= o.lagMin)
  return out
}

/** Select spacing: the shortest inactive time of each select between windows, and from one select ending to another
 * starting. */
export function csSpacing(selects: readonly Signal[], o: { active?: string; min?: number } = {}): Record<string, unknown> {
  const active = o.active ?? '0'
  const wins: { a: number; b: number; s: string }[] = []
  for (const s of selects) for (const [a, b] of s.intervals(active)) if (a !== s.t[0]) wins.push({ a, b, s: s.name })
  wins.sort((x, y) => x.a - y.a)
  let same = Infinity
  let cross = Infinity
  for (const w of wins) {
    if (w.b === Infinity) continue
    const nextSame = wins.find((v) => v.s === w.s && v.a >= w.b)
    if (nextSame) same = Math.min(same, nextSame.a - w.b)
    const nextOther = wins.find((v) => v.s !== w.s && v.a >= w.b)
    if (nextOther) cross = Math.min(cross, nextOther.a - w.b)
  }
  const worst = Math.min(same, cross)
  const out: Record<string, unknown> = { windows: wins.length, same_select: fin(same), between_selects: fin(cross) }
  if (o.min !== undefined) out.pass = !Number.isFinite(worst) || worst >= o.min
  return out
}

/** More than one of `signals` active at once (selects that must be one-hot, output enables that must not fight).
 * An unknown level counts as active: nothing guarantees it is not. */
export function overlap(signals: readonly Signal[], o: { active?: string; t0?: number; t1?: number; end: number }): Record<string, unknown> {
  const active = o.active ?? '0'
  const t0 = o.t0 ?? -Infinity
  const t1 = o.t1 ?? o.end
  const times = [...new Set(signals.flatMap((s) => s.t))].filter((t) => t <= t1).sort((a, b) => a - b)
  if (Number.isFinite(t0) && !times.includes(t0)) times.push(t0)
  times.sort((a, b) => a - b)
  let most = 0
  let total = 0
  let longest = 0
  let runStart: number | null = null
  const first: { t: number; active: string[] }[] = []
  let count = 0
  for (let k = 0; k < times.length; k++) {
    const t = times[k] as number
    if (t < t0) continue
    const on = signals.filter((s) => {
      const v = s.at(t)
      return v === active || v === 'x' || v === 'z'
    })
    most = Math.max(most, on.length)
    const next = Math.min(times[k + 1] ?? t1, t1)
    if (on.length >= 2) {
      total += Math.max(0, next - t)
      if (runStart === null) {
        runStart = t
        count++
        if (first.length < 10) first.push({ t: r6(t) ?? t, active: on.map((s) => s.name) })
      }
      longest = Math.max(longest, next - runStart)
    } else runStart = null
  }
  return { most_active: most, overlaps: count, overlap_time: r6(total), longest: r6(longest), ...(first.length ? { first: first } : {}), pass: most <= 1 }
}

export function pulseCheck(s: Signal, end: number, o: { minHigh?: number; minLow?: number; minPeriod?: number; maxPeriod?: number } = {}): Record<string, unknown> {
  const p = pulses(s, end)
  const fails: string[] = []
  if (o.minHigh !== undefined && p.high_min !== null && p.high_min < o.minHigh) fails.push('high')
  if (o.minLow !== undefined && p.low_min !== null && p.low_min < o.minLow) fails.push('low')
  if (o.minPeriod !== undefined && p.period_min !== null && p.period_min < o.minPeriod) fails.push('period_min')
  if (o.maxPeriod !== undefined && p.period_max !== null && p.period_max > o.maxPeriod) fails.push('period_max')
  const any = o.minHigh !== undefined || o.minLow !== undefined || o.minPeriod !== undefined || o.maxPeriod !== undefined
  return { ...p, ...(any ? { pass: fails.length === 0, ...(fails.length ? { failed: fails } : {}) } : {}) }
}

function fin(v: number): number | null {
  return Number.isFinite(v) ? r6(v) : null
}
