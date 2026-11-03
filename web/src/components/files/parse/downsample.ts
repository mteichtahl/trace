/**
 * Fewer points to draw, keeping the shape: the points are cut into buckets by index and each bucket keeps its lowest
 * and highest point (in order), so spikes and glitches survive. The first and last points are always kept.
 */
export function downsample(points: readonly (readonly [number, number])[], max: number): [number, number][] {
  const n = points.length
  if (n <= max || max < 4) return points.map((p) => [p[0], p[1]])
  const buckets = Math.max(1, Math.floor((max - 2) / 2))
  const out: [number, number][] = [[points[0]![0], points[0]![1]]]
  const size = (n - 2) / buckets
  for (let b = 0; b < buckets; b++) {
    const lo = 1 + Math.floor(b * size)
    const hi = Math.min(n - 1, 1 + Math.floor((b + 1) * size))
    if (hi <= lo) continue
    let iMin = lo
    let iMax = lo
    for (let i = lo; i < hi; i++) {
      const y = points[i]![1]
      if (y < points[iMin]![1] || Number.isNaN(points[iMin]![1])) iMin = i
      if (y > points[iMax]![1] || Number.isNaN(points[iMax]![1])) iMax = i
    }
    const [a, c] = iMin <= iMax ? [iMin, iMax] : [iMax, iMin]
    out.push([points[a]![0], points[a]![1]])
    if (c !== a) out.push([points[c]![0], points[c]![1]])
  }
  const last = points[n - 1]!
  out.push([last[0], last[1]])
  return out
}

/** Series on one shared x: `ys[s][i]` is series s at `xs[i]` (null where it has no value there). */
export interface Aligned {
  xs: number[]
  ys: (number | null)[][]
}

/** Series of [x, y] points onto one sorted x (series that already share their x values cost nothing extra). */
export function align(series: readonly { points: readonly (readonly [number, number])[] }[]): Aligned {
  if (!series.length) return { xs: [], ys: [] }
  const first = series[0]!.points
  const same = series.every((s) => s.points.length === first.length && s.points.every((p, i) => p[0] === first[i]![0]))
  const sorted = first.every((p, i) => i === 0 || p[0] >= first[i - 1]![0])
  if (same && sorted) return { xs: first.map((p) => p[0]), ys: series.map((s) => s.points.map((p) => (Number.isFinite(p[1]) ? p[1] : null))) }
  const xset = new Set<number>()
  for (const s of series) for (const p of s.points) if (Number.isFinite(p[0])) xset.add(p[0])
  const xs = [...xset].sort((a, b) => a - b)
  const at = new Map(xs.map((x, i) => [x, i]))
  const ys = series.map((s) => {
    const col: (number | null)[] = new Array(xs.length).fill(null)
    for (const p of s.points) {
      const i = at.get(p[0])
      if (i !== undefined && Number.isFinite(p[1])) col[i] = p[1]
    }
    return col
  })
  return { xs, ys }
}

/**
 * Which rows to draw, at most about `max` per series in all: each series keeps the lowest and highest of its values in
 * every bucket (so a spike in any series survives), the union of those rows is drawn for every series (so a tooltip
 * reads all of them at one x). First and last rows always kept. Rows from `lo` to `hi` (exclusive) only.
 */
export function pickRows(ys: readonly (readonly (number | null)[])[], max: number, lo = 0, hi = ys[0]?.length ?? 0): number[] {
  const n = hi - lo
  if (n <= 0) return []
  if (n <= max) return Array.from({ length: n }, (_, i) => lo + i)
  const per = Math.max(4, Math.floor(max / Math.max(1, ys.length)))
  const buckets = Math.max(1, Math.floor((per - 2) / 2))
  const keep = new Set<number>([lo, hi - 1])
  const size = (n - 2) / buckets
  for (const col of ys) {
    for (let b = 0; b < buckets; b++) {
      const a = lo + 1 + Math.floor(b * size)
      const z = Math.min(hi - 1, lo + 1 + Math.floor((b + 1) * size))
      let iMin = -1
      let iMax = -1
      for (let i = a; i < z; i++) {
        const y = col[i]
        if (y === null || y === undefined) continue
        if (iMin < 0 || y < col[iMin]!) iMin = i
        if (iMax < 0 || y > col[iMax]!) iMax = i
      }
      if (iMin >= 0) keep.add(iMin)
      if (iMax >= 0) keep.add(iMax)
    }
  }
  return [...keep].sort((a, b) => a - b)
}

/** The first row at or after x0 and the row after the last at or before x1 (xs sorted), widened by one either side. */
export function windowRows(xs: readonly number[], x0: number, x1: number): [number, number] {
  let lo = 0
  let hi = xs.length
  let a = 0
  let b = xs.length
  while (a < b) {
    const m = (a + b) >> 1
    if (xs[m]! < x0) a = m + 1
    else b = m
  }
  lo = Math.max(0, a - 1)
  a = 0
  b = xs.length
  while (a < b) {
    const m = (a + b) >> 1
    if (xs[m]! <= x1) a = m + 1
    else b = m
  }
  hi = Math.min(xs.length, a + 1)
  return [lo, hi]
}
