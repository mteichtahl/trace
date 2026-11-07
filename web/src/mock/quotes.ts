/**
 * Mock JLCPCB quotes for the soil sensor (build.get quotes, quote.record, cost.get's forecast, Order submit's pay step),
 * as src/core/quotes.ts answers them. VITE_MOCK_QUOTES=1 or 3 starts with that many; none otherwise. quote.record adds
 * one in memory, with its change from the one before worked out as the API does for the total. With 3, an agent's quote
 * from the person's words waits to be confirmed. quote.correct, quote.withdraw and quote.confirm change them in memory.
 */
import type { BuildView, CostView, OrderSheetView, QuoteInput, QuoteView } from '@/lib/types-s1'

const DAY = 86_400_000
const dayAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10)
const at = (n: number) => new Date(Date.now() - n * DAY).toISOString()
const OPTIONS = [{ option: 'Layers', value: '4' }, { option: 'PCB thickness', value: '1.6 mm' }, { option: 'Surface finish', value: 'HASL' }]
const LABEL: Record<string, string> = { pcb: 'PCB', assembly: 'Assembly and setup', components: 'Components', extended: 'Extended-part fees', stencil: 'Stencil', shipping: 'Shipping', tax: 'Tax and duty', other: 'Other' }
const lines = (l: Record<string, number>) => Object.entries(l).map(([kind, amount]) => ({ kind: kind as never, amount, label: LABEL[kind]! }))

const FIRST: QuoteView = {
  id: 'q1', on: dayAgo(9), at: at(9), total: 158.62, currency: 'USD', quantity: 10, revision: 'A', fab: 'JLCPCB',
  lines: lines({ pcb: 18.4, assembly: 25, components: 71.32, extended: 9, shipping: 26.4, tax: 8.5 }), options: OPTIONS, optionsFrom: 'run_fab_a', partsRun: 'run_bom_a',
  link: null, why: 'First quote after uploading the package.', by: 'Marc Teichtahl', change: null, order: null,
}
const SECOND: QuoteView = {
  id: 'q2', on: dayAgo(5), at: at(5), total: 164.9, currency: 'USD', quantity: 10, revision: 'A', fab: 'JLCPCB',
  lines: lines({ pcb: 26.2, assembly: 25, components: 74.8, extended: 9, shipping: 21.4, tax: 8.5 }), options: OPTIONS.map((o) => (o.option === 'Surface finish' ? { ...o, value: 'ENIG' } : o)), optionsFrom: null, partsRun: 'run_bom_b',
  link: null, why: 'ENIG for the fine-pitch radio module; switched to the cheaper DHL option.', by: 'Marc Teichtahl',
  change: { amount: 6.28, pct: 4, reasons: ['Options changed: Surface finish HASL to ENIG.', 'Parts re-checked (run_bom_b): +US$3.48 at the checked prices.', 'PCB +US$7.80, Components +US$3.48, Shipping −US$5.00.'] },
  order: null,
}
const THIRD: QuoteView = {
  id: 'q3', on: dayAgo(1), at: at(1), total: 161.3, currency: 'USD', quantity: 10, revision: 'A', fab: 'JLCPCB',
  lines: lines({ pcb: 26.2, assembly: 25, components: 74.8, extended: 6, shipping: 21.4, tax: 7.9 }), options: SECOND.options, optionsFrom: null, partsRun: 'run_bom_b',
  link: 'https://cart.jlcpcb.com/quote/Q2611-4471', why: 'Swapped U3 for a basic part: one less extended-part fee.', by: 'Priya Shah',
  change: { amount: -3.6, pct: -2.2, reasons: ['Extended-part fees −US$3.00, Tax and duty −US$0.60.'] },
  order: null,
}

const AGENTS: QuoteView = {
  id: 'qa1', on: dayAgo(0), at: at(0), total: 159.8, currency: 'USD', quantity: 10, revision: 'A', fab: 'JLCPCB',
  lines: [], options: SECOND.options, optionsFrom: null, partsRun: 'run_bom_b', link: null, why: null, by: 'the worker agent',
  said: 'JLCPCB says US$159.80 now that the coupon applies.', agent: true,
  change: { amount: -1.5, pct: -0.9, reasons: [] }, order: null,
}

const start = import.meta.env.VITE_MOCK_QUOTES
/** Newest first, as build.get answers. */
export const QUOTES: QuoteView[] = start === '3' ? [AGENTS, THIRD, SECOND, FIRST] : start === '1' ? [FIRST] : []
const live = (q: QuoteView) => !q.correctedBy && !q.withdrawn
/** the newest quote that counts */
const newest = () => QUOTES.find(live)

/** build.get with the quotes: the order being prepared costs the newest, the estimate kept beside it. */
export function withQuotes(b: BuildView): BuildView {
  const q = newest()
  return {
    ...b, quotes: QUOTES,
    orders: b.orders.map((o) => (o.state === 'ready' && q
      ? { ...o, basis: 'quote' as const, total: q.total, currency: q.currency, quote: { id: q.id, on: q.on, total: q.total, currency: q.currency, quantity: q.quantity, by: q.by, ...(q.agent ? { agent: true } : {}) } }
      : o)),
  }
}

/** cost.get: the forecast is the newest quote when there is one, and says so. */
export function costWithQuote(c: CostView): CostView {
  const q = newest()
  return q ? { ...c, forecast: q.total, forecastBasis: { kind: 'quote', total: q.total, on: q.on, id: q.id } } : c
}

/** Order submit's pay step with the newest quote. */
export const payWithQuote = (p: OrderSheetView['pay']): OrderSheetView['pay'] => {
  const q = newest()
  return { ...p, quote: q ? { id: q.id, on: q.on, total: q.total, currency: q.currency, quantity: q.quantity } : null }
}

/** quote.record in memory. */
export function recordQuote(a: QuoteInput): QuoteView {
  const before = newest()
  const total = Math.round(a.total * 100) / 100
  const quantity = a.quantity ?? 10
  const currency = a.currency ?? 'USD'
  const amount = before && before.currency === currency ? Math.round((total - before.total) * 100) / 100 : null
  const q: QuoteView = {
    id: `q${QUOTES.length + 1}`, on: a.on ?? dayAgo(0), at: new Date().toISOString(), total, currency, quantity, revision: 'A', fab: 'JLCPCB',
    lines: (a.lines ?? []).map((l) => ({ ...l, label: LABEL[l.kind]! })), options: a.options ?? before?.options ?? OPTIONS, optionsFrom: a.options ? null : 'run_fab_a', partsRun: 'run_bom_b',
    link: a.link ?? null, why: a.why ?? null, by: 'Marc Teichtahl',
    change: before ? { amount, pct: amount !== null ? Math.round((amount / before.total) * 1000) / 10 : null, reasons: before.quantity !== quantity ? [`Quantity ${before.quantity} to ${quantity} boards.`] : [] } : null,
    order: null,
  }
  QUOTES.unshift(q)
  return q
}

/** quote.confirm in memory: the agent's quote is the person's now. */
export function confirmQuote(id: string): QuoteView | null {
  const q = QUOTES.find((x) => x.id === id)
  if (!q) return null
  if (q.agent) { delete q.agent; q.confirmedBy = 'Marc Teichtahl' }
  return q
}

/** quote.correct in memory: a new quote in the old one's place, the old one kept, marked corrected. */
export function correctQuote(a: QuoteInput & { quote: string; reason?: string }): QuoteView | null {
  const old = confirmQuote(a.quote)
  if (!old || !live(old)) return null
  const total = Math.round(a.total * 100) / 100
  const q: QuoteView = {
    ...old, id: `q${QUOTES.length + 1}`, at: new Date().toISOString(), total, on: a.on ?? old.on, quantity: a.quantity ?? old.quantity, currency: a.currency ?? old.currency,
    lines: a.lines ? a.lines.map((l) => ({ ...l, label: LABEL[l.kind]! })) : old.lines, options: a.options ?? old.options, optionsFrom: a.options ? null : old.optionsFrom,
    link: a.link ?? old.link, why: a.why ?? old.why, by: 'Marc Teichtahl',
    corrects: { id: old.id, on: old.on, total: old.total, reason: a.reason ?? null, by: 'Marc Teichtahl' },
    change: old.change && old.change.amount !== null ? ((d) => ({ ...old.change!, amount: d, pct: Math.round((d / (old.total - old.change!.amount!)) * 1000) / 10 }))(Math.round((old.change.amount + total - old.total) * 100) / 100) : old.change,
  }
  delete q.confirmedBy
  delete q.said
  old.correctedBy = q.id
  old.change = null
  q.order = old.order
  old.order = null
  QUOTES.splice(QUOTES.indexOf(old), 0, q)
  return q
}

/** quote.withdraw in memory. */
export function withdrawQuote(id: string, reason: string): QuoteView | null {
  const q = confirmQuote(id)
  if (!q || !live(q) || q.order) return null
  q.withdrawn = { reason, by: 'Marc Teichtahl', at: new Date().toISOString() }
  q.change = null
  return q
}

/** Order submit's "JLCPCB quote recorded" check, before the order's: met once a quote is recorded, else asked for without holding Submit back. */
export function quoteCheck<C extends { id: string }>(checks: C[]): C[] {
  const q = newest()
  const c = (q
    ? { id: 'quote', status: 'met', detail: `US$${q.total.toFixed(2)} for ${q.quantity} boards, quoted ${q.on}.` }
    : { id: 'quote', status: 'not_due', detail: 'no quote recorded yet: record the total JLCPCB shows (Record a quote on the Build tab) so the order\'s cost is the quote, not the estimate' }) as unknown as C
  const rest = checks.filter((x) => x.id !== 'quote')
  const at = rest.findIndex((x) => x.id === 'recorded')
  return at < 0 ? [...rest, c] : [...rest.slice(0, at), c, ...rest.slice(at)]
}
