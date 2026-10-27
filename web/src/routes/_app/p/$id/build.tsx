/**
 * Build (/p/:id/build): releases, orders, boards by serial and the bench. An order ready to place shows the JLCPCB
 * order sheet (docs/ui/screens/Order.png): the board options to tick as they are entered, the parts re-checked today
 * with any price change, the cost against the budget, "After you pay" to record the order, and the Wait line for
 * JLCPCB's confirmation with what trace does meanwhile. trace prepares the order but never pays.
 *
 * After payment: the shipping as the person records it (order.update) with the Wait line for the carrier, boards by
 * serial with their incoming inspection (src/components/project/build-record.tsx), and the bench with each
 * instrument's identity answer and the bring-up readings against their limits.
 *
 * Data: build.get, order.record, order.update; build.get's notes say what the record does not hold yet (the order
 * sheet's lines).
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Check, Download, FileText, Loader2 } from 'lucide-react'
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
import { useFileUrl } from '@/components/skills/findings'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { WaitLine } from '@/components/wait-line'
import { projectId, repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, money } from '@/lib/format'
import { useAction, useCall, useJourney } from '@/lib/queries'
import type { OrderView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { BenchReadings, BoardList, PlacedOrders } from '@/components/project/build-record'

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

  if (b.isError && !notBuilt(b.error)) return <div className="mt-6"><QueryError error={b.error} what="the build record" onRetry={() => void b.refetch()} /></div>
  if (b.isError)
    return (
      <div className="mt-6 space-y-3">
        <EmptyState>Releases, orders and boards appear here from Release on.</EmptyState>
        <NeedsBuilding>This tab reads releases, orders, boards and the bench from build.get, which could not be read.</NeedsBuilding>
      </div>
    )
  if (!data) return <TabSkeleton loading={b.isLoading} />

  const ready = data.orders.find((o) => o.state === 'ready')
  return (
    <div className="pb-12">
      {ready && <OrderSheet repo={repo} order={ready} />}
      {data.notes?.length ? <div className="mt-6 space-y-1">{data.notes.map((n) => <NeedsBuilding key={n}>{n}</NeedsBuilding>)}</div> : null}

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
                <span className="text-muted-foreground">{money(o.total, o.currency)}</span>
                {o.number && <span className="font-mono text-xs">{o.number}</span>}
                <StatusBadge status={o.state === 'ready' ? 'yours' : o.state === 'delivered' ? 'done' : 'waiting'} label={{ ready: 'Ready to place', placed: 'Placed', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered' }[o.state]} className="ml-auto" />
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
  const [paid, setPaid] = useState(o.paid != null ? o.paid.toFixed(2) : o.total.toFixed(2))
  const [ship, setShip] = useState(o.ship ?? '')
  const record = useCall('order.record', (a) => [['build.get', a.repo], ['journey.get', a.repo]])
  // the board's picture: the one a run stored (design.get), never a guessed path
  const design = useAction('design.get', { repo })
  const board = useFileUrl(repo, design.data?.board?.path)
  const changedUp = o.parts.filter((p) => p.now > p.then)
  const optionCols = useMemo<ColumnDef<Option, any>[]>(() => [
    { accessorKey: 'option', header: 'Option', size: 200, meta: { label: 'Option', kind: 'text' } },
    { accessorKey: 'value', header: 'Value', size: 260, meta: { label: 'Value', kind: 'text' }, cell: ({ row }) => <span className="font-medium">{row.original.value}</span> },
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
      id: 'status', accessorFn: (p) => (p.stock < o.boards ? 'Short' : p.now > p.then ? 'Price up' : 'In stock'), header: 'Status', size: 170, meta: { label: 'Status', kind: 'enum' },
      cell: ({ row }) => {
        const p = row.original
        if (p.stock < o.boards) return <StatusBadge status="failing" label="Short: back to Sign-off" />
        if (p.now > p.then) return <StatusBadge status="warning" label={`In stock · +${money((p.now - p.then) * o.boards, o.currency)}`} />
        return <StatusBadge status="met" label="In stock" />
      },
    },
  ], [o])

  useCommands([
    { id: 'order-download', label: 'Download the order package', run: () => toast('The package downloads from the release files.') },
    { id: 'order-sign', label: 'Sign the order gate', run: () => window.location.assign(`/p/${id}/gates/${orderGate?.id ?? 'fabricate.order'}`) },
  ])

  const canRecord = signed && number.trim().length >= 4 && Number(paid) > 0 && !!ship
  const sumCost = o.cost.reduce((n, c) => n + c.amount, 0)

  return (
    <div className="mt-6 space-y-6">
      <section className="flex flex-wrap items-start gap-4 rounded-xl border border-primary/40 bg-primary-soft p-5 md:p-6" aria-labelledby="order-title">
        <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Order gate · trace prepares, you place and pay on JLCPCB</p>
          <h2 id="order-title" className="mt-1 text-xl font-semibold">The order for {o.boards} boards is ready to place on JLCPCB. Expected cost about {money(o.total, o.currency)}.</h2>
          {o.changed && <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm"><StatusBadge status="warning" /> {o.changed}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!signed && user?.class === 'admin' && <Button asChild><Link to="/p/$id/gates/$gate" params={{ id, gate: orderGate?.id ?? 'fabricate.order' }}>Sign the order gate</Link></Button>}
          <Button variant="outline" className="bg-background" onClick={() => toast('The package (Gerbers, parts list and placement file) downloads from the release.')}><Download /> Download the package</Button>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <section className="rounded-xl border p-5" aria-labelledby="options">
            <h3 id="options" className="text-lg font-semibold">Board options to enter on JLCPCB</h3>
            <p className="mt-1 text-sm text-muted-foreground">Copy these into JLCPCB's order form and tick each one as you go. They come from the signed release; {entered.size} of {o.options.length} entered.</p>
            <div className="mt-3"><DataTable id="order-options" persist={false} data={o.options} columns={optionCols} getRowId={(r) => r.option} noun="options" /></div>
            <p className="mt-4 text-xs text-muted-foreground">Files</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {o.files.map((f) => <span key={f} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs"><FileText className="size-3.5" aria-hidden />{f}</span>)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">The parts list (BOM) and placement file (CPL) are in JLCPCB's own format.</p>
          </section>

          <section className="rounded-xl border p-5" aria-labelledby="parts">
            <h3 id="parts" className="text-lg font-semibold">Parts re-checked {o.checkedAt ? ago(o.checkedAt) : 'today'}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {o.parts.every((p) => p.stock >= o.boards) ? `All ${o.parts.length} lines are in stock at LCSC.` : 'Some lines are short: the project goes back to Sign-off.'}{' '}
              {changedUp.length ? `${changedUp.length} price${changedUp.length > 1 ? 's' : ''} went up since sign-off, adding ${money(changedUp.reduce((n, p) => n + (p.now - p.then) * o.boards, 0), o.currency)} for ${o.boards} boards.` : 'No price changed since sign-off.'}
            </p>
            <div className="mt-3"><DataTable id="order-parts" persist={false} data={o.parts} columns={partCols} getRowId={(r) => r.ref} noun="lines" /></div>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border p-5">
            <h3 className="text-sm font-semibold">{o.release} · top</h3>
            <div className="mt-3 flex h-40 items-center justify-center rounded-lg bg-muted/50">
              {board.data?.url ? <img src={board.data.url} alt={`${o.release}, top side`} className="max-h-36" /> : <span className="text-xs text-muted-foreground">No render yet</span>}
            </div>
          </div>
          <div className="rounded-xl border p-5 text-sm">
            <h3 className="font-semibold">Cost</h3>
            <dl className="mt-3 space-y-1.5">
              {o.cost.map((c) => <div key={c.label} className="flex justify-between"><dt className="text-muted-foreground">{c.label}</dt><dd>{money(c.amount, o.currency)}</dd></div>)}
              <div className="flex justify-between border-t pt-2 font-semibold"><dt>Total</dt><dd>{money(sumCost, o.currency)}</dd></div>
            </dl>
            {o.budget !== undefined && (
              <>
                <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Budget for {o.release} {money(o.budget, o.currency)} · <StatusBadge plain status={sumCost <= o.budget ? 'met' : 'failing'} label={sumCost <= o.budget ? 'within budget' : 'over budget'} /></p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden><div className={cn('h-full rounded-full', sumCost <= o.budget ? 'bg-foreground/70' : 'bg-destructive')} style={{ width: `${Math.min(100, (sumCost / o.budget) * 100)}%` }} /></div>
              </>
            )}
          </div>
          <form className="space-y-3 rounded-xl border p-5 text-sm" onSubmit={(e) => { e.preventDefault(); record.mutate({ repo, order: o.id, number: number.trim(), paid: Number(paid), ship: ship || null }, { onSuccess: () => toast('Order recorded. trace is watching it.', { description: `Order ${number.trim()}: bring-up work starts.` }), onError: (er) => toast.error('Could not record the order. What you typed is kept.', { description: String(er) }) }) }}>
            <h3 className="font-semibold">After you pay</h3>
            <p className="text-muted-foreground">Record the order so trace can watch it and start the bring-up work.</p>
            <div className="space-y-1.5"><Label htmlFor="order-number">Order number</Label><Input id="order-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. Y12-4471058A" className="font-mono" disabled={!signed} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label htmlFor="order-paid">Paid ({o.currency === 'USD' ? 'US$' : o.currency})</Label><Input id="order-paid" inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} disabled={!signed} /></div>
              <div className="space-y-1.5"><Label htmlFor="order-ship">Quoted ship date</Label><Input id="order-ship" type="date" value={ship} onChange={(e) => setShip(e.target.value)} disabled={!signed} /></div>
            </div>
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
