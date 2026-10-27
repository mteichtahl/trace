/**
 * The gate's cost line (admins): what the project has spent so far, the cloud part an estimate with what AWS billed
 * beside it, and the budget. From cost.get. Pure, so it is tested on its own.
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
  const budget = c.budget !== undefined ? ` Budget ${money(c.budget, c.currency)}: ${money(Math.max(0, c.budget - spent - (c.committed ?? 0) - (c.forecast ?? 0)), c.currency)} left after what is committed and forecast.` : ''
  return `${parts.join(', ')}.${budget}`
}
