/**
 * Operations' rules, pure: the range's step, how series merge into chart rows, the tiles the design names (in its
 * order, with what is missing said honestly), the Process tab's charts and tables in words, the status line's tone,
 * and how often to refresh (slower when the tab is not visible).
 */
import type { OpsAnswer, OpsLevel, OpsProcess, OpsReworkCause, OpsSeries, OpsTile, OpsWaitKind, OpsWidget } from '@/lib/admin-types'
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

/**
 * A series' label as the chart shows it: CloudWatch's own labels name a runtime or memory by its whole ARN
 * ("GetMemory arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/trace_m_8a9ca7b7-n7ExQ1Gm5V Invocations"), which
 * ran to two lines each and, thirty of them in a legend, over the rest of the page. The ARN keeps only its resource.
 */
export const seriesLabel = (label: string): string =>
  label.replace(/arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d*:(?:runtime|memory|[a-z-]+)\/([A-Za-z0-9_.-]+)/g, '$1').replace(/\s+/g, ' ').trim()

/** A chart keeps its legend inside up to this many series; past it the legend is a capped, scrolling list below. */
export const IN_CHART_LEGEND_MAX = 6

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
  /** said after `sub`, in the warning colour ("4 lost") */
  subWarn?: string
  change?: string
  spark: number[]
  /** the sparkline's colour: what the number is about */
  tone?: 'verified' | 'primary' | 'warning' | 'muted'
  status: OpsLevel
  /** the status in the tile's own words ("Lost jobs above 0"); `plain`: a note without a status icon ("Higher is better") */
  statusWord?: string
  plain?: boolean
  /** the API does not report it yet: what is needed */
  missing?: string
  /** not one of the designed five: shown behind "More numbers" */
  extra?: boolean
}

const DESIGN: { id: string; label: string; admin?: boolean; aka?: string[]; needs: string }[] = [
  { id: 'builds', label: 'Builds passed', aka: ['build-failures'], needs: 'the build runners\' results on a listed dashboard (its Process rows)' },
  { id: 'jobs', label: 'Agent jobs finished', needs: 'jobs by outcome on a listed dashboard (its Process rows)' },
  { id: 'waiting', label: 'Waiting on people', needs: 'the waits on people on a listed dashboard (its Process rows); they are recorded as people answer, accept and sign' },
  { id: 'working', label: 'Time trace was working', needs: 'job time and the waits on people on a listed dashboard (its Process rows)' },
  { id: 'cost', label: 'Cloud spend this month', admin: true, needs: 'a spend metric on a listed dashboard' },
]

/** A length of time for a tile: "13 min", "72 min", "4.9 h", "40 s", split into number and unit (minutes up to two hours). */
export function timeParts(seconds: number): { value: string; unit: string } {
  if (seconds < 60) return { value: String(Math.round(seconds)), unit: 's' }
  if (seconds < 7200) return { value: String(Math.round(seconds / 60)), unit: 'min' }
  if (seconds < 86_400) return { value: String(Math.round((seconds / 3600) * 10) / 10), unit: 'h' }
  return { value: String(Math.round((seconds / 86_400) * 10) / 10), unit: 'd' }
}

/** A length of time in words for a table: "13 min", "4.9 h". */
export const timeWords = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–'
  const p = timeParts(seconds)
  return `${p.value} ${p.unit}`
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function valueOf(t: OpsTile): Pick<TileView, 'value' | 'unit' | 'sub' | 'subWarn' | 'statusWord' | 'plain' | 'tone'> {
  const d = t.detail ?? {}
  if (t.id === 'builds' && t.value !== null) {
    return { value: String(t.value), unit: '%', sub: `${n(d.passed)} of ${n(d.total)} · ${n(d.failed)} failed`, tone: 'verified' }
  }
  if (t.id === 'jobs' && t.value !== null) {
    const lost = n(d.lost)
    const parts = 'done' in d ? `${n(d.done)} done · ${n(d.failed)} failed · ` : undefined
    return { value: t.value.toLocaleString(), ...(parts ? { sub: parts, subWarn: `${lost} lost` } : {}), tone: 'primary', ...(lost > 0 ? { statusWord: 'Lost jobs above 0' } : {}) }
  }
  if (t.id === 'waiting') {
    const slow = typeof d.slowest === 'number' ? ` · slowest 10 % over ${timeWords(d.slowest)}` : ''
    return { ...(t.value === null ? { value: '–' } : timeParts(t.value)), sub: `median${slow}`, tone: 'warning' }
  }
  if (t.id === 'working') {
    return { value: t.value === null ? '–' : String(t.value), ...(t.value === null ? {} : { unit: '%' }), sub: 'of elapsed time · the rest waited on people', tone: 'primary', statusWord: 'Higher is better', plain: true }
  }
  if (t.value === null || t.value === undefined) return { value: '–' }
  if (t.unit === 'USD') return { value: money(t.value), tone: 'muted' }
  if (t.unit === 'ms') {
    const min = t.value / 60_000
    return min >= 1 ? { value: String(Math.round(min * 10) / 10), unit: 'min' } : { value: duration(t.value / 1000, { short: true }) }
  }
  if (t.unit === 's') return timeParts(t.value)
  if (t.unit === '%') return { value: String(t.value), unit: '%' }
  const rate = typeof d.successRate === 'number' ? `${Math.round((d.successRate as number) * 100)}% succeeded` : undefined
  return { value: t.value.toLocaleString(), ...(rate ? { sub: rate } : {}) }
}

/** This month's cloud spend from the cost ledger (usage.month, admins), which the cost tile shows when it has it. */
export interface MonthCost { estimated: number; actual: number | null; currency: string; projects: number }

/** The cost tile from the ledger: the month's estimate across projects, with what AWS billed beside it. Pure. */
export function costTile(c: MonthCost): TileView {
  return {
    id: 'cost', label: 'Cloud spend this month', value: money(c.estimated, c.currency), spark: [], status: 'ok', tone: 'muted',
    sub: `Estimate across ${c.projects} project${c.projects === 1 ? '' : 's'}${c.actual !== null ? ` · ${money(c.actual, c.currency)} billed by AWS, a day behind` : ' · not billed by AWS yet'}`,
  }
}

/** The design's tiles in its order (cost for admins only), each from the API's tile when there is one; the API's other
 * tiles after them, marked `extra`. */
export function tileViews(tiles: OpsTile[], admin: boolean, month?: MonthCost | null): TileView[] {
  const used = new Set<string>()
  const out: TileView[] = []
  for (const d of DESIGN) {
    if (d.admin && !admin) continue
    // the cost tile from the cost ledger when an admin has it (CloudWatch's metric is Claude's estimate only)
    if (d.id === 'cost' && month) { out.push(costTile(month)); for (const t of tiles) if (t.id === d.id || d.aka?.includes(t.id)) used.add(t.id); continue }
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
    out.push({ id: t.id, label: t.label, ...valueOf(t), spark: t.spark, status: t.status, change: t.change?.text ?? changeFromSpark(t.spark), extra: true })
  }
  return out
}

// ------------------------------------------------------------------ the Process tab

/** What waited, in words (the table's rows, in this order). */
export const WAIT_WORDS: Record<OpsWaitKind, string> = { question: 'Question answered', change: 'Change accepted', gate: 'Gate signed' }
/** Why work was done twice, in words (the Rework table's rows, in this order). */
export const REWORK_WORDS: Record<OpsReworkCause, string> = {
  job_restarted: 'Jobs started again after being lost',
  conflict_resolved: 'Changes that conflicted and were brought up to date',
  sent_back: 'Changes sent back (Ask for changes)',
  asked_again: 'Questions asked again',
}

const COLOR = { passed: 'var(--verified)', failed: 'var(--destructive)', lost: 'var(--warning)', cancelled: 'var(--muted-foreground)' }

/** The Process tab's two charts as widgets the chart draws: stacked bars with colours that mean something. */
export function processCharts(p: OpsProcess | undefined): { builds: OpsWidget | null; jobs: OpsWidget | null } {
  const col = <T extends number[]>(points: [number, ...T][], i: number): [number, number][] => points.map((x) => [x[0], x[i + 1] as number])
  const builds: OpsWidget | null = p?.builds?.points.length ? {
    id: 'process:builds', title: 'Builds', kind: 'bar', unit: 'builds',
    series: [{ label: 'Passed', color: COLOR.passed, points: col(p.builds.points, 0) }, { label: 'Failed', color: COLOR.failed, points: col(p.builds.points, 1) }],
  } : null
  const jobs: OpsWidget | null = p?.jobs?.points.length ? {
    id: 'process:jobs', title: 'Agent jobs by outcome', kind: 'bar', unit: 'jobs',
    series: [
      { label: 'Done', color: COLOR.passed, points: col(p.jobs.points, 0) },
      { label: 'Failed', color: COLOR.failed, points: col(p.jobs.points, 1) },
      { label: 'Lost (no word for 15 min)', color: COLOR.lost, points: col(p.jobs.points, 2) },
      { label: 'Cancelled', color: COLOR.cancelled, points: col(p.jobs.points, 3) },
    ],
  } : null
  return { builds, jobs }
}

/** The waits table's rows: every kind, in order, with what is known ("–" for a kind with none yet). */
export function waitRows(p: OpsProcess | undefined): { kind: OpsWaitKind; what: string; count: number; median: string; slowest: string; slow: boolean }[] {
  return (Object.keys(WAIT_WORDS) as OpsWaitKind[]).map((kind) => {
    const w = p?.waits.find((x) => x.kind === kind)
    // a slowest tenth past four hours is worth a look
    return { kind, what: WAIT_WORDS[kind], count: w?.count ?? 0, median: timeWords(w?.median), slowest: timeWords(w?.slowest), slow: (w?.slowest ?? 0) > 4 * 3600 }
  })
}

/** The rework table's rows: every cause, in order. */
export const reworkRows = (p: OpsProcess | undefined): { cause: OpsReworkCause; what: string; count: number }[] =>
  (Object.keys(REWORK_WORDS) as OpsReworkCause[]).map((cause) => ({ cause, what: REWORK_WORDS[cause], count: p?.rework.find((x) => x.cause === cause)?.count ?? 0 }))

/** One stage's bar: its share of the longest stage, and the parts trace worked and waited on a person. */
export function stageBars(stages: readonly { id: string; name: string; seconds: number; waiting: number }[]): { id: string; name: string; width: number; working: number; waiting: number; hours: string }[] {
  const max = Math.max(1, ...stages.map((s) => s.seconds))
  return stages.map((s) => {
    const wait = Math.min(s.waiting, s.seconds)
    return {
      id: s.id, name: s.name, width: (s.seconds / max) * 100,
      working: s.seconds ? ((s.seconds - wait) / s.seconds) * 100 : 0, waiting: s.seconds ? (wait / s.seconds) * 100 : 0,
      hours: `${(Math.round((s.seconds / 3600) * 10) / 10).toFixed(1)} h`,
    }
  })
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
