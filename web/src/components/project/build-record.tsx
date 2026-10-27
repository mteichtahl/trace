/**
 * The Build tab's record after payment (docs/ui-design.md "Build"): each placed order with its shipping and Wait line,
 * the form to record what the fab or carrier said (shipped with a tracking number, delivered), boards by serial with
 * their incoming inspection checks, and the bench: each instrument's identity answer and the bring-up readings per
 * board and step against their limits. Data: build.get; writes: order.update (people record status: trace never
 * marks an order itself), order.check_now. JLCPCB gives order status to partner companies only, so the Wait line
 * says what trace can check (a DHL parcel with the key set) and when it checks next.
 */
import { Check, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Section } from '@/components/shell/app-shell'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { WaitLine } from '@/components/wait-line'
import { call } from '@/lib/api'
import { ago, eng, money } from '@/lib/format'
import { useCall } from '@/lib/queries'
import type { BoardView, BuildView, Carrier, OrderView, ReadingView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const CARRIER: Record<Carrier, string> = { dhl: 'DHL', fedex: 'FedEx', ups: 'UPS', other: 'Another carrier' }
const STEP: Record<string, string> = { inspect: 'Inspect', unpowered: 'Unpowered checks', rails: 'Power each rail', clocks: 'Clocks and reset', firmware: 'Firmware', tests: 'Hardware tests' }

/** A limit in words: "3.25 to 3.35 V", "at most 150 mA", "at least 1 kΩ". Pure. */
export function limitText(r: Pick<ReadingView, 'min' | 'max' | 'unit'>): string {
  const u = r.unit ?? ''
  if (r.min !== undefined && r.max !== undefined) return `${eng(r.min, u)} to ${eng(r.max, u)}`
  if (r.max !== undefined) return `at most ${eng(r.max, u)}`
  if (r.min !== undefined) return `at least ${eng(r.min, u)}`
  return 'no limit'
}

// ------------------------------------------------------------------ orders after payment

export function PlacedOrders({ repo, orders }: { repo: string; orders: OrderView[] }) {
  const placed = orders.filter((o) => o.state !== 'ready' && !o.cancelled)
  if (!placed.length) return null
  return (
    <Section label="Shipping" count={placed.length} className="mt-10">
      <ul className="space-y-3">
        {placed.map((o) => <PlacedOrder key={o.id} repo={repo} order={o} />)}
      </ul>
    </Section>
  )
}

function PlacedOrder({ repo, order: o }: { repo: string; order: OrderView }) {
  const update = useCall('order.update', (a) => [['build.get', a.repo], ['journey.get', a.repo]])
  const [carrier, setCarrier] = useState<Carrier>(o.tracking?.carrier ?? 'dhl')
  const [tracking, setTracking] = useState(o.tracking?.number ?? '')
  const save = (args: { state?: 'shipped' | 'delivered'; carrier?: Carrier; tracking?: string }, done: string) =>
    update.mutate({ repo, order: o.number ?? o.id, ...args }, { onSuccess: () => toast(done), onError: (e) => toast.error('Could not record it. What you typed is kept.', { description: String(e) }) })
  return (
    <li className="rounded-xl border">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
        <span className="font-medium">Order {o.number}</span>
        <span className="text-muted-foreground">{o.boards} boards of {o.release}{o.paid != null ? ` · ${money(o.paid, o.currency)} paid` : ''}</span>
        {o.tracking && <span className="font-mono text-xs">{CARRIER[o.tracking.carrier]} {o.tracking.number}</span>}
        <StatusBadge status={o.state === 'delivered' ? 'done' : 'waiting'} label={{ ready: 'Ready', placed: 'Placed', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered' }[o.state]} className="ml-auto" />
      </div>
      {o.wait && (
        <div className="border-t">
          <WaitLine wait={o.wait} onCheckNow={o.wait.checkable ? async () => { const r = await call('order.check_now', { repo, order: o.number ?? o.id }); if (!r.ok) toast(r.reason ?? 'Nothing to check.') } : undefined} />
        </div>
      )}
      {o.state === 'placed' && (
        <form className="flex flex-wrap items-end gap-3 border-t px-5 py-4 text-sm" onSubmit={(e) => { e.preventDefault(); save({ state: 'shipped', carrier, tracking: tracking.trim() }, `Order ${o.number} marked shipped.`) }}>
          <p className="w-full text-muted-foreground">When the fab emails the shipping notice, record the carrier and tracking number. trace follows a DHL parcel on its own once an admin adds the DHL key.</p>
          <div className="space-y-1.5">
            <Label htmlFor={`carrier-${o.id}`}>Carrier</Label>
            <Select value={carrier} onValueChange={(v) => setCarrier(v as Carrier)}>
              <SelectTrigger id={`carrier-${o.id}`} className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(CARRIER) as Carrier[]).map((c) => <SelectItem key={c} value={c}>{CARRIER[c]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor={`tracking-${o.id}`}>Tracking number</Label>
            <Input id={`tracking-${o.id}`} value={tracking} onChange={(e) => setTracking(e.target.value)} className="font-mono" placeholder="e.g. 1234567890" />
          </div>
          <Button type="submit" variant="outline" disabled={update.isPending || tracking.trim().length < 6}>{update.isPending && <Loader2 className="animate-spin" />}Mark shipped</Button>
        </form>
      )}
      {o.state === 'shipped' && (
        <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3 text-sm">
          <span className="flex-1 text-muted-foreground">{o.tracking?.status ? `${CARRIER[o.tracking.carrier]} last said: ${o.tracking.status}.` : 'Shipped.'} Mark it delivered when the boards are in hand.</span>
          <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => save({ state: 'delivered' }, `Order ${o.number} marked delivered.`)}>Mark delivered</Button>
        </div>
      )}
    </li>
  )
}

// ------------------------------------------------------------------ boards by serial

export function BoardList({ boards }: { boards: BoardView[] }) {
  if (!boards.length) return <EmptyState>No boards yet. Each board gets a serial at Incoming inspection, so every later result belongs to one board.</EmptyState>
  return (
    <ul className="divide-y rounded-xl border">
      {boards.map((b) => (
        <li key={b.serial} className="px-5 py-3.5 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono font-medium">{b.serial}</span>
            {b.order && <span className="text-muted-foreground">order {b.order}</span>}
            {b.received && <span className="text-muted-foreground">received {ago(b.received)}</span>}
            {(b.readings ?? 0) > 0 && <span className="text-muted-foreground">{b.readings} bring-up reading{b.readings === 1 ? '' : 's'}{b.failing ? `, ${b.failing} out of limits` : ''}</span>}
            <StatusBadge status={b.state === 'failed' ? 'failing' : b.state === 'brought_up' ? 'done' : b.state === 'inspected' ? 'met' : 'waiting'} label={{ received: 'Received', inspected: 'Inspected', failed: 'Failed inspection', brought_up: 'Brought up' }[b.state]} className="ml-auto" />
          </div>
          {b.checks?.length ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {b.checks.map((c) => (
                <li key={c.id} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', c.result === 'fail' && 'border-destructive text-destructive')} title={c.note}>
                  {c.result === 'fail' ? <X className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />}
                  {c.check}{c.ref ? ` at ${c.ref}` : ''}{c.result === 'marked' ? ' (left off)' : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------ the bench and its readings

export function BenchReadings({ bench }: { bench: NonNullable<BuildView['bench']> }) {
  const byBoard = new Map<string, ReadingView[]>()
  for (const r of bench.readings ?? []) byBoard.set(r.board, [...(byBoard.get(r.board) ?? []), r])
  if (!byBoard.size) return <p className="mt-3 text-sm text-muted-foreground">No bring-up readings yet. The bring-up run takes them with the bench instruments, each against its step's limits.</p>
  return (
    <div className="mt-4 space-y-4">
      {[...byBoard].map(([serial, rs]) => (
        <div key={serial}>
          <p className="text-sm font-medium">{serial}</p>
          <div className="mt-1.5 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-3 py-2 font-medium">Step</th><th className="px-3 py-2 font-medium">What</th><th className="px-3 py-2 text-right font-medium">Reading</th><th className="px-3 py-2 font-medium">Limit</th><th className="px-3 py-2 font-medium">Result</th><th className="px-3 py-2 font-medium">Taken</th></tr></thead>
              <tbody className="divide-y">
                {rs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2">{STEP[r.step] ?? r.step}</td>
                    <td className="px-3 py-2">{r.quantity}{r.instrument ? <span className="text-muted-foreground"> · {r.instrument}</span> : null}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{r.value === null ? '—' : eng(r.value, r.unit ?? '', 4)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{limitText(r)}</td>
                    <td className="px-3 py-2"><StatusBadge plain status={r.pass ? 'met' : 'failing'} label={r.pass ? 'In limits' : 'Out of limits'} /></td>
                    <td className="px-3 py-2 text-muted-foreground">{ago(r.at)} by {r.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
