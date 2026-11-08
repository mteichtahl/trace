/**
 * The gate's cost list (admins), one short item each: what the project has spent so far in all (the cloud work
 * estimated, what AWS billed and the orders paid: spentTotal), what AWS billed explained, and the project's two
 * budgets, each by its own name:
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
  if (e?.kind === 'quote') return `the JLCPCB quote of ${e.on}, the newest recorded (not the estimate)`
  if (e?.kind === 'estimate') {
    const without = e.without?.length ? ` without ${e.without.map((k) => (k === 'case' ? 'the case' : k)).join(' or ')}, which the budget leaves out` : ''
    return `the high end of the order estimate of ${e.at.slice(0, 10)}${without}, ${money(e.low, currency)} to ${money(e.high, currency)}, from its parts check and the fab's published prices`
  }
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

/**
 * What the project has spent in all (Marc: "Spent so far means all costs in total"): trace's cloud work (estimated),
 * what AWS billed for the project's tagged resources (agent runtime, memory, runner, secrets: spend the estimate does
 * not count, so nothing is counted twice) and the orders paid. It counted the estimate alone, so test-esp32 said US$141
 * spent with US$34.75 billed beside it. Orders placed and not paid yet are said apart, not added; orders in another
 * currency too. A report, not a budget: the build budget and the cloud-work allowance are checked as before. cost.get
 * says the same (spent.total, spent.text). Pure.
 */
export interface SpentTotal {
  total: number
  currency: string
  /** each part in words, in order: the cloud work, the AWS bill, the orders */
  parts: string[]
  /** "US$90 more is committed: orders placed, not paid yet."; null with nothing committed */
  committed: string | null
}

export const NOT_A_BUDGET = 'A total to know, not a budget: the build budget and the cloud-work allowance are checked as before.'

export function spentTotal(c: Pick<CostView, 'currency' | 'orderCurrency' | 'spent' | 'committed'>): SpentTotal {
  const oc = c.orderCurrency ?? c.currency
  const same = oc === c.currency
  const cloud = c.spent.cloud ?? 0
  const orders = c.spent.orders ?? 0
  const billed = c.spent.detail?.actual ?? null
  const total = cents(cloud + (billed?.total ?? 0) + (same ? orders : 0))
  return {
    total, currency: c.currency,
    parts: [
      `cloud work ${money(cloud, c.currency)} (estimated)`,
      billed ? `AWS billed ${money(billed.total, c.currency)}${billed.through ? ` (to ${billed.through})` : ''}` : 'no AWS bill read yet',
      orders ? `orders ${money(orders, oc)} paid${same ? '' : ' (not added: another currency)'}` : 'no orders paid yet',
    ],
    committed: c.committed ? `${money(c.committed, oc)} more is committed: orders placed, not paid yet.` : null,
  }
}

/** The parts as one sentence: "Cloud work US$141 (estimated), AWS billed US$34.75 (to 2026-11-05), no orders paid yet." */
export function spentParts(t: SpentTotal): string {
  const s = t.parts.join(', ')
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`
}

/**
 * One item of the gate's cost list: a short head ("Build budget" "US$200 for boards, parts and case: US$28.80 left")
 * and what explains it, one short line each. The list was one paragraph of about ninety words (spent, the AWS bill,
 * the build budget with the forecast's source, the order estimate with its limits, the allowance), hard to read at a
 * gate (test-esp32 run 2, #236).
 */
export interface SpendItem { id: 'spent' | 'billed' | 'build' | 'estimate' | 'cloud'; label: string; text: string; more: string[] }

export function gateSpendItems(c: CostView): SpendItem[] | null {
  if (!c.money) return null
  const actual = c.spent.detail?.actual
  const b = budgetsOf(c)
  // the total first, its parts right under it
  const t = spentTotal(c)
  const items: SpendItem[] = [{ id: 'spent', label: 'Spent so far', text: `${money(t.total, t.currency)} in all.`, more: [spentParts(t), ...(t.committed ? [t.committed] : []), NOT_A_BUDGET] }]
  if (actual) items.push(billedItem(actual, c.currency))
  if (b.build) items.push(buildItem(b.build))
  if (c.orderEstimate) items.push(estimateItem(c.orderEstimate))
  const cl = cloudItem(b, c.spent.cloud !== null)
  if (cl) items.push(cl)
  return items
}

/** The gate's cost list as plain text, one sentence after another (its tests read it so). */
export function gateSpendLine(c: CostView): string | null {
  const items = gateSpendItems(c)
  return items ? items.map((i) => [`${i.label} ${i.text}`, ...i.more].join(' ')).join(' ') : null
}

/**
 * What AWS billed, said as what it is: the project's own tagged resources, a day or so behind, and different spend
 * from the estimate, not a check on it (test-esp32 run 2, #183: "US$119 of it cloud work (estimated; US$34.75 billed
 * by AWS so far)" read as the estimate being 3.4 times the bill).
 */
function billedItem(a: NonNullable<NonNullable<CostView['spent']['detail']>['actual']>, currency: string): SpendItem {
  const services = Object.entries(a.byService).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([s]) => s)
  return {
    id: 'billed', label: 'Billed by AWS', text: `${money(a.total, currency)}${a.through ? ` through ${a.through}` : ''}, in the total, apart from the estimate.`,
    more: [
      `For the project's own tagged resources${services.length ? ` (${services.slice(0, 3).join(', ')}${services.length > 3 ? ' and more' : ''})` : ''}: its agent runtime, memory and runner, which the estimate does not count.`,
      'Model use and the shared job machines are not tagged per project, so the bill leaves them out: the two figures are different spend.',
      'Billing runs about a day behind.',
    ],
  }
}

function buildItem(b: NonNullable<Budgets['build']>): SpendItem {
  const m = (n: number) => money(n, b.currency)
  const head = `${m(b.budget)} for boards, parts and case`
  const held = [
    b.orders ? `After ${m(cents(b.orders))} paid for orders.` : '',
    b.committed ? `After ${m(b.committed)} committed for orders placed but not paid yet.` : '',
    b.forecast ? `After ${m(b.forecast)} forecast for the order${b.forecastSource ? `: ${b.forecastSource}` : ''}.` : '',
  ].filter(Boolean)
  if (!held.length) return { id: 'build', label: 'Build budget', text: `${head}: nothing ordered or forecast yet.`, more: [] }
  return { id: 'build', label: 'Build budget', text: `${head}: ${b.left >= 0 ? `${m(b.left)} left` : `${m(-b.left)} over`}.`, more: held }
}

function estimateItem(e: NonNullable<CostView['orderEstimate']>): SpendItem {
  const m = (n: number) => money(n, e.currency)
  const r = (a: number, b: number) => (a === b ? m(a) : `${m(a)} to ${m(b)}`)
  const said = limitsSaid(e)
  return {
    id: 'estimate', label: 'Order estimate', text: `${r(e.low, e.high)} for ${e.quantity} boards, ${r(e.perBoard.low, e.perBoard.high)} per board.`,
    more: [
      `From the parts check of ${e.at.slice(0, 10)}; the fab's fees, case and shipping from its published prices, not a quote.`,
      ...said.map((x) => `${x[0]!.toUpperCase()}${x.slice(1)}.`),
      ...(said.length && (e.verdict === 'over' || e.verdict === 'at_risk') ? [CHANGE_NOW] : []),
    ],
  }
}

function cloudItem(b: Budgets, known: boolean): SpendItem | null {
  const m = (n: number) => money(n, b.cloud.currency)
  const { allowance, spent, left } = b.cloud
  if (allowance === null || left === null) {
    // said only beside a build budget, so nobody reads the cloud work into it
    return b.build && known ? { id: 'cloud', label: 'Cloud work', text: 'not counted against the build budget.', more: ['No cloud-work allowance is set (Settings).'] } : null
  }
  return {
    id: 'cloud', label: 'Cloud-work allowance', text: `${m(allowance)}: ${left >= 0 ? `${m(left)} left` : `${m(-left)} over`} after ${m(cents(spent))} of trace's cloud work (estimated).`,
    more: left >= 0 ? [] : ['Cost and time shows what each job cost.'],
  }
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
  const said = limitsSaid(e)
  if (!said.length) return `${head}.`
  return `${head}: ${said.join('; ')}.${e.verdict === 'over' || e.verdict === 'at_risk' ? ` ${CHANGE_NOW}` : ''}`
}

const CHANGE_NOW = 'Change the budget, the parts, the case or the quantity now, while it is cheap.'

/** Each cost limit the estimate could be compared with: "over REQ-4ce9e8 (US$100) by US$41 to US$144". */
function limitsSaid(e: NonNullable<CostView['orderEstimate']>): string[] {
  const m = (n: number) => money(n, e.currency)
  const r = (a: number, b: number) => (a === b ? m(a) : `${m(a)} to ${m(b)}`)
  return e.limits.filter((l) => l.verdict !== 'not_compared').map((l) => {
    // a limit that leaves shipping or the case out is compared without them, and says so (test-esp32-run2 R35)
    const without = l.compared && l.excludes?.length ? ` without ${l.excludes.map((k) => (k === 'case' ? 'the case' : k)).join(' or ')}` : ''
    const what = `${l.requirement ?? (l.kind === 'total' ? 'the build budget' : 'the target unit cost')}${without}`
    const got = l.compared ? [l.compared.low, l.compared.high] as const : l.kind === 'total' ? [e.low, e.high] as const : [e.perBoard.low, e.perBoard.high] as const
    return l.verdict === 'under' ? `under ${what} (${m(l.amount)})`
      : l.verdict === 'over' ? `over ${what} (${m(l.amount)}) by ${r(got[0] - l.amount, got[1] - l.amount)}`
        : `at risk against ${what} (${m(l.amount)}): up to ${m(got[1] - l.amount)} over`
  })
}
