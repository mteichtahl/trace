/**
 * A numeric table (a scope or meter capture, loop_gain.csv, a sweep's points) as a chart: the first column is x when
 * it is numeric and runs one way (time, frequency, index), every other numeric column a series. Units come from the
 * header (t_s, CH1_v, mag_db, phase_deg, "Freq (MHz)", "I [mA]") and are scaled to the base unit; columns of
 * different units draw as separate panels (magnitude and phase apart). x goes on a log axis when the first column
 * is a frequency spanning more than two decades.
 */
import type { Table } from '../csv'
import type { ResultPlot } from './series'

/** suffix → unit and the factor to the base unit */
const UNITS: Record<string, [string, number]> = {
  s: ['s', 1], sec: ['s', 1], ms: ['s', 1e-3], us: ['s', 1e-6], 'µs': ['s', 1e-6], ns: ['s', 1e-9], ps: ['s', 1e-12],
  v: ['V', 1], volts: ['V', 1], mv: ['V', 1e-3], uv: ['V', 1e-6], 'µv': ['V', 1e-6], kv: ['V', 1e3],
  a: ['A', 1], amps: ['A', 1], ma: ['A', 1e-3], ua: ['A', 1e-6], 'µa': ['A', 1e-6], na: ['A', 1e-9],
  hz: ['Hz', 1], khz: ['Hz', 1e3], mhz: ['Hz', 1e6], ghz: ['Hz', 1e9],
  w: ['W', 1], mw: ['W', 1e-3], ohm: ['Ω', 1], ohms: ['Ω', 1], 'Ω': ['Ω', 1], kohm: ['Ω', 1e3],
  db: ['dB', 1], dbm: ['dBm', 1], deg: ['°', 1], degrees: ['°', 1], '°': ['°', 1], rad: ['rad', 1],
  c: ['°C', 1], degc: ['°C', 1], '°c': ['°C', 1], k: ['K', 1], pct: ['%', 1], '%': ['%', 1], f: ['F', 1], uf: ['F', 1e-6], nf: ['F', 1e-9], pf: ['F', 1e-12],
}

/** Names whose meaning gives the unit when the header carries none. */
const NAMED: [RegExp, string][] = [
  [/^(t|time)$/i, 's'], [/^(f|freq|frequency)$/i, 'Hz'], [/^(mag|magnitude|gain)$/i, 'dB'], [/^phase$/i, '°'], [/^(temp|temperature)$/i, '°C'],
]

export interface ColumnUnit {
  /** the label without its unit ("t", "CH1", "mag") */
  label: string
  unit: string
  factor: number
}

/** The label, unit and scale of a header cell. */
export function columnUnit(h: string): ColumnUnit {
  const s = h.trim()
  let m = /^(.*?)\s*[([]\s*([^)\]]+?)\s*[)\]]$/.exec(s)
  if (m) {
    const u = UNITS[m[2]!.toLowerCase()] ?? UNITS[m[2]!]
    if (u) return { label: m[1]!.trim() || s, unit: u[0], factor: u[1] }
    return { label: m[1]!.trim() || s, unit: m[2]!, factor: 1 }
  }
  m = /^(.+?)[_ ]([A-Za-zµ°%Ω]+)$/.exec(s)
  if (m) {
    const u = UNITS[m[2]!.toLowerCase()]
    if (u) return { label: m[1]!, unit: u[0], factor: u[1] }
  }
  for (const [re, unit] of NAMED) if (re.test(s)) return { label: s, unit, factor: 1 }
  return { label: s, unit: '', factor: 1 }
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Cells that mean "no reading" rather than text: a meter's overload, NaN, a dash. */
const NO_READING = /^(ol|-?ol|overload|nan|-?inf(inity)?|n\/a|na|-|—|error|err)$/i

/** A column is numeric when nearly all its filled cells are numbers (blanks and "no reading" cells aside). */
export function numericColumn(t: Table, c: number): boolean {
  let filled = 0
  let good = 0
  for (const r of t.rows) {
    const v = r[c]?.trim()
    if (!v || NO_READING.test(v)) continue
    filled++
    if (num(v) !== null) good++
  }
  return good >= 2 && good >= filled * 0.95
}

/** Does the column run one way (never back), and move at all? */
export function monotonic(xs: readonly number[]): boolean {
  if (xs.length < 2) return false
  let up = true
  let down = true
  for (let i = 1; i < xs.length; i++) {
    if (xs[i]! < xs[i - 1]!) up = false
    if (xs[i]! > xs[i - 1]!) down = false
  }
  return (up || down) && xs[0] !== xs[xs.length - 1]
}

const FREQ = /^(f|freq|frequency)([_ ]?(hz|khz|mhz|ghz))?$|^(f|freq|frequency)\s*[([]/i

/**
 * The table as chart panels, or null when it does not chart (x not numeric or not one-way, nothing numeric to draw).
 */
export function csvToPlots(t: Table, title = ''): ResultPlot[] | null {
  if (t.header.length < 2 || t.rows.length < 2 || !numericColumn(t, 0)) return null
  const xu = columnUnit(t.header[0]!)
  const rows = t.rows.filter((r) => num(r[0]) !== null)
  const xs = rows.map((r) => num(r[0])! * xu.factor)
  if (!monotonic(xs)) return null
  const cols = t.header.map((_, c) => c).filter((c) => c > 0 && numericColumn(t, c))
  if (!cols.length) return null
  const pos = xs.filter((x) => x > 0)
  const xLog = FREQ.test(t.header[0]!.trim()) && pos.length === xs.length && Math.max(...xs) / Math.min(...xs) > 100
  const groups = new Map<string, { name: string; points: [number, number][] }[]>()
  for (const c of cols) {
    const u = columnUnit(t.header[c]!)
    const points: [number, number][] = []
    rows.forEach((r, i) => {
      const y = num(r[c])
      if (y !== null) points.push([xs[i]!, y * u.factor])
    })
    groups.set(u.unit, [...(groups.get(u.unit) ?? []), { name: u.label, points }])
  }
  const xLabel = xu.label === 't' ? 'Time' : /^(f|freq)$/i.test(xu.label) ? 'Frequency' : xu.label
  return [...groups].map(([unit, series]) => {
    const word = unitWord(unit, series.length === 1 ? series[0]!.name : '')
    return { title, panel: word, x: { label: xLabel, unit: xu.unit }, y: { label: word, unit }, series, xLog }
  })
}

function unitWord(unit: string, only: string): string {
  switch (unit) {
    case 'V': return 'Voltage'
    case 'A': return 'Current'
    case 'dB': return 'Magnitude'
    case '°': return 'Phase'
    case '°C': return 'Temperature'
    case 'W': return 'Power'
    case 'Hz': return 'Frequency'
    case 'Ω': return 'Resistance'
    case 's': return 'Time'
    default: return only || unit || 'Value'
  }
}
