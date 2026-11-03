/**
 * ngspice ASCII rawfiles (`<analysis>.raw`, what sim.spice and the ams tools keep) into charts. The reading matches the
 * server's parseRaw (src/tools/sim/spice.ts): a header (Title, Plotname, Flags, No. Variables, No. Points), the
 * variables one per line (index, name, type), then Values: each point's first value on the line with the point's
 * index, the others one per line after it. Complex values (AC, noise) are "re,im". A file may hold several plots.
 *
 *   tran   voltages and currents against time (one panel each)
 *   ac     magnitude in dB and phase in degrees against frequency, log axis
 *   dc     each vector against the swept variable
 *   noise  spectral density against frequency, log axis
 *   op     a table of values (also integrated noise, a single point)
 */
import type { ResultPlot } from './series'

export type RawKind = 'tran' | 'ac' | 'dc' | 'op' | 'noise' | 'noise_total' | 'other'

export interface RawVar {
  name: string
  /** ngspice's type word: voltage, current, time, frequency, notype, ... */
  type: string
}

export interface RawPlot {
  title: string
  plotname: string
  kind: RawKind
  complex: boolean
  vars: RawVar[]
  /** per variable: the real parts (or the values) */
  re: number[][]
  /** per variable: the imaginary parts (complex plots only; zeros otherwise) */
  im: number[][]
  points: number
}

export function rawKind(plotname: string): RawKind {
  const p = plotname.toLowerCase()
  if (p.startsWith('operating')) return 'op'
  if (p.startsWith('dc')) return 'dc'
  if (p.startsWith('ac')) return 'ac'
  if (p.startsWith('transient')) return 'tran'
  if (p.startsWith('integrated noise')) return 'noise_total'
  if (p.includes('noise')) return 'noise'
  return 'other'
}

/** Is this the start of an ngspice ASCII rawfile? */
export const looksLikeRaw = (text: string): boolean => /^\s*(Title|Plotname):/m.test(text.slice(0, 2000)) && /^Variables:/m.test(text.slice(0, 20000))

/** Every plot in the file. Throws on a binary rawfile (it says so). */
export function parseSpiceRaw(text: string): RawPlot[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: RawPlot[] = []
  let i = 0
  while (i < lines.length) {
    let title = ''
    let plotname = ''
    let complex = false
    let npoints: number | null = null
    const vars: RawVar[] = []
    let binary = false
    for (; i < lines.length; i++) {
      const ln = lines[i]!
      if (ln.startsWith('Title:')) title = ln.slice(6).trim()
      else if (ln.startsWith('Plotname:')) plotname = ln.slice(9).trim()
      else if (ln.startsWith('Flags:')) complex = /complex/i.test(ln)
      else if (ln.startsWith('No. Points:')) npoints = Number(ln.slice(11).trim())
      else if (ln.startsWith('Variables:')) {
        i++
        while (i < lines.length && !/^(Values|Binary):/.test(lines[i]!)) {
          const parts = lines[i]!.trim().split(/\s+/)
          if (parts.length >= 2) vars.push({ name: parts[1]!, type: (parts[2] ?? 'notype').toLowerCase() })
          i++
        }
        binary = (lines[i] ?? '').startsWith('Binary:')
        i++
        break
      }
    }
    if (!vars.length) break
    if (binary) throw new Error('This is a binary rawfile. trace keeps ASCII ones (ngspice: set filetype=ascii).')
    const nv = vars.length
    const re: number[][] = vars.map(() => [])
    const im: number[][] = vars.map(() => [])
    let k = 0
    for (; i < lines.length; i++) {
      const s = lines[i]!.trim()
      if (!s) continue
      if (s.startsWith('Title:') || s.startsWith('Plotname:')) break
      const parts = s.split(/\s+/)
      const tok = k % nv === 0 && parts.length >= 2 ? parts[1]! : parts[parts.length - 1]!
      const col = k % nv
      if (complex) {
        const [a, b] = tok.split(',')
        re[col]!.push(Number(a))
        im[col]!.push(Number(b ?? 0))
      } else {
        re[col]!.push(Number(tok))
        im[col]!.push(0)
      }
      k++
      if (npoints !== null && k >= npoints * nv) {
        i++
        break
      }
    }
    out.push({ title, plotname, kind: rawKind(plotname), complex, vars, re, im, points: re[0]?.length ?? 0 })
    while (i < lines.length && !lines[i]!.startsWith('Title:') && !lines[i]!.startsWith('Plotname:')) i++
  }
  return out
}

/** The unit of an ngspice vector, from its type word, or its name when the type says nothing. */
export function unitOf(v: RawVar): string {
  switch (v.type) {
    case 'voltage': return 'V'
    case 'current': return 'A'
    case 'time': return 's'
    case 'frequency': return 'Hz'
    case 'temperature': return '°C'
    case 'inoise_spectrum': case 'onoise_spectrum': return /^i/.test(v.name) ? 'A/√Hz' : 'V/√Hz'
    default:
      if (/^v\(|^v-sweep$/i.test(v.name)) return 'V'
      if (/^i\(|#branch$|^i-sweep$/i.test(v.name)) return 'A'
      if (/temp/i.test(v.name)) return '°C'
      return ''
  }
}

/** A friendlier label for the swept variable of a DC analysis. */
function sweepLabel(v: RawVar): string {
  const n = v.name.toLowerCase()
  if (n === 'v-sweep') return 'Swept voltage'
  if (n === 'i-sweep') return 'Swept current'
  if (n.startsWith('temp')) return 'Temperature'
  if (n === 'res-sweep') return 'Swept resistance'
  return v.name
}

const ANALYSIS: Record<RawKind, string> = {
  tran: 'Transient', ac: 'AC', dc: 'DC sweep', op: 'Operating point', noise: 'Noise', noise_total: 'Integrated noise', other: 'Simulation',
}

/** The panels a plot draws as. An op (or single-point) plot draws as none: use opRows. */
export function rawToPlots(p: RawPlot): ResultPlot[] {
  if (p.kind === 'op' || p.kind === 'noise_total' || p.points < 2 || p.vars.length < 2) return []
  const scale = p.vars[0]!
  const xs = p.re[0]!
  const xUnit = p.kind === 'dc' ? unitOf(scale) : unitOf(scale) || (p.kind === 'tran' ? 's' : p.kind === 'ac' || p.kind === 'noise' ? 'Hz' : '')
  const xLabel = p.kind === 'tran' ? 'Time' : p.kind === 'ac' || p.kind === 'noise' ? 'Frequency' : p.kind === 'dc' ? sweepLabel(scale) : scale.name
  const xLog = (p.kind === 'ac' || p.kind === 'noise') && xs.every((x) => x > 0) && xs.length > 1 && Math.max(...xs) / Math.min(...xs) > 100
  const title = `${ANALYSIS[p.kind]}${p.title ? ` · ${p.title}` : ''}`
  const rest = p.vars.slice(1).map((v, j) => ({ v, c: j + 1 }))
  const base = (panel: string, unit: string, label: string, series: ResultPlot['series']): ResultPlot => ({ title, panel, x: { label: xLabel, unit: xUnit }, y: { label, unit }, series, xLog })

  if (p.complex && p.kind !== 'noise') {
    const mag = rest.map(({ v, c }) => ({
      name: v.name,
      points: xs.map((x, i): [number, number] => {
        const m = Math.hypot(p.re[c]![i]!, p.im[c]![i]!)
        return [x, m > 0 ? 20 * Math.log10(m) : -400]
      }),
    }))
    const ph = rest.map(({ v, c }) => ({
      name: v.name,
      points: xs.map((x, i): [number, number] => [x, (Math.atan2(p.im[c]![i]!, p.re[c]![i]!) * 180) / Math.PI]),
    }))
    return [base('Magnitude', 'dB', 'Magnitude', mag), base('Phase', '°', 'Phase', ph)]
  }

  const value = (c: number, i: number) => (p.complex ? Math.hypot(p.re[c]![i]!, p.im[c]![i]!) : p.re[c]![i]!)
  // one panel per unit (voltages, currents, ...), in the order they first appear
  const groups = new Map<string, { v: RawVar; c: number }[]>()
  for (const r of rest) {
    const u = unitOf(r.v)
    groups.set(u, [...(groups.get(u) ?? []), r])
  }
  const word = (u: string) => (u === 'V' ? 'Voltage' : u === 'A' ? 'Current' : u === 'V/√Hz' || u === 'A/√Hz' ? 'Noise density' : u === '°C' ? 'Temperature' : 'Value')
  return [...groups].map(([u, vs]) => base(word(u), u, word(u), vs.map(({ v, c }) => ({ name: v.name, points: xs.map((x, i): [number, number] => [x, value(c, i)]) }))))
}

export interface OpRow {
  name: string
  value: number
  unit: string
  /** complex values: the imaginary part */
  imag?: number
}

/** A single-point plot (op, integrated noise) as rows: name, value, unit. Other plots: the first point. */
export function opRows(p: RawPlot): OpRow[] {
  return p.vars.map((v, c) => ({ name: v.name, value: p.re[c]![0] ?? NaN, unit: unitOf(v), ...(p.complex ? { imag: p.im[c]![0] ?? 0 } : {}) }))
}
