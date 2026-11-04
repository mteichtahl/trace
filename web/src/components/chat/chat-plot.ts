/**
 * The plot a reply can draw (```plot, also ```chart): trace's PlotData shape (title, axes with units, series of
 * [x, y] points, an optional limit line and verdict) plus a chart kind and words on the x axis. Written as JSON5, so
 * comments and unquoted keys are fine. `parsePlot` checks it and says what is wrong in plain words.
 */
export type PlotKind = 'line' | 'step' | 'bar' | 'scatter' | 'area'

export interface ChatPlot {
  title?: string
  kind?: PlotKind
  x?: { label?: string; unit?: string }
  y?: { label?: string; unit?: string }
  /** x may be a number (time, frequency…) or a word (a part, a stage); words keep the order they first appear in */
  series: { name: string; points: [number | string, number][] }[]
  limit?: { value: number; label?: string; kind?: 'min' | 'max' }
  verdict?: string
  ok?: boolean
}

export const PLOT_KINDS: readonly PlotKind[] = ['line', 'step', 'bar', 'scatter', 'area']
export const MAX_PLOT_POINTS = 5000

export class PlotError extends Error {}

export async function parsePlot(source: string): Promise<ChatPlot> {
  const { default: json5 } = await import('json5')
  let raw: unknown
  try {
    raw = json5.parse(source)
  } catch (e) {
    throw new PlotError(`it is not valid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  return checkPlot(raw)
}

export function checkPlot(raw: unknown): ChatPlot {
  if (!raw || typeof raw !== 'object') throw new PlotError('it needs an object with series')
  const p = raw as Partial<ChatPlot>
  if (!Array.isArray(p.series) || p.series.length === 0) throw new PlotError('it needs at least one series')
  if (p.kind !== undefined && !PLOT_KINDS.includes(p.kind)) throw new PlotError(`kind must be one of ${PLOT_KINDS.join(', ')}`)
  let total = 0
  p.series.forEach((s, i) => {
    if (!s || !Array.isArray(s.points)) throw new PlotError(`series ${i + 1} needs points as [x, y] pairs`)
    for (const pt of s.points) {
      if (!Array.isArray(pt) || pt.length < 2 || typeof pt[1] !== 'number' || !(typeof pt[0] === 'number' || typeof pt[0] === 'string'))
        throw new PlotError(`series ${i + 1} has a point that is not [x, y] with a number y`)
    }
    total += s.points.length
  })
  if (total > MAX_PLOT_POINTS) throw new PlotError(`it has ${total} points; at most ${MAX_PLOT_POINTS} are drawn in a message (attach a results file instead)`)
  return { ...p, series: p.series.map((s, i) => ({ name: typeof s.name === 'string' && s.name ? s.name : `Series ${i + 1}`, points: s.points })) }
}

/** Is the x axis words (categories) rather than numbers? */
export const categorical = (p: ChatPlot): boolean => p.series.some((s) => s.points.some(([x]) => typeof x === 'string'))

/** One row per x value, one column per series (what Recharts draws from). */
export function plotRows(p: ChatPlot): Record<string, number | string>[] {
  const words = categorical(p)
  const xs: (number | string)[] = []
  const seen = new Set<string>()
  for (const s of p.series)
    for (const [x] of s.points) {
      const k = String(x)
      if (!seen.has(k)) {
        seen.add(k)
        xs.push(words ? String(x) : x)
      }
    }
  if (!words) (xs as number[]).sort((a, b) => a - b)
  return xs.map((x) => {
    const r: Record<string, number | string> = { x }
    for (const s of p.series) {
      const pt = s.points.find((q) => String(q[0]) === String(x))
      if (pt) r[s.name] = pt[1]
    }
    return r
  })
}

const cell = (v: unknown): string => {
  const s = v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The plot's numbers as CSV: x, then one column per series. */
export function plotCsv(p: ChatPlot): string {
  const xh = [p.x?.label ?? 'x', p.x?.unit ? `(${p.x.unit})` : ''].filter(Boolean).join(' ')
  const head = [xh, ...p.series.map((s) => s.name)]
  const rows = plotRows(p).map((r) => [r.x, ...p.series.map((s) => r[s.name])])
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\n')
}
