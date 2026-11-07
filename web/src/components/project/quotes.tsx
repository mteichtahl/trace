/**
 * JLCPCB cost over time (the Build tab, from Fabricate on): every JLCPCB quote the person recorded, newest first, each
 * with its total, its change from the quote before and why (the person's note, and what trace can tell moved: build.get
 * quotes[].change), the order placed against it with what was paid against the quote; a small chart of the totals with
 * the order estimate's range as a band; and the form to record a quote read off JLCPCB (quote.record). trace never signs
 * in to JLCPCB: every figure here is what a person entered, or an agent recorded from a person's words (said so).
 *
 * A quote entered wrong is corrected (quote.correct: the form prefilled with it; the old one stays to see, marked
 * corrected), one recorded by mistake is withdrawn with the reason (quote.withdraw), and an agent's is confirmed into
 * the journey record (quote.confirm) so an order can be linked to it. Corrected and withdrawn quotes are kept out of
 * the chart and the changes. The form's options start from the quote before's, else the release package's (#241).
 */
import { ExternalLink, Loader2, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Section } from '@/components/shell/app-shell'
import { EmptyState } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { useCall } from '@/lib/queries'
import type { OrderView, QuoteInput, QuoteLineKind, QuoteView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { estimateRange, exact, signedMoney } from './order-sheet'

/** The breakdown lines, in the words JLCPCB's cart uses (src/core/quotes.ts QUOTE_LINE_WORDS). */
export const QUOTE_LINES: { kind: QuoteLineKind; label: string }[] = [
  { kind: 'pcb', label: 'PCB' }, { kind: 'assembly', label: 'Assembly and setup' }, { kind: 'components', label: 'Components' },
  { kind: 'extended', label: 'Extended-part fees' }, { kind: 'stencil', label: 'Stencil' }, { kind: 'shipping', label: 'Shipping' },
  { kind: 'tax', label: 'Tax and duty' }, { kind: 'other', label: 'Other' },
]

type Estimate = NonNullable<OrderView['estimate']>
type Option = { option: string; value: string }
/** what a new quote is for unless the person says otherwise: the release package's options among them */
export type QuoteDefaults = { quantity: number; currency: string; release: string; options: Option[] }

/** A quote that counts: not corrected by another and not withdrawn. */
export const counts = (q: Pick<QuoteView, 'correctedBy' | 'withdrawn'>): boolean => !q.correctedBy && !q.withdrawn
/** A reason as the person wrote it, without its own full stop (the sentence adds one). */
const stop = (s: string): string => s.trim().replace(/[.]+$/, '')
const INVALIDATES = (a: { repo: string }): unknown[][] => [['build.get', a.repo], ['cost.get', a.repo], ['skill.get', a.repo], ['journey.get', a.repo]]

/** "−US$1.80 (−1.5%)" from the quote before, or null for the first (or across currencies). */
export function changeWords(q: Pick<QuoteView, 'change' | 'currency'>): string | null {
  const c = q.change
  if (!c || c.amount === null) return null
  if (c.amount === 0) return 'no change'
  return `${signedMoney(c.amount, q.currency)}${c.pct !== null ? ` (${c.pct > 0 ? '+' : c.pct < 0 ? '−' : ''}${Math.abs(c.pct)}%)` : ''}`
}

export function QuoteHistory({ repo, quotes, estimate, defaults, className }: {
  repo: string
  quotes: QuoteView[]
  estimate?: Estimate | null
  defaults: QuoteDefaults
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // the quote being corrected
  const [editing, setEditing] = useState<QuoteView | null>(null)
  const live = quotes.filter(counts)
  return (
    <Section
      label="JLCPCB cost over time" count={live.length} className={className}
      action={!open && !editing && <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus /> Record a quote</Button>}
    >
      {(open || editing) && <RecordQuote key={editing?.id ?? 'new'} repo={repo} defaults={defaults} quotes={quotes} editing={editing} onDone={() => { setOpen(false); setEditing(null) }} />}
      {quotes.length === 0 ? (
        !open && <EmptyState>No quote yet. Upload the package on JLCPCB, then record the total it shows here. Every quote is kept, so you can see how the cost moves and why.</EmptyState>
      ) : (
        <div className="space-y-4">
          {live.length > 1 && <QuoteChart quotes={live} estimate={estimate ?? null} />}
          <ol className="divide-y rounded-xl border" aria-label="Quotes, newest first">
            {quotes.map((q) => <QuoteItem key={q.id} repo={repo} q={q} onCorrect={() => { setOpen(false); setEditing(q) }} />)}
          </ol>
        </div>
      )}
    </Section>
  )
}

function QuoteItem({ repo, q, onCorrect }: { repo: string; q: QuoteView; onCorrect: () => void }) {
  const change = changeWords(q)
  const up = (q.change?.amount ?? 0) > 0
  const live = counts(q)
  const confirm = useCall('quote.confirm', INVALIDATES)
  const withdraw = useCall('quote.withdraw', INVALIDATES)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  return (
    <li className={cn('px-5 py-4 text-sm', !live && 'bg-muted/40')}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cn('text-base font-semibold', !live && 'text-muted-foreground line-through')}>{exact(q.total, q.currency)}</span>
        <span className="text-muted-foreground">{q.on} · {q.quantity} boards of {q.revision}</span>
        {q.withdrawn && <StatusBadge plain status="waived" label="Withdrawn" />}
        {q.correctedBy && <StatusBadge plain status="waived" label="Corrected" />}
        {q.agent && <StatusBadge plain status="yours" label="Not confirmed yet" />}
        {change && <span className={cn('font-medium', up ? 'text-destructive' : 'text-verified')}>{change} on the quote before</span>}
        {q.link && (/^https?:\/\//.test(q.link)
          ? <a href={q.link} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">On JLCPCB <ExternalLink className="size-3" aria-hidden /></a>
          : <span className="ml-auto font-mono text-xs text-muted-foreground">{q.link}</span>)}
      </div>
      {q.withdrawn && <p className="mt-1.5">Withdrawn by {q.withdrawn.by}: {stop(q.withdrawn.reason)}. Kept to see, out of the totals.</p>}
      {q.correctedBy && <p className="mt-1.5">Entered wrong and corrected: the correction takes its place in the totals. Kept to see as it was entered.</p>}
      {q.corrects && <p className="mt-1.5">Corrects the entry of {exact(q.corrects.total, q.currency)} for {q.corrects.on}{q.corrects.reason ? `: ${stop(q.corrects.reason)}` : ''} ({q.corrects.by}).</p>}
      {(q.why || q.change?.reasons.length) ? (
        <dl className="mt-2 space-y-1">
          {q.why && <div className="sm:flex sm:gap-2"><dt className="shrink-0 text-xs text-muted-foreground sm:w-28 sm:text-sm">Why</dt><dd>{q.why}</dd></div>}
          {q.change?.reasons.length ? (
            <div className="sm:flex sm:gap-2"><dt className="shrink-0 text-xs text-muted-foreground sm:w-28 sm:text-sm">What changed</dt><dd><ul className="space-y-0.5">{q.change.reasons.map((r) => <li key={r}>{r}</li>)}</ul></dd></div>
          ) : null}
        </dl>
      ) : null}
      {q.lines.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{q.lines.map((l) => `${l.label} ${exact(l.amount, q.currency)}`).join(' · ')}</p>
      )}
      {q.order && (
        <p className="mt-1.5 text-xs">
          Order <span className="font-mono">{q.order.number}</span> was placed against it
          {q.order.paid !== null ? `: ${exact(q.order.paid, q.currency)} paid${q.order.difference !== null ? `, ${q.order.difference === 0 ? 'the same as the quote' : `${signedMoney(q.order.difference, q.currency)} on the quote`}` : ''}.` : ', cost not given.'}
        </p>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {q.said ? <>Recorded by {q.by} from your words: “{q.said}”</> : <>Recorded by {q.by}</>}
        {q.confirmedBy ? `, confirmed by ${q.confirmedBy}` : ''}
        {q.optionsFrom ? ' · for the release package\'s options' : q.options.length ? ` · for the options given with it (${q.options.length})` : ''}
      </p>
      {q.agent && <p className="mt-1.5 text-xs">An agent recorded this from your words. Confirm it to keep it in the project's record, so the order can be linked to it.</p>}
      {live && (asking ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2" aria-label={`Withdraw the quote of ${q.on}`}
          onSubmit={(e) => {
            e.preventDefault()
            withdraw.mutate({ repo, quote: q.id, reason: reason.trim() }, {
              onSuccess: () => { toast('Quote withdrawn.', { description: 'It is kept to see, out of the totals.' }); setAsking(false) },
              onError: (er) => toast.error('Could not withdraw the quote.', { description: String(er) }),
            })
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5"><Label htmlFor={`withdraw-${q.id}`}>Why is it withdrawn?</Label><Input id={`withdraw-${q.id}`} value={reason} placeholder="e.g. Entered for the wrong board" onChange={(e) => setReason(e.target.value)} /></div>
          <Button type="submit" size="sm" variant="destructive" disabled={reason.trim().length < 3 || withdraw.isPending}>{withdraw.isPending && <Loader2 className="animate-spin" />}Withdraw quote</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
        </form>
      ) : (
        <div className={cn('mt-2 flex flex-wrap gap-1', !q.agent && '-ml-3')}>
          {q.agent && (
            <Button
              size="sm" variant="outline" disabled={confirm.isPending}
              onClick={() => confirm.mutate({ repo, quote: q.id }, { onSuccess: () => toast('Quote confirmed.', { description: 'It is in the project\'s record now; the order can be linked to it.' }), onError: (er) => toast.error('Could not confirm the quote.', { description: String(er) }) })}
            >{confirm.isPending && <Loader2 className="animate-spin" />}Confirm</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onCorrect}>Correct</Button>
          {/* a quote an order was placed against is corrected, not withdrawn */}
          {!q.order && <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>Withdraw</Button>}
        </div>
      ))}
    </li>
  )
}

// ------------------------------------------------------------------ the chart

const H = 150
const PAD = { l: 52, r: 12, t: 12, b: 24 }

/** The totals over time, oldest on the left, with the order estimate's range as a band when it is in the same currency. */
export function QuoteChart({ quotes, estimate }: { quotes: QuoteView[]; estimate: Estimate | null }) {
  // drawn at the width it has, so the words stay their size on a phone
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(560)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setW(Math.round(e.contentRect.width)) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const pts = [...quotes].reverse()
  const cur = pts[pts.length - 1]!.currency
  const mine = pts.filter((q) => q.currency === cur)
  const band = estimate && estimate.currency === cur ? estimate : null
  const values = [...mine.map((q) => q.total), ...(band ? [band.low, band.high] : [])]
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || hi || 1
  const yMin = Math.max(0, lo - span * 0.15)
  const yMax = hi + span * 0.15
  const t = (q: QuoteView) => Date.parse(`${q.on}T00:00:00Z`)
  const t0 = t(mine[0]!)
  const t1 = t(mine[mine.length - 1]!)
  const x = (q: QuoteView, i: number) => PAD.l + (t1 > t0 ? (t(q) - t0) / (t1 - t0) : mine.length > 1 ? i / (mine.length - 1) : 0.5) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b)
  const line = mine.map((q, i) => `${i ? 'L' : 'M'}${x(q, i).toFixed(1)},${y(q.total).toFixed(1)}`).join(' ')
  return (
    <figure className="rounded-xl border p-4">
      <div ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label={`JLCPCB total per quote: ${mine.map((q) => `${q.on} ${exact(q.total, cur)}`).join(', ')}${band ? `; the estimate ${estimateRange(band)}` : ''}`}>
        {band && (
          <g>
            <rect x={PAD.l} width={W - PAD.l - PAD.r} y={y(band.high)} height={Math.max(1, y(band.low) - y(band.high))} className="fill-muted" />
            <text x={PAD.l + 6} y={y(band.low) - 5} className="fill-muted-foreground text-[11px]">Estimate {estimateRange(band)}</text>
          </g>
        )}
        {[yMin, (yMin + yMax) / 2, yMax].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="stroke-border" strokeDasharray="2 3" />
            <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground text-[11px]">{exact(v, cur).replace(/\.\d\d$/, '')}</text>
          </g>
        ))}
        <path d={line} fill="none" className="stroke-primary" strokeWidth={2} />
        {mine.map((q, i) => (
          <g key={q.id}>
            <circle cx={x(q, i)} cy={y(q.total)} r={4} className="fill-primary" />
            <text x={x(q, i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === mine.length - 1 ? 'end' : 'middle'} className="fill-muted-foreground text-[11px]">{q.on.slice(5)}</text>
          </g>
        ))}
      </svg>
      </div>
      <figcaption className="mt-1 text-xs text-muted-foreground">Total per quote{band ? ', with the order estimate as the shaded band' : ''}{mine.length < pts.length ? `. Quotes in other currencies are left out of the chart.` : '.'}</figcaption>
    </figure>
  )
}

// ------------------------------------------------------------------ recording a quote

const today = (): string => new Date().toISOString().slice(0, 10)

/**
 * The form's fields as quote.record takes them: amounts as numbers, blank lines left out, and the options only when
 * given (else the quote before's, or the release package's, stand). Null with why when not valid.
 */
export function quoteArgs(f: { on: string; total: string; currency: string; quantity: string; lines: Partial<Record<QuoteLineKind, string>>; link: string; why: string; options?: Option[] | undefined }): { args: QuoteInput } | { problem: string } {
  const total = Number(f.total)
  if (!f.total.trim() || !(total > 0)) return { problem: 'Give the total JLCPCB shows.' }
  const quantity = Number(f.quantity)
  if (!Number.isInteger(quantity) || quantity < 1) return { problem: 'Give how many boards it is for.' }
  const lines: NonNullable<QuoteInput['lines']> = []
  for (const { kind, label } of QUOTE_LINES) {
    const v = f.lines[kind]?.trim()
    if (!v) continue
    const n = Number(v)
    if (!Number.isFinite(n)) return { problem: `${label} is not an amount.` }
    lines.push({ kind, amount: n })
  }
  const sum = lines.reduce((n, l) => n + l.amount, 0)
  if (lines.length && sum > total + 0.01) return { problem: `The lines add up to ${sum.toFixed(2)}, more than the total.` }
  let options: Option[] | undefined
  if (f.options) {
    options = []
    const seen = new Set<string>()
    for (const o of f.options) {
      const option = o.option.trim()
      const value = o.value.trim()
      if (!option && !value) continue
      if (!option) return { problem: `Name the option with the value ${value}.` }
      if (!value) return { problem: `Give a value for ${option}.` }
      if (seen.has(option.toLowerCase())) return { problem: `${option} is given twice.` }
      seen.add(option.toLowerCase())
      options.push({ option, value })
    }
  }
  return {
    args: {
      on: f.on || today(), total, currency: f.currency.trim().toUpperCase() || undefined, quantity, ...(lines.length ? { lines } : {}), ...(options ? { options } : {}),
      ...(f.link.trim() ? { link: f.link.trim() } : {}), ...(f.why.trim() ? { why: f.why.trim() } : {}),
    },
  }
}

/** The same options, in any order. */
const sameOptions = (a: Option[], b: Option[]): boolean => a.length === b.length && a.every((o) => b.some((x) => x.option === o.option && x.value === o.value))

export function RecordQuote({ repo, defaults, quotes = [], editing = null, onDone }: {
  repo: string; defaults: QuoteDefaults; quotes?: QuoteView[]
  /** the quote being corrected: the form starts from it */
  editing?: QuoteView | null
  onDone: () => void
}) {
  const record = useCall('quote.record', INVALIDATES)
  const correct = useCall('quote.correct', INVALIDATES)
  const busy = record.isPending || correct.isPending
  // the options a quote is for unless changed: the one corrected, else the quote before's, else the release package's
  const before = quotes.find(counts)
  const startOptions = editing?.options ?? (before?.options.length ? before.options : defaults.options)
  const from = editing ? 'the quote as entered' : before?.options.length ? 'the quote before' : 'the release package'
  const [f, setF] = useState(() => (editing
    ? {
        on: editing.on, total: editing.total.toFixed(2), currency: editing.currency, quantity: String(editing.quantity),
        lines: Object.fromEntries(editing.lines.map((l) => [l.kind, String(l.amount)])) as Partial<Record<QuoteLineKind, string>>, link: editing.link ?? '', why: editing.why ?? '',
      }
    : { on: today(), total: '', currency: defaults.currency, quantity: String(defaults.quantity), lines: {} as Partial<Record<QuoteLineKind, string>>, link: '', why: '' }))
  const [opts, setOpts] = useState<Option[]>(startOptions)
  const [reason, setReason] = useState('')
  const [shown, setShown] = useState(!!editing?.lines.length)
  const [optsShown, setOptsShown] = useState(false)
  // the options are sent when changed (else the server keeps the same ones), or when they are an agent's quote's
  const changedOpts = !sameOptions(opts.filter((o) => o.option.trim() || o.value.trim()).map((o) => ({ option: o.option.trim(), value: o.value.trim() })), startOptions)
  const out = quoteArgs({ ...f, options: changedOpts || (!editing && before?.agent) ? opts : undefined })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const setOpt = (i: number, k: keyof Option) => (e: { target: { value: string } }) => setOpts((xs) => xs.map((o, j) => (j === i ? { ...o, [k]: e.target.value } : o)))
  const failed = (er: unknown) => toast.error(`Could not ${editing ? 'save the correction' : 'record the quote'}. What you typed is kept.`, { description: String(er) })
  return (
    <form
      className="mb-4 space-y-4 rounded-xl border border-primary/40 p-5 text-sm" aria-label={editing ? 'Correct a JLCPCB quote' : 'Record a JLCPCB quote'}
      onSubmit={(e) => {
        e.preventDefault()
        if ('problem' in out) return
        if (editing) {
          correct.mutate({ repo, quote: editing.id, ...out.args, ...(reason.trim() ? { reason: reason.trim() } : {}) }, {
            onSuccess: (r) => { toast('Quote corrected.', { description: `${exact(r.quote.total, r.quote.currency)} takes the place of ${exact(editing.total, editing.currency)}, which is kept to see.` }); onDone() },
            onError: failed,
          })
          return
        }
        record.mutate({ repo, ...out.args }, {
          onSuccess: (r) => { toast('Quote recorded.', { description: r.quote.change ? `${exact(r.quote.total, r.quote.currency)}, ${changeWords(r.quote) ?? 'not compared'} on the quote before.` : `${exact(r.quote.total, r.quote.currency)}: the order's cost is now this quote.` }); onDone() },
          onError: failed,
        })
      }}
    >
      <div>
        <h3 className="font-semibold">{editing ? `Correct the quote of ${editing.on}` : 'Record a JLCPCB quote'}</h3>
        <p className="mt-0.5 text-muted-foreground">
          {editing
            ? `Fix what was entered wrong. The quote as entered (${exact(editing.total, editing.currency)}) is kept to see, marked corrected; this one takes its place in the totals${editing.order ? ' and stays linked to the order' : ''}.`
            : <>Read it off JLCPCB's cart: trace never signs in there. It is for {defaults.release}{opts.length ? ` with ${opts.length} option${opts.length === 1 ? '' : 's'} from ${from}` : ''}.</>}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1.5"><Label htmlFor="quote-on">Date</Label><Input id="quote-on" type="date" value={f.on} max={today()} onChange={set('on')} /></div>
        <div className="space-y-1.5"><Label htmlFor="quote-total">Total</Label><Input id="quote-total" inputMode="decimal" placeholder="e.g. 182.40" value={f.total} onChange={set('total')} /></div>
        <div className="space-y-1.5"><Label htmlFor="quote-currency">Currency</Label><Input id="quote-currency" value={f.currency} maxLength={3} className="uppercase" onChange={set('currency')} /></div>
        <div className="space-y-1.5"><Label htmlFor="quote-qty">Boards</Label><Input id="quote-qty" inputMode="numeric" value={f.quantity} onChange={set('quantity')} /></div>
      </div>
      {shown ? (
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">The breakdown, as far as JLCPCB shows it (leave a line blank to skip it; a discount goes in Other, below zero)</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {QUOTE_LINES.map(({ kind, label }) => (
              <div key={kind} className="space-y-1"><Label htmlFor={`quote-${kind}`} className="text-xs">{label}</Label><Input id={`quote-${kind}`} inputMode="decimal" value={f.lines[kind] ?? ''} onChange={(e) => setF((x) => ({ ...x, lines: { ...x.lines, [kind]: e.target.value } }))} /></div>
            ))}
          </div>
        </fieldset>
      ) : (
        <Button type="button" variant="link" className="h-auto whitespace-normal p-0 text-left text-xs" onClick={() => setShown(true)}>Add the breakdown (PCB, assembly, components, shipping …)</Button>
      )}
      {optsShown ? (
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">The options it is for, from {from}. Change what JLCPCB quoted differently; a blank row is left out.</legend>
          <ul className="space-y-2" aria-label="Options">
            {opts.map((o, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input aria-label={`Option ${i + 1}`} value={o.option} placeholder="Option" className="min-w-0 flex-1" onChange={setOpt(i, 'option')} />
                <Input aria-label={`Value of ${o.option || `option ${i + 1}`}`} value={o.value} placeholder="Value" className="min-w-0 flex-1" onChange={setOpt(i, 'value')} />
                <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${o.option || `option ${i + 1}`}`} onClick={() => setOpts((xs) => xs.filter((_, j) => j !== i))}><X /></Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="link" className="h-auto whitespace-normal p-0 text-left text-xs" onClick={() => setOpts((xs) => [...xs, { option: '', value: '' }])}>Add an option</Button>
            {changedOpts && <Button type="button" variant="link" className="h-auto whitespace-normal p-0 text-left text-xs" onClick={() => setOpts(startOptions)}>Undo the changes</Button>}
          </div>
        </fieldset>
      ) : (
        <Button type="button" variant="link" className="h-auto whitespace-normal p-0 text-left text-xs" onClick={() => setOptsShown(true)}>{opts.length ? `Change the options (${opts.length}, from ${from})` : 'Add the options it is for'}</Button>
      )}
      <div className="space-y-1.5"><Label htmlFor="quote-link">JLCPCB link or reference (optional)</Label><Input id="quote-link" value={f.link} placeholder="https://cart.jlcpcb.com/… or the quote number" onChange={set('link')} /></div>
      <div className="space-y-1.5"><Label htmlFor="quote-why">Why (optional)</Label><Textarea id="quote-why" rows={2} value={f.why} placeholder="e.g. Quoted again after switching to ENIG" onChange={set('why')} /></div>
      {editing && <div className="space-y-1.5"><Label htmlFor="quote-reason">What was wrong (optional)</Label><Input id="quote-reason" value={reason} placeholder="e.g. Typed 1105 for 110.50" onChange={(e) => setReason(e.target.value)} /></div>}
      {'problem' in out && f.total.trim() !== '' && <p className="text-xs text-destructive">{out.problem}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={'problem' in out || busy}>{busy && <Loader2 className="animate-spin" />}{editing ? 'Save the correction' : 'Record quote'}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  )
}
