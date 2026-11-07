/**
 * The gate's cost line (admins): what the project has spent so far, the cloud part an estimate with what AWS billed
 * beside it, and the project's two budgets, each by its own name:
 *
 *   the build budget          what the order may cost (boards, parts, case): the orders paid, orders placed and not
 *                             paid yet (committed) and the order forecast (boards x the build plan's target unit cost,
 *                             until an order is placed: an order being prepared is a forecast, #218) count against it
 *   the cloud-work allowance  what trace's own cloud work (agents, graphics card and CPU jobs) may cost
 *
 * They were one number, so with US$1.59 of cloud work spent the gate said "US$18.41 left after what is committed and
 * forecast", nothing said the forecast was the order, and the agents' spend came off the build's money (test-esp32
 * run 2, issue log #91, #100, #151). Over a budget says by how much, never US$0. From cost.get. Pure, so it is tested
 * on its own; Cost and time shows the same figures (budgetsOf).
 */
import { money } from '@/lib/format'
import type { CostView } from '@/lib/types-s1'

const cents = (n: number): number => Math.round(n * 100) / 100

type Costs = Pick<CostView, 'currency' | 'orderCurrency' | 'spent' | 'committed' | 'forecast' | 'budget' | 'cloudBudget' | 'quantity' | 'unit_cost'>

export interface Budgets {
  /** the build budget against the order; null without one */
  build: { budget: number; orders: number; committed: number; forecast: number; left: number; currency: string; forecastSource: string | null } | null
  /** trace's cloud work against its allowance (allowance null: none set) */
  cloud: { allowance: number | null; spent: number; left: number | null; currency: string }
}

/** Where the order's forecast comes from, in words: "10 boards at US$8 each, the build plan's target unit cost". */
export function forecastSource(c: Pick<CostView, 'quantity' | 'unit_cost'>, currency: string): string | null {
  return c.quantity && c.unit_cost ? `${c.quantity} boards at ${money(c.unit_cost, currency)} each, the build plan's target unit cost` : null
}

/** The two budgets with what counts against each. */
export function budgetsOf(c: Costs): Budgets {
  const buildCurrency = c.orderCurrency ?? c.currency
  const orders = c.spent.orders ?? 0
  const committed = c.committed ?? 0
  const forecast = c.forecast ?? 0
  const cloud = c.spent.cloud ?? 0
  return {
    build: c.budget === undefined ? null : { budget: c.budget, orders, committed, forecast, left: cents(c.budget - orders - committed - forecast), currency: buildCurrency, forecastSource: forecast ? forecastSource(c, buildCurrency) : null },
    cloud: { allowance: c.cloudBudget ?? null, spent: cloud, left: c.cloudBudget === undefined ? null : cents(c.cloudBudget - cloud), currency: c.currency },
  }
}

export function gateSpendLine(c: CostView): string | null {
  if (!c.money) return null
  const cloud = c.spent.cloud ?? 0
  const orders = c.spent.orders ?? 0
  const actual = c.spent.detail?.actual
  const parts = [
    `Spent so far ${money(cloud + orders, c.currency)}`,
    c.spent.cloud !== null && (cloud > 0 || actual) ? `${money(cloud, c.currency)} of it cloud work (estimated from model use and job time)` : '',
    orders ? `${money(orders, c.orderCurrency ?? c.currency)} on orders` : '',
  ].filter(Boolean)
  const b = budgetsOf(c)
  return [`${parts.join(', ')}.`, actual ? billedLine(actual, c.currency) : '', b.build ? buildBudgetLine(b.build) : '', cloudLine(b, c.spent.cloud !== null)].filter(Boolean).join(' ')
}

/**
 * What AWS billed, said as what it is: the project's own tagged resources (its agent runtime, memory, runner), a day or
 * so behind. Model use and the shared job machines are not tagged per project, so the bill leaves them out and the
 * estimate counts only them: the two figures are different spend, not one figure checked against the other. The gate
 * said "US$119 of it cloud work (estimated; US$34.75 billed by AWS so far)", which read as the estimate being 3.4
 * times the bill (test-esp32 run 2, #183).
 */
export function billedLine(a: NonNullable<NonNullable<CostView['spent']['detail']>['actual']>, currency: string): string {
  const services = Object.entries(a.byService).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([s]) => s)
  const through = a.through ? ` through ${a.through}` : ''
  const what = services.length ? ` (${services.slice(0, 3).join(', ')}${services.length > 3 ? ' and more' : ''})` : ''
  return `Apart from that, AWS billed ${money(a.total, currency)}${through} for the project's own tagged resources${what}: its agent runtime, memory and runner, which the estimate does not count. Model use and the shared job machines are not tagged per project, so that bill leaves them out; the two figures are different spend. Billing runs about a day behind.`
}

/**
 * "Build budget US$100 (boards, parts and case): US$20 left after US$80 forecast for the order (10 boards at US$8 each,
 * the build plan's target unit cost)." Cloud work is never in it.
 */
export function buildBudgetLine(b: NonNullable<Budgets['build']>): string {
  const m = (n: number) => money(n, b.currency)
  const held = [
    b.orders ? `${m(cents(b.orders))} paid for orders` : '',
    b.committed ? `${m(b.committed)} committed for orders placed but not paid yet` : '',
    b.forecast ? `${m(b.forecast)} forecast for the order${b.forecastSource ? ` (${b.forecastSource})` : ''}` : '',
  ].filter(Boolean)
  const head = `Build budget ${m(b.budget)} (boards, parts and case)`
  if (!held.length) return `${head}: nothing ordered or forecast yet.`
  const after = `after ${held.join(' and ')}`
  return b.left >= 0 ? `${head}: ${m(b.left)} left ${after}.` : `${head}: ${m(-b.left)} over ${after}.`
}

/** "Cloud-work allowance US$60: US$58.41 left after US$1.59 of trace's cloud work (estimated)." */
export function cloudLine(b: Budgets, known = true): string {
  const m = (n: number) => money(n, b.cloud.currency)
  const { allowance, spent, left } = b.cloud
  if (allowance === null || left === null) {
    // said only beside a build budget, so nobody reads the cloud work into it
    return b.build && known ? 'trace\'s cloud work does not count against the build budget, and no cloud-work allowance is set (Settings).' : ''
  }
  const after = `after ${m(cents(spent))} of trace's cloud work (estimated)`
  return left >= 0
    ? `Cloud-work allowance ${m(allowance)}: ${m(left)} left ${after}.`
    : `Cloud-work allowance ${m(allowance)}: ${m(-left)} over ${after}. Cost and time shows what each job cost.`
}
