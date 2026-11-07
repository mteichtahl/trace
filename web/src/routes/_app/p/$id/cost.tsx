/**
 * Cost and time (/p/:id/cost, admins): spent, committed and forecast cost against the project's two budgets (the build
 * budget for the order, the cloud-work allowance for trace's own work: budgets.tsx), the stage timeline
 * (days and cloud use per stage, forecasts for what is queued), spend by job grouped by stage with work done again
 * marked (and the warning when the current stage nears its share of the cloud-work allowance), and the spend lines as a Data table. The chart is
 * Recharts, loaded lazily. Data: cost.get, from the cost ledger: cloud use is an estimate (each run's tokens and each
 * job's running time, priced from a dated table), with what AWS billed beside it from Cost Explorer, a day behind,
 * and when it reads next. What the record does not hold (forecast days) is null and shown as "not recorded", with the
 * API's notes saying why.
 */
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { Skeleton } from '@/components/ui/skeleton'
import { useTraceContext } from '@/components/chat/context'
import { DataTable, Highlight } from '@/components/data-table'
import { NeedsBuilding, TabSkeleton, notBuilt } from '@/components/project/shared'
import { Section } from '@/components/shell/app-shell'
import { EmptyState, NotShared, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, money } from '@/lib/format'
import { useAction } from '@/lib/queries'
import type { CostView } from '@/lib/types-s1'
import { CloudBreakdown } from '@/components/project/cloud-cost'
import { SpendByJob, SpendWarningCard } from '@/components/project/spend-by-job'
import { Budgets } from '@/components/project/budgets'
import { forecastSource } from '@/components/project/gate-spend'
import { cn } from '@/lib/utils'

const StageChart = lazy(() => import('@/components/project/stage-chart'))

export const Route = createFileRoute('/_app/p/$id/cost')({
  staticData: { crumb: 'Cost and time' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Cost,
})

type Line = CostView['lines'][number]
const KIND: Record<Line['kind'], string> = { agents: 'Agents', gpu: 'Graphics card', cpu: 'CPU job', tools: 'Tools function', order: 'Order' }

function Cost() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const c = useAction('cost.get', { repo }, { enabled: admin })
  useTraceContext({ label: 'Cost and time', description: 'The project tab on screen', value: { tab: 'cost' } }, 'screen')
  if (!admin) return <NotShared />
  if (c.isError && !notBuilt(c.error) && !/no record/.test(String(c.error))) return <div className="mt-6"><QueryError error={c.error} what="cost and time" onRetry={() => void c.refetch()} /></div>
  if (c.isError)
    return (
      <div className="mt-6 space-y-3">
        <EmptyState>No cost recorded for this project yet. Cloud use and orders collect here as work runs.</EmptyState>
        <NeedsBuilding>Spent, committed and forecast cost and the stage timeline come from cost.get, which could not be read.</NeedsBuilding>
      </div>
    )
  if (!c.data) return <TabSkeleton loading={c.isLoading} />
  const d = c.data
  /** a sum or an amount the record may not hold: "not recorded" */
  const m = (v: number | null | undefined) => (v === null || v === undefined ? 'not recorded' : money(v, d.currency))
  const columns: ColumnDef<Line, any>[] = [
    { accessorKey: 'what', header: 'What', size: 340, meta: { label: 'What', kind: 'text' }, cell: ({ row }) => <Highlight text={row.original.what} /> },
    { id: 'kind', accessorFn: (l) => KIND[l.kind], header: 'Kind', size: 140, meta: { label: 'Kind', kind: 'enum' } },
    { accessorKey: 'amount', header: 'Cost', size: 120, meta: { label: 'Cost', kind: 'number', align: 'right' }, cell: ({ row }) => <span>{money(row.original.amount, d.currency)}{row.original.estimate ? <span className="ml-1 text-xs text-muted-foreground">estimate</span> : null}</span> },
    { id: 'at', accessorFn: (l) => l.at, header: 'When', size: 120, meta: { label: 'When', kind: 'date' }, cell: ({ row }) => ago(row.original.at) },
  ]
  return (
    <div className="pb-12">
      <p className="mt-6 text-[15px]">
        <span className="font-semibold">{m(d.spent.cloud)} of cloud work so far{d.spent.detail ? ' (estimated)' : ''}.</span> The order: {m(d.spent.orders)} paid, {m(d.committed)} committed and {m(d.forecast)} forecast. Each counts against its own budget.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Cloud work to date" value={m(d.spent.cloud)} hint={d.spent.detail ? (d.spent.detail.actual ? `Estimate · ${money(d.spent.detail.actual.total, d.currency)} billed by AWS` : 'Estimate · AWS has billed nothing tagged yet') : undefined} />
        <Tile label="Orders paid" value={m(d.spent.orders)} />
        <Tile label="Committed" value={m(d.committed)} hint="Orders placed, not paid yet" />
        <Tile label="Forecast for the order" value={m(d.forecast)} hint={forecastSource(d, d.orderCurrency ?? d.currency) ?? 'Boards × the target unit cost'} />
      </div>
      {d.warning && <SpendWarningCard warning={d.warning} currency={d.currency} id={id} link={false} className="mt-4" />}
      <Budgets cost={d} id={id} className="mt-4" />

      {d.spent.detail && <CloudBreakdown detail={d.spent.detail} currency={d.currency} explorer={d.explorer} prices={d.prices} />}

      <Section label="Stage timeline" className="mt-10">
        <div className="rounded-xl border p-5">
          <Suspense fallback={<Skeleton className="h-56" />}><StageChart stages={d.stages} currency={d.currency} /></Suspense>
          <table className="sr-only">
            <caption>Days and cloud use per stage</caption>
            <tbody>{d.stages.map((s) => <tr key={s.stage}><td>{s.stage}</td><td>{s.days} days</td><td>{m(s.cloud)}</td></tr>)}</tbody>
          </table>
          <ol className="mt-4 flex flex-wrap gap-2 text-xs">
            {d.stages.map((s) => (
              <li key={s.stage} className={cn('rounded-md border px-2.5 py-1.5', s.state === 'current' && 'border-primary text-primary')}>
                <span className="font-medium">{s.stage}</span> · {s.state === 'queued' ? (s.forecastDays ? `forecast ${s.forecastDays} days` : 'not started') : `${s.days} days${s.forecastDays && s.state === 'current' ? ` of about ${s.forecastDays}` : ''}`}{s.cloud !== null ? ` · ${money(s.cloud, d.currency)}` : ''}
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {d.jobs && d.jobs.jobs.length > 0 && (
        <Section label="Spend by job" count={d.jobs.jobs.filter((j) => j.id !== null).length} className="mt-10">
          <SpendByJob spend={d.jobs} currency={d.currency} />
        </Section>
      )}

      {d.notes?.length ? <div className="mt-6 space-y-1">{d.notes.map((n) => <NeedsBuilding key={n}>{n}</NeedsBuilding>)}</div> : null}

      <Section label="Spend" count={d.lines.length}>
        <DataTable id="cost-lines" data={d.lines} columns={columns} getRowId={(l) => l.id} noun="lines" defaultView={{ sorting: [{ id: 'at', desc: true }] }} />
      </Section>
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
