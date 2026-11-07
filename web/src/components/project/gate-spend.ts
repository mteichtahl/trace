/**
 * The gate's cost line (admins): what the project has spent so far, the cloud part an estimate with what AWS billed
 * beside it, and the project's two budgets, each by its own name:
 *
 *   the build budget          what the order may cost (boards, parts, case): the orders paid, orders placed and not
 *                             paid yet (committed) and the order forecast (the newest order estimate's high end, else
 *                             boards x the build plan's target unit cost, until an order is placed: an order being
 *                             prepared is a forecast, #218, #178) count against it
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

type Costs = Pick<CostView, 'currency' | 'orderCurrency' | 'spent' | 'committed' | 'forecast' | 'forecastBasis' | 'budget' | 'cloudBudget' | 'quantity' | 'unit_cost'>

export interface Budgets {
  /** the build budget against the order; null without one */
  build: { budget: number; orders: number; committed: number; forecast: number; left: number; currency: string; forecastSource: string | null } | null
  /** trace's cloud work against its allowance (allowance null: none set) */
  cloud: { allowance: number | null; spent: number; left: number | null; currency: string }
}

/**
 * Where the order's forecast comes from, in words: the newest order estimate when there is one ("the high end of the
 * order estimate of 2026-11-06, US$141 to US$244"), else "10 boards at US$8 each, the build plan's target unit cost".
 * The target was said with an estimate on record (test-esp32 run 2, #178).
 */
export function forecastSource(c: Pick<CostView, 'quantity' | 'unit_cost' | 'forecastBasis'>, currency: string): string | null {
  const e = c.forecastBasis
  if (e?.kind === 'estimate') return `the high end of the order estimate of ${e.at.slice(0, 10)}, ${money(e.low, currency)} to ${money(e.high, currency)}, from its parts check and the fab's published prices`
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
    c.spent.cloud !== null && (cloud > 0 || actual) ? `${money(cloud, c.currency)} of it cloud work (estimated${actual ? `; ${money(actual.total, c.currency)} billed by AWS so far` : ''})` : '',
    orders ? `${money(orders, c.orderCurrency ?? c.currency)} on orders` : '',
  ].filter(Boolean)
  const b = budgetsOf(c)
  return [`${parts.join(', ')}.`, b.build ? buildBudgetLine(b.build) : '', c.orderEstimate ? estimateLine(c.orderEstimate) : '', cloudLine(b, c.spent.cloud !== null)].filter(Boolean).join(' ')
}

/**
 * "Order estimate US$141 to US$244 for 10 boards (parts check of 2026-11-04; fees from published prices, not a quote):
 * REQ-4ce9e8 over …". Said at every gate once there is a parts check, so a cost requirement the order would break is
 * seen at Architect or Capture, not first at Sign-off (test-esp32 run 2, #162).
 */
export function estimateLine(e: NonNullable<CostView['orderEstimate']>): string {
  const m = (n: number) => money(n, e.currency)
  const r = (a: number, b: number) => (a === b ? m(a) : `${m(a)} to ${m(b)}`)
  const head = `Order estimate ${r(e.low, e.high)} for ${e.quantity} boards, ${r(e.perBoard.low, e.perBoard.high)} per board (parts check of ${e.at.slice(0, 10)}; the fab's fees, case and shipping from its published prices, not a quote)`
  const named = e.limits.filter((l) => l.verdict !== 'not_compared')
  if (!named.length) return `${head}.`
  const said = named.map((l) => {
    const what = l.requirement ?? (l.kind === 'total' ? 'the build budget' : 'the target unit cost')
    const got = l.kind === 'total' ? [e.low, e.high] as const : [e.perBoard.low, e.perBoard.high] as const
    return l.verdict === 'under' ? `under ${what} (${m(l.amount)})`
      : l.verdict === 'over' ? `over ${what} (${m(l.amount)}) by ${r(got[0] - l.amount, got[1] - l.amount)}`
        : `at risk against ${what} (${m(l.amount)}): up to ${m(got[1] - l.amount)} over`
  })
  return `${head}: ${said.join('; ')}.${e.verdict === 'over' || e.verdict === 'at_risk' ? ' Change the budget, the parts, the case or the quantity now, while it is cheap.' : ''}`
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
