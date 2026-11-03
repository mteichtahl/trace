/**
 * Operations' Process tab (docs/ui-design.md "Operations", Process): how trace and its people work together over the
 * range, for the projects this person may see.
 *
 *   Builds                   trace's own and each project's builds, passed and failed per period (CodeBuild's counts)
 *   Agent jobs by outcome    every job that started, lost ones included (no word for 15 minutes)
 *   Waiting on people        by what waited: count, median and slowest 10 %, from when trace was ready to the act
 *   Rework                   work done twice, by cause
 *   Where the time went      each stage of a project: trace working, and waiting on a person (journey.time)
 *   Waiting now              what waits on this person now, oldest first (the inbox); tapping one opens it
 *
 * The first four come with /api/ops (src/web/ops.ts processView); the stages and what waits now are read from the API
 * as the person (journey.time, inbox), so the same access rules apply. Phone: one column, the tables kept narrow.
 */
import { useNavigate } from '@tanstack/react-router'
import { lazy, Suspense, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/states'
import { projectName } from '@/lib/api'
import type { OpsProcess } from '@/lib/admin-types'
import { useAction, useInbox } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { processCharts, reworkRows, stageBars, timeWords, waitRows } from './ops-model'

const OpsChart = lazy(() => import('./ops-chart-impl'))

function Card({ title, sub, wide, children, label }: { title: string; sub: string; wide?: boolean; children: React.ReactNode; label?: string }) {
  return (
    <article className={cn('min-w-0 rounded-xl border bg-card p-4', wide && 'lg:col-span-2')} aria-label={label ?? title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mb-3 mt-0.5 text-xs text-muted-foreground">{sub}</p>
      {children}
    </article>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

const th = 'whitespace-nowrap border-b px-2 py-1.5 text-left text-xs font-medium text-muted-foreground'
const td = 'border-b px-2 py-2 align-top'
const num = 'whitespace-nowrap text-right tabular-nums'

export function ProcessPanel({ process, step, repo, repos, rangeWords, phone }: {
  process: OpsProcess | undefined
  step: number
  /** the project filter, when one is chosen */
  repo: string | null
  /** the person's projects */
  repos: string[]
  rangeWords: string
  phone: boolean
}) {
  const charts = processCharts(process)
  const waits = waitRows(process)
  const rework = reworkRows(process)
  const b = process?.builds
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card title="Builds" sub="trace's own and each project's, passed and failed">
        {charts.builds ? (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}><OpsChart widget={charts.builds} step={step} height="h-40" /></Suspense>
        ) : <p className="py-6 text-sm text-muted-foreground">No builds in this range.</p>}
        {b && (b.own.passed + b.own.failed > 0 || b.projects.passed + b.projects.failed > 0) && (
          <p className="mt-2 text-xs text-muted-foreground">
            {b.own.passed + b.own.failed > 0 && <>trace's own: {b.own.passed} of {b.own.passed + b.own.failed} passed</>}
            {b.own.passed + b.own.failed > 0 && b.projects.passed + b.projects.failed > 0 && ' · '}
            {b.projects.passed + b.projects.failed > 0 && <>projects: {b.projects.passed} of {b.projects.passed + b.projects.failed} passed</>}
          </p>
        )}
      </Card>
      <Card title="Agent jobs by outcome" sub="every job that started, including those that went silent">
        {charts.jobs ? (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}><OpsChart widget={charts.jobs} step={step} height="h-40" /></Suspense>
        ) : <p className="py-6 text-sm text-muted-foreground">No jobs finished in this range.</p>}
      </Card>
      <Card title="Waiting on people, by what waited" sub={`from when trace was ready to when a person acted · ${rangeWords}`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr><th className={th}>What waited</th><th className={cn(th, num)}>Count</th><th className={cn(th, num)}>Median</th><th className={cn(th, num)}>Slowest 10 %</th></tr>
          </thead>
          <tbody>
            {waits.map((w) => (
              <tr key={w.kind}>
                <td className={td}>{w.what}</td>
                <td className={cn(td, num)}>{w.count}</td>
                <td className={cn(td, num)}>{w.median}</td>
                <td className={cn(td, num, w.slow && 'text-destructive')}>{w.slowest}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Rework" sub={`work done twice, by cause · ${rangeWords}`}>
        <table className="w-full border-collapse text-sm">
          <thead><tr><th className={th}>Cause</th><th className={cn(th, num)}>Count</th></tr></thead>
          <tbody>
            {rework.map((r) => (
              <tr key={r.cause}><td className={td}>{r.what}</td><td className={cn(td, num)}>{r.count}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
      <StageTimes repos={repo ? [repo] : repos} phone={phone} />
      <WaitingNow repo={repo} />
    </div>
  )
}

/** Where one project's time went, by stage (journey.time): the filter's project, else one the person picks here. */
function StageTimes({ repos, phone }: { repos: string[]; phone: boolean }) {
  const [picked, setPicked] = useState<string | null>(null)
  const repo = picked && repos.includes(picked) ? picked : repos[0] ?? null
  const read = useAction('journey.time', { repo: repo ?? '' }, { enabled: Boolean(repo) })
  const data = read.data
  const name = data?.project ?? (repo ? projectName(repo) : '')
  return (
    <Card wide title="Where the time went, by stage" sub={`${name ? `${name} · ` : ''}trace working, and waiting on a person, in each stage`}>
      {repos.length > 1 && (
        <div className="mb-3 flex items-center gap-2">
          <Label htmlFor="ops-stage-project" className="text-xs font-normal text-muted-foreground">Project</Label>
          <Select value={repo ?? ''} onValueChange={setPicked}>
            <SelectTrigger id="ops-stage-project" size="sm" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>{repos.map((r) => <SelectItem key={r} value={r}>{projectName(r)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      )}
      {!repo ? <p className="py-4 text-sm text-muted-foreground">You have no projects yet.</p> : read.isLoading ? <Skeleton className="h-40 w-full" /> : !data?.started || !data.stages.length ? (
        <p className="py-4 text-sm text-muted-foreground">{name || 'This project'} has not started its journey yet.</p>
      ) : stageBars(data.stages).map((s) => (
        <div key={s.id} className={cn('my-1.5 grid items-center gap-2.5 text-[13px]', phone ? 'grid-cols-[70px_1fr_48px]' : 'grid-cols-[110px_1fr_72px]')}>
          <span className="truncate">{s.name}</span>
          <div className="h-3.5 min-w-0">
            <div className="flex h-full overflow-hidden rounded" style={{ width: `${Math.max(s.width, 1)}%` }} role="img" aria-label={`${s.name}: ${s.hours}, ${Math.round(s.waiting)} % of it waiting on a person`}>
              <span className="block h-full bg-primary" style={{ width: `${s.working}%` }} />
              <span className="block h-full bg-warning" style={{ width: `${s.waiting}%` }} />
            </div>
          </div>
          <span className="text-right tabular-nums text-muted-foreground">{s.hours}</span>
        </div>
      ))}
      <Legend items={[{ label: 'trace working', color: 'var(--primary)' }, { label: 'Waiting on a person', color: 'var(--warning)' }]} />
    </Card>
  )
}

/** What waits on a person here: open questions, changes ready to accept, gates ready to sign (not spend or stuck agents). */
const WAITING_KINDS = new Set(['question', 'review', 'gate'])

/** What waits on this person now, oldest first (the inbox, with its access rules): tapping one opens it. */
function WaitingNow({ repo }: { repo: string | null }) {
  const inbox = useInbox()
  const navigate = useNavigate()
  const items = (inbox.data ?? []).filter((i) => WAITING_KINDS.has(i.kind) && (!repo || i.repo === repo)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const open = (to?: string, href?: string) => { if (to) void navigate({ to: to as string }); else if (href) window.open(href, '_blank', 'noopener') }
  return (
    <Card wide title="Waiting now, oldest first" sub="tap one to open it">
      {inbox.isLoading ? <Skeleton className="h-24 w-full" /> : !items.length ? (
        <EmptyState className="py-4">Nothing waits on you now.</EmptyState>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr><th className={th}>Project</th><th className={th}>What</th><th className={th}>Waiting on</th><th className={cn(th, num)}>For</th></tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const for_ = timeWords((Date.now() - Date.parse(i.createdAt)) / 1000)
              const old = Date.now() - Date.parse(i.createdAt) > 30 * 60_000
              return (
                <tr
                  key={i.id}
                  tabIndex={0}
                  role="link"
                  className="cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  onClick={() => open(i.action.to, i.action.href)}
                  onKeyDown={(e) => { if (e.key === 'Enter') open(i.action.to, i.action.href) }}
                >
                  <td className={td}>{i.project.replace(/^.*\//, '')}</td>
                  <td className={td}>{i.summary.replace(/^[^:]+:\s*/, '').replace(/\*\*/g, '')}</td>
                  <td className={td}>You</td>
                  <td className={cn(td, num, old && 'text-warning')}>{for_}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}
