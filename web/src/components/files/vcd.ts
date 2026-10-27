/**
 * A Value Change Dump (IEEE 1364 VCD) reader for the waveform viewer: the timescale, every signal with its scope and
 * width, and each signal's changes as [time, value] in time order. Aliases (several names on one id code) share
 * their changes. Values stay as written: '0', '1', 'x', 'z' for one bit, a binary string for a bus, a number for real.
 */

export interface VcdSignal {
  /** the id code in the dump */
  id: string
  name: string
  /** dotted scope path ("top.i2c") */
  scope: string
  width: number
  type: string
  changes: [number, string][]
}

export interface Vcd {
  timescale: { value: number; unit: string; seconds: number }
  date?: string
  version?: string
  signals: VcdSignal[]
  /** the last time in the dump */
  end: number
}

const UNITS: Record<string, number> = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 }

export function parseVcd(text: string): Vcd {
  const tokens = text.split(/\s+/).filter(Boolean)
  const scopes: string[] = []
  const signals: VcdSignal[] = []
  const byId = new Map<string, VcdSignal[]>()
  const changes = new Map<string, [number, string][]>()
  let timescale = { value: 1, unit: 'ns', seconds: 1e-9 }
  let date: string | undefined
  let version: string | undefined
  let i = 0
  let t = 0
  let end = 0

  const until = (): string[] => {
    const out: string[] = []
    while (i < tokens.length && tokens[i] !== '$end') out.push(tokens[i++]!)
    i++ // $end
    return out
  }
  const record = (id: string, v: string) => {
    let list = changes.get(id)
    if (!list) changes.set(id, (list = []))
    const last = list[list.length - 1]
    if (last && last[0] === t) last[1] = v
    else list.push([t, v])
  }

  while (i < tokens.length) {
    const tok = tokens[i++]!
    if (tok.startsWith('$')) {
      switch (tok) {
        case '$timescale': {
          const words = until().join('')
          const m = /^(\d+)\s*([a-z]+)$/i.exec(words)
          if (m) {
            const value = Number(m[1])
            const unit = m[2]!.toLowerCase()
            timescale = { value, unit, seconds: value * (UNITS[unit] ?? 1e-9) }
          }
          break
        }
        case '$scope': {
          const [, name] = until()
          scopes.push(name ?? '')
          break
        }
        case '$upscope':
          until()
          scopes.pop()
          break
        case '$var': {
          const [type = 'wire', w = '1', id = '', ...rest] = until()
          // the reference may carry a bit range as its own token: "data [7:0]"
          const name = rest.join(' ').replace(/\s+\[/, '[')
          const s: VcdSignal = { id, name, scope: scopes.join('.'), width: Number(w) || 1, type, changes: [] }
          signals.push(s)
          byId.set(id, [...(byId.get(id) ?? []), s])
          break
        }
        case '$date':
          date = until().join(' ')
          break
        case '$version':
          version = until().join(' ')
          break
        case '$dumpvars': case '$dumpall': case '$dumpon': case '$dumpoff': case '$enddefinitions':
          // value changes inside $dumpvars are read as ordinary changes; the closing $end is skipped below
          if (tok === '$enddefinitions') until()
          break
        case '$end':
          break
        default:
          until() // $comment and anything else
      }
      continue
    }
    if (tok[0] === '#') {
      const n = Number(tok.slice(1))
      if (Number.isFinite(n)) {
        t = n
        if (n > end) end = n
      }
      continue
    }
    const c = tok[0]!.toLowerCase()
    if (c === 'b' || c === 'r') {
      const id = tokens[i++]
      if (id !== undefined) record(id, c === 'b' ? tok.slice(1).toLowerCase() : tok.slice(1))
      continue
    }
    if ('01xzuhlw-'.includes(c)) record(tok.slice(1), c)
  }

  for (const [id, list] of changes) for (const s of byId.get(id) ?? []) s.changes = list
  return { timescale, date, version, signals, end }
}

/** The value a signal holds at time t ('x' before its first change). */
export function valueAt(s: VcdSignal, t: number): string {
  let lo = 0
  let hi = s.changes.length - 1
  let found = 'x'
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = s.changes[mid]!
    if (c[0] <= t) {
      found = c[1]
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** A bus value for reading: binary to hex ("0x48"), x and z kept as words. */
export function busLabel(v: string, width: number): string {
  if (width <= 1) return v
  if (/[xz]/i.test(v)) return /^x+$/i.test(v) ? 'x' : /^z+$/i.test(v) ? 'z' : v
  if (!/^[01]+$/.test(v)) return v
  const n = parseInt(v, 2)
  return `0x${n.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')}`
}

/** A time in the dump's units as words with an engineering prefix ("1.25 µs"). */
export function timeLabel(ticks: number, timescale: Vcd['timescale']): string {
  const s = ticks * timescale.seconds
  if (s === 0) return '0 s'
  const abs = Math.abs(s)
  const steps: [number, string][] = [[1, 's'], [1e-3, 'ms'], [1e-6, 'µs'], [1e-9, 'ns'], [1e-12, 'ps'], [1e-15, 'fs']]
  const [scale, unit] = steps.find(([k]) => abs >= k * 0.9995) ?? steps[steps.length - 1]!
  return `${Number((s / scale).toPrecision(4))} ${unit}`
}
