/**
 * Transient results: per series (the board maximum, minimum and each part), the time to 90 % of the rise and to
 * steady state (99 % of the rise toward the steady-state solution), and the extremes over time; and the comparison
 * of two series (two runs, or a run against measurements), as Antmicro's `tpost compare-csv` overlays them:
 * the second is interpolated onto the first's times and the difference reported (max, RMS, at the end).
 */

export interface Series { name: string; t: number[]; y: number[] }

export interface SeriesMetrics {
  name: string
  start_c: number
  end_c: number
  steady_c: number
  max_c: number
  min_c: number
  t90_s: number | null
  t_steady_s: number | null
  /** the last value as a fraction of the rise to steady state */
  reached: number
}

function crossing(s: Series, level: number, rising: boolean): number | null {
  for (let i = 1; i < s.t.length; i++) {
    const a = s.y[i - 1]!
    const b = s.y[i]!
    if (rising ? a < level && b >= level : a > level && b <= level) return s.t[i - 1]! + ((level - a) / (b - a || 1)) * (s.t[i]! - s.t[i - 1]!)
  }
  return null
}

export function metrics(s: Series, steady?: number): SeriesMetrics {
  const y0 = s.y[0]!
  const yEnd = s.y[s.y.length - 1]!
  const yss = steady ?? yEnd
  const rise = yss - y0
  const rising = rise >= 0
  const t90 = Math.abs(rise) < 1e-9 ? 0 : crossing(s, y0 + 0.9 * rise, rising)
  const t99 = Math.abs(rise) < 1e-9 ? 0 : crossing(s, y0 + 0.99 * rise, rising)
  return {
    name: s.name, start_c: y0, end_c: yEnd, steady_c: yss, max_c: Math.max(...s.y), min_c: Math.min(...s.y), t90_s: t90, t_steady_s: t99,
    reached: Math.abs(rise) < 1e-9 ? 1 : (yEnd - y0) / rise,
  }
}

export function interpolate(s: Series, t: number): number | null {
  if (!s.t.length || t < s.t[0]! || t > s.t[s.t.length - 1]!) return null
  for (let i = 1; i < s.t.length; i++) {
    if (t <= s.t[i]!) {
      const f = (t - s.t[i - 1]!) / (s.t[i]! - s.t[i - 1]! || 1)
      return s.y[i - 1]! + f * (s.y[i]! - s.y[i - 1]!)
    }
  }
  return s.y[s.y.length - 1]!
}

export interface Comparison { a: string; b: string; points: number; max_abs_c: number; rms_c: number; end_diff_c: number | null; mean_diff_c: number }

/** b against a: b interpolated at a's times (where both are defined); differences are b - a. */
export function compare(a: Series, b: Series): Comparison {
  const d: number[] = []
  for (let i = 0; i < a.t.length; i++) {
    const v = interpolate(b, a.t[i]!)
    if (v !== null) d.push(v - a.y[i]!)
  }
  if (!d.length) throw new Error(`${b.name} and ${a.name} do not overlap in time`)
  const endB = interpolate(b, a.t[a.t.length - 1]!)
  return {
    a: a.name, b: b.name, points: d.length, max_abs_c: Math.max(...d.map(Math.abs)), rms_c: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length),
    end_diff_c: endB === null ? null : endB - a.y[a.y.length - 1]!, mean_diff_c: d.reduce((s, x) => s + x, 0) / d.length,
  }
}

/** Series from CSV text: the first column is time (s), every other column a series. */
export function seriesFromCsv(text: string, prefix = ''): Series[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim())
  const head = lines[0]?.split(',').map((x) => x.trim()) ?? []
  if (head.length < 2) throw new Error('a time-series CSV needs a time column and at least one value column')
  const out: Series[] = head.slice(1).map((n) => ({ name: `${prefix}${n}`, t: [], y: [] }))
  for (const l of lines.slice(1)) {
    const cells = l.split(',').map((x) => Number(x.trim()))
    const t = cells[0]!
    if (!Number.isFinite(t)) continue
    out.forEach((s, i) => { const v = cells[i + 1]; if (v !== undefined && Number.isFinite(v)) { s.t.push(t); s.y.push(v) } })
  }
  return out
}
