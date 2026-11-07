/**
 * The order sheet's words (src/routes/_app/p/$id/build.tsx), from build.get's order being prepared: it is "ready to
 * place" only when build.get says so, and its cost is the order estimate (else the build plan's target), said as such,
 * until there is a quote (test-esp32 run 2, #217, #226, #227). Pure, so it is tested on its own.
 */
import { money } from '@/lib/format'
import type { OrderView } from '@/lib/types-s1'

/** An order's amount in the list: what was paid or quoted, else the order estimate or the target, said as such. */
export function orderAmount(o: Pick<OrderView, 'state' | 'total' | 'currency' | 'basis' | 'target' | 'estimate' | 'quote'>): string {
  if (o.state !== 'ready') {
    // paid, and against the quote it was placed on
    const d = o.quote?.difference
    return d === undefined || d === null ? money(o.total, o.currency) : `${exact(o.total, o.currency)} paid, quoted ${exact(o.quote!.total, o.quote!.currency)} (${signedMoney(d, o.currency)})`
  }
  if (o.basis === 'quote') return `quoted ${exact(o.total, o.currency)}`
  if (o.estimate) return `estimate ${estimateRange(o.estimate)}, no quote yet`
  return o.target != null ? `target ${money(o.target, o.currency)}, no quote yet` : 'no quote yet'
}

/** The order sheet's headline and cost line, from what build.get says (never "ready" without its word). */
export function orderHeadline(o: Pick<OrderView, 'boards' | 'ready' | 'basis' | 'target' | 'total' | 'currency' | 'estimate' | 'quote'>): { title: string; cost: string } {
  const title = o.ready === true ? `The order for ${o.boards} boards is ready to place on JLCPCB.` : `The order for ${o.boards} boards is not ready to place yet.`
  const e = o.estimate
  const cost = o.basis === 'quote'
    // the newest quote is the cost; the estimate stays beside it to compare
    ? `JLCPCB quoted ${exact(o.total, o.currency)}${o.quote ? ` on ${o.quote.on}` : ''}${o.quote?.quantity && o.quote.quantity !== o.boards ? ` for ${o.quote.quantity} boards` : ''}.${e ? ` The estimate was ${estimateRange(e)}.` : ''}`
    // the order estimate before the target: it is from the parts check and the fab's prices (#227)
    : e ? `No quote yet: the order estimate is ${estimateRange(e)}, from the parts check and the fab's published prices, not a quote.`
      : o.target != null ? `No quote yet: the build plan's target is ${money(o.target, o.currency)}, not a price.` : 'No quote yet, and no target unit cost in the build plan.'
  return { title, cost }
}

/** A quoted or paid amount to the cent, as JLCPCB shows it: US$182.40. */
export const exact = (n: number, c: string): string => `${n < 0 ? '−' : ''}${money(0, c).replace(/0$/, '')}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** A change: +US$3.20, −US$5.00. */
export const signedMoney = (n: number, c: string): string => `${n >= 0 ? '+' : '−'}${exact(Math.abs(n), c)}`

/** "US$141 to US$244", or one figure when the range is one. */
export const estimateRange = (e: NonNullable<OrderView['estimate']>): string => (e.low === e.high ? money(e.high, e.currency) : `${money(e.low, e.currency)} to ${money(e.high, e.currency)}`)

/**
 * What the order is held against the budget by: the quote; else the order estimate's high end (as the build budget's
 * forecast is, #178); else the build plan's target.
 */
export function againstBudget(o: Pick<OrderView, 'basis' | 'cost' | 'estimate' | 'target' | 'total'>): { amount: number; what: string } | null {
  if (o.basis === 'quote') return { amount: o.total, what: 'the quote' }
  if (o.estimate) return { amount: o.estimate.high, what: 'the estimate\'s high end' }
  return o.target != null ? { amount: o.target, what: 'the target' } : null
}

/**
 * A unit price. Below a cent it keeps its digits, up to five places (US$0.002, US$0.00202), so a change of a fraction
 * of a cent shows in the two columns (#229).
 */
export function unitPrice(n: number, c: string): string {
  if (!(n > 0 && n < 0.01)) return money(n, c)
  const digits = n.toFixed(5).replace(/0+$/, '')
  return `${money(0, c).replace(/0$/, '')}${digits.length < 5 ? n.toFixed(3) : digits}`
}

type PriceLine = Pick<OrderView['parts'][number], 'now' | 'then' | 'need'>

/** One line's change since sign-off at the build quantity: "+US$0.40", "−US$0.10", "up under a cent", or null. */
export function lineChange(p: PriceLine, boards: number, currency: string): string | null {
  if (p.now === p.then) return null
  const d = (p.now - p.then) * (p.need ?? boards)
  return Math.abs(d) < 0.005 ? `${d > 0 ? 'up' : 'down'} under a cent` : signedMoney(d, currency)
}

/**
 * The parts check's price sentence: the rises and the drops since sign-off, and their net change for the build. A net
 * change that rounds to nothing is said as under a cent, not "adding US$0.00" (test-esp32 round 6, #229).
 */
export function priceChangeLine(parts: PriceLine[], boards: number, currency: string): string {
  const up = parts.filter((p) => p.now > p.then).length
  const down = parts.filter((p) => p.now < p.then).length
  if (!up && !down) return 'No price changed since sign-off.'
  const n = (k: number) => `${k} price${k > 1 ? 's' : ''}`
  const moved = up && down ? `${n(up)} went up and ${down} went down` : up ? `${n(up)} went up` : `${n(down)} went down`
  const net = parts.reduce((s, p) => s + (p.now - p.then) * (p.need ?? boards), 0)
  const words = Math.abs(net) < 0.005 ? `less than a cent${up && down ? ' net' : ''}` : up && down ? `${signedMoney(net, currency)} net` : signedMoney(net, currency)
  return `${moved} since sign-off: ${words} for ${boards} boards.`
}
