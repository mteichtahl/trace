/**
 * Cloud spend in words and numbers (Cost and time, Admin › Usage and cost): the estimate by kind (agents, graphics
 * card jobs, CPU jobs) from the cost ledger, what AWS billed beside it from Cost Explorer, and the two things a person
 * must know to read them: estimates are priced from a dated table (the AWS price list, fetched daily, or the built-in
 * table when it could not be), and AWS's figures arrive about a day late and count only what carries the project's
 * tag. Admin-only, like every amount (the screens that use it check).
 */
import { Info } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { ago, money, until } from '@/lib/format'
import type { CloudSpend, ExplorerView, PricesView } from '@/lib/types-s1'

const KINDS: { id: keyof Omit<CloudSpend['estimated'], 'total'>; label: string }[] = [
  { id: 'agents', label: 'Agents (Claude)' },
  { id: 'gpu', label: 'Graphics card jobs' },
  { id: 'cpu', label: 'CPU jobs' },
]

/** The badge beside the prices' line: from the AWS price list (when fetched), or the built-in table, or a warning
 * (the fetch failed, the table is old). Pure. */
export function pricesLine(p: PricesView | undefined, now = Date.now()): { status: 'met' | 'waiting' | 'warning'; label: string } {
  if (!p) return { status: 'waiting', label: 'Price table' }
  // answers of before the price list: only the date and whether it is old
  if (!p.source) return p.stale ? { status: 'warning', label: 'Price table more than six months old' } : { status: 'met', label: `Price table of ${p.asOf}` }
  const status = p.status ?? (p.stale ? 'warning' : 'met')
  if (p.source === 'price-list') return { status, label: p.failed ? 'Price list fetch failed' : `AWS price list, fetched ${p.fetchedAt ? ago(p.fetchedAt, now) : p.asOf}` }
  return { status, label: p.failed ? 'Built-in prices: fetch failed' : 'Built-in prices' }
}

/** The line under AWS's figure: when Cost Explorer read, when it reads next, whether the tag is active. Pure. */
export function explorerLine(e: ExplorerView | undefined, now = Date.now()): { status: 'met' | 'waiting' | 'warning'; label: string; text: string } {
  if (!e) return { status: 'waiting', label: 'Not read yet', text: 'What AWS billed is read once a day from Cost Explorer; figures lag about 24 hours.' }
  if (e.ok) return { status: 'met', label: `Read ${e.checkedAt ? ago(e.checkedAt, now) : ''}`.trim(), text: `${e.nextAt ? `Next read ${until(e.nextAt, now)}. ` : ''}AWS's figures arrive about 24 hours late.` }
  return { status: e.tag === 'inactive' ? 'warning' : 'waiting', label: e.tag === 'inactive' ? 'Tag not active' : 'Not read yet', text: e.text }
}

export function CloudBreakdown({ detail, currency, explorer, prices }: { detail: CloudSpend; currency: string; explorer?: ExplorerView | undefined; prices?: PricesView | undefined }) {
  const ex = explorerLine(explorer)
  const pl = pricesLine(prices)
  return (
    <section className="mt-4 grid gap-3 md:grid-cols-2" aria-label="Cloud use">
      <div className="rounded-xl border p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Cloud use, estimated</h3>
          <span className="text-sm font-semibold">{money(detail.estimated.total, currency)}</span>
        </div>
        <dl className="mt-3 space-y-1.5 text-sm">
          {KINDS.map((k) => (
            <div key={k.id} className="flex justify-between"><dt className="text-muted-foreground">{k.label}</dt><dd>{money(detail.estimated[k.id], currency)}</dd></div>
          ))}
        </dl>
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{prices?.text ?? 'Each run\'s tokens and each job\'s running time, priced from the price table.'}</span>
        </p>
        {prices && <p className="mt-1.5"><StatusBadge plain status={pl.status} label={pl.label} /></p>}
      </div>
      <div className="rounded-xl border p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Billed by AWS</h3>
          <span className="text-sm font-semibold">{detail.actual ? money(detail.actual.total, currency) : 'not yet'}</span>
        </div>
        {detail.actual && Object.keys(detail.actual.byService).length > 0 ? (
          <dl className="mt-3 space-y-1.5 text-sm">
            {Object.entries(detail.actual.byService).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, v]) => (
              <div key={s} className="flex justify-between gap-3"><dt className="truncate text-muted-foreground">{s}</dt><dd>{money(v, currency)}</dd></div>
            ))}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Nothing billed with this project's tag yet.</p>
        )}
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge plain status={ex.status} label={ex.label} />
          <span>{ex.text}{detail.actual?.through ? ` Through ${detail.actual.through}${detail.actual.estimatedDays ? `; ${detail.actual.estimatedDays} recent day${detail.actual.estimatedDays === 1 ? '' : 's'} may still change` : ''}.` : ''}</span>
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">Counts the project's own tagged resources (its agent runtime, memory, runner). Model use and the shared job machines are not tagged per project, so the estimate is the figure for those.</p>
      </div>
    </section>
  )
}
