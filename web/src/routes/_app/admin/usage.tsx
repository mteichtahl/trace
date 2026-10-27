/**
 * Admin › Usage and cost (docs/ui-design.md, "Admin"): spend across projects for the month, by project, against
 * budgets. Data: usage.month (admins only): each project's estimated cloud use from the cost ledger (agents, graphics
 * card and CPU jobs, priced from the dated price table), what AWS billed with its tag (Cost Explorer, a day behind),
 * the orders paid this month, and the budget; and the installation's spend no project tag covers.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Column, Section } from '@/components/shell/app-shell'
import { EmptyState, NotShared, QueryError } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTraceContext } from '@/components/chat/context'
import { explorerLine } from '@/components/project/cloud-cost'
import { projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { money } from '@/lib/format'
import { useAction } from '@/lib/queries'

export const Route = createFileRoute('/_app/admin/usage')({
  staticData: { crumb: 'Usage and cost' },
  component: Usage,
})

const monthOf = (d: Date): string => d.toISOString().slice(0, 7)
const shift = (m: string, by: number): string => { const [y, mo] = m.split('-').map(Number) as [number, number]; return monthOf(new Date(Date.UTC(y, mo - 1 + by, 1))) }
const monthName = (m: string): string => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })

function Usage() {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const [month, setMonth] = useState(monthOf(new Date()))
  const u = useAction('usage.month', { month }, { enabled: admin })
  useTraceContext({ label: 'Usage and cost', description: 'The screen the person is on: Admin, usage and cost across projects for a month', value: u.data ? { month, totals: u.data.totals } : { month } }, 'screen')
  if (!admin) return <Column><NotShared /></Column>
  const d = u.data
  const ex = explorerLine(d?.explorer)
  return (
    <Column>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usage and cost</h1>
          <p className="mt-1 text-[15px] text-muted-foreground">Spend across projects for {monthName(month)}: cloud use and recorded orders, by project, against each budget.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setMonth(shift(month, -1))}>Previous month</Button>
          <Button variant="outline" size="sm" disabled={month >= monthOf(new Date())} onClick={() => setMonth(shift(month, 1))}>Next month</Button>
        </div>
      </div>
      {u.isError && <div className="mt-6"><QueryError error={u.error} what="usage and cost" onRetry={() => void u.refetch()} /></div>}
      {!d && !u.isError && <Skeleton className="mt-8 h-64 rounded-xl" />}
      {d && (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Tile label="Cloud use, estimated" value={money(d.totals.estimated, d.currency)} hint="Each run and job, priced from the price table" />
            <Tile label="Billed by AWS" value={d.totals.actual === null ? 'not yet' : money(d.totals.actual, d.currency)} hint="Cost Explorer, about a day behind" />
            <Tile label="Orders paid" value={money(d.totals.orders, d.currency)} hint="Recorded with each order" />
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge plain status={ex.status} label={ex.label} /> <span>{d.explorer.text}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{d.prices.text}{d.prices.stale ? ' The table is more than six months old.' : ''}</p>
          <Section label="Projects" count={d.projects.length} className="mt-8">
            {d.projects.length === 0 ? (
              <EmptyState>No projects yet.</EmptyState>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b"><th className="px-4 py-2.5 font-medium">Project</th><th className="px-4 py-2.5 text-right font-medium">Cloud, estimated</th><th className="px-4 py-2.5 text-right font-medium">Billed by AWS</th><th className="px-4 py-2.5 text-right font-medium">Orders</th><th className="px-4 py-2.5 font-medium">Budget</th><th className="sr-only">Open</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {d.projects.map((p) => {
                      const spent = p.estimated.total + p.orders
                      return (
                        <tr key={p.repo}>
                          <td className="px-4 py-3 font-medium">{projectName(p.repo)}</td>
                          <td className="px-4 py-3 text-right" title={`Agents ${money(p.estimated.agents, d.currency)}, graphics card ${money(p.estimated.gpu, d.currency)}, CPU ${money(p.estimated.cpu, d.currency)}`}>{money(p.estimated.total, d.currency)}</td>
                          <td className="px-4 py-3 text-right">{p.actual === null ? <span className="text-muted-foreground">not yet</span> : money(p.actual, d.currency)}</td>
                          <td className="px-4 py-3 text-right">{money(p.orders, p.orderCurrency)}</td>
                          <td className="px-4 py-3">{p.budget === null ? <span className="text-muted-foreground">No budget set</span> : <StatusBadge plain status={spent <= p.budget ? 'met' : 'failing'} label={`${money(spent, d.currency)} of ${money(p.budget, p.orderCurrency)}`} />}</td>
                          <td className="px-4 py-3 text-right"><Button asChild variant="link" size="sm" className="h-auto px-0"><Link to={`/p/${projectId(p.repo)}/cost` as string}>Cost and time</Link></Button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          {d.shared && (
            <Section label="Shared by the installation" className="mt-8">
              <div className="rounded-xl border p-5 text-sm">
                <p className="flex justify-between"><span>{d.shared.text}</span><span className="font-semibold">{money(d.shared.total, d.currency)}</span></p>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{Object.entries(d.shared.byService).map(([s, v]) => <li key={s} className="flex justify-between"><span>{s}</span><span>{money(v, d.currency)}</span></li>)}</ul>
              </div>
            </Section>
          )}
        </>
      )}
    </Column>
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
