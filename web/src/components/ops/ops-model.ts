/**
 * Operations' rules, pure: the range's step, how series merge into chart rows, the tiles the design names (in its
 * order, with what is missing said honestly), the status line's tone, and how often to refresh (slower when the tab
 * is not visible).
 */
import type { OpsAnswer, OpsLevel, OpsSeries, OpsTile, OpsWidget } from '@/lib/admin-types'
import { duration, money } from '@/lib/format'

export type Range = '1h' | '24h' | '7d' | '30d' | 'custom'
export const RANGES: { id: Range; label: string; words: string }[] = [
  { id: '1h', label: '1 h', words: 'the last hour' },
  { id: '24h', label: '24 h', words: 'the last 24 hours' },
  { id: '7d', label: '7 d', words: 'the last 7 days' },
  { id: '30d', label: '30 d', words: 'the last 30 days' },
  { id: 'custom', label: 'Custom', words: 'the chosen dates' },
]

const MIN = 60_000
const HOUR = 60 * MIN

/** The spacing of points in a range (what one tapped point covers). */
export function stepOf(range: Range, custom?: { start: string; end: string }): number {
  if (range === '1h') return 5 * MIN
  if (range === '24h') return HOUR
  if (range === '7d') return 6 * HOUR
  if (range === '30d') return 24 * HOUR
  if (custom) {
    const span = Date.parse(custom.end) - Date.parse(custom.start)
    return span <= 2 * HOUR ? 5 * MIN : span <= 2 * 86_400_000 ? HOUR : span <= 14 * 86_400_000 ? 6 * HOUR : 24 * HOUR
  }
  return HOUR
}

export const seriesKey = (s: OpsSeries, i: number): string => `s${i}_${s.label.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`

/** Rows for Recharts: one per moment, a column per series. */
export function chartRows(w: OpsWidget): Record<string, number>[] {
  const by = new Map<number, Record<string, number>>()
  w.series.forEach((s, i) => {
    const k = seriesKey(s, i)
    for (const [t, v] of s.points) {
      const r = by.get(t) ?? { t }
      r[k] = v
      by.set(t, r)
    }
  })
  return [...by.values()].sort((a, b) => a.t! - b.t!)
}

export function axisTime(t: number, step: number): string {
  const d = new Date(t)
  if (step >= 24 * HOUR) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  if (step >= 6 * HOUR) return d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + String(d.getHours()).padStart(2, '0')
  return `${String(d.getHours()).padStart(2, '0')}${step < HOUR ? `:${String(d.getMinutes()).padStart(2, '0')}` : ''}`
}

/** "Tue 14:00–15:00", "12 Oct", "Tue 14:05–14:10". */
export function momentLabel(t: number, step: number): string {
  const a = new Date(t)
  const b = new Date(t + step)
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (step >= 24 * HOUR) return a.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${a.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm(a)}–${hm(b)}`
}

/** What each series says at one moment, as a sentence ("4 runs: Verification 2, Analog 2."). */
export function momentSummary(w: OpsWidget, t: number): string {
  const vals = w.series.map((s) => ({ label: s.label, v: s.points.find(([x]) => x === t)?.[1] })).filter((x) => x.v !== undefined) as { label: string; v: number }[]
  if (!vals.length) return 'No values at this moment.'
  const unit = w.unit ?? ''
  if (vals.length === 1) return `${fmt(vals[0]!.v)} ${unit}`.trim() + '.'
  const total = vals.reduce((a, b) => a + b.v, 0)
  const top = vals.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4).map((x) => `${x.label} ${fmt(x.v)}`).join(', ')
  return w.kind === 'bar' || w.kind === 'area' ? `${fmt(total)} ${unit} in all: ${top}.` : `${top}${unit ? ` ${unit}` : ''}.`
}

const fmt = (v: number): string => (Number.isInteger(v) ? v.toLocaleString() : (Math.round(v * 10) / 10).toLocaleString())

// ------------------------------------------------------------------ the five tiles

export interface TileView {
  id: string
  label: string
  value: string
  unit?: string
  sub?: string
  change?: string
  spark: number[]
  status: OpsLevel
  /** the API does not report it yet: what is needed */
  missing?: string
}

const DESIGN: { id: string; label: string; admin?: boolean; aka?: string[]; needs: string }[] = [
  { id: 'runs', label: 'Agent runs', needs: 'agent runtime invocations on a listed dashboard' },
  { id: 'latency', label: 'Median run time', needs: 'run latency on a listed dashboard' },
  { id: 'jobs', label: 'Jobs waiting', aka: ['waiting'], needs: 'a queue-depth metric for graphics card and CPU jobs' },
  { id: 'builds', label: 'Build failures', aka: ['build-failures'], needs: 'build runner results on a listed dashboard' },
  { id: 'cost', label: 'Cloud spend this month', admin: true, needs: 'a spend metric on a listed dashboard' },
]

function valueOf(t: OpsTile): { value: string; unit?: string; sub?: string } {
  if (t.value === null || t.value === undefined) return { value: '–' }
  if (t.unit === 'USD') return { value: money(t.value) }
  if (t.unit === 'ms') {
    const min = t.value / 60_000
    return min >= 1 ? { value: String(Math.round(min * 10) / 10), unit: 'min' } : { value: duration(t.value / 1000, { short: true }) }
  }
  const rate = typeof t.detail?.successRate === 'number' ? `${Math.round((t.detail.successRate as number) * 100)}% succeeded` : undefined
  return { value: t.value.toLocaleString(), ...(rate ? { sub: rate } : {}) }
}

/** The design's tiles in its order (cost for admins only), each from the API's tile when there is one. */
export function tileViews(tiles: OpsTile[], admin: boolean): TileView[] {
  const used = new Set<string>()
  const out: TileView[] = []
  for (const d of DESIGN) {
    if (d.admin && !admin) continue
    const t = tiles.find((x) => x.id === d.id || d.aka?.includes(x.id))
    if (!t) {
      out.push({ id: d.id, label: d.label, value: '–', spark: [], status: 'ok', missing: `Not reported yet: needs ${d.needs}.` })
      continue
    }
    used.add(t.id)
    const v = valueOf(t)
    const sub = [v.sub, t.note].filter(Boolean).join(' · ') || undefined
    out.push({ id: d.id, label: d.label, ...v, sub, change: t.change?.text ?? changeFromSpark(t.spark), spark: t.spark, status: t.status })
  }
  // any further tile the API adds, after the designed five (never cost for non-admins)
  for (const t of tiles) {
    if (used.has(t.id) || (!admin && /cost|spend/i.test(t.id + t.label))) continue
    out.push({ id: t.id, label: t.label, ...valueOf(t), spark: t.spark, status: t.status, change: t.change?.text ?? changeFromSpark(t.spark) })
  }
  return out
}

/** Without a previous period from the API, the change across the shown range. */
export function changeFromSpark(spark: number[]): string | undefined {
  if (spark.length < 2) return undefined
  const half = Math.floor(spark.length / 2)
  const a = spark.slice(0, half).reduce((x, y) => x + y, 0)
  const b = spark.slice(half).reduce((x, y) => x + y, 0)
  if (a === 0) return undefined
  const pct = Math.round(((b - a) / a) * 100)
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}% in the second half of the range`
}

export const LEVEL: Record<OpsLevel, { status: 'verified' | 'warning' | 'failing'; word: string }> = {
  ok: { status: 'verified', word: 'Normal' },
  warn: { status: 'warning', word: 'Needs a look' },
  alarm: { status: 'failing', word: 'Alarm' },
}

// ------------------------------------------------------------------ refreshing

/** How long until the next refresh: the API's nextAt while visible; four times as long (at least 5 minutes) when hidden. */
export function refreshIn(a: Pick<OpsAnswer, 'updatedAt' | 'nextAt'> | undefined, now: number, visible: boolean): number {
  const base = a ? Math.max(5_000, Date.parse(a.nextAt) - Date.parse(a.updatedAt)) : 60_000
  const due = a ? Date.parse(a.nextAt) - now : base
  if (visible) return Math.max(1_000, due)
  return Math.max(5 * MIN, base * 4)
}

export function opsUrl(range: Range, repo: string | null, custom?: { start: string; end: string }): string {
  const q = new URLSearchParams()
  if (range === 'custom' && custom) {
    q.set('start', new Date(custom.start).toISOString())
    q.set('end', new Date(custom.end).toISOString())
  } else q.set('range', range === 'custom' ? '24h' : range)
  if (repo) q.set('repo', repo)
  return `/api/ops?${q.toString()}`
}

/** "Jobs" from a dashboard named "trace-jobs" or "trace-Jobs-dashboard". */
export function sectionTitle(title: string): string {
  const t = title.replace(/^trace[-_]/i, '').replace(/[-_]dashboard$/i, '').replace(/[-_]+/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : title
}
