/**
 * The order sheet's words (src/routes/_app/p/$id/build.tsx), from build.get's order being prepared: it is "ready to
 * place" only when build.get says so, and its cost is the build plan's target, said as such, until there is a quote
 * (test-esp32 run 2, #217, #226). Pure, so it is tested on its own.
 */
import { money } from '@/lib/format'
import type { OrderView } from '@/lib/types-s1'

/** An order's amount in the list: what was paid or quoted, or the target said as such. */
export function orderAmount(o: Pick<OrderView, 'state' | 'total' | 'currency' | 'basis' | 'target'>): string {
  if (o.state !== 'ready' || o.basis === 'quote') return money(o.total, o.currency)
  return o.target != null ? `target ${money(o.target, o.currency)}, no quote yet` : 'no quote yet'
}

/** The order sheet's headline and cost line, from what build.get says (never "ready" without its word). */
export function orderHeadline(o: Pick<OrderView, 'boards' | 'ready' | 'basis' | 'target' | 'total' | 'currency'>): { title: string; cost: string } {
  const title = o.ready === true ? `The order for ${o.boards} boards is ready to place on JLCPCB.` : `The order for ${o.boards} boards is not ready to place yet.`
  const cost = o.basis === 'quote'
    ? `Expected cost about ${money(o.total, o.currency)}, from the quote.`
    : o.target != null ? `No quote yet: the build plan's target is ${money(o.target, o.currency)}, not a price.` : 'No quote yet, and no target unit cost in the build plan.'
  return { title, cost }
}
