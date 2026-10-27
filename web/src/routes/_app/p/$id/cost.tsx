/**
 * Cost and time (/p/:id/cost, admins): spent, committed and forecast cost against the budget, the stage timeline
 * (days and cloud use per stage, forecasts for what is queued), and the spend lines as a Data table. The chart is
 * Recharts, loaded lazily. Data: cost.get, which needs building; the tab says so without it.
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
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, NotShared, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, money } from '@/lib/format'
import { useAction } from '@/lib/queries'
import type { CostView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const StageChart = lazy(() => import('@/components/project/stage-chart'))

export const Route = createFileRoute('/_app/p/$id/cost')({
  staticData: { crumb: 'Cost and time' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Cost,
})

type Line = CostView['lines'][number]
const KIND: Record<Line['kind'], string> = { agents: 'Agents', gpu: 'Graphics card', cpu: 'CPU job', order: 'Order' }

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
        <NeedsBuilding>Spent, committed and forecast cost and the stage timeline come from cost.get, which the API does not have yet.</NeedsBuilding>
      </div>
    )
  if (!c.data) return <TabSkeleton loading={c.isLoading} />
  const d = c.data
  const spent = d.spent.cloud + d.spent.orders
  const total = spent + d.committed + d.forecast
  const columns: ColumnDef<Line, any>[] = [
    { accessorKey: 'what', header: 'What', size: 340, meta: { label: 'What', kind: 'text' }, cell: ({ row }) => <Highlight text={row.original.what} /> },
    { id: 'kind', accessorFn: (l) => KIND[l.kind], header: 'Kind', size: 140, meta: { label: 'Kind', kind: 'enum' } },
    { accessorKey: 'amount', header: 'Cost', size: 100, meta: { label: 'Cost', kind: 'number', align: 'right' }, cell: ({ row }) => money(row.original.amount, d.currency) },
    { id: 'at', accessorFn: (l) => l.at, header: 'When', size: 120, meta: { label: 'When', kind: 'date' }, cell: ({ row }) => ago(row.original.at) },
  ]
  return (
    <div className="pb-12">
      <p className="mt-6 text-[15px]">
        <span className="font-semibold">{money(spent, d.currency)} spent so far,</span> {money(d.committed, d.currency)} committed and {money(d.forecast, d.currency)} forecast to release.
        {d.budget !== undefined && <> Budget {money(d.budget, d.currency)}: {total <= d.budget ? 'within budget.' : 'over budget.'}</>}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Cloud use to date" value={money(d.spent.cloud, d.currency)} />
        <Tile label="Orders paid" value={money(d.spent.orders, d.currency)} />
        <Tile label="Committed" value={money(d.committed, d.currency)} hint="Orders ready to place" />
        <Tile label="Forecast to release" value={money(d.forecast, d.currency)} hint="From the running view" />
      </div>
      {d.budget !== undefined && (
        <div className="mt-4 rounded-xl border p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>Against the budget of {money(d.budget, d.currency)}</span>
            <StatusBadge status={total <= d.budget ? 'met' : 'failing'} label={total <= d.budget ? `${money(d.budget - total, d.currency)} to spare` : `${money(total - d.budget, d.currency)} over`} />
          </div>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Spent ${money(spent, d.currency)}, committed ${money(d.committed, d.currency)}, forecast ${money(d.forecast, d.currency)} of ${money(d.budget, d.currency)}`}>
            <div className="bg-foreground/80" style={{ width: `${(spent / d.budget) * 100}%` }} />
            <div className="bg-foreground/45" style={{ width: `${(d.committed / d.budget) * 100}%` }} />
            <div className="bg-foreground/20" style={{ width: `${(d.forecast / d.budget) * 100}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-foreground/80" />Spent</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-foreground/45" />Committed</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-foreground/20" />Forecast</span>
          </div>
        </div>
      )}

      <Section label="Stage timeline" className="mt-10">
        <div className="rounded-xl border p-5">
          <Suspense fallback={<Skeleton className="h-56" />}><StageChart stages={d.stages} currency={d.currency} /></Suspense>
          <table className="sr-only">
            <caption>Days and cloud use per stage</caption>
            <tbody>{d.stages.map((s) => <tr key={s.stage}><td>{s.stage}</td><td>{s.days} days</td><td>{money(s.cloud, d.currency)}</td></tr>)}</tbody>
          </table>
          <ol className="mt-4 flex flex-wrap gap-2 text-xs">
            {d.stages.map((s) => (
              <li key={s.stage} className={cn('rounded-md border px-2.5 py-1.5', s.state === 'current' && 'border-primary text-primary')}>
                <span className="font-medium">{s.stage}</span> · {s.state === 'queued' ? `forecast ${s.forecastDays ?? '?'} days` : `${s.days} days${s.forecastDays && s.state === 'current' ? ` of about ${s.forecastDays}` : ''}`} · {money(s.cloud, d.currency)}
              </li>
            ))}
          </ol>
        </div>
      </Section>

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
