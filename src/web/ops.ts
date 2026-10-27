/**
 * GET /api/ops: Operations, a permitted view of trace's CloudWatch dashboards. CloudWatch stays the source of truth.
 *
 *   read      GetDashboard for each configured dashboard; its metric widgets (SEARCH expressions and explicit metric
 *             rows, with the "." shorthand), each as one GetMetricData query for the range. The period is the
 *             widget's, raised so a series has at most ~720 points (a SEARCH's own period is rewritten the same way).
 *   attribute each series is matched to a project by the names trace gives a project's resources, all carrying the
 *             project's hash (src/core/project.ts projectHash): its worker runtime `<prefix>_w_<hash>`, its memory
 *             `<prefix>_m_<hash>`, and `-ci-`, `-gpu-`, `-cpu-`, `-kb-<hash>`. A SEARCH result's label is its
 *             dimension values, so the runtime and memory names are in it. trace's own metrics (namespace
 *             bedrock-agentcore) carry no repository on purpose (low cardinality): their aggregate series cannot be
 *             attributed (admins only), and their per-project series (trace.project.*: jobs, job time, tool calls,
 *             tool time, Claude cost, remote jobs) carry `project-<hash>` (src/core/telemetry.ts PROJECT METRICS),
 *             which is attributed like a resource name.
 *   filter    the person's class (`whoami`) and projects (`projects`), asked as them through the API runtime:
 *               admin        everything
 *               contributor  only series attributed to one of their projects; a widget mixing projects keeps only
 *                            theirs, each labelled with its project; unattributed series are admin-only; no cost
 *                            series (a cost metric, or a widget titled with cost or spend): money is for admins
 *               reviewer     the same
 *             Alarms (DescribeAlarms, ALARM and INSUFFICIENT_DATA, names starting with the prefix) the same way, by
 *             their name and dimension values.
 *   answer    { status: { level, text }, tiles, alarms, sections: [{ id, title, widgets: [{ id, title, kind, unit,
 *             series: [{ label, repo?, points: [[t, v]] }] }] }], updatedAt, nextAt } (nextAt: 60 s on)
 */
import type { MetricAlarm, MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch'
import { z } from 'zod'
import { projectHash } from '../core/project.js'
import { type Caller, callApi } from './call.js'
import type { WebConfig } from './config.js'
import { type WebDeps, signedIn } from './deps.js'
import { WebError, route } from './http.js'

export const REFRESH_S = 60
const MAX_POINTS = 720
/** The longest range asked for at once (each range is a GetMetricData bill). */
export const MAX_RANGE_DAYS = 30
const RANGES: Readonly<Record<string, number>> = { '1h': 3600, '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400 }

// ------------------------------------------------------------------ who may see what

export type Part = 'contributor' | 'reviewer'

export interface Access {
  admin: boolean
  /** repo → part */
  projects: ReadonlyMap<string, Part>
}

const Who = z.object({ ok: z.literal(true), result: z.object({ class: z.string().nullable() }).loose() }).loose()
const Projects = z.object({ ok: z.literal(true), result: z.array(z.object({ repo: z.string(), role: z.string().optional(), part: z.string().optional() }).loose()) }).loose()

/** The person's access, asked of the API runtime as them (the one place that decides access). */
export async function accessOf(deps: WebDeps, who: Caller): Promise<Access> {
  const [w, p] = await Promise.all([callApi(deps, who, 'whoami', {}), callApi(deps, who, 'projects', {})])
  const wa = Who.safeParse(w.json)
  const pa = Projects.safeParse(p.json)
  if (!wa.success || !pa.success) throw new WebError(w.status === 401 || p.status === 401 ? 401 : 502, 'could not read your access', 'access')
  const projects = new Map<string, Part>()
  for (const x of pa.data.result) {
    const part: Part = x.part === 'reviewer' || (x.part === undefined && x.role === 'read') ? 'reviewer' : 'contributor'
    projects.set(x.repo.toLowerCase(), part)
  }
  return { admin: wa.data.result.class === 'admin', projects }
}

/** The marks of trace's resource names any project's hash could leave in a label: `<prefix>_w_<8 hex>` and the rest. */
const markPattern = (prefix: string): RegExp => {
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const under = esc(prefix.replace(/-/g, '_').toLowerCase())
  const dash = esc(prefix.toLowerCase())
  // `project-<hash>`: the per-project metrics' dimension (trace.project), the same hash with no installation prefix
  return new RegExp(`(?:${under}_[wm]_|${dash}-(?:ci|gpu|cpu|kb|m)-|\\bproject-)([0-9a-f]{8})`, 'g')
}

/**
 * The project a name or label belongs to, among `repos`, by the hash in trace's resource names; null if none, and null
 * too when the text carries the marks of more than one project (of any project, the person's or not): a series that
 * mixes projects is never shown as one of them (only to an admin, who sees everything).
 */
export function attribute(text: string, prefix: string, repos: Iterable<string>): string | null {
  const t = text.toLowerCase()
  const hashes = new Set([...t.matchAll(markPattern(prefix))].map((m) => m[1]))
  if (hashes.size !== 1) return null
  const [h] = hashes
  for (const repo of repos) {
    try { if (projectHash(repo) === h) return repo } catch { continue }
  }
  return null
}

const COST = /cost|spend|budget|billing|EstimatedCharges/i

// ------------------------------------------------------------------ the dashboard's widgets

const WidgetJson = z.object({
  type: z.string(),
  properties: z.object({
    title: z.string().optional(),
    view: z.string().optional(),
    stacked: z.boolean().optional(),
    period: z.number().optional(),
    stat: z.string().optional(),
    region: z.string().optional(),
    metrics: z.array(z.array(z.unknown())).optional(),
    yAxis: z.object({ left: z.object({ label: z.string().optional() }).loose().optional() }).loose().optional(),
  }).loose(),
}).loose()
const DashboardJson = z.object({ widgets: z.array(z.unknown()) }).loose()

export interface Query { id: string; expression?: string; namespace?: string; metric?: string; dimensions?: { Name: string; Value: string }[]; stat: string; period: number; label?: string }
export interface MetricWidget { index: number; title: string; kind: string; unit: string | null; queries: Query[] }

const Opts = z.object({ id: z.string().optional(), expression: z.string().optional(), label: z.string().optional(), stat: z.string().optional(), period: z.number().optional(), visible: z.boolean().optional() }).loose()

const kindOf = (view: string | undefined, stacked: boolean | undefined): string =>
  view === 'singleValue' ? 'value' : view === 'bar' ? 'bar' : view === 'pie' ? 'pie' : view === 'gauge' ? 'gauge' : stacked ? 'area' : 'line'

/** A dashboard body's metric widgets and their queries. */
export function parseDashboard(body: string): MetricWidget[] {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return [] }
  const d = DashboardJson.safeParse(raw)
  if (!d.success) return []
  const out: MetricWidget[] = []
  d.data.widgets.forEach((w, index) => {
    const p = WidgetJson.safeParse(w)
    if (!p.success || p.data.type !== 'metric') return
    const props = p.data.properties
    const queries: Query[] = []
    let prev: unknown[] = []
    for (const row of props.metrics ?? []) {
      const last = row[row.length - 1]
      const opts = last && typeof last === 'object' && !Array.isArray(last) ? Opts.safeParse(last) : null
      const o = opts?.success ? opts.data : {}
      if (o.visible === false) continue
      const qid = (o.id ?? `q${index}_${queries.length}`).replace(/[^A-Za-z0-9_]/g, '_')
      const id = /^[a-z]/.test(qid) ? qid : `q${qid}`
      const stat = o.stat ?? props.stat ?? 'Average'
      const period = o.period ?? props.period ?? 300
      if (o.expression) {
        queries.push({ id, expression: o.expression, stat, period, ...(o.label ? { label: o.label } : {}) })
        prev = []
        continue
      }
      const items = opts?.success ? row.slice(0, -1) : row
      const filled = items.map((x, i) => (x === '.' || x === '...' ? prev[i] : x))
      prev = filled
      if (filled.length < 2 || filled.some((x) => typeof x !== 'string')) continue
      const [namespace, metric, ...dims] = filled as string[]
      const dimensions: { Name: string; Value: string }[] = []
      for (let i = 0; i + 1 < dims.length; i += 2) dimensions.push({ Name: dims[i] as string, Value: dims[i + 1] as string })
      queries.push({ id, namespace, metric, dimensions, stat, period, ...(o.label ? { label: o.label } : {}) })
    }
    if (queries.length) out.push({ index, title: props.title ?? `Widget ${index + 1}`, kind: kindOf(props.view, props.stacked), unit: props.yAxis?.left?.label ?? null, queries })
  })
  return out
}

/** The period that keeps a range under MAX_POINTS points, at least the widget's, in whole minutes. */
export const periodFor = (rangeS: number, base: number): number => Math.max(base, Math.ceil(rangeS / MAX_POINTS / 60) * 60)

const metricOfExpression = (e: string): string | null => /MetricName="([^"]+)"/.exec(e)?.[1] ?? null

/** A GetMetricData query for a widget query (a SEARCH's period rewritten). */
export function toMetricDataQuery(q: Query, rangeS: number): MetricDataQuery {
  const period = periodFor(rangeS, q.period)
  if (q.expression) {
    const expression = q.expression.replace(/(SEARCH\(.*,\s*'[^']*'\s*,\s*)(\d+)(\s*\))/, (_m, a: string, _p: string, b: string) => `${a}${period}${b}`)
    return { Id: q.id, Expression: expression, ReturnData: true, Period: period, ...(q.label ? { Label: q.label } : {}) }
  }
  return {
    Id: q.id, ReturnData: true, ...(q.label ? { Label: q.label } : {}),
    MetricStat: { Metric: { Namespace: q.namespace, MetricName: q.metric, Dimensions: q.dimensions }, Period: period, Stat: q.stat },
  }
}

// ------------------------------------------------------------------ the answer

export interface Series { label: string; repo?: string; metric: string | null; points: [number, number][] }
export interface WidgetOut { id: string; title: string; kind: string; unit: string | null; series: Omit<Series, 'metric'>[] }

/** Which series of a widget this person may see, labelled with their project. */
export function filterSeries(series: readonly Series[], widgetTitle: string, access: Access, prefix: string): Series[] {
  const repos = [...access.projects.keys()]
  const out: Series[] = []
  for (const s of series) {
    const repo = attribute(s.label, prefix, repos) ?? undefined
    const cost = COST.test(widgetTitle) || COST.test(s.metric ?? '') || COST.test(s.label)
    if (!access.admin) {
      if (!repo) continue
      // money is for admins (docs/ui-design.md Operations): a contributor's project's spend is on its Cost tab for admins
      if (cost) continue
    }
    out.push({ ...s, ...(repo ? { repo } : {}) })
  }
  return out
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

/** The summary tiles from what the person may see. */
export function tiles(widgets: readonly { series: readonly Series[] }[], access: Access): Record<string, unknown>[] {
  const all = widgets.flatMap((w) => w.series)
  const of = (name: string, label?: RegExp): Series[] => all.filter((s) => s.metric === name && (!label || label.test(s.label)))
  const values = (ss: readonly Series[]): number[] => ss.flatMap((s) => s.points.map(([, v]) => v))
  const spark = (ss: readonly Series[]): number[] => {
    const by = new Map<number, number>()
    for (const s of ss) for (const [t, v] of s.points) by.set(t, (by.get(t) ?? 0) + v)
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  }
  const runtime = /_w_/
  const runs = of('Invocations', runtime)
  const errors = [...of('SystemErrors', runtime), ...of('UserErrors', runtime)]
  const latency = of('Latency', runtime)
  const total = sum(values(runs))
  const failed = sum(values(errors))
  const lat = values(latency).sort((a, b) => a - b)
  const out: Record<string, unknown>[] = [
    { id: 'runs', label: 'Agent runs', value: total, unit: 'runs', detail: total ? { successRate: Math.max(0, 1 - failed / total) } : null, spark: spark(runs), status: total && failed / total > 0.1 ? 'warn' : 'ok' },
    { id: 'latency', label: 'Median run time', value: lat.length ? lat[Math.floor(lat.length / 2)] : null, unit: 'ms', spark: spark(latency), status: 'ok' },
  ]
  // the aggregate where the person sees it (admins), else the per-project series of their projects: never both
  const pick = (aggregate: string, perProject: string): Series[] => { const a = of(aggregate); return a.length ? a : of(perProject) }
  const jobs = pick('trace.jobs', 'trace.project.jobs')
  if (jobs.length) out.push({ id: 'jobs', label: 'Jobs finished', value: sum(values(jobs)), unit: 'jobs', spark: spark(jobs), status: 'ok' })
  const calls = pick('trace.tool.calls', 'trace.project.tool.calls')
  if (calls.length) out.push({ id: 'tools', label: 'Tool calls', value: sum(values(calls)), unit: 'calls', spark: spark(calls), status: 'ok' })
  const cost = pick('trace.claude.cost', 'trace.project.claude.cost')
  if (access.admin && cost.length) out.push({ id: 'cost', label: 'Claude spend (estimate)', value: Math.round(sum(values(cost)) * 100) / 100, unit: 'USD', spark: spark(cost), status: 'ok' })
  return out
}

interface AlarmOut { name: string; state: string; reason: string; since: string | null; metric: string | null; threshold: number | null; repo?: string }

export function filterAlarms(alarms: readonly MetricAlarm[], access: Access, prefix: string): { visible: AlarmOut[]; hiddenFiring: number } {
  const repos = [...access.projects.keys()]
  const visible: AlarmOut[] = []
  let hiddenFiring = 0
  for (const a of alarms) {
    const text = [a.AlarmName ?? '', ...(a.Dimensions ?? []).map((d) => d.Value ?? ''), ...(a.Metrics ?? []).flatMap((m) => (m.MetricStat?.Metric?.Dimensions ?? []).map((d) => d.Value ?? ''))].join(' ')
    const repo = attribute(text, prefix, repos) ?? undefined
    const cost = COST.test(a.AlarmName ?? '') || COST.test(a.MetricName ?? '')
    const allowed = access.admin || (repo !== undefined && !(cost && access.projects.get(repo) === 'reviewer'))
    if (!allowed) { if (a.StateValue === 'ALARM') hiddenFiring++; continue }
    visible.push({
      name: a.AlarmName ?? '', state: a.StateValue ?? 'UNKNOWN', reason: a.AlarmDescription ?? a.StateReason ?? '',
      since: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : null,
      metric: a.MetricName ?? null, threshold: a.Threshold ?? null, ...(repo ? { repo } : {}),
    })
  }
  return { visible, hiddenFiring }
}

export function statusLine(alarms: readonly AlarmOut[], hiddenFiring: number): { level: 'ok' | 'warn' | 'alarm'; text: string } {
  const firing = alarms.filter((a) => a.state === 'ALARM')
  if (firing.length) {
    const first = firing[0] as AlarmOut
    return { level: 'alarm', text: firing.length === 1 ? `One alarm is firing: ${first.name}${first.reason ? ` (${first.reason})` : ''}.` : `${firing.length} alarms are firing, starting with ${first.name}.` }
  }
  if (hiddenFiring) return { level: 'warn', text: 'Your projects are healthy; a shared service needs attention and the admins can see it.' }
  const waiting = alarms.filter((a) => a.state === 'INSUFFICIENT_DATA').length
  if (waiting) return { level: 'ok', text: `All systems normal; ${waiting === 1 ? 'one alarm is' : `${waiting} alarms are`} waiting for data.` }
  return { level: 'ok', text: 'All systems normal.' }
}

function rangeOf(q: URLSearchParams, now: number): { start: Date; end: Date; seconds: number } {
  const from = q.get('start')
  const to = q.get('end')
  if (from || to) {
    const end = to ? Date.parse(to) : now
    const start = from ? Date.parse(from) : end - 86_400_000
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_RANGE_DAYS * 86_400_000) throw new WebError(400, `start and end: two ISO times, start first, at most ${MAX_RANGE_DAYS} days apart`, 'bad_request')
    return { start: new Date(start), end: new Date(end), seconds: Math.round((end - start) / 1000) }
  }
  const r = q.get('range') ?? '24h'
  const seconds = RANGES[r]
  if (!seconds) throw new WebError(400, 'range: 1h, 24h, 7d or 30d', 'bad_request')
  return { start: new Date(now - seconds * 1000), end: new Date(now), seconds }
}

/** The whole Operations answer for one person. */
export async function operations(deps: WebDeps, who: Caller, c: WebConfig, q: URLSearchParams): Promise<Record<string, unknown>> {
  const now = deps.now()
  const range = rangeOf(q, now)
  const access = await accessOf(deps, who)
  const only = q.get('repo')?.toLowerCase() || null
  if (only && !access.admin && !access.projects.has(only)) throw new WebError(403, 'no access', 'no_access')
  const cw = deps.cloudwatch(c)
  const sections: Record<string, unknown>[] = []
  const shown: { series: Series[] }[] = []
  for (const name of c.dashboards) {
    let body: string
    try {
      body = await cw.getDashboard(name)
    } catch (e) {
      deps.log({ warning: 'ops: GetDashboard failed', dashboard: name, error: e instanceof Error ? e.name : 'Error' })
      continue
    }
    const widgets = parseDashboard(body)
    const queries: MetricDataQuery[] = []
    const owner = new Map<string, { widget: MetricWidget; query: Query }>()
    for (const w of widgets) {
      for (const qq of w.queries) {
        const id = `w${w.index}_${qq.id}`.replace(/[^A-Za-z0-9_]/g, '_')
        owner.set(id, { widget: w, query: qq })
        queries.push({ ...toMetricDataQuery(qq, range.seconds), Id: id })
      }
    }
    const results: MetricDataResult[] = []
    for (let i = 0; i < queries.length; i += 500) results.push(...await cw.getMetricData(queries.slice(i, i + 500), range.start, range.end))
    const byWidget = new Map<number, Series[]>()
    for (const r of results) {
      const o = owner.get(r.Id ?? '')
      if (!o) continue
      const ts = r.Timestamps ?? []
      const vs = r.Values ?? []
      const points = ts.map((t, i) => [new Date(t).getTime(), vs[i] ?? 0] as [number, number]).sort((a, b) => a[0] - b[0])
      const metric = o.query.metric ?? (o.query.expression ? metricOfExpression(o.query.expression) : null)
      const list = byWidget.get(o.widget.index) ?? []
      list.push({ label: r.Label ?? o.query.label ?? metric ?? r.Id ?? '', metric, points })
      byWidget.set(o.widget.index, list)
    }
    const out: WidgetOut[] = []
    for (const w of widgets) {
      let series = filterSeries(byWidget.get(w.index) ?? [], w.title, access, c.prefix)
      if (only) series = series.filter((s) => s.repo === only)
      if (!series.length) continue
      shown.push({ series })
      out.push({ id: `${name}:${w.index}`, title: w.title, kind: w.kind, unit: w.unit, series: series.map(({ metric: _m, ...s }) => s) })
    }
    if (out.length) sections.push({ id: name, title: name, widgets: out })
  }
  let alarms: MetricAlarm[] = []
  try {
    alarms = await cw.describeAlarms(c.prefix)
  } catch (e) {
    deps.log({ warning: 'ops: DescribeAlarms failed', error: e instanceof Error ? e.name : 'Error' })
  }
  const a = filterAlarms(alarms, access, c.prefix)
  const visible = only ? a.visible.filter((x) => x.repo === only) : a.visible
  return {
    status: statusLine(visible, a.hiddenFiring),
    tiles: tiles(shown, access),
    alarms: visible,
    sections,
    updatedAt: new Date(now).toISOString(),
    nextAt: new Date(now + REFRESH_S * 1000).toISOString(),
  }
}

export function opsRoutes(deps: WebDeps) {
  return [
    route('GET', '/api/ops', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      if (!s.config.features.ops) throw new WebError(404, 'Operations is turned off', 'disabled')
      return { body: await operations(deps, { config: s.config, token: s.token, sub: s.claims.sub }, s.config, req.query) }
    }),
  ]
}
