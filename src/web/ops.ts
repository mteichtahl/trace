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
 *   process   the dashboard's Process rows (titles starting PROCESS_TITLE, src/infra/observability.ts PROCESS) are
 *             not shown as charts: their series, filtered exactly as above, make the Process tab (processView): builds
 *             passed and failed (CodeBuild's own counts, by runner: a project's runner is attributed by its hash,
 *             trace's own build-only runners belong to no project and so are admins'), jobs by outcome (lost
 *             included), waits on people by kind (median, slowest 10 %, count), rework by cause, and the time trace
 *             was working. A row with setPeriodToTimeRange is read as CloudWatch draws it: one value per series for
 *             the whole range (its period the range itself), for medians and counts over the range. Medians of
 *             several series (kinds, projects) are combined weighted by their counts: exact for one series, close
 *             otherwise (CloudWatch cannot merge percentiles across series)
 *   answer    { status: { level, text }, tiles, alarms, sections: [{ id, title, widgets: [{ id, title, kind, unit,
 *             series: [{ label, repo?, points: [[t, v]] }] }] }], process, updatedAt, nextAt } (nextAt: 60 s on)
 */
import type { MetricAlarm, MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch'
import { z } from 'zod'
import { projectHash } from '../core/project.js'
import { PROCESS_TITLE, REWORK_CAUSES, WAIT_KINDS, type ReworkCause, type WaitKind } from '../core/telemetry.js'
import { type Caller, callApi } from './call.js'
import type { WebConfig } from './config.js'
import { type WebDeps, signedIn } from './deps.js'
import { MESSAGES_ID } from './ports.js'
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
    setPeriodToTimeRange: z.boolean().optional(),
    metrics: z.array(z.array(z.unknown())).optional(),
    yAxis: z.object({ left: z.object({ label: z.string().optional() }).loose().optional() }).loose().optional(),
  }).loose(),
}).loose()
const DashboardJson = z.object({ widgets: z.array(z.unknown()) }).loose()

export interface Query { id: string; expression?: string; namespace?: string; metric?: string; dimensions?: { Name: string; Value: string }[]; stat: string; period: number; label?: string }
export interface MetricWidget {
  index: number; title: string; kind: string; unit: string | null; queries: Query[]
  /** one value per series for the whole range (setPeriodToTimeRange) */
  whole?: boolean
  /** a Process row (its title starts with PROCESS_TITLE): read for the Process tab, not shown as a chart */
  process?: boolean
}

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
    const title = props.title ?? `Widget ${index + 1}`
    if (queries.length) {
      out.push({
        index, title, kind: kindOf(props.view, props.stacked), unit: props.yAxis?.left?.label ?? null, queries,
        ...(props.setPeriodToTimeRange ? { whole: true } : {}), ...(title.startsWith(PROCESS_TITLE) ? { process: true } : {}),
      })
    }
  })
  return out
}

/** The period that keeps a range under MAX_POINTS points, at least the widget's, in whole minutes. */
export const periodFor = (rangeS: number, base: number): number => Math.max(base, Math.ceil(rangeS / MAX_POINTS / 60) * 60)

const metricOfExpression = (e: string): string | null => /MetricName="([^"]+)"/.exec(e)?.[1] ?? null
/** A SEARCH's statistic: SEARCH('…', 'p50', 300) → p50. */
const statOfExpression = (e: string): string | null => /SEARCH\(.*,\s*'([^']+)'\s*,\s*\d+\s*\)/.exec(e)?.[1] ?? null

/** The period of a whole-range read: the range itself, in whole minutes (CloudWatch's setPeriodToTimeRange). */
export const wholePeriod = (rangeS: number): number => Math.max(60, Math.ceil(rangeS / 60) * 60)

/** A GetMetricData query for a widget query (a SEARCH's period rewritten; `whole`: the whole range in one period). */
export function toMetricDataQuery(q: Query, rangeS: number, whole = false): MetricDataQuery {
  const period = whole ? wholePeriod(rangeS) : periodFor(rangeS, q.period)
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

export interface Series { label: string; repo?: string; metric: string | null; points: [number, number][]; stat?: string | null; whole?: boolean }
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
const values = (ss: readonly Series[]): number[] => ss.flatMap((s) => s.points.map(([, v]) => v))
/** The series summed per moment, in time order. */
const perMoment = (ss: readonly Series[]): Map<number, number> => {
  const by = new Map<number, number>()
  for (const s of ss) for (const [t, v] of s.points) by.set(t, (by.get(t) ?? 0) + v)
  return new Map([...by.entries()].sort((a, b) => a[0] - b[0]))
}
const spark = (ss: readonly Series[]): number[] => [...perMoment(ss).values()]

// ------------------------------------------------------------------ the Process tab

/** A job's outcome (trace.outcome) as Operations says it. */
export const OUTCOME_WORDS = { ok: 'done', error: 'failed', denied: 'failed', rejected: 'failed', lost: 'lost', aborted: 'cancelled' } as const
type JobWord = (typeof OUTCOME_WORDS)[keyof typeof OUTCOME_WORDS]
const JOB_WORDS: readonly JobWord[] = ['done', 'failed', 'lost', 'cancelled']

/** The word of `words` a SEARCH series' label carries (its dimension values, space separated), or null. */
const wordIn = <T extends string>(label: string, words: readonly T[]): T | null => {
  const have = new Set(label.split(/[\s,{}]+/))
  return words.find((w) => have.has(w)) ?? null
}

/**
 * The value at quantile `q` of values weighted by their counts (a median of medians, weighted): exact for one series,
 * close for several, since CloudWatch cannot merge percentiles across series.
 */
export function weightedQuantile(parts: readonly { value: number; count: number }[], q = 0.5): number | null {
  const ps = parts.filter((p) => Number.isFinite(p.value) && p.count > 0).sort((a, b) => a.value - b.value)
  const total = sum(ps.map((p) => p.count))
  if (!total) return null
  let acc = 0
  for (const p of ps) { acc += p.count; if (acc >= total * q) return p.value }
  return ps.at(-1)?.value ?? null
}

/** Whole-range series of one metric paired by label and moment: each label's value of `stat` with its count. */
function withCounts(ss: readonly Series[], metric: string, stat: string): { label: string; value: number; count: number }[] {
  const counts = new Map<string, number>()
  for (const s of ss) if (s.metric === metric && s.stat === 'SampleCount') for (const [t, v] of s.points) counts.set(`${s.label}|${t}`, (counts.get(`${s.label}|${t}`) ?? 0) + v)
  return ss.filter((s) => s.metric === metric && s.stat === stat).flatMap((s) => s.points.map(([t, v]) => ({ label: s.label, value: v, count: counts.get(`${s.label}|${t}`) ?? 0 })))
}

type Tally = { passed: number; failed: number }

export interface ProcessView {
  /** builds passed and failed per moment ([t, passed, failed]); by source: trace's own runners and the projects' */
  builds: (Tally & { points: [number, number, number][]; own: Tally; projects: Tally }) | null
  /** jobs by outcome per moment ([t, done, failed, lost, cancelled]) */
  jobs: ({ points: [number, number, number, number, number][] } & Record<JobWord, number>) | null
  /** waits on people over the range by kind, seconds */
  waits: { kind: WaitKind; count: number; median: number | null; slowest: number | null }[]
  /** every kind together, and the average wait per moment */
  wait: { count: number; median: number | null; slowest: number | null; spark: number[] } | null
  rework: { cause: ReworkCause; count: number }[]
  /**
   * Time trace was working: the jobs' run time ÷ (their run time + the time trace waited on people), over the range,
   * with the seconds of each. Higher is better: the rest of the time, the work waited on a person. Null without either.
   */
  working: { share: number | null; jobSeconds: number; waitSeconds: number; spark: number[] } | null
  /** a job's median run time over the range, seconds (the Median run time tile) */
  runTime: { median: number | null; count: number } | null
}

/**
 * The Process tab from the Process rows' series this person may see. The aggregate series where they see them
 * (admins), else their projects' per-project ones: never both, so nothing is counted twice.
 */
export function processView(series: readonly Series[]): ProcessView {
  const of = (metric: string, stat?: string, whole?: boolean): Series[] =>
    series.filter((s) => s.metric === metric && (stat === undefined || s.stat === stat) && (whole === undefined || Boolean(s.whole) === whole))
  const pick = (a: Series[], b: Series[]): Series[] => (a.length ? a : b)
  // builds: CodeBuild's counts; a runner attributed to a project is the project's, the rest trace's own
  const ok = of('SucceededBuilds')
  const bad = of('FailedBuilds')
  const passedAt = perMoment(ok)
  const failedAt = perMoment(bad)
  const moments = [...new Set([...passedAt.keys(), ...failedAt.keys()])].sort((a, b) => a - b)
  const bySource = (repo: boolean): Tally => ({ passed: sum(values(ok.filter((s) => Boolean(s.repo) === repo))), failed: sum(values(bad.filter((s) => Boolean(s.repo) === repo))) })
  const builds = ok.length || bad.length ? {
    passed: sum(values(ok)), failed: sum(values(bad)), own: bySource(false), projects: bySource(true),
    points: moments.map((t) => [t, passedAt.get(t) ?? 0, failedAt.get(t) ?? 0] as [number, number, number]),
  } : null
  // jobs: every outcome, lost included
  const js = pick(of('trace.jobs', 'Sum', false), of('trace.project.jobs', 'Sum', false))
  const outcomes = Object.keys(OUTCOME_WORDS) as (keyof typeof OUTCOME_WORDS)[]
  const byWord = (w: JobWord): Series[] => js.filter((s) => { const o = wordIn(s.label, outcomes); return o !== null && OUTCOME_WORDS[o] === w })
  const wordAt = Object.fromEntries(JOB_WORDS.map((w) => [w, perMoment(byWord(w))])) as Record<JobWord, Map<number, number>>
  const jobs = js.length ? {
    ...Object.fromEntries(JOB_WORDS.map((w) => [w, sum(values(byWord(w)))])) as Record<JobWord, number>,
    points: [...perMoment(js).keys()].map((t) => [t, ...JOB_WORDS.map((w) => wordAt[w].get(t) ?? 0)] as [number, number, number, number, number]),
  } : null
  // waits: over the whole range by kind, and per moment (sum ÷ count) for the spark
  const whole = of('trace.project.wait', undefined, true)
  const p50 = withCounts(whole, 'trace.project.wait', 'p50')
  const p90 = withCounts(whole, 'trace.project.wait', 'p90')
  const kindOf = (l: string): WaitKind | null => wordIn(l, WAIT_KINDS)
  const waits = WAIT_KINDS.map((kind) => {
    const a = p50.filter((x) => kindOf(x.label) === kind)
    return { kind, count: sum(a.map((x) => x.count)), median: weightedQuantile(a), slowest: weightedQuantile(p90.filter((x) => kindOf(x.label) === kind)) }
  }).filter((w) => w.count > 0)
  const waitSum = perMoment(of('trace.project.wait', 'Sum', false))
  const waitN = perMoment(of('trace.project.wait', 'SampleCount', false))
  const waitSeconds = sum([...waitSum.values()])
  const count = sum(waits.map((w) => w.count))
  const wait = count || waitSum.size ? {
    count, median: weightedQuantile(p50.filter((x) => kindOf(x.label) !== null)), slowest: weightedQuantile(p90.filter((x) => kindOf(x.label) !== null)),
    spark: [...waitSum.entries()].map(([t, v]) => (waitN.get(t) ? v / (waitN.get(t) as number) : 0)),
  } : null
  // rework by cause, over the range
  const rws = of('trace.project.rework', 'Sum')
  const rework = REWORK_CAUSES.map((cause) => ({ cause, count: sum(values(rws.filter((s) => wordIn(s.label, REWORK_CAUSES) === cause))) }))
  // trace working: job time against job time plus waits, per moment and over the range
  const jt = perMoment(pick(of('trace.job.duration', 'Sum', false), of('trace.project.job.duration', 'Sum', false)))
  const jobSeconds = sum([...jt.values()])
  const share = (j: number, w: number): number | null => (j + w > 0 ? j / (j + w) : null)
  const allT = [...new Set([...jt.keys(), ...waitSum.keys()])].sort((a, b) => a - b)
  const working = jt.size || waitSum.size ? {
    share: share(jobSeconds, waitSeconds), jobSeconds, waitSeconds,
    spark: allT.map((t) => share(jt.get(t) ?? 0, waitSum.get(t) ?? 0) ?? 0),
  } : null
  // a job's median run time over the range
  const rtAll = withCounts(of('trace.job.duration', undefined, true), 'trace.job.duration', 'p50')
  const rt = rtAll.length ? rtAll : withCounts(of('trace.project.job.duration', undefined, true), 'trace.project.job.duration', 'p50')
  const runTime = rt.length ? { median: weightedQuantile(rt), count: sum(rt.map((x) => x.count)) } : null
  return { builds, jobs, waits, wait, rework, working, runTime }
}

/** A builds pass rate below this is worth a look. */
const BUILDS_WARN_BELOW = 0.8

/** The summary tiles from what the person may see: the Process tab's four first, then the runtime's and trace's own. */
export function tiles(widgets: readonly { series: readonly Series[] }[], access: Access, p?: ProcessView): Record<string, unknown>[] {
  const all = widgets.flatMap((w) => w.series)
  const of = (name: string, label?: RegExp): Series[] => all.filter((s) => s.metric === name && (!label || label.test(s.label)))
  const out: Record<string, unknown>[] = []
  if (p?.builds) {
    const total = p.builds.passed + p.builds.failed
    const rate = total ? p.builds.passed / total : null
    out.push({
      id: 'builds', label: 'Builds passed', value: rate === null ? null : Math.round(rate * 100), unit: '%', detail: { passed: p.builds.passed, failed: p.builds.failed, total },
      spark: p.builds.points.map(([, a, b]) => (a + b ? a / (a + b) : 1)), status: rate !== null && rate < BUILDS_WARN_BELOW ? 'warn' : 'ok',
    })
  }
  if (p?.jobs) {
    const { done, failed, lost, cancelled } = p.jobs
    out.push({
      id: 'jobs', label: 'Agent jobs finished', value: done + failed + lost + cancelled, unit: 'jobs', detail: { done, failed, lost, cancelled },
      spark: p.jobs.points.map(([, ...v]) => sum(v)), status: lost > 0 ? 'warn' : 'ok',
    })
  }
  if (p?.wait) out.push({ id: 'waiting', label: 'Waiting on people', value: p.wait.median, unit: 's', detail: { slowest: p.wait.slowest, count: p.wait.count }, spark: p.wait.spark, status: 'ok' })
  if (p?.working) {
    out.push({
      id: 'working', label: 'Time trace was working', value: p.working.share === null ? null : Math.round(p.working.share * 100), unit: '%',
      detail: { jobSeconds: p.working.jobSeconds, waitSeconds: p.working.waitSeconds }, spark: p.working.spark, status: 'ok',
    })
  }
  const runtime = /_w_/
  const runs = of('Invocations', runtime)
  const errors = [...of('SystemErrors', runtime), ...of('UserErrors', runtime)]
  const total = sum(values(runs))
  const failed = sum(values(errors))
  out.push({ id: 'runs', label: 'Agent runs', value: total, unit: 'runs', detail: total ? { successRate: Math.max(0, 1 - failed / total) } : null, spark: spark(runs), status: total && failed / total > 0.1 ? 'warn' : 'ok' })
  // a job's own run time (seconds), not the runtime's Latency: a worker's invocation is accepted in milliseconds and
  // its job runs on, so the median of Latency read "0 s" for jobs that take minutes
  if (p?.runTime) out.push({ id: 'latency', label: 'Median run time', value: p.runTime.median, unit: 's', spark: [], status: 'ok' })
  // the aggregate where the person sees it (admins), else the per-project series of their projects: never both
  const pick = (aggregate: string, perProject: string): Series[] => { const a = of(aggregate); return a.length ? a : of(perProject) }
  if (!p?.jobs) {
    // a dashboard without its Process rows yet (made before them): the jobs from its other widgets
    const jobs = pick('trace.jobs', 'trace.project.jobs')
    if (jobs.length) out.push({ id: 'jobs', label: 'Agent jobs finished', value: sum(values(jobs)), unit: 'jobs', spark: spark(jobs), status: 'ok' })
  }
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
  const processSeries: Series[] = []
  const notes: string[] = []
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
        queries.push({ ...toMetricDataQuery(qq, range.seconds, w.whole), Id: id })
      }
    }
    const results: MetricDataResult[] = []
    for (let i = 0; i < queries.length; i += 500) results.push(...await cw.getMetricData(queries.slice(i, i + 500), range.start, range.end))
    const byWidget = new Map<number, Series[]>()
    for (const r of results) {
      // what CloudWatch said it left out (a request over its limits, a query it refused): logged, and shown to admins,
      // so an empty chart says why instead of looking like no data
      if (r.StatusCode && r.StatusCode !== 'Complete' || r.Messages?.length) {
        const where = owner.get(r.Id ?? '')?.widget.title ?? (r.Id === MESSAGES_ID ? 'the request' : r.Id ?? '')
        for (const m of r.Messages?.length ? r.Messages : [{ Code: r.StatusCode, Value: '' }]) {
          const note = `${name}: ${where}: ${[m.Code, m.Value].filter(Boolean).join(': ')}`
          if (!notes.includes(note)) notes.push(note)
        }
      }
      const o = owner.get(r.Id ?? '')
      if (!o) continue
      const ts = r.Timestamps ?? []
      const vs = r.Values ?? []
      const points = ts.map((t, i) => [new Date(t).getTime(), vs[i] ?? 0] as [number, number]).sort((a, b) => a[0] - b[0])
      const metric = o.query.metric ?? (o.query.expression ? metricOfExpression(o.query.expression) : null)
      const stat = o.query.expression ? statOfExpression(o.query.expression) ?? o.query.stat : o.query.stat
      const list = byWidget.get(o.widget.index) ?? []
      list.push({ label: r.Label ?? o.query.label ?? metric ?? r.Id ?? '', metric, points, stat, ...(o.widget.whole ? { whole: true } : {}) })
      byWidget.set(o.widget.index, list)
    }
    const out: WidgetOut[] = []
    for (const w of widgets) {
      let series = filterSeries(byWidget.get(w.index) ?? [], w.title, access, c.prefix)
      if (only) series = series.filter((s) => s.repo === only)
      if (!series.length) continue
      // a Process row: its numbers make the Process tab, never a chart of its own (and never counted in two tiles)
      if (w.process) { processSeries.push(...series); continue }
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
  const process = processView(processSeries)
  if (notes.length) deps.log({ warning: 'ops: CloudWatch left data out', notes: notes.slice(0, 20) })
  return {
    status: statusLine(visible, a.hiddenFiring),
    tiles: tiles(shown, access, process),
    alarms: visible,
    sections,
    process,
    ...(access.admin && notes.length ? { notes: notes.slice(0, 20) } : {}),
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
