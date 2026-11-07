/**
 * JLCPCB quotes (docs/user-journey.md "Fabricate"): what the fab said the order costs, as the person read it off
 * JLCPCB. trace never signs in to JLCPCB, so a quote is always the person's: entered in the Build tab (quote.record),
 * or recorded by an agent from words the person gave it (journey.quote_record, kept in the agents' facts with those
 * words: src/core/agent-facts.ts agent_quotes). Every quote is kept, so the cost can be followed over time and why it
 * moved.
 *
 *   quotes (journey table, src/core/build-tables.ts)
 *           the date, the total and its currency, the breakdown lines given (PCB, assembly and setup, components,
 *           extended-part fees, stencil, shipping, tax and duty, other), the quantity and the options it was for (by
 *           default the release package's: kicad.fab's order_options), the release revision, the newest parts check
 *           when it was recorded (its run and total), a link or reference, the person's why, and the order placed
 *           against it (order.record links the newest quote of the revision with no order yet, or the one named)
 *
 * What changed between two quotes is worked out on read (quoteChanges): the total's change in amount and per cent,
 * and what trace can tell moved: the quantity, the options, the revision, the parts at the checked prices between
 * the two parts checks, and each breakdown line. The person's why is shown beside it. Pure over the rows.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { JourneyError, type OrderRow, type Signer, decide, loadJourney } from './journey.js'
import { transaction } from './store.js'

export const QUOTE_LINES = ['pcb', 'assembly', 'components', 'extended', 'stencil', 'shipping', 'tax', 'other'] as const
export type QuoteLineKind = (typeof QUOTE_LINES)[number]
/** Each breakdown line in the words JLCPCB's cart uses. */
export const QUOTE_LINE_WORDS: Readonly<Record<QuoteLineKind, string>> = {
  pcb: 'PCB', assembly: 'Assembly and setup', components: 'Components', extended: 'Extended-part fees', stencil: 'Stencil', shipping: 'Shipping', tax: 'Tax and duty', other: 'Other',
}

export const QuoteLineSchema = z.object({
  kind: z.enum(QUOTE_LINES),
  // a discount is an "other" line below zero
  amount: z.number().min(-1_000_000).max(10_000_000),
})
export const QuoteOptionSchema = z.object({ option: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(160) })
export type QuoteLine = z.infer<typeof QuoteLineSchema>
export type QuoteOption = z.infer<typeof QuoteOptionSchema>

/** What a person (or an agent, from the person's words) enters for a quote. */
export const QuoteFields = z.object({
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date such as 2026-11-04').optional().describe('the quote\'s date (default today)'),
  total: z.number().positive().max(10_000_000).describe('the total JLCPCB shows'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'a currency code such as USD').optional().describe('default: the build plan\'s'),
  quantity: z.number().int().min(1).max(1_000_000).optional().describe('boards quoted (default: the build plan\'s quantity)'),
  lines: z.array(QuoteLineSchema).max(16).optional().describe('the breakdown, as far as it was given'),
  options: z.array(QuoteOptionSchema).max(80).optional().describe('the options it was for (default: the release package\'s)'),
  link: z.string().trim().min(3).max(300).optional().describe('a JLCPCB link or reference (a quote or cart number)'),
  why: z.string().trim().max(1000).optional().describe('why it was quoted again, or what changed, in the person\'s words'),
})
export type QuoteInput = z.infer<typeof QuoteFields>

export interface QuoteRow {
  id: string; revision: string; fab: string; on: string; total: number; currency: string; quantity: number
  lines: QuoteLine[]; options: QuoteOption[]; optionsFrom: string | null; partsRun: string | null; partsTotal: number | null
  link: string | null; why: string | null; orderId: string | null; by: string; at: number
  /** the person's own, or an agent's from the person's words (`said`) */
  source: 'person' | 'agent'; said: string | null
}

/** What a quote is for unless the person says otherwise: the journey's revision and build plan, and the record's runs. */
export interface QuoteDefaults {
  revision: string; fab: string; currency: string; quantity: number
  options: QuoteOption[]; optionsFrom: string | null; partsRun: string | null; partsTotal: number | null
}

const now = (): number => Date.now() / 1000
const newId = (): string => `q${randomUUID().replaceAll('-', '').slice(0, 15)}`
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const json = <T>(v: unknown, fallback: T): T => { try { const x: unknown = JSON.parse(String(v ?? '')); return Array.isArray(x) ? x as T : fallback } catch { return fallback } }
const cents = (n: number): number => Math.round(n * 100) / 100
const today = (): string => new Date().toISOString().slice(0, 10)

/** An amount as the screens say it: US$3.20, EUR 3.20. */
export const amount = (n: number, currency: string): string => `${n < 0 ? '−' : ''}${currency === 'USD' ? 'US$' : `${currency} `}${Math.abs(n).toFixed(2)}`
/** A change: +US$3.20, −US$5.00. */
export const signed = (n: number, currency: string): string => `${n >= 0 ? '+' : '−'}${amount(Math.abs(n), currency)}`

function rowOf(r: Record<string, unknown>, source: 'person' | 'agent'): QuoteRow {
  return {
    id: String(r.id), revision: String(r.revision), fab: String(r.fab), on: String(r.quoted_on), total: Number(r.total), currency: String(r.currency), quantity: Number(r.quantity),
    lines: json<QuoteLine[]>(r.lines, []), options: json<QuoteOption[]>(r.options, []), optionsFrom: str(r.options_from), partsRun: str(r.parts_run), partsTotal: num(r.parts_total),
    link: str(r.link), why: str(r.why), orderId: str(r.order_id), by: String(r.by), at: Number(r.at), source, said: source === 'agent' ? str(r.said) : null,
  }
}

/** Oldest first: by the quote's date, then when it was recorded. */
const byTime = (a: QuoteRow, b: QuoteRow): number => (a.on === b.on ? a.at - b.at : a.on < b.on ? -1 : 1)

/** Every quote in the journey record, oldest first (none for a record that predates quotes). */
export function loadQuotes(db: DatabaseSync): QuoteRow[] {
  if (!has(db, 'quotes')) return []
  return (db.prepare('SELECT * FROM quotes').all() as Record<string, unknown>[]).map((r) => rowOf(r, 'person')).sort(byTime)
}

/** Every quote an agent recorded from a person's words (the agents' facts), oldest first. */
export function loadAgentQuotes(db: DatabaseSync): QuoteRow[] {
  if (!has(db, 'agent_quotes')) return []
  return (db.prepare('SELECT * FROM agent_quotes').all() as Record<string, unknown>[]).map((r) => rowOf(r, 'agent')).sort(byTime)
}

/** The person's quotes and the agents' together, oldest first. */
export const allQuotes = (person: readonly QuoteRow[], agent: readonly QuoteRow[]): QuoteRow[] => [...person, ...agent].sort(byTime)

/** The newest quote of a revision, or null. */
export const latestQuote = (quotes: readonly QuoteRow[], revision: string): QuoteRow | null => [...quotes].filter((q) => q.revision === revision).sort(byTime).at(-1) ?? null

/**
 * What a quote is for by default, from the record database: the journey's revision and build plan, the release
 * package's options (the newest kicad.fab run's order_options) and the newest parts check with its total.
 */
export function quoteDefaults(db: DatabaseSync): QuoteDefaults | null {
  const r = loadJourney(db)
  if (!r) return null
  const b = r.journey.build
  return { revision: r.journey.revision, fab: b.fab, currency: b.currency, quantity: b.quantity, ...quoteRuns(db) }
}

/** The release package's options (the newest kicad.fab run's order_options) and the newest parts check, from the runs. */
export function quoteRuns(db: DatabaseSync): Pick<QuoteDefaults, 'options' | 'optionsFrom' | 'partsRun' | 'partsTotal'> {
  const out: Pick<QuoteDefaults, 'options' | 'optionsFrom' | 'partsRun' | 'partsTotal'> = { options: [], optionsFrom: null, partsRun: null, partsTotal: null }
  if (!has(db, 'runs')) return out
  const fab = db.prepare("SELECT id, result FROM runs WHERE kind='kicad.fab' ORDER BY started DESC LIMIT 1").get() as { id: string; result: unknown } | undefined
  if (fab) {
    let res: unknown = null
    try { res = JSON.parse(String(fab.result ?? 'null')) } catch { res = null }
    const raw = res && typeof res === 'object' ? (res as { order_options?: unknown }).order_options : null
    if (Array.isArray(raw)) {
      out.options = raw.flatMap((o): QuoteOption[] => (o && typeof o === 'object' && typeof (o as QuoteOption).option === 'string' && typeof (o as QuoteOption).value === 'string' ? [{ option: (o as QuoteOption).option, value: (o as QuoteOption).value }] : []))
      out.optionsFrom = String(fab.id)
    }
  }
  const check = db.prepare("SELECT id FROM runs WHERE kind='parts.bom_check' AND status != 'error' ORDER BY started DESC, id DESC LIMIT 1").get() as { id: string } | undefined
  if (check) {
    out.partsRun = String(check.id)
    if (has(db, 'parts_list_lines')) {
      const t = db.prepare('SELECT SUM(line_total) AS t FROM parts_list_lines WHERE run_id=?').get(check.id) as { t: number | null } | undefined
      out.partsTotal = t?.t === null || t?.t === undefined ? null : cents(Number(t.t))
    }
  }
  return out
}

/** A quote's rules, the same for a person's and an agent's. Returns the row to write (no id, by or time). */
function quoteOf(q: QuoteInput, d: QuoteDefaults): Omit<QuoteRow, 'id' | 'by' | 'at' | 'source' | 'said' | 'orderId'> {
  const on = q.on ?? today()
  if (on > today()) throw new JourneyError('The quote\'s date is in the future: give the date JLCPCB quoted it.')
  if (!(q.total > 0)) throw new JourneyError('Give the quote\'s total, as JLCPCB shows it.')
  const kinds = new Set<string>()
  for (const l of q.lines ?? []) {
    if (kinds.has(l.kind)) throw new JourneyError(`${QUOTE_LINE_WORDS[l.kind]} is given twice: give each line once.`)
    kinds.add(l.kind)
    if (l.amount < 0 && l.kind !== 'other') throw new JourneyError(`${QUOTE_LINE_WORDS[l.kind]} cannot be below zero (a discount goes in Other).`)
  }
  const lines = (q.lines ?? []).map((l) => ({ kind: l.kind, amount: cents(l.amount) }))
  const sum = cents(lines.reduce((n, l) => n + l.amount, 0))
  if (lines.length && sum > cents(q.total) + 0.01) throw new JourneyError(`The lines add up to ${amount(sum, q.currency ?? d.currency)}, more than the total ${amount(q.total, q.currency ?? d.currency)}.`)
  const own = q.options !== undefined
  return {
    revision: d.revision, fab: d.fab, on, total: cents(q.total), currency: q.currency ?? d.currency, quantity: q.quantity ?? d.quantity, lines,
    options: own ? q.options! : d.options, optionsFrom: own ? null : d.optionsFrom, partsRun: d.partsRun, partsTotal: d.partsTotal,
    link: q.link?.trim() || null, why: q.why?.trim() || null,
  }
}

const COLS = 'id, revision, fab, quoted_on, total, currency, quantity, lines, options, options_from, parts_run, parts_total, link, why, order_id'
const values = (id: string, q: ReturnType<typeof quoteOf>): unknown[] => [
  id, q.revision, q.fab, q.on, q.total, q.currency, q.quantity, JSON.stringify(q.lines), JSON.stringify(q.options), q.optionsFrom, q.partsRun, q.partsTotal, q.link, q.why, null,
]

/** Record a quote the person read off JLCPCB, in the journey record. Logged in the decisions. */
export function recordQuote(db: DatabaseSync, input: QuoteInput, d: QuoteDefaults, by: Signer): QuoteRow {
  if (!loadJourney(db)) throw new JourneyError('This project has not started its journey yet.')
  const q = quoteOf(input, d)
  const id = newId()
  const t = now()
  transaction(db, () => {
    db.prepare(`INSERT INTO quotes (${COLS}, by, at, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values(id, q) as never[], by.label, t, t)
    // the quote before it in time (a quote can be entered late, with its own date)
    const all = loadQuotes(db)
    const before = all.slice(0, all.findIndex((x) => x.id === id)).filter((x) => x.revision === q.revision).at(-1)
    decide(db, {
      kind: 'quote.recorded', stage: 'fabricate', ref: id, by: by.label,
      summary: `${q.fab} quote recorded: ${amount(q.total, q.currency)} for ${q.quantity} boards of ${q.revision}, quoted ${q.on}${before && before.currency === q.currency ? ` (${signed(q.total - before.total, q.currency)} on the quote before)` : ''}.`,
      detail: { total: q.total, currency: q.currency, quantity: q.quantity, on: q.on, ...(q.why ? { why: q.why } : {}) },
    })
  })
  return loadQuotes(db).find((x) => x.id === id) as QuoteRow
}

/** The figures in a person's words: "US$182.40", "182.4", "1,234.50". */
const figures = (s: string): number[] => [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replaceAll(',', ''))).filter((n) => Number.isFinite(n))

/**
 * Record a quote an agent heard from a person, in the agents' facts (an agent may not write the journey record). Only
 * from the person's words: they are kept with it, and the total must be a figure in them, so an agent cannot record a
 * price it worked out or guessed.
 */
export function recordAgentQuote(db: DatabaseSync, input: QuoteInput & { said: string }, d: QuoteDefaults, agent: { agent: string; label: string; jobId: string | null }): QuoteRow {
  const said = input.said.trim()
  if (said.length < 6) throw new JourneyError('Give the person\'s words the quote is from (said): an agent records a quote only from what a person told it.')
  if (!figures(said).some((n) => Math.abs(n - input.total) < 0.005)) throw new JourneyError(`The total ${input.total} is not in the person's words. Record only the figure the person gave; ask them (journey.ask) when it is not clear.`)
  const q = quoteOf(input, d)
  const id = newId()
  const t = now()
  db.prepare(`INSERT INTO agent_quotes (${COLS}, said, agent, by, job_id, at, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values(id, q) as never[], said, agent.agent, agent.label, agent.jobId, t, t)
  return loadAgentQuotes(db).find((x) => x.id === id) as QuoteRow
}

/**
 * Link an order to the quote it was placed against: the one named, else the newest quote of the order's revision
 * with no order yet. Returns the quote linked, or null when there is none. Only the person's quotes are linked (the
 * API may not write the agents' facts): a quote an agent recorded is entered by the person to link it.
 */
export function linkOrderQuote(db: DatabaseSync, order: Pick<OrderRow, 'id' | 'revision'>, quote?: string | undefined): QuoteRow | null {
  const qs = loadQuotes(db)
  const q = quote ? qs.find((x) => x.id === quote) : qs.filter((x) => x.revision === order.revision && (x.orderId === null || x.orderId === order.id)).at(-1)
  if (quote && !q) throw new JourneyError(`No quote ${quote} is recorded.`)
  if (!q) return null
  if (q.orderId === order.id) return q
  if (q.orderId !== null) throw new JourneyError(`Quote ${q.id} is already linked to another order.`)
  db.prepare('UPDATE quotes SET order_id=?, updated=? WHERE id=?').run(order.id, now(), q.id)
  return { ...q, orderId: order.id }
}

// ------------------------------------------------------------------ what changed between two quotes

export interface QuoteChange {
  /** the total's change, null when the two are in different currencies */
  amount: number | null
  /** per cent of the earlier total */
  pct: number | null
  /** what trace can tell changed, one sentence each */
  reasons: string[]
}

/** What changed from one quote to the next. Pure. */
export function quoteChanges(prev: QuoteRow, cur: QuoteRow): QuoteChange {
  const reasons: string[] = []
  const same = prev.currency === cur.currency
  if (!same) reasons.push(`In ${cur.currency}, not ${prev.currency}: the change is not worked out across currencies.`)
  if (prev.revision !== cur.revision) reasons.push(`Revision ${prev.revision} to ${cur.revision}.`)
  if (prev.quantity !== cur.quantity) reasons.push(`Quantity ${prev.quantity} to ${cur.quantity} boards.`)
  // the options: changed, added, dropped
  const was = new Map(prev.options.map((o) => [o.option, o.value]))
  const now_ = new Map(cur.options.map((o) => [o.option, o.value]))
  const moved: string[] = []
  for (const [k, v] of now_) {
    const w = was.get(k)
    if (w === undefined) { if (was.size) moved.push(`${k} ${v} added`) } else if (w !== v) moved.push(`${k} ${w} to ${v}`)
  }
  if (now_.size) for (const [k, w] of was) if (!now_.has(k)) moved.push(`${k} ${w} dropped`)
  if (moved.length) reasons.push(`Options changed: ${moved.slice(0, 6).join('; ')}${moved.length > 6 ? `; ${moved.length - 6} more` : ''}.`)
  // the parts at the checked prices, between the two parts checks
  if (same && prev.partsRun && cur.partsRun && prev.partsRun !== cur.partsRun && prev.partsTotal !== null && cur.partsTotal !== null) {
    const d = cents(cur.partsTotal - prev.partsTotal)
    reasons.push(d === 0 ? `Parts re-checked (${cur.partsRun}): no change at the checked prices.` : `Parts re-checked (${cur.partsRun}): ${signed(d, cur.currency)} at the checked prices.`)
  }
  // the breakdown lines, where both quotes give them
  if (same && prev.lines.length && cur.lines.length) {
    const a = new Map(prev.lines.map((l) => [l.kind, l.amount]))
    const b = new Map(cur.lines.map((l) => [l.kind, l.amount]))
    const parts: string[] = []
    for (const k of QUOTE_LINES) {
      const x = a.get(k)
      const y = b.get(k)
      if (x === undefined && y === undefined) continue
      const d = cents((y ?? 0) - (x ?? 0))
      if (d === 0) continue
      const word = QUOTE_LINE_WORDS[k]
      parts.push(x === undefined ? `${word} ${signed(d, cur.currency)} (new)` : y === undefined ? `${word} ${signed(d, cur.currency)} (gone)` : `${word} ${signed(d, cur.currency)}`)
    }
    if (parts.length) reasons.push(`${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()))
  }
  const change = same ? cents(cur.total - prev.total) : null
  return { amount: change, pct: change !== null && prev.total > 0 ? Math.round((change / prev.total) * 1000) / 10 : null, reasons }
}

// ------------------------------------------------------------------ the view

export interface QuoteView {
  id: string; on: string; at: string; total: number; currency: string; quantity: number; revision: string; fab: string
  lines: (QuoteLine & { label: string })[]; options: QuoteOption[]; optionsFrom: string | null; partsRun: string | null
  link: string | null; why: string | null; by: string
  /** recorded by an agent from the person's words */
  said?: string
  /** the change from the quote before (oldest first), with what trace can tell moved; null for the first */
  change: QuoteChange | null
  /** the order placed against it, and what was paid against the quote */
  order: { id: string; number: string; paid: number | null; difference: number | null } | null
}

/** Every quote as the screens and agents read it, newest first, each with its change from the one before. Pure. */
export function quoteViews(quotes: readonly QuoteRow[], orders: readonly Pick<OrderRow, 'id' | 'number' | 'paid' | 'currency'>[]): QuoteView[] {
  const sorted = [...quotes].sort(byTime)
  return sorted.map((q, i) => {
    const o = q.orderId ? orders.find((x) => x.id === q.orderId) ?? null : null
    return {
      id: q.id, on: q.on, at: new Date(q.at * 1000).toISOString(), total: q.total, currency: q.currency, quantity: q.quantity, revision: q.revision, fab: q.fab,
      lines: q.lines.map((l) => ({ ...l, label: QUOTE_LINE_WORDS[l.kind] })), options: q.options, optionsFrom: q.optionsFrom, partsRun: q.partsRun,
      link: q.link, why: q.why, by: q.by, ...(q.source === 'agent' && q.said ? { said: q.said } : {}),
      change: i > 0 ? quoteChanges(sorted[i - 1]!, q) : null,
      order: o ? { id: o.id, number: o.number, paid: o.paid, difference: o.paid !== null && o.currency === q.currency ? cents(o.paid - q.total) : null } : null,
    }
  }).reverse()
}
