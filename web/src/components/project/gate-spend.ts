/**
 * The gate's cost line (admins): what the project has spent so far, the cloud part an estimate with what AWS billed
 * beside it, and the budget: what is left, or how far over, after what is spent, committed and forecast, each named.
 * The forecast is named because it is most of the budget before any order (the build: boards x the planned unit cost),
 * and a bare "US$0 left" with US$21 spent of US$100 read as wrong arithmetic (test-esp32 run 2, issue log #91, #100).
 * Over budget says by how much, never US$0. From cost.get. Pure, so it is tested on its own.
 */
import { money } from '@/lib/format'
import type { CostView } from '@/lib/types-s1'

export function gateSpendLine(c: CostView): string | null {
  if (!c.money) return null
  const cloud = c.spent.cloud ?? 0
  const orders = c.spent.orders ?? 0
  const spent = cloud + orders
  const actual = c.spent.detail?.actual
  const parts = [
    `Spent so far ${money(spent, c.currency)}`,
    c.spent.cloud !== null && (cloud > 0 || actual) ? `${money(cloud, c.currency)} of it cloud use (estimated${actual ? `; ${money(actual.total, c.currency)} billed by AWS so far` : ''})` : '',
    orders ? `${money(orders, c.orderCurrency ?? c.currency)} on orders` : '',
  ].filter(Boolean)
  return `${parts.join(', ')}.${c.budget !== undefined ? ` ${budgetLine(c, spent, c.budget)}` : ''}`
}

const cents = (n: number): number => Math.round(n * 100) / 100

/** "Budget US$100: US$1.28 over after US$21.28 spent and US$80 forecast for the build (10 boards at US$8)." */
export function budgetLine(c: Pick<CostView, 'currency' | 'committed' | 'forecast' | 'quantity' | 'unit_cost'>, spent: number, budget: number): string {
  const committed = c.committed ?? 0
  const forecast = c.forecast ?? 0
  const left = cents(budget - spent - committed - forecast)
  const held = [
    committed ? `${money(committed, c.currency)} committed` : '',
    forecast ? `${money(forecast, c.currency)} forecast for the build${c.quantity && c.unit_cost ? ` (${c.quantity} boards at ${money(c.unit_cost, c.currency)})` : ''}` : '',
  ].filter(Boolean)
  const after = `after ${money(cents(spent), c.currency)} spent${held.length ? ` and ${held.join(' and ')}` : ''}`
  return left >= 0
    ? `Budget ${money(budget, c.currency)}: ${money(left, c.currency)} left ${after}.`
    : `Budget ${money(budget, c.currency)}: ${money(-left, c.currency)} over ${after}. Cost and time shows what each job cost.`
}
