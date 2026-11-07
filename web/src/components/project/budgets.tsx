/**
 * The project's two budgets side by side (Cost and time, and the Overview's side column for admins), each with what
 * counts against it and where its forecast comes from:
 *
 *   Build budget          the order: boards, parts and case (orders paid; committed: orders placed, not paid yet;
 *                         the order forecast from the build plan's quantity and target unit cost until an order is
 *                         placed, an order being prepared included: test-esp32 run 2, #218)
 *   Cloud-work allowance  trace's own agents and jobs (estimated)
 *
 * They were one number, so the agents' spend used up the build's money and raising it to keep trace working raised
 * what the build may cost (test-esp32 run 2, issue log #91, #151). The figures are gate-spend.ts's budgetsOf.
 */
import { Link } from '@tanstack/react-router'
import { StatusBadge } from '@/components/status-badge'
import { money } from '@/lib/format'
import type { CostView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { budgetsOf, estimateLine } from './gate-spend'

const pct = (n: number, of: number): string => `${Math.min(100, Math.max(0, (n / of) * 100))}%`

export function Budgets({ cost, id, compact = false, className }: { cost: CostView; id: string; compact?: boolean; className?: string }) {
  const b = budgetsOf(cost)
  const box = 'rounded-xl border p-5'
  return (
    <div className={cn(compact ? 'space-y-4' : 'grid gap-3 md:grid-cols-2', className)}>
      <section className={box} aria-label="Build budget">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Build budget</h3>
          {b.build && <StatusBadge status={b.build.left >= 0 ? 'met' : 'failing'} label={b.build.left >= 0 ? `${money(b.build.left, b.build.currency)} to spare` : `${money(-b.build.left, b.build.currency)} over`} />}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">Boards, parts and case: what the order may cost. trace's cloud work is not in it.</p>
        {b.build ? (
          <>
            <p className="mt-3 text-2xl font-semibold tracking-tight">{money(b.build.budget, b.build.currency)}</p>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Orders paid ${money(b.build.orders, b.build.currency)}, committed ${money(b.build.committed, b.build.currency)}, forecast ${money(b.build.forecast, b.build.currency)} of ${money(b.build.budget, b.build.currency)}`}>
              <div className="bg-foreground/80" style={{ width: pct(b.build.orders, b.build.budget) }} />
              <div className="bg-foreground/45" style={{ width: pct(b.build.committed, b.build.budget) }} />
              <div className="bg-foreground/20" style={{ width: pct(b.build.forecast, b.build.budget) }} />
            </div>
            <dl className="mt-3 space-y-1 text-sm">
              <Row label="Orders paid" value={money(b.build.orders, b.build.currency)} />
              <Row label="Committed" hint="Orders placed, not paid yet" value={money(b.build.committed, b.build.currency)} />
              <Row label="Forecast for the order" hint={b.build.forecastSource ? `${b.build.forecastSource[0]!.toUpperCase()}${b.build.forecastSource.slice(1)}` : cost.forecast === null ? 'No target unit cost in the build plan' : undefined} value={cost.forecast === null ? 'not known' : money(b.build.forecast, b.build.currency)} />
            </dl>
          </>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No build budget set. <Link to="/p/$id/settings" params={{ id }} className="text-primary hover:underline">Set it in Settings</Link></p>
        )}
        {cost.orderEstimate && <OrderEstimate e={cost.orderEstimate} />}
      </section>
      <section className={box} aria-label="Cloud-work allowance">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Cloud-work allowance</h3>
          {b.cloud.left !== null && <StatusBadge status={b.cloud.left >= 0 ? 'met' : 'failing'} label={b.cloud.left >= 0 ? `${money(b.cloud.left, b.cloud.currency)} left` : `${money(-b.cloud.left, b.cloud.currency)} over`} />}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">trace's own agents and jobs, estimated. Apart from the build budget.</p>
        {b.cloud.allowance !== null ? (
          <>
            <p className="mt-3 text-2xl font-semibold tracking-tight">{money(b.cloud.allowance, b.cloud.currency)}</p>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Cloud work ${money(b.cloud.spent, b.cloud.currency)} of ${money(b.cloud.allowance, b.cloud.currency)}`}>
              <div className={cn(b.cloud.left !== null && b.cloud.left < 0 ? 'bg-destructive' : 'bg-foreground/80')} style={{ width: pct(b.cloud.spent, b.cloud.allowance) }} />
            </div>
            <dl className="mt-3 space-y-1 text-sm">
              <Row label="Cloud work so far" hint="Not forecast: it counts as it runs" value={money(b.cloud.spent, b.cloud.currency)} />
            </dl>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm"><span className="font-semibold">{money(b.cloud.spent, b.cloud.currency)}</span> of cloud work so far.</p>
            <p className="mt-1 text-sm text-muted-foreground">No allowance set, so nothing warns before cloud work runs long. <Link to="/p/$id/settings" params={{ id }} className="text-primary hover:underline">Set it in Settings</Link></p>
          </>
        )}
      </section>
    </div>
  )
}

/** The order estimate against the cost requirements, from the newest parts check (#162). */
function OrderEstimate({ e }: { e: NonNullable<CostView['orderEstimate']> }) {
  const m = (a: number, b: number) => (a === b ? money(a, e.currency) : `${money(a, e.currency)} to ${money(b, e.currency)}`)
  const label = e.verdict === 'over' ? 'Over a cost requirement' : e.verdict === 'at_risk' ? 'At risk' : e.verdict === 'under' ? 'Within the cost requirements' : null
  return (
    <div className="mt-4 border-t pt-3" aria-label="Order estimate">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">Order estimate</h4>
        {label && <StatusBadge status={e.verdict === 'under' ? 'met' : e.verdict === 'over' ? 'failing' : 'warning'} label={label} />}
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        <Row label={`The order, ${e.quantity} boards`} hint="Boards, assembly, parts, case and shipping" value={m(e.low, e.high)} />
        <Row label="Per board" hint="Boards, assembly and parts" value={m(e.perBoard.low, e.perBoard.high)} />
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">{estimateLine(e)}</p>
      {e.notIn.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{e.notIn.join(' ')}</p>}
    </div>
  )
}

function Row({ label, hint, value }: { label: string; hint?: string | undefined; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0"><span className="text-muted-foreground">{label}</span>{hint && <span className="block text-xs text-muted-foreground/80">{hint}</span>}</dt>
      <dd className="shrink-0 font-medium tabular-nums">{value}</dd>
    </div>
  )
}
