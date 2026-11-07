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
