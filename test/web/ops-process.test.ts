/**
 * Operations' Process tab (src/web/ops.ts processView, the dashboard's Process rows from src/infra/observability.ts):
 * builds from CodeBuild's own counts split by source (trace's own runners admins only), jobs by outcome with the lost
 * ones, waits on people by kind, rework by cause, the time trace was working and a job's own median run time, all
 * filtered by the person's access exactly like the charts, and never shown as charts of their own.
 */
import { describe, expect, it } from 'vitest'
import type { MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch'
import { dashboardBody } from '../../src/infra/observability.js'
import { projectHash } from '../../src/core/project.js'
import { PROCESS_TITLE } from '../../src/core/telemetry.js'
import { parseDashboard, processView, toMetricDataQuery, weightedQuantile, wholePeriod } from '../../src/web/ops.js'
import { accessToken } from '../api/fixtures.js'
import { NOW, bearerOf, world } from './fakes.js'

const A = 'acme/board'
const C = 'other/secret'
const ha = projectHash(A)
const hc = projectHash(C)
/** trace's own repository: a build-only runner (ciRepositories), no project of anyone's */
const hown = projectHash('mteichtahl/trace')
const DAY = 86_400

const body = JSON.stringify(dashboardBody({ region: 'us-east-1', prefix: 'trace', runtimes: [`trace_w_${ha}`, `trace_w_${hc}`, 'trace_api'], gpu: false }))

type Row = [label: string, values: number[]]
/** The Process rows' series by metric, statistic and whether the query is over the whole range. */
const SERIES: Record<string, Row[]> = {
  'SucceededBuilds|Sum': [[`trace-ci-${ha}`, [3, 2]], [`trace-ci-${hc}`, [1, 1]], [`trace-ci-${hown}`, [4, 4]]],
  'FailedBuilds|Sum': [[`trace-ci-${ha}`, [0, 1]], [`trace-ci-${hown}`, [1, 0]]],
  'trace.jobs|Sum': [['task verify ok', [5, 5]], ['task verify lost', [1, 0]]],
  'trace.project.jobs|Sum': [[`project-${ha} ok`, [2, 2]], [`project-${ha} lost`, [1, 0]], [`project-${hc} ok`, [3, 3]]],
  'trace.project.wait|Sum': [[`project-${ha} question`, [600, 1200]]],
  'trace.project.wait|SampleCount': [[`project-${ha} question`, [1, 2]]],
  'trace.project.wait|p50|whole': [[`project-${ha} question`, [780]], [`project-${ha} gate`, [60]], [`project-${hc} change`, [300]]],
  'trace.project.wait|p90|whole': [[`project-${ha} question`, [1500]], [`project-${ha} gate`, [17_640]], [`project-${hc} change`, [400]]],
  'trace.project.wait|SampleCount|whole': [[`project-${ha} question`, [3]], [`project-${ha} gate`, [1]], [`project-${hc} change`, [5]]],
  'trace.project.rework|Sum|whole': [[`project-${ha} sent_back`, [2]], [`project-${hc} asked_again`, [1]]],
  'trace.job.duration|Sum': [['task verify ok', [1800, 1800]]],
  'trace.project.job.duration|Sum': [[`project-${ha} ok`, [900, 900]], [`project-${hc} ok`, [60, 60]]],
  'trace.job.duration|p50|whole': [['task verify ok', [400]]],
  'trace.job.duration|SampleCount|whole': [['task verify ok', [10]]],
  'trace.project.job.duration|p50|whole': [[`project-${ha} ok`, [300]]],
  'trace.project.job.duration|SampleCount|whole': [[`project-${ha} ok`, [4]]],
}

function data(q: MetricDataQuery): MetricDataResult[] {
  const e = q.Expression ?? ''
  const metric = /MetricName="([^"]+)"/.exec(e)?.[1]
  const stat = /'([^']+)', \d+\)$/.exec(e)?.[1]
  const whole = q.Period === DAY
  // only the Process rows answer (the other widgets have their own tests): the same metric elsewhere is empty
  if (!/"trace-ci"|"trace.outcome"|"trace.project"|"trace.wait.kind"|"trace.rework.cause"/.test(e)) return []
  const rows = SERIES[`${metric}|${stat}${whole ? '|whole' : ''}`] ?? []
  const t = whole ? [new Date(NOW - DAY * 1000)] : [new Date(NOW - 600_000), new Date(NOW - 300_000)]
  return rows.map(([label, values]) => ({ Id: q.Id, Label: label, Timestamps: t, Values: values }))
}

function opsWorld(cls: 'admin' | 'user', projects: { repo: string; part?: string }[]) {
  const w = world()
  w.cw.dashboards.set('trace-agents', body)
  w.cw.data = data
  w.runtime.answers.set('whoami', () => ({ body: { ok: true, result: { sub: 's', class: cls } } }))
  w.runtime.answers.set('projects', () => ({ body: { ok: true, result: projects } }))
  const get = async (q = 'range=24h') => (await w.serve({ method: 'GET', path: '/api/ops', query: new URLSearchParams(q), headers: bearerOf(accessToken('s', cls === 'admin' ? ['trace-admins'] : ['trace-users'])) })).json() as Ops
  return { get }
}

type Tile = { id: string; value: number | null; unit: string; detail?: Record<string, number | null>; status: string }
type Ops = {
  tiles: Tile[]
  sections: { widgets: { title: string }[] }[]
  process: ReturnType<typeof processView>
}
const tile = (o: Ops, id: string): Tile | undefined => o.tiles.find((t) => t.id === id)

describe('the dashboard\'s Process rows', () => {
  it('are read whole-range where CloudWatch draws one value per series, and are never charts of their own', () => {
    const ws = parseDashboard(body).filter((w) => w.process)
    expect(ws.map((w) => w.title)).toEqual([
      'Builds passed and failed', 'Agent jobs by outcome', 'Agent job time', 'Waiting on people', 'Waiting on people over the range', 'Rework over the range', 'Agent run time over the range',
    ].map((t) => `${PROCESS_TITLE}${t}`))
    expect(ws.filter((w) => w.whole).map((w) => w.title.slice(PROCESS_TITLE.length))).toEqual(['Waiting on people over the range', 'Rework over the range', 'Agent run time over the range'])
    const wait = ws.find((w) => w.title.endsWith('over the range'))!
    const q = toMetricDataQuery(wait.queries[0]!, 7 * DAY, true)
    expect(q.Period).toBe(7 * DAY)
    expect(q.Expression).toMatch(/'p50', 604800\)$/)
    expect(wholePeriod(90)).toBe(120)
    // builds: CodeBuild's per-runner series of this installation's runners only
    expect(ws[0]!.queries.map((x) => x.expression)).toEqual([
      'SEARCH(\'{AWS/CodeBuild,ProjectName} MetricName="SucceededBuilds" "trace-ci"\', \'Sum\', 300)',
      'SEARCH(\'{AWS/CodeBuild,ProjectName} MetricName="FailedBuilds" "trace-ci"\', \'Sum\', 300)',
    ])
  })
})

describe('the Process tab and its tiles', () => {
  it('a contributor: their project\'s builds, jobs (lost counted), waits, rework and working time, nothing of others or trace\'s own', async () => {
    const o = await opsWorld('user', [{ repo: A, part: 'contributor' }]).get()
    expect(o.sections.flatMap((s) => s.widgets.map((w) => w.title)).some((t) => t.startsWith(PROCESS_TITLE))).toBe(false)
    const p = o.process
    expect(p.builds).toMatchObject({ passed: 5, failed: 1, own: { passed: 0, failed: 0 }, projects: { passed: 5, failed: 1 } })
    expect(p.builds?.points.map(([, a, b]) => [a, b])).toEqual([[3, 0], [2, 1]])
    expect(p.jobs).toMatchObject({ done: 4, failed: 0, lost: 1, cancelled: 0 })
    expect(p.waits).toEqual([{ kind: 'question', count: 3, median: 780, slowest: 1500 }, { kind: 'gate', count: 1, median: 60, slowest: 17_640 }])
    expect(p.wait).toMatchObject({ count: 4, median: 780, spark: [600, 600] })
    expect(p.rework).toEqual([{ cause: 'job_restarted', count: 0 }, { cause: 'conflict_resolved', count: 0 }, { cause: 'sent_back', count: 2 }, { cause: 'asked_again', count: 0 }])
    expect(p.working).toMatchObject({ jobSeconds: 1800, waitSeconds: 1800, share: 0.5 })
    expect(tile(o, 'builds')).toMatchObject({ value: 83, unit: '%', detail: { passed: 5, failed: 1, total: 6 }, status: 'ok' })
    expect(tile(o, 'jobs')).toMatchObject({ value: 5, detail: { done: 4, failed: 0, lost: 1, cancelled: 0 }, status: 'warn' })
    expect(tile(o, 'waiting')).toMatchObject({ value: 780, unit: 's', detail: { slowest: 1500, count: 4 } })
    expect(tile(o, 'working')).toMatchObject({ value: 50, unit: '%' })
    // a job's own run time in seconds, not the runtime's invocation latency (which read 0 s)
    expect(tile(o, 'latency')).toMatchObject({ value: 300, unit: 's' })
    expect(o.tiles.map((t) => t.id).slice(0, 4)).toEqual(['builds', 'jobs', 'waiting', 'working'])
  })

  it('an admin: every runner, trace\'s own apart; the aggregate jobs and run time, never added to the per-project ones', async () => {
    const o = await opsWorld('admin', [{ repo: A }, { repo: C }]).get()
    expect(o.process.builds).toMatchObject({ passed: 15, failed: 2, own: { passed: 8, failed: 1 }, projects: { passed: 7, failed: 1 } })
    expect(o.process.jobs).toMatchObject({ done: 10, lost: 1 })
    expect(o.process.waits.map((w) => w.kind)).toEqual(['question', 'change', 'gate'])
    expect(o.process.rework.find((r) => r.cause === 'asked_again')?.count).toBe(1)
    expect(o.process.working).toMatchObject({ jobSeconds: 3600 })
    expect(tile(o, 'latency')).toMatchObject({ value: 400, unit: 's' })
    // the project filter: that project's series alone, the per-project ones standing in for the aggregate
    const only = await opsWorld('admin', [{ repo: A }, { repo: C }]).get(`range=24h&repo=${encodeURIComponent(C)}`)
    expect(only.process.builds).toMatchObject({ passed: 2, failed: 0, own: { passed: 0, failed: 0 } })
    expect(only.process.jobs).toMatchObject({ done: 6, lost: 0 })
    expect(tile(only, 'jobs')?.status).toBe('ok')
  })

  it('says what CloudWatch left out, to admins only, instead of an empty chart that looks like no data', async () => {
    const w = world()
    w.cw.dashboards.set('trace-agents', body)
    w.cw.data = (q) => q.Id?.startsWith('w1_') ? [{ Id: q.Id, Label: 'x', StatusCode: 'PartialData', Messages: [{ Code: 'MaxQueryTimeSeriesLimit', Value: 'Too many series' }], Timestamps: [], Values: [] }] : []
    for (const cls of ['admin', 'user'] as const) {
      w.runtime.answers.set('whoami', () => ({ body: { ok: true, result: { sub: 's', class: cls } } }))
      w.runtime.answers.set('projects', () => ({ body: { ok: true, result: [{ repo: A }] } }))
      const o = (await w.serve({ method: 'GET', path: '/api/ops', query: new URLSearchParams('range=24h'), headers: bearerOf(accessToken('s', cls === 'admin' ? ['trace-admins'] : ['trace-users'])) })).json() as { notes?: string[] }
      if (cls === 'admin') expect(o.notes?.[0]).toMatch(/^trace-agents: .+: MaxQueryTimeSeriesLimit: Too many series$/)
      else expect(o.notes).toBeUndefined()
    }
  })

  it('without the Process rows (a dashboard made before them): no Process, and the old jobs tile from the other widgets', () => {
    const p = processView([])
    expect(p).toEqual({ builds: null, jobs: null, waits: [], wait: null, rework: [{ cause: 'job_restarted', count: 0 }, { cause: 'conflict_resolved', count: 0 }, { cause: 'sent_back', count: 0 }, { cause: 'asked_again', count: 0 }], working: null, runTime: null })
  })

  it('medians of several series are weighted by their counts', () => {
    expect(weightedQuantile([{ value: 60, count: 1 }, { value: 780, count: 3 }])).toBe(780)
    expect(weightedQuantile([{ value: 60, count: 3 }, { value: 780, count: 1 }])).toBe(60)
    expect(weightedQuantile([{ value: 60, count: 9 }, { value: 900, count: 1 }], 0.95)).toBe(900)
    expect(weightedQuantile([])).toBeNull()
  })
})
