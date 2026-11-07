/**
 * Build (/p/:id/build): releases, orders, boards by serial and the bench. The order being prepared shows the JLCPCB
 * order sheet (docs/ui/screens/Order.png): the board options the release package recorded, to tick as they are
 * entered, the parts from the newest check at the build quantity with any price change since sign-off, the board's
 * newest accepted render, the cost against the budget, "After you pay" to record the order, and the Wait line for
 * JLCPCB's confirmation with what trace does meanwhile. trace prepares the order but never pays.
 *
 * It says "ready to place" only when build.get says so (the package built and every line in stock at today's check),
 * else what is still missing; and its cost is the build plan's target, said as such, until there is a quote
 * (test-esp32 run 2, #217, #226: "ready to place … about US$90" with no package, 0 options and "All 0 lines in stock").
 *
 * After payment: the shipping as the person records it (order.update) with the Wait line for the carrier, boards by
 * serial with their incoming inspection (src/components/project/build-record.tsx), and the bench with each
 * instrument's identity answer and the bring-up readings against their limits.
 *
 * Deploys (src/components/project/deploys.tsx): what the environment runs, a request waiting with Deploy / Skip this one
 * for a person who may decide, a deploy's progress live, and what happened lately with Roll back (docs/stay-in-trace.md).
 *
 * Data: build.get, order.record, order.update, deploys.get and the deploy.* decisions; build.get's notes say what the
 * record does not hold yet (the order sheet's lines).
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Check, Download, FileText, Loader2, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTraceContext } from '@/components/chat/context'
import { DataTable } from '@/components/data-table'
import { NeedsBuilding, TabSkeleton, notBuilt } from '@/components/project/shared'
import { Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { useFileUrl as useRenderUrl } from '@/components/files/data'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { WaitLine } from '@/components/wait-line'
import { projectId, repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, money } from '@/lib/format'
import { useAction, useCall, useJourney } from '@/lib/queries'
import type { HardwareLine, HardwareList, OrderView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { BenchReadings, BoardList, PlacedOrders } from '@/components/project/build-record'
import { DeploysPanel } from '@/components/project/deploys'
import { againstBudget, estimateRange, exact, orderAmount, orderHeadline } from '@/components/project/order-sheet'
import { QuoteHistory } from '@/components/project/quotes'

export const Route = createFileRoute('/_app/p/$id/build')({
  staticData: { crumb: 'Build' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Build,
})

function Build() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const b = useAction('build.get', { repo })
  const data = b.data
  useTraceContext({ label: 'Build', description: 'The project tab on screen', value: { tab: 'build', orders: data?.orders.map((o) => ({ id: o.id, state: o.state, total: o.total })) ?? [] } }, 'screen')

  // deploys come from GitHub and the deploy workflow, not the build record: shown whatever build.get answers
  const deploys = <Section label="Deploys" className="mt-6"><DeploysPanel repo={repo} /></Section>
  if (b.isError && !notBuilt(b.error)) return <div className="mt-6"><QueryError error={b.error} what="the build record" onRetry={() => void b.refetch()} />{deploys}</div>
  if (b.isError)
    return (
      <div className="mt-6 space-y-3">
        <EmptyState>Releases, orders and boards appear here from Release on.</EmptyState>
        <NeedsBuilding>This tab reads releases, orders, boards and the bench from build.get, which could not be read.</NeedsBuilding>
        {deploys}
      </div>
    )
  if (!data) return <TabSkeleton loading={b.isLoading} />

  const ready = data.orders.find((o) => o.state === 'ready')
  return (
    <div className="pb-12">
      {ready && <OrderSheet repo={repo} order={ready} />}
      {data.notes?.length ? <div className="mt-6 space-y-1">{data.notes.map((n) => <NeedsBuilding key={n}>{n}</NeedsBuilding>)}</div> : null}

      {data.quotes && (
        <QuoteHistory
          repo={repo} quotes={data.quotes} estimate={ready?.estimate ?? null}
          defaults={{ quantity: ready?.boards ?? data.orders[0]?.boards ?? 1, currency: ready?.currency ?? data.orders[0]?.currency ?? 'USD', release: ready?.release ?? data.orders[0]?.release ?? 'this revision', options: ready?.options.filter((x) => !/quantity$/i.test(x.option)).map(({ option, value }) => ({ option, value })) ?? [] }}
        />
      )}

      {deploys}

      <PlacedOrders repo={repo} orders={data.orders} />

      <Section label="Releases" count={data.releases.length} className="mt-10">
        {data.releases.length === 0 ? (
          <EmptyState>No release yet. The release gate freezes the design files into one.</EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {data.releases.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
                <span className="font-semibold">{r.revision}</span>
                <span className="font-mono text-xs text-muted-foreground">{r.commit}</span>
                <span className="text-muted-foreground">{r.files !== null ? `${r.files} files · ` : ''}released by {r.by} {ago(r.at)}</span>
                {r.frozen && <StatusBadge status="done" label="Frozen" className="ml-auto" />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Orders" count={data.orders.length}>
        {data.orders.length === 0 ? (
          <EmptyState>No orders yet. trace prepares the first once the release gate is signed.</EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {data.orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
                <span className="font-medium">{o.boards} boards of {o.release}</span>
                <span className="text-muted-foreground">{orderAmount(o)}</span>
                {o.number && <span className="font-mono text-xs">{o.number}</span>}
                <StatusBadge status={o.state === 'ready' ? (o.ready === true ? 'yours' : 'waiting') : o.state === 'delivered' ? 'done' : 'waiting'} label={o.state === 'ready' ? (o.ready === true ? 'Ready to place' : 'Being prepared') : { placed: 'Placed', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered' }[o.state]} className="ml-auto" />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Boards" count={data.boards.length}>
        <BoardList boards={data.boards} />
      </Section>

      <Section label="Bench">
        {!data.bench ? (
          <EmptyState>No bench yet. Bench setup wires it before the first power-on.</EmptyState>
        ) : (
          <div className="rounded-xl border p-5 text-sm">
            <p>{data.bench.configured ? 'The bench is set up and saved.' : data.bench.note ?? 'The bench is not set up yet.'}</p>
            <ul className="mt-3 space-y-1.5">
              {data.bench.instruments.map((i) => (
                <li key={i.name} className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{i.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{i.address}</span>
                  {i.identity && <span className="text-xs text-muted-foreground">{[i.identity.manufacturer, i.identity.model, i.identity.serial && `serial ${i.identity.serial}`].filter(Boolean).join(' ')}</span>}
                  <StatusBadge plain status={i.answered ? 'met' : 'untested'} label={i.answered ? 'Answered its identity query' : 'Not answered yet'} className="ml-auto" />
                </li>
              ))}
            </ul>
            <BenchReadings bench={data.bench} />
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild variant="outline"><Link to="/p/$id/do/$skill" params={{ id, skill: 'bench-setup' }}>Open Bench setup</Link></Button>
              {data.boards.length > 0 && <Button asChild variant="outline"><Link to="/p/$id/do/$skill" params={{ id, skill: 'bring-up-run' }}>Open Bring-up run</Link></Button>}
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}

// ------------------------------------------------------------------ the JLCPCB order sheet

/** unit prices below a cent keep their digits (US$0.002, not US$0.00) */
const price = (n: number, c: string) => (n > 0 && n < 0.01 ? `${money(0, c).replace(/0$/, '')}${n.toFixed(3).slice(1)}`.replace('$.', '$0.') : money(n, c))

type Option = OrderView['options'][number]
type PartLine = OrderView['parts'][number]

function OrderSheet({ repo, order: o }: { repo: string; order: OrderView }) {
  const id = projectId(repo)
  const { user } = useAuth()
  const j = useJourney(repo)
  const orderGate = j.data?.gates.find((g) => g.id === 'fabricate.order' || g.id === 'order')
  const signed = orderGate?.state === 'signed' || o.state === 'placed'
  const [entered, setEntered] = useState<Set<string>>(new Set())
  const [number, setNumber] = useState(o.number ?? '')
  // what was paid: never the target filled in for the person
  const [paid, setPaid] = useState(o.paid != null ? o.paid.toFixed(2) : o.basis === 'quote' ? o.total.toFixed(2) : '')
  const [ship, setShip] = useState(o.ship ?? '')
  const record = useCall('order.record', (a) => [['build.get', a.repo], ['journey.get', a.repo]])
  // the board's picture: the newest accepted renders of the revision (build.get), never a guessed path
  const pictureRef = useMemo(() => (o.render ? { repo, path: o.render.name, run: { id: o.render.run, name: o.render.name } } : null), [repo, o.render])
  const board = useRenderUrl(pictureRef)
  const changedUp = o.parts.filter((p) => p.now > p.then)
  const need = (p: PartLine): number => p.need ?? o.boards
  const short = o.parts.filter((p) => p.stock < need(p) || (p.status !== undefined && p.status !== 'ok'))
  const head = orderHeadline(o)
  const quoted = o.basis === 'quote'
  const optionCols = useMemo<ColumnDef<Option, any>[]>(() => [
    { accessorKey: 'option', header: 'Option', size: 200, meta: { label: 'Option', kind: 'text' } },
    {
      accessorKey: 'value', header: 'Value', size: 260, meta: { label: 'Value', kind: 'text' },
      cell: ({ row }) => <span><span className="font-medium">{row.original.value}</span>{row.original.decided === false && <span className="block text-xs text-muted-foreground">JLCPCB's default: not decided in the record</span>}</span>,
    },
    {
      id: 'entered', header: 'Entered', size: 90, enableSorting: false, meta: { label: 'Entered' },
      cell: ({ row }) => (
        <Checkbox aria-label={`Entered ${row.original.option}`} checked={entered.has(row.original.option)} onCheckedChange={(v) => setEntered((s) => { const n = new Set(s); if (v) n.add(row.original.option); else n.delete(row.original.option); return n })} />
      ),
    },
  ], [entered])
  const partCols = useMemo<ColumnDef<PartLine, any>[]>(() => [
    { accessorKey: 'ref', header: 'Ref', size: 160, meta: { label: 'Ref', kind: 'text' }, cell: ({ row }) => <span><span className="font-mono">{row.original.ref}</span><span className="block text-xs text-muted-foreground">{row.original.name}</span></span> },
    { accessorKey: 'lcsc', header: 'LCSC', size: 110, meta: { label: 'LCSC', kind: 'text', mono: true } },
    { accessorKey: 'stock', header: 'Stock', size: 100, meta: { label: 'Stock', kind: 'number', align: 'right' }, cell: ({ row }) => row.original.stock.toLocaleString('en-US') },
    { accessorKey: 'then', header: 'Price then', size: 100, meta: { label: 'Price then', kind: 'number', align: 'right' }, cell: ({ row }) => price(row.original.then, o.currency) },
    { accessorKey: 'now', header: 'Price now', size: 100, meta: { label: 'Price now', kind: 'number', align: 'right' }, cell: ({ row }) => price(row.original.now, o.currency) },
    {
      id: 'status', accessorFn: (p) => (p.stock < (p.need ?? o.boards) || (p.status !== undefined && p.status !== 'ok') ? 'Short' : p.now > p.then ? 'Price up' : 'In stock'), header: 'Status', size: 170, meta: { label: 'Status', kind: 'enum' },
      cell: ({ row }) => {
        const p = row.original
        if (p.stock < (p.need ?? o.boards) || (p.status !== undefined && p.status !== 'ok')) return <StatusBadge status="failing" label="Short: back to Sign-off" />
        if (p.now > p.then) return <StatusBadge status="warning" label={`In stock · +${money((p.now - p.then) * (p.need ?? o.boards), o.currency)}`} />
        return <StatusBadge status="met" label="In stock" />
      },
    },
  ], [o])

  useCommands([
    { id: 'order-download', label: 'Download the order package', run: () => toast('The package downloads from the release files.') },
    { id: 'order-sign', label: 'Sign the order gate', run: () => window.location.assign(`/p/${id}/gates/${orderGate?.id ?? 'fabricate.order'}`) },
  ])

  const canRecord = signed && number.trim().length >= 4 && Number(paid) > 0 && !!ship
  // against the budget: the quote when there is one, else the order estimate's high end, else the target (a forecast)
  const vs = againstBudget(o)
  const against = vs?.amount ?? null

  return (
    <div className="mt-6 space-y-6">
      <section className="flex flex-wrap items-start gap-4 rounded-xl border border-primary/40 bg-primary-soft p-5 md:p-6" aria-labelledby="order-title">
        <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Order gate · trace prepares, you place and pay on JLCPCB</p>
          <h2 id="order-title" className="mt-1 text-xl font-semibold">{head.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{head.cost}</p>
          {o.ready !== true && o.missing?.length ? (
            <ul className="mt-2 space-y-1 text-sm" aria-label="Still to do before the order">
              {o.missing.map((m) => <li key={m} className="flex items-start gap-2"><StatusBadge plain status="untested" label="To do" className="shrink-0" /><span>{m}</span></li>)}
            </ul>
          ) : null}
          {o.changed && <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm"><StatusBadge status="warning" /> {o.changed}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!signed && user?.class === 'admin' && <Button asChild><Link to="/p/$id/gates/$gate" params={{ id, gate: orderGate?.id ?? 'fabricate.order' }}>Sign the order gate</Link></Button>}
          <Button variant="outline" className="bg-background" disabled={!o.files.length} onClick={() => toast('The package (Gerbers, parts list and placement file) downloads from the release.')}><Download /> Download the package</Button>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <section className="rounded-xl border p-5" aria-labelledby="options">
            <h3 id="options" className="text-lg font-semibold">Board options to enter on JLCPCB</h3>
            {o.options.length ? (
              <>
                <p className="mt-1 text-sm text-muted-foreground">Copy these into JLCPCB's order form and tick each one as you go. They come from the release package; {entered.size} of {o.options.length} entered.</p>
                <div className="mt-3"><DataTable id="order-options" persist={false} data={o.options} columns={optionCols} getRowId={(r) => r.option} noun="options" /></div>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{o.optionsNote ?? 'No board options yet: the release package records them when it is built (kicad.fab).'}</p>
            )}
            <p className="mt-4 text-xs text-muted-foreground">Files</p>
            {o.files.length ? (
              <>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {o.files.map((f) => <span key={f} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs"><FileText className="size-3.5" aria-hidden />{f}</span>)}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">The parts list (BOM) and placement file (CPL) are in JLCPCB's own format.</p>
              </>
            ) : <p className="mt-1 text-sm text-muted-foreground">No package files yet.</p>}
          </section>

          <section className="rounded-xl border p-5" aria-labelledby="parts">
            <h3 id="parts" className="text-lg font-semibold">{o.checkedAt ? `Parts re-checked ${ago(o.checkedAt)}` : 'Parts not checked yet'}</h3>
            {o.parts.length ? (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  {short.length ? `${short.length} of ${o.parts.length} lines are short: the project goes back to Sign-off.` : `All ${o.parts.length} lines are in stock at LCSC for ${o.boards} boards.`}{' '}
                  {changedUp.length ? `${changedUp.length} price${changedUp.length > 1 ? 's' : ''} went up since sign-off, adding ${money(changedUp.reduce((n, p) => n + (p.now - p.then) * need(p), 0), o.currency)} for ${o.boards} boards.` : 'No price changed since sign-off.'}
                </p>
                <div className="mt-3"><DataTable id="order-parts" persist={false} data={o.parts} columns={partCols} getRowId={(r) => r.ref} noun="lines" /></div>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">There is no parts check at {o.boards} boards yet: stock and prices are checked on the day of the order (parts.bom_check).</p>
            )}
          </section>

          <HardwareSection repo={repo} hardware={o.hardware} />
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border p-5">
            <h3 className="text-sm font-semibold">{o.release} · {o.render ? o.render.label.toLowerCase() : 'top'}</h3>
            <div className="mt-3 flex h-40 items-center justify-center rounded-lg bg-muted/50">
              {board.data?.url ? <img src={board.data.url} alt={`${o.release}, ${o.render ? o.render.label.toLowerCase() : 'top side'}`} className="max-h-36" /> : <span className="text-xs text-muted-foreground">{o.render ? (board.isError ? 'The render could not be loaded' : 'Loading the render') : 'No render yet'}</span>}
            </div>
          </div>
          <div className="rounded-xl border p-5 text-sm">
            <h3 className="font-semibold">Cost</h3>
            {!quoted && <p className="mt-1 text-xs text-muted-foreground">No quote yet. JLCPCB quotes the boards, assembly and shipping once the package is uploaded; record it under JLCPCB cost over time.</p>}
            {quoted && o.quote && (
              <div className="mt-2">
                <p className="text-xs text-muted-foreground">Latest JLCPCB quote, {o.quote.on}{o.quote.quantity && o.quote.quantity !== o.boards ? `, for ${o.quote.quantity} boards` : ''}{o.quote.agent ? ` (recorded by ${o.quote.by} from your words)` : ''}</p>
                <p className="mt-0.5 text-2xl font-semibold tracking-tight">{exact(o.quote.total, o.quote.currency)}</p>
              </div>
            )}
            <dl className="mt-3 space-y-1.5">
              {o.estimate && (
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{quoted ? 'Order estimate, to compare' : 'Order estimate, not a quote'} (parts check of {o.estimate.at.slice(0, 10)}, the fab's published prices)</dt><dd className="shrink-0">{estimateRange(o.estimate)}</dd></div>
              )}
              {o.cost.map((c) => <div key={c.label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{c.label}</dt><dd className="shrink-0">{money(c.amount, o.currency)}</dd></div>)}
              {!o.cost.length && <div className="text-muted-foreground">No target unit cost in the build plan and no parts check yet.</div>}
            </dl>
            {o.estimate && !quoted && o.estimate.notIn.length > 0 && <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" aria-label="Not in the estimate">{o.estimate.notIn.map((n) => <li key={n}>{n}</li>)}</ul>}
            {o.budget !== undefined && against !== null && (
              <>
                <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Budget for {o.release} {money(o.budget, o.currency)} · <StatusBadge plain status={against <= o.budget ? 'met' : 'failing'} label={`${vs!.what} is ${against <= o.budget ? 'within budget' : 'over budget'}`} /></p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden><div className={cn('h-full rounded-full', against <= o.budget ? 'bg-foreground/70' : 'bg-destructive')} style={{ width: `${Math.min(100, (against / o.budget) * 100)}%` }} /></div>
              </>
            )}
          </div>
          <form className="space-y-3 rounded-xl border p-5 text-sm" onSubmit={(e) => { e.preventDefault(); record.mutate({ repo, order: o.id, number: number.trim(), paid: Number(paid), ship: ship || null }, { onSuccess: () => toast('Order recorded. trace is watching it.', { description: `Order ${number.trim()}: bring-up work starts.` }), onError: (er) => toast.error('Could not record the order. What you typed is kept.', { description: String(er) }) }) }}>
            <h3 className="font-semibold">After you pay</h3>
            <p className="text-muted-foreground">Record the order so trace can watch it and start the bring-up work.</p>
            <div className="space-y-1.5"><Label htmlFor="order-number">Order number</Label><Input id="order-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. Y12-4471058A" className="font-mono" disabled={!signed} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label htmlFor="order-paid">Paid ({o.currency === 'USD' ? 'US$' : o.currency})</Label><Input id="order-paid" inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} disabled={!signed} aria-describedby={o.quote && !o.quote.agent ? 'order-paid-quote' : undefined} /></div>
              <div className="space-y-1.5"><Label htmlFor="order-ship">Quoted ship date</Label><Input id="order-ship" type="date" value={ship} onChange={(e) => setShip(e.target.value)} disabled={!signed} /></div>
            </div>
            {o.quote && !o.quote.agent && (
              <p id="order-paid-quote" className="text-xs text-muted-foreground">
                Placed against the quote of {o.quote.on}, {exact(o.quote.total, o.quote.currency)}{Number(paid) > 0 && Math.abs(Number(paid) - o.quote.total) >= 0.005 ? `: ${Number(paid) > o.quote.total ? '+' : '−'}${exact(Math.abs(Number(paid) - o.quote.total), o.quote.currency)} on it` : ''}.
              </p>
            )}
            <Button type="submit" variant="outline" className="w-full" disabled={!canRecord || record.isPending}>{record.isPending && <Loader2 className="animate-spin" />}Record order</Button>
            {!signed && <p className="text-xs text-muted-foreground">Available once the order gate is signed.</p>}
            {o.state === 'placed' && <p className="flex items-center gap-1.5 text-xs text-verified"><Check className="size-3.5" /> Recorded{o.number ? `: ${o.number}` : ''}</p>}
          </form>
        </aside>
      </div>

      {o.wait && o.state === 'ready' && (
        <Section label="Once the order is recorded">
          <div className="rounded-xl border">
            <WaitLine wait={{ ...o.wait, what: o.wait.what }} />
          </div>
          {o.meanwhile && (
            <div className="mt-3 rounded-xl border p-5">
              <h3 className="font-semibold">Meanwhile</h3>
              <p className="mt-1 text-sm text-muted-foreground">While the boards are made, trace gets bring-up ready so the first power-on is short. {o.meanwhile.filter((m) => m.state === 'done').length} of {o.meanwhile.length} done.</p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {o.meanwhile.map((m) => (
                  <li key={m.title} className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
                    {m.state === 'done' ? <Check className="size-4 rounded-full bg-foreground p-0.5 text-background" aria-hidden /> : m.state === 'running' ? <Loader2 className="size-4 animate-spin text-primary" aria-hidden /> : <span className="size-4 rounded-full border" aria-hidden />}
                    <span className="flex-1">{m.title}</span>
                    <span className="text-xs text-muted-foreground">{m.state === 'done' ? 'Done' : m.state === 'running' ? 'In progress' : 'To do'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ panel and mounting hardware

const KIND_LABEL: Record<HardwareLine['kind'], string> = { panel: 'Panel', mounting: 'Mounting' }
const SOURCE_LABEL: Record<string, string> = { case: 'Case build', board: 'Mounting holes', schematic: 'Schematic' }

/**
 * The panel and mounting hardware: its own list beside the parts, bought separately (never part of the JLCPCB assembly
 * order). Off by default: when the build plan does not include it, one line says so with a way to turn it on.
 */
function HardwareSection({ repo, hardware }: { repo: string; hardware: HardwareList | null | undefined }) {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const update = useCall('project.update', (a) => [['journey.get', a.repo], ['build.get', a.repo]])
  const cols = useMemo<ColumnDef<HardwareLine, any>[]>(() => [
    { accessorKey: 'qty', header: 'Qty', size: 70, meta: { label: 'Qty', kind: 'number', align: 'right' } },
    {
      accessorKey: 'item', header: 'Item', size: 260, meta: { label: 'Item', kind: 'text' },
      cell: ({ row }) => <span><span className="font-medium">{row.original.item}</span>{row.original.for.length > 0 && <span className="block font-mono text-xs text-muted-foreground">{row.original.for.join(' ')}</span>}</span>,
    },
    { id: 'kind', accessorFn: (l) => KIND_LABEL[l.kind], header: 'Kind', size: 110, meta: { label: 'Kind', kind: 'enum' } },
    { id: 'size', accessorFn: (l) => l.size ?? '', header: 'Size', size: 150, meta: { label: 'Size', kind: 'text' }, cell: ({ row }) => row.original.size ?? <span className="text-muted-foreground">—</span> },
    { id: 'length', accessorFn: (l) => l.length_mm ?? -1, header: 'Length', size: 90, meta: { label: 'Length', kind: 'number', align: 'right' }, cell: ({ row }) => (row.original.length_mm !== null ? `${row.original.length_mm} mm` : <span className="text-muted-foreground">{row.original.source === 'board' ? 'To suit' : '—'}</span>) },
    { id: 'part', accessorFn: (l) => l.mpn ?? l.lcsc ?? '', header: 'Part number', size: 130, meta: { label: 'Part number', kind: 'text', mono: true }, cell: ({ row }) => row.original.mpn ?? row.original.lcsc ?? <span className="text-muted-foreground">Any</span> },
    { id: 'source', accessorFn: (l) => SOURCE_LABEL[l.source] ?? l.source, header: 'From', size: 130, meta: { label: 'From', kind: 'enum' } },
  ], [])

  if (hardware === undefined) {
    return (
      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-4 text-sm" aria-label="Panel and mounting hardware">
        <Wrench className="size-4 text-muted-foreground" aria-hidden />
        <p className="flex-1 text-muted-foreground">Panel and mounting hardware (case parts, screws, knobs) is not included in this build.</p>
        {admin && (
          <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ repo, build: { hardware: true } }, { onSuccess: () => toast('Hardware list included.', { description: 'trace makes it as a separate list beside the parts.' }), onError: (e) => toast.error('Could not include it.', { description: String(e) }) })}>
            {update.isPending && <Loader2 className="animate-spin" />}Include it
          </Button>
        )}
      </section>
    )
  }

  const items = hardware?.lines.reduce((n, l) => n + l.qty, 0) ?? 0
  return (
    <section className="rounded-xl border p-5" aria-labelledby="hardware">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="hardware" className="text-lg font-semibold">Panel and mounting hardware</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {hardware ? `${items} item${items === 1 ? '' : 's'} in ${hardware.lines.length} line${hardware.lines.length === 1 ? '' : 's'}. ` : ''}A separate list: bought on its own, not part of the JLCPCB assembly order.
          </p>
        </div>
        {hardware?.lines.length ? <Button size="sm" variant="outline" onClick={() => toast('The hardware list (hardware.csv) downloads with the release files.')}><Download /> hardware.csv</Button> : null}
      </div>
      {hardware?.case_stale && <p className="mt-3 flex flex-wrap items-center gap-2 text-sm"><StatusBadge status="warning" label="Case out of date" /> The case was built for an earlier board. trace rebuilds it before you order.</p>}
      {hardware === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> trace makes the hardware list with the next parts list check.</p>
      ) : hardware.lines.length ? (
        <div className="mt-3"><DataTable id="order-hardware" persist={false} data={hardware.lines} columns={cols} getRowId={(r) => `${r.item}|${r.for.join(' ')}`} noun="lines" /></div>
      ) : null}
      {hardware && hardware.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">{hardware.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
    </section>
  )
}
