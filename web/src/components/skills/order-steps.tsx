/**
 * Order submit's steps (docs/user-journey.md, "Order submit"; test-esp32 #225): what the record holds for each, so no
 * step reads "trace has nothing open". Re-check stock shows today's parts check with what changed since the release
 * approval; Download the package lists the package's files, the ones to upload first, each opening in the app; Enter
 * the options lists each option with where it comes from and an "Entered" tick; Review JLCPCB's part matching lists
 * each line with its LCSC part, confirmed matched or marked not placed by JLCPCB; Pay and record points at the order
 * gate and the order form on the Build page. Where the record has nothing for a step, it says what makes it.
 */
import { Link } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { EvidenceChip } from '@/components/evidence-chip'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/states'
import { fileHref } from '@/components/files/data'
import { projectId } from '@/lib/api'
import type { OrderSheetView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export const ORDER_STEPS = ['stock', 'package', 'options', 'matching', 'pay'] as const

export interface OrderDraft { entered?: string[]; matched?: string[]; unplaced?: string[] }

/** The bar's checks the screen works out from the draft as it is ticked (the record agrees once saved). Pure. */
export function orderChecks(v: OrderSheetView | undefined, d: OrderDraft): Record<string, 'met' | 'not_met'> {
  const out: Record<string, 'met' | 'not_met'> = {}
  if (v?.board_run && v.options.length) out.options = v.options.every((o) => (d.entered ?? []).includes(o.id)) ? 'met' : 'not_met'
  if (v?.lines.length) out.matching = v.lines.every((l) => (d.matched ?? []).includes(l.key) || (d.unplaced ?? []).includes(l.key)) ? 'met' : 'not_met'
  return out
}

const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const run = (id: string, label = `run ${id.replace(/^run_/, '').slice(0, 8)}`) => <EvidenceChip evidence={{ kind: 'run', id, label }} />
const price = (n: number | null): string => (n === null ? 'not known' : n < 1 ? n.toFixed(4) : n.toFixed(2))
const size = (n: number | null): string => (n === null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`)
const toggle = (xs: string[] | undefined, k: string): string[] => ((xs ?? []).includes(k) ? (xs ?? []).filter((x) => x !== k) : [...(xs ?? []), k])

export function OrderStep({ repo, step, view, draft, setDraft, loading }: { repo: string; step: string; view?: OrderSheetView; draft: OrderDraft; setDraft: (fn: (d: OrderDraft) => OrderDraft) => void; loading: boolean }) {
  if (!(ORDER_STEPS as readonly string[]).includes(step)) return null
  const body = !view ? <EmptyState className="mt-2">{loading ? 'Loading what trace prepared…' : 'trace could not read the record for this step.'}</EmptyState>
    : step === 'stock' ? <Stock v={view.stock} />
    : step === 'package' ? <Package repo={repo} v={view.package} />
    : step === 'options' ? <Options v={view} entered={draft.entered ?? []} toggle={(id) => setDraft((d) => ({ ...d, entered: toggle(d.entered, id) }))} />
    : step === 'matching' ? <Matching v={view} draft={draft} setDraft={setDraft} />
    : <Pay repo={repo} v={view.pay} />
  return <section className="mt-6" aria-labelledby="order-step"><h2 id="order-step" className="text-base font-semibold">For this step</h2>{body}</section>
}

function Stock({ v }: { v: OrderSheetView['stock'] }) {
  if (!v) return <EmptyState className="mt-2">No parts check is recorded yet: trace re-checks stock and prices (parts.bom_check) when Fabricate opens.</EmptyState>
  const c = v.currency ?? ''
  return (
    <div className="mt-2 space-y-3">
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <p className="rounded-lg border px-3 py-2"><span className="block text-xs text-muted-foreground">Checked</span>{v.today ? 'Today' : day(v.at)}{!v.today && <span className="block text-xs text-warning-foreground">Not today: check it again before ordering.</span>}</p>
        <p className="rounded-lg border px-3 py-2"><span className="block text-xs text-muted-foreground">Parts for {v.boards ?? v.build_quantity} boards</span>{v.total === null ? 'not known' : `${c} ${v.total.toFixed(2)}`}{v.signed?.total != null && v.total !== null && v.signed.total !== v.total && <span className="block text-xs text-muted-foreground">{c} {v.signed.total.toFixed(2)} at sign-off</span>}</p>
        <p className="rounded-lg border px-3 py-2"><span className="block text-xs text-muted-foreground">Stock</span>{v.blocking ? `${v.blocking} of ${v.lines.length} lines out, short or not found.` : `Every line in stock (${v.lines.length} lines).`}</p>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {v.signed ? `${v.changed ? `${v.changed} ${v.changed === 1 ? 'line changed' : 'lines changed'}` : 'Nothing changed'} since the parts check of ${day(v.signed.at)} the release was approved on.` : 'No parts check before the release approval to compare with.'} {run(v.run)}
      </p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-3 py-2 font-medium">Part</th><th className="px-3 py-2 font-medium">Stock</th><th className="px-3 py-2 font-medium">Unit price</th><th className="px-3 py-2 font-medium">Since sign-off</th></tr></thead>
          <tbody className="divide-y">
            {v.lines.map((l) => (
              <tr key={l.key} className={cn(l.change && 'bg-warning/5')}>
                <td className="px-3 py-2"><span className="font-mono text-xs">{l.mpn ?? `line ${l.line}`}</span><span className="block text-xs text-muted-foreground">{[l.refs, l.lcsc].filter(Boolean).join(' · ')}</span></td>
                <td className="px-3 py-2">{l.stock === null ? 'not known' : `${l.stock.toLocaleString()} for ${l.need}`}{l.status !== 'ok' && <span className="block text-xs text-destructive">{l.status}</span>}</td>
                <td className="px-3 py-2">{price(l.unit_price)}</td>
                <td className="px-3 py-2 text-xs">{l.change === 'new' ? 'Not in that check' : l.change === 'price' ? `Was ${price(l.was_price)}` : l.change === 'status' ? `Was ${l.was_status}` : v.signed ? 'Unchanged' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Package({ repo, v }: { repo: string; v: OrderSheetView['package'] }) {
  if (!v) return <EmptyState className="mt-2">No release package is recorded yet: trace builds it (kicad.fab) when Fabricate opens.</EmptyState>
  const upload = v.files.filter((f) => f.upload)
  const rest = v.files.filter((f) => !f.upload)
  const item = (f: NonNullable<OrderSheetView['package']>['files'][number]) => (
    <li key={f.path} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
      {f.repo_path ? <a className="min-w-0 flex-1 font-mono text-xs text-primary hover:underline" href={fileHref({ repo, path: f.repo_path })}>{f.path}</a> : <span className="min-w-0 flex-1 font-mono text-xs">{f.path}</span>}
      <span className="text-xs text-muted-foreground">{size(f.bytes)}</span>
    </li>
  )
  return (
    <div className="mt-2 space-y-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={v.problems.length ? 'failing' : 'clean'} label={v.problems.length ? `${v.problems.length} problems` : 'No problems'} />
        <span className="text-muted-foreground">{v.dir ? <>In <span className="font-mono text-xs">{v.dir}</span></> : 'Written to a work folder, not the repository'} · {day(v.at)}{v.placements !== null ? ` · ${v.placements} parts placed` : ''}</span>
        {run(v.run)}
      </p>
      {v.problems.length > 0 && <ul className="ml-5 list-disc text-sm text-destructive">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {upload.length > 0 && (
        <div className="rounded-xl border">
          <p className="flex items-center gap-2 border-b px-4 py-2 text-sm font-medium"><Download className="size-4" aria-hidden />Upload to JLCPCB</p>
          <ul className="divide-y">{upload.map(item)}</ul>
        </div>
      )}
      {rest.length > 0 && (
        <details className="rounded-xl border">
          <summary className="cursor-pointer px-4 py-2 text-sm">The other {rest.length} files</summary>
          <ul className="divide-y border-t">{rest.map(item)}</ul>
        </details>
      )}
      {v.hand_placed && v.hand_placed.length > 0 && <p className="text-sm">Placed by hand, not by JLCPCB: {v.hand_placed.join(', ')}.</p>}
    </div>
  )
}

function Options({ v, entered, toggle: tick }: { v: OrderSheetView; entered: string[]; toggle: (id: string) => void }) {
  if (!v.board_run) return <EmptyState className="mt-2">No board check (kicad.board) is recorded yet, so the board's own options are not known: trace reads the board when it builds the package.</EmptyState>
  const groups = [['board', 'PCB'], ['assembly', 'PCB assembly']] as const
  return (
    <div className="mt-2 space-y-3">
      <p className="text-sm text-muted-foreground">Enter each option on JLCPCB's order page as it is here, then tick it.</p>
      {groups.map(([g, title]) => {
        const opts = v.options.filter((o) => o.group === g)
        if (!opts.length) return null
        return (
          <div key={g} className="overflow-x-auto rounded-xl border">
            <p className="border-b px-4 py-2 text-sm font-medium">{title}</p>
            <ul className="divide-y">
              {opts.map((o) => (
                <li key={o.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-2 text-sm', !o.decided && 'bg-warning/5')}>
                  <span className="min-w-0 flex-1">{o.label}: <span className="font-medium">{o.value}</span><span className="block text-xs text-muted-foreground">{o.source}</span></span>
                  <label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={entered.includes(o.id)} onChange={() => tick(o.id)} />Entered</label>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function Matching({ v, draft, setDraft }: { v: OrderSheetView; draft: OrderDraft; setDraft: (fn: (d: OrderDraft) => OrderDraft) => void }) {
  if (!v.lines.length) return <EmptyState className="mt-2">No parts list is recorded yet: the package's parts list (kicad.fab) gives each line's LCSC part.</EmptyState>
  const set = (key: string, to: 'matched' | 'unplaced' | null) => setDraft((d) => ({
    ...d, matched: (d.matched ?? []).filter((x) => x !== key).concat(to === 'matched' ? [key] : []), unplaced: (d.unplaced ?? []).filter((x) => x !== key).concat(to === 'unplaced' ? [key] : []),
  }))
  return (
    <div className="mt-2 space-y-3">
      <p className="text-sm text-muted-foreground">After uploading the parts list, check that JLCPCB matched each line to this LCSC part. A line it will not place is fitted by hand at Incoming inspection.</p>
      {v.lines_from === 'parts' && <p className="text-xs text-muted-foreground">From the newest parts check: no package parts list is recorded.</p>}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-3 py-2 font-medium">Designators</th><th className="px-3 py-2 font-medium">Part</th><th className="px-3 py-2 font-medium">LCSC</th><th className="px-3 py-2 font-medium">On JLCPCB</th></tr></thead>
          <tbody className="divide-y">
            {v.lines.map((l) => {
              const state = (draft.matched ?? []).includes(l.key) ? 'matched' : (draft.unplaced ?? []).includes(l.key) ? 'unplaced' : null
              return (
                <tr key={l.key}>
                  <td className="px-3 py-2">{l.refs}{l.qty !== null && <span className="block text-xs text-muted-foreground">{l.qty} per board</span>}</td>
                  <td className="px-3 py-2"><span className="font-mono text-xs">{l.mpn ?? l.value ?? ''}</span>{l.value && l.mpn && l.value !== l.mpn && <span className="block text-xs text-muted-foreground">{l.value}</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.lcsc ?? <span className="font-sans text-destructive">none</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-3 text-xs">
                      <label className="inline-flex items-center gap-1.5"><input type="radio" name={`match-${l.key}`} checked={state === 'matched'} onChange={() => set(l.key, 'matched')} />Matched</label>
                      <label className="inline-flex items-center gap-1.5"><input type="radio" name={`match-${l.key}`} checked={state === 'unplaced'} onChange={() => set(l.key, 'unplaced')} />Not placed</label>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Pay({ repo, v }: { repo: string; v: OrderSheetView['pay'] }) {
  const id = projectId(repo)
  return (
    <ol className="mt-2 divide-y rounded-xl border text-sm">
      <li className="flex flex-wrap items-center gap-3 px-4 py-3">
        <StatusBadge status={v.sheet === 'met' ? 'met' : v.sheet === 'waived' ? 'waived' : 'yours'} label={v.sheet === 'met' ? 'Met' : v.sheet === 'waived' ? 'Waived' : 'Submit first'} />
        <span className="min-w-0 flex-1">The order sheet matches the release<span className="block text-xs text-muted-foreground">Submit this skill once the options are entered and the parts matched.</span></span>
      </li>
      <li className="flex flex-wrap items-center gap-3 px-4 py-3">
        <StatusBadge status={v.gate?.signed ? 'met' : 'yours'} label={v.gate?.signed ? 'Signed' : 'Not signed'} />
        <span className="min-w-0 flex-1">The order gate{v.gate?.signed ? <span className="block text-xs text-muted-foreground">Signed by {v.gate.signed.by}, {day(v.gate.signed.at)}.</span> : <span className="block text-xs text-muted-foreground">An admin signs it before anything is paid.</span>}</span>
        {v.gate && <Link className="text-xs text-primary hover:underline" to="/p/$id/gates/$gate" params={{ id, gate: v.gate.id }}>Open the order gate</Link>}
      </li>
      <li className="flex flex-wrap items-center gap-3 px-4 py-3">
        <StatusBadge status={v.order ? 'met' : 'yours'} label={v.order ? 'Recorded' : 'Not recorded'} />
        <span className="min-w-0 flex-1">Pay on JLCPCB, then record the order{v.order ? <span className="block text-xs text-muted-foreground">Order {v.order.number}{v.order.paid !== null ? `, ${v.order.currency} ${v.order.paid.toFixed(2)} paid` : ', cost not given'}{v.order.ship ? `, ships ${v.order.ship}` : ', no ship date'}.</span> : <span className="block text-xs text-muted-foreground">The order number, what was paid and the quoted ship date, on the Build page.</span>}</span>
        <Link className="text-xs text-primary hover:underline" to="/p/$id/build" params={{ id }}>Record the order</Link>
      </li>
    </ol>
  )
}
