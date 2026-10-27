/**
 * Operations (docs/ui-design.md, "Operations"): how trace itself is running, drawn from the CloudWatch dashboards the
 * installer creates and filtered by the API to what this person may see (GET /api/ops).
 *
 *   1. the status line, amber or red with the reason when an alarm fires
 *   2. controls: time range, a project filter (the person's projects only), the Wait line for refreshes
 *   3. five summary tiles with sparklines, change and a status word (cloud spend for admins only)
 *   4. alarms, summary first
 *   5. sections as tabs, one per dashboard; tapping a point opens a side sheet for that moment
 *
 * Phone: status and alarms first, tiles two by two, each section's charts scroll sideways one at a time.
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarRange, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react'
import { lazy, Suspense, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable, Highlight } from '@/components/data-table'
import { Column } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { SideSheet } from '@/components/side-sheet'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, Loading, Partial, QueryError } from '@/components/states'
import { Term } from '@/components/term'
import { WaitLine } from '@/components/wait-line'
import { useTraceContext } from '@/components/chat/context'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ApiError, api, projectName } from '@/lib/api'
import type { OpsAlarm, OpsAnswer, OpsWidget } from '@/lib/admin-types'
import { useAuth } from '@/lib/auth'
import { ago, time } from '@/lib/format'
import { q, useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { LEVEL, RANGES, type Range, momentLabel, momentSummary, opsUrl, refreshIn, sectionTitle, stepOf, tileViews, type TileView } from './ops-model'

const OpsChart = lazy(() => import('./ops-chart-impl'))

function useVisible(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener('visibilitychange', cb)
      return () => document.removeEventListener('visibilitychange', cb)
    },
    () => document.visibilityState !== 'hidden',
    () => true,
  )
}

export function Operations({ section }: { section?: string }) {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const navigate = useNavigate()
  const phone = useMediaQuery('(max-width: 767px)')
  const projects = useProjects()
  const [range, setRange] = useState<Range>('24h')
  const [custom, setCustom] = useState<{ start: string; end: string }>(() => {
    const end = new Date()
    const start = new Date(end.getTime() - 3 * 86_400_000)
    const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    return { start: local(start), end: local(end) }
  })
  const [repo, setRepo] = useState<string | null>(null)
  const [moment, setMoment] = useState<{ widget: OpsWidget; t: number } | null>(null)
  const visible = useVisible()
  const step = stepOf(range, range === 'custom' ? custom : undefined)

  const ops = useQuery({
    queryKey: ['ops', range, repo, range === 'custom' ? custom : null],
    queryFn: ({ signal }) => api<OpsAnswer>(opsUrl(range, repo, range === 'custom' ? custom : undefined), { signal }),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    refetchInterval: (query) => refreshIn(query.state.data, Date.now(), document.visibilityState !== 'hidden'),
    refetchIntervalInBackground: true,
  })
  const data = ops.data
  const sections = data?.sections ?? []
  const current = sections.find((s) => s.id === section) ?? sections[0]
  const tiles = useMemo(() => tileViews(data?.tiles ?? [], admin), [data?.tiles, admin])

  useTraceContext(
    {
      label: 'Operations',
      description: 'The screen the person is on: Operations, how trace itself is running (from CloudWatch, filtered by their access)',
      value: { range, project: repo, section: current?.title ?? null, status: data?.status.text ?? null, firing: data?.alarms.filter((a) => a.state === 'ALARM').map((a) => a.name) ?? [] },
    },
    'screen',
  )
  useTraceContext(moment ? { label: `${moment.widget.title} · ${momentLabel(moment.t, step)}`, description: 'The chart point the person opened', value: { widget: moment.widget.title, at: new Date(moment.t).toISOString(), summary: momentSummary(moment.widget, moment.t) } } : null, 'ops-moment')

  useCommands([
    { id: 'ops-refresh', label: 'Refresh Operations now', group: 'Operations', icon: RefreshCw, run: () => void ops.refetch() },
    ...RANGES.filter((r) => r.id !== 'custom').map((r) => ({ id: `ops-range-${r.id}`, label: `Operations: show ${r.words}`, keywords: ['range', 'time'], run: () => setRange(r.id) })),
    ...sections.map((s) => ({ id: `ops-section-${s.id}`, label: `Operations: ${sectionTitle(s.title)}`, keywords: ['dashboard', 'section'], run: () => void navigate({ to: '/ops/$section', params: { section: s.id } }) })),
  ])

  const disabled = ops.error instanceof ApiError && ops.error.status === 404
  const nextAt = data ? new Date(Date.parse(data.updatedAt) + (visible ? Date.parse(data.nextAt) - Date.parse(data.updatedAt) : refreshIn(data, Date.now(), false))).toISOString() : null

  const statusBlock = data && <StatusLine status={data.status} />
  const alarmsBlock = data && <Alarms alarms={data.alarms} admin={admin} />

  return (
    <Column wide>
      <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
      {ops.isError && !data ? (
        <div className="mt-6">
          {disabled ? (
            <EmptyState>Operations is turned off for this installation. An admin can turn it on in the installer's Monitoring settings.</EmptyState>
          ) : (
            <QueryError error={ops.error} what="Operations" onRetry={() => void ops.refetch()} />
          )}
        </div>
      ) : ops.isLoading ? (
        <Loading>
          <Skeleton className="mt-4 h-6 w-2/3" />
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
          </div>
          <Skeleton className="mt-6 h-64 rounded-xl" />
        </Loading>
      ) : data ? (
        <>
          <div className="mt-2">{statusBlock}</div>
          <p className="mt-2 text-sm text-muted-foreground">
            Built from trace's <Term term="CloudWatch" definition="AWS's metrics, logs and alarms service, where trace's dashboards live.">CloudWatch</Term> dashboards, filtered to what you can see.
            {admin ? ' You are an admin, so this shows every project and the cloud spend.' : ' It shows your projects; installation-wide health is summed up in the status line.'}
          </p>
          {phone && <div className="mt-4">{alarmsBlock}</div>}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-lg bg-muted p-[3px]">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={range === r.id}
                  onClick={() => setRange(r.id)}
                  className={cn('rounded-md px-3 py-1 text-sm text-muted-foreground', range === r.id && 'bg-background font-medium text-foreground shadow-sm')}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {range === 'custom' && <CustomRange value={custom} onChange={setCustom} />}
            <div className="flex items-center gap-2">
              <Label htmlFor="ops-project" className="text-sm font-normal text-muted-foreground">Project</Label>
              <Select value={repo ?? 'all'} onValueChange={(v) => setRepo(v === 'all' ? null : v)}>
                <SelectTrigger id="ops-project" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{admin ? 'All projects' : 'All my projects'}</SelectItem>
                  {(projects.data ?? []).map((p) => (
                    <SelectItem key={p.repo} value={p.repo}>{projectName(p.repo)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <WaitLine
            compact
            className="mt-3"
            wait={{ id: 'ops', what: '', text: '', lastCheckedAt: data.updatedAt, nextCheckAt: nextAt, slowed: !visible }}
            words={{ last: 'Updated', next: 'next update', now: 'Refresh now', busy: 'Refreshing' }}
            onCheckNow={() => ops.refetch()}
          />
          {ops.isError && <Partial onRetry={() => void ops.refetch()}>The last refresh failed. Showing what was true at {time(data.updatedAt)}.</Partial>}

          <section aria-label="Summary" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {tiles.map((t) => <Tile key={t.id} tile={t} />)}
          </section>

          {!phone && <div className="mt-6">{alarmsBlock}</div>}

          <Sections
            sections={sections}
            current={current?.id}
            onSection={(id) => void navigate({ to: '/ops/$section', params: { section: id } })}
            step={step}
            phone={phone}
            selected={moment?.t ?? null}
            onPick={(widget, t) => setMoment({ widget, t })}
          />

          <p className="mt-8 rounded-xl bg-muted/60 p-4 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Who sees what: </span>
            admins see everything, cost included; contributors and reviewers see their projects' agent runs, jobs and tool calls (trace's own per-project series), and installation health as a status line, without cost, logs or traces.
          </p>

          <MomentSheet moment={moment} step={step} admin={admin} repos={repo ? [repo] : (projects.data ?? []).map((p) => p.repo)} onClose={() => setMoment(null)} />
        </>
      ) : null}
    </Column>
  )
}

function StatusLine({ status }: { status: OpsAnswer['status'] }) {
  const l = LEVEL[status.level] ?? LEVEL.ok
  return (
    <p
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2 text-[15px]',
        status.level === 'warn' && 'rounded-lg border border-warning/40 bg-warning/10 px-3 py-2',
        status.level === 'alarm' && 'rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2',
      )}
    >
      <StatusBadge status={l.status} label={l.word} />
      <span>{status.text}</span>
    </p>
  )
}

function CustomRange({ value, onChange }: { value: { start: string; end: string }; onChange: (v: { start: string; end: string }) => void }) {
  const [draft, setDraft] = useState(value)
  const bad = !(Date.parse(draft.start) < Date.parse(draft.end))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <CalendarRange /> {new Date(value.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – {new Date(value.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3">
        <div className="space-y-1">
          <Label htmlFor="ops-from">From</Label>
          <Input id="ops-from" type="datetime-local" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ops-to">To</Label>
          <Input id="ops-to" type="datetime-local" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
        </div>
        {bad && <p className="text-xs text-destructive">The start must come before the end.</p>}
        <Button size="sm" disabled={bad} onClick={() => onChange(draft)}>Show this range</Button>
      </PopoverContent>
    </Popover>
  )
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={cn('h-8', className)} aria-hidden />
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ')
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn('h-8 w-full', className)} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Tile({ tile: t }: { tile: TileView }) {
  const l = LEVEL[t.status] ?? LEVEL.ok
  return (
    <article className="flex flex-col rounded-xl border bg-card p-4" data-density-item aria-label={t.label}>
      <p className="text-xs text-muted-foreground">{t.label}</p>
      {t.missing ? (
        <>
          <p className="mt-1 text-2xl font-semibold text-muted-foreground">–</p>
          <p className="mt-2 text-xs text-muted-foreground">{t.missing}</p>
        </>
      ) : (
        <>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {t.value}
            {t.unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{t.unit}</span>}
          </p>
          {t.sub && <p className="mt-0.5 text-xs text-muted-foreground">{t.sub}</p>}
          <Sparkline values={t.spark} className="mt-2 text-muted-foreground" />
          {t.change && <p className="mt-1 text-xs text-muted-foreground">{t.change}</p>}
          <div className="mt-auto pt-2">
            <StatusBadge status={l.status} label={l.word} plain />
          </div>
        </>
      )}
    </article>
  )
}

const ALARM_STATE: Record<string, { status: 'failing' | 'untested' | 'verified'; word: string }> = {
  ALARM: { status: 'failing', word: 'Firing' },
  INSUFFICIENT_DATA: { status: 'untested', word: 'Waiting for data' },
  OK: { status: 'verified', word: 'Cleared' },
}

function Alarms({ alarms, admin }: { alarms: OpsAlarm[]; admin: boolean }) {
  const firing = alarms.filter((a) => a.state === 'ALARM')
  return (
    <section aria-labelledby="ops-alarms" className="rounded-xl border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="ops-alarms" className="text-base font-semibold">Alarms</h2>
        {firing.length ? <StatusBadge status="failing" label={`${firing.length} firing now`} plain /> : <StatusBadge status="verified" label="No alarms firing now" plain />}
        {alarms.length > firing.length && <span className="ml-auto text-xs text-muted-foreground">{alarms.length - firing.length} waiting for data or recently cleared</span>}
      </div>
      {alarms.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing in alarm or waiting for data that you can see.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {alarms.map((a) => {
            const s = ALARM_STATE[a.state] ?? { status: 'untested' as const, word: a.state }
            return (
              <li key={a.name} className={cn('rounded-lg border p-3 text-sm', a.state === 'ALARM' ? 'border-destructive/40 bg-destructive/5' : 'border-warning/40 bg-warning/10')}>
                <div className="flex flex-col items-start gap-2 sm:flex-row">
                  <StatusBadge status={s.status} label={s.word} />
                  <div className="min-w-0 flex-1">
                    <p>
                      {a.summary ?? a.reason ?? a.name}
                      {a.since && <span className="text-muted-foreground"> Since {ago(a.since)}.</span>}
                    </p>
                    {a.todo && (
                      <p className="mt-1">
                        <span className="font-medium">What to do: </span>
                        {a.todo}
                      </p>
                    )}
                    {a.repo && <p className="mt-1 text-xs text-muted-foreground">{projectName(a.repo)}</p>}
                  </div>
                  {admin && (
                    <Button asChild variant="link" size="sm" className="h-auto px-0">
                      <a href="/admin/installation">Installation settings</a>
                    </Button>
                  )}
                </div>
                <Collapsible className="mt-2">
                  <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden /> The alarm's metric and threshold
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    <p>Alarm <span className="font-mono">{a.name}</span></p>
                    {a.metric && <p>Metric <span className="font-mono">{a.metric}</span>{a.threshold !== null && <> · threshold {a.threshold}</>}</p>}
                  </CollapsibleContent>
                </Collapsible>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Sections({
  sections, current, onSection, step, phone, selected, onPick,
}: {
  sections: OpsAnswer['sections']
  current?: string
  onSection: (id: string) => void
  step: number
  phone: boolean
  selected: number | null
  onPick: (w: OpsWidget, t: number) => void
}) {
  if (!sections.length)
    return (
      <EmptyState className="mt-8">
        No charts to show for this range. Either no dashboard is listed for Operations yet (an admin lists them in Admin › Installation), or none of their metrics belong to your projects.
      </EmptyState>
    )
  const sec = sections.find((s) => s.id === current) ?? sections[0]!
  return (
    <section className="mt-8" aria-label="Dashboards">
      <div role="tablist" aria-label="Sections" className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === sec.id}
            onClick={() => onSection(s.id)}
            className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm', s.id === sec.id ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {sectionTitle(s.title)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className={cn('mt-4', phone ? '-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2' : 'grid gap-4 lg:grid-cols-2')}>
        {sec.widgets.map((w) => (
          <article key={w.id} className={cn('rounded-xl border bg-card p-4', phone && 'w-[85vw] shrink-0 snap-center')} aria-label={w.title}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">{w.title}</h3>
                <p className="text-xs text-muted-foreground">{w.unit ? `${w.unit[0]!.toUpperCase()}${w.unit.slice(1)}` : 'Values'}, {w.series.length} series. Tap a point for that moment.</p>
              </div>
              {w.links?.cloudwatch && (
                <a href={w.links.cloudwatch} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline">
                  Open in CloudWatch <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </div>
            {w.series.every((s) => s.points.length === 0) ? (
              <p className="mt-6 text-sm text-muted-foreground">No data in this range.</p>
            ) : (
              <Suspense fallback={<Skeleton className="mt-3 h-56 w-full" />}>
                <div className="mt-3">
                  <OpsChart widget={w} step={step} selected={selected} onPick={(t) => onPick(w, t)} />
                </div>
              </Suspense>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

interface RunRow { id: string; repo: string; project: string; kind: string; result: 'passed' | 'failing' | 'running' | 'warning'; word: string; summary: string }

const runColumns: ColumnDef<RunRow, any>[] = [
  { accessorKey: 'id', header: 'Run', size: 100, meta: { label: 'Run', mono: true }, cell: ({ row }) => <span className="font-mono text-primary"><Highlight text={row.original.id} /></span> },
  { accessorKey: 'project', header: 'Project', size: 130, meta: { label: 'Project', kind: 'enum' } },
  { accessorKey: 'kind', header: 'Kind', size: 120, meta: { label: 'Kind', kind: 'enum' } },
  { accessorKey: 'word', header: 'Result', size: 130, meta: { label: 'Result', kind: 'enum' }, cell: ({ row }) => <StatusBadge status={row.original.result} label={row.original.word} /> },
]

/** The side sheet for one moment: what each series said, the runs from the record that started in it, and links. */
function MomentSheet({ moment, step, admin, repos, onClose }: { moment: { widget: OpsWidget; t: number } | null; step: number; admin: boolean; repos: string[]; onClose: () => void }) {
  const runs = useQueries({ queries: repos.map((repo) => ({ ...q('runs', { repo, limit: 200 }), enabled: !!moment })) })
  const navigate = useNavigate()
  const rows: RunRow[] = moment
    ? runs.flatMap((r, i) =>
        (r.data ?? [])
          .map((x) => x as { id: string; kind: string; subject?: string | null; started: number; status: string; summary?: string | null })
          .filter((x) => x.started * 1000 >= moment.t && x.started * 1000 < moment.t + step)
          .map((x) => ({
            id: x.id, repo: repos[i]!, project: projectName(repos[i]!), kind: x.subject ?? x.kind, summary: x.summary ?? '',
            result: x.status === 'pass' ? 'passed' as const : x.status === 'running' ? 'running' as const : x.status === 'error' ? 'warning' as const : 'failing' as const,
            word: x.status === 'pass' ? 'Succeeded' : x.status === 'running' ? 'Running' : x.status === 'error' ? 'Tool error' : 'Failed',
          })),
      )
    : []
  const failed = runs.filter((r) => r.isError).length
  const loading = runs.some((r) => r.isLoading)
  const links = moment?.widget.links
  return (
    <SideSheet
      open={!!moment}
      onOpenChange={(o) => !o && onClose()}
      title={moment ? `${momentLabel(moment.t, step)} · ${moment.widget.title}` : ''}
      description={moment ? momentSummary(moment.widget, moment.t) : undefined}
    >
      {moment && (
        <div className="space-y-4">
          <h3 className="section-label">Runs that started then</h3>
          {loading ? (
            <Loading><Skeleton className="h-32 w-full" /></Loading>
          ) : (
            <>
              {failed > 0 && <Partial>Runs from {failed} project{failed > 1 ? 's' : ''} could not be loaded.</Partial>}
              <DataTable
                id="ops-moment-runs"
                data={rows}
                columns={runColumns}
                getRowId={(r) => r.id}
                noun="runs"
                persist={false}
                pageSize={20}
                maxHeight="50vh"
                empty="No runs in the record started in this period. The chart may count work trace does not record as a run, such as model calls."
                onRowClick={(r) => void navigate({ to: `/p/${r.repo.replace('/', '~')}/runs/${r.id}` as string })}
              />
            </>
          )}
          {admin && (
            <div className="space-y-1.5 border-t pt-3 text-sm">
              <p className="text-xs text-muted-foreground">For admins</p>
              {links?.logs ? <a className="flex items-center gap-1.5 text-primary hover:underline" href={links.logs} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" /> Logs Insights query for this period</a> : null}
              {links?.traces ? <a className="flex items-center gap-1.5 text-primary hover:underline" href={links.traces} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" /> Traces for these runs</a> : null}
              {links?.cloudwatch ? <a className="flex items-center gap-1.5 text-primary hover:underline" href={links.cloudwatch} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" /> Open in CloudWatch</a> : null}
              {!links?.logs && !links?.traces && !links?.cloudwatch && (
                <p className="text-muted-foreground">The API does not give console links for this chart yet, so there is no Open in CloudWatch here.</p>
              )}
            </div>
          )}
        </div>
      )}
    </SideSheet>
  )
}

