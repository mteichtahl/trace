/**
 * What a protocol model produces: time-ordered changes on named signals, the decoded meaning of each stretch of time
 * (annotations, for diagrams), the bits a responder drives with their expected values (for testbenches), and any
 * analog line voltages (RS-232 levels).
 *
 * The digital part is the same structure sim/wave.ts reads from a VCD (Signal: time, value changes), so a model run
 * is decoded, timed and drawn by exactly the code that handles a simulator's or a logic analyser's capture. Times are
 * seconds, rounded to the picosecond so that sums of intervals do not drift (VCDs are written at 1 ps).
 */
import { Capture, Signal, writeVcd } from '../sim/wave.js'

export class ModelError extends Error {
  override name = 'ModelError'
}

/** Round to the picosecond. */
export const ps = (t: number): number => Math.round(t * 1e12) / 1e12

export type AnnotationKind = 'start' | 'restart' | 'stop' | 'addr' | 'data' | 'ack' | 'nack' | 'frame' | 'field' | 'idle' | 'error' | 'info'

export interface Annotation {
  t0: number
  t1: number
  /** The row it belongs to (a protocol's decode row, e.g. "i2c", or a signal's name). */
  lane: string
  label: string
  kind: AnnotationKind
  /** The transaction it is part of (0-based), when it is. */
  tx?: number
}

/** A bit driven by the responder (slave, receiver), and what it must be when the initiator samples it. */
export interface SampleCheck {
  t: number
  signal: string
  expected: '0' | '1'
  label: string
}

export class WaveBuilder {
  private readonly sig = new Map<string, [number, string][]>()
  readonly widths = new Map<string, number>()
  readonly annotations: Annotation[] = []
  readonly samples: SampleCheck[] = []
  /** Analog voltages: name → [t, V] breakpoints (piecewise linear). */
  readonly analog = new Map<string, [number, number][]>()
  /** Signals the initiator (master) drives: what a testbench replays into a DUT. */
  readonly driven = new Set<string>()
  /** Tracks kept for testbenches (a master's own drive of a shared line), left out of the capture, VCD and CSV. */
  readonly hidden = new Set<string>()
  end = 0

  constructor(readonly protocol: string) {}

  /** A signal with its value at t = 0. */
  declare(name: string, init: string, o: { width?: number; driven?: boolean; hidden?: boolean } = {}): void {
    if (this.sig.has(name)) throw new ModelError(`signal ${name} declared twice`)
    this.sig.set(name, [[0, init]])
    this.widths.set(name, o.width ?? 1)
    if (o.driven) this.driven.add(name)
    if (o.hidden) this.hidden.add(name)
  }

  has(name: string): boolean {
    return this.sig.has(name)
  }

  /** A change at t (no change when the value is already that). Changes must come in time order per signal. */
  set(name: string, t: number, v: string): void {
    const s = this.sig.get(name)
    if (!s) throw new ModelError(`signal ${name} was not declared`)
    const tt = ps(t)
    const last = s[s.length - 1] as [number, string]
    if (tt < last[0]) throw new ModelError(`${name}: change at ${tt} s is before the last one at ${last[0]} s`)
    if (last[1] === v) return
    if (tt === last[0]) {
      last[1] = v
      const prev = s[s.length - 2]
      if (prev && prev[1] === v) s.pop()
    } else s.push([tt, v])
    if (tt > this.end) this.end = tt
  }

  /** The value of a signal at time t (its last change at or before t). */
  at(name: string, t: number): string {
    const s = this.sig.get(name)
    if (!s) throw new ModelError(`signal ${name} was not declared`)
    let v = s[0]?.[1] ?? 'x'
    for (const [ti, vi] of s) {
      if (ti > t) break
      v = vi
    }
    return v
  }

  note(a: Annotation): void {
    this.annotations.push({ ...a, t0: ps(a.t0), t1: ps(a.t1) })
  }

  expect(c: SampleCheck): void {
    this.samples.push({ ...c, t: ps(c.t) })
  }

  analogPoint(name: string, t: number, v: number): void {
    const a = this.analog.get(name) ?? []
    if (!this.analog.has(name)) this.analog.set(name, a)
    a.push([ps(t), v])
    if (t > this.end) this.end = ps(t)
  }

  /** Extend the end of the run (idle time after the last change). */
  idle(t: number): void {
    if (t > this.end) this.end = ps(t)
  }

  /** The visible signals (hidden testbench tracks left out). */
  names(): string[] {
    return [...this.sig.keys()].filter((n) => !this.hidden.has(n))
  }

  changes(name: string): readonly (readonly [number, string])[] {
    const s = this.sig.get(name)
    if (!s) throw new ModelError(`signal ${name} was not declared`)
    return s
  }

  /** The digital signals as a Capture, the structure sim/wave.ts decodes. */
  capture(): Capture {
    const c = new Capture()
    for (const [n, ch] of this.sig) {
      if (this.hidden.has(n)) continue
      const s = new Signal(n, this.widths.get(n) ?? 1)
      for (const [t, v] of ch) s.push(t, v)
      c.add(s)
    }
    c.start = 0
    c.end = this.end
    c.timescale = 1e-12
    c.source = `protocol.model ${this.protocol}`
    c.index()
    return c
  }

  vcd(): string {
    const signals: Record<string, [number, string][]> = {}
    for (const [n, ch] of this.sig) if (!this.hidden.has(n)) signals[n] = [...ch]
    // a final marker so the VCD's last timestamp is the end of the run (idle time included)
    const out = writeVcd(signals, { timescale: '1ps', scope: this.protocol, widths: Object.fromEntries([...this.widths].filter(([n]) => !this.hidden.has(n))) })
    return `${out}#${Math.round(this.end * 1e12)}\n`
  }

  /** CSV: time (s) first, one column per digital signal, one row per change; analog lines go to analogCsv. */
  csv(): string {
    const names = this.names()
    const times = [...new Set(names.flatMap((n) => this.changes(n).map(([t]) => t)))].sort((a, b) => a - b)
    const rows = [['time', ...names].join(',')]
    for (const t of times) rows.push([String(t), ...names.map((n) => this.at(n, t))].join(','))
    if (this.end > (times[times.length - 1] ?? 0)) rows.push([String(this.end), ...names.map((n) => this.at(n, this.end))].join(','))
    return `${rows.join('\n')}\n`
  }

  /** The analog lines as CSV (time first), at their breakpoints merged; null when there are none. */
  analogCsv(): string | null {
    if (!this.analog.size) return null
    const names = [...this.analog.keys()]
    const times = [...new Set(names.flatMap((n) => (this.analog.get(n) ?? []).map(([t]) => t)))].sort((a, b) => a - b)
    const interp = (pts: readonly [number, number][], t: number): number => {
      if (!pts.length) return 0
      if (t <= (pts[0] as [number, number])[0]) return (pts[0] as [number, number])[1]
      for (let k = 1; k < pts.length; k++) {
        const [t1, v1] = pts[k] as [number, number]
        const [t0, v0] = pts[k - 1] as [number, number]
        if (t <= t1) return t1 === t0 ? v1 : v0 + ((t - t0) / (t1 - t0)) * (v1 - v0)
      }
      return (pts[pts.length - 1] as [number, number])[1]
    }
    const rows = [['time', ...names].join(',')]
    for (const t of times) rows.push([String(t), ...names.map((n) => String(Number(interp(this.analog.get(n) ?? [], t).toPrecision(6))))].join(','))
    return `${rows.join('\n')}\n`
  }
}

/** Shift each rising and falling change of a one-bit signal by its own delay (receiver threshold crossings from an
 * analog run). A pulse narrower than the difference of the delays disappears, as it would at the receiver. */
export function delayEdges(s: Signal, rise: number, fall: number): Signal {
  const ev: [number, string][] = []
  for (let k = 0; k < s.t.length; k++) {
    const v = s.v[k] as string
    const prev = k ? (s.v[k - 1] as string) : null
    const t = s.t[k] as number
    const d = k === 0 ? 0 : v === '1' && prev === '0' ? rise : v === '0' && prev === '1' ? fall : Math.max(rise, fall)
    const te = ps(t + d)
    // a change that lands at or before the one before it cancels that one (the pulse between them is swallowed)
    while (ev.length > 1 && (ev[ev.length - 1] as [number, string])[0] >= te) ev.pop()
    if ((ev[ev.length - 1]?.[1] ?? null) !== v) ev.push([te, v])
  }
  const out = new Signal(s.name, s.width)
  for (const [t, v] of ev) out.push(t, v)
  return out
}
