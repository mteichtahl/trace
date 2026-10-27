/**
 * Datasheets and parts: the shared library, read through the read-only tools (datasheets.list, parts.search,
 * parts.alternatives) with the `tool` action on one of the person's projects (the API runs every tool on a project's
 * worker). Parts show as Part cards (the chat's card) and as a parts Data table; a part opens a side sheet with stock
 * for the build quantity, price, lifecycle, the datasheet (opened at a page) and alternatives. Distributor data is
 * shown as trace shows it in parts results, never as raw provider answers.
 */
import type { ColumnDef } from '@tanstack/react-table'
import { BookOpen, LayoutGrid, Table2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PartCard } from '@/components/chat/cards'
import { askTrace } from '@/components/chat/chat-state'
import { useTraceContext } from '@/components/chat/context'
import { DataTable, Highlight } from '@/components/data-table'
import { Facts, SideSheet } from '@/components/side-sheet'
import { EmptyState, ErrorState, Loading, Partial, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { Term } from '@/components/term'
import { projectName } from '@/lib/api'
import { count, money } from '@/lib/format'
import { type LibraryDatasheet, type PartOffer, lifecycleWord, priceAt, readDatasheets, readOffers } from '@/lib/knowledge'
import { useJourney } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { type KnowledgeView, libraryRepo, useLibraryTool } from './use-knowledge'
import { DatasheetSheet, type SheetTarget } from './viewers'

interface SearchAnswer {
  total?: number
  providers?: { provider: string; ok: boolean; note?: string }[]
  offers?: unknown[]
}

const partColumns = (qty: number): ColumnDef<PartOffer, any>[] => [
  { accessorKey: 'mpn', header: 'Part', size: 200, meta: { label: 'Part', kind: 'text', mono: true }, cell: ({ row }) => <span className="font-mono font-medium"><Highlight text={row.original.mpn} /></span> },
  { accessorKey: 'manufacturer', header: 'Maker', size: 160, meta: { label: 'Maker', kind: 'enum' } },
  { accessorKey: 'description', header: 'Description', size: 260, meta: { label: 'Description', kind: 'text' } },
  { accessorKey: 'package', header: 'Package', size: 110, meta: { label: 'Package', kind: 'enum' } },
  {
    accessorKey: 'stock', header: `In stock (for ${qty})`, size: 140, meta: { label: 'In stock', kind: 'number', align: 'right' },
    cell: ({ row }) => (row.original.stock === null ? '—' : <StatusBadge plain status={row.original.stock >= qty ? 'met' : 'not_met'} label={count(row.original.stock)} />),
  },
  { id: 'price', accessorFn: (r) => priceAt(r.priceBreaks, qty) ?? undefined, header: `Price at ${qty}`, size: 110, meta: { label: 'Price', kind: 'number', align: 'right' }, cell: ({ getValue }) => (getValue() === undefined ? '—' : money(getValue() as number)) },
  { id: 'lifecycle', accessorFn: (r) => lifecycleWord(r.lifecycle), header: 'Lifecycle', size: 150, meta: { label: 'Lifecycle', kind: 'enum' } },
]

const dsColumns: ColumnDef<LibraryDatasheet, any>[] = [
  { accessorKey: 'mpn', header: 'Part', size: 170, meta: { label: 'Part', kind: 'text', mono: true }, cell: ({ row }) => <span className="font-mono font-medium"><Highlight text={row.original.mpn} /></span> },
  { accessorKey: 'manufacturer', header: 'Maker', size: 170, meta: { label: 'Maker', kind: 'enum' } },
  { accessorKey: 'title', header: 'Title', size: 320, meta: { label: 'Title', kind: 'text' } },
  { accessorKey: 'pages', header: 'Pages', size: 80, meta: { label: 'Pages', kind: 'number', align: 'right' } },
  { id: 'status', accessorFn: (r) => (r.changed ? 'Changed: re-read' : 'Current'), header: 'Status', size: 150, meta: { label: 'Status', kind: 'enum' }, cell: ({ row }) => (row.original.changed ? <StatusBadge status="fix" label="Changed: re-read" /> : <StatusBadge status="met" label="Current" />) },
]

/** The shared library, as a tab or as the Shared library scope. */
export function LibraryResults({ view, all }: { view: KnowledgeView; all: string[] }) {
  const repo = libraryRepo(view, all)
  const journey = useJourney(repo ?? '')
  const projectQty = repo ? journey.data?.summary?.cost?.quantity : undefined
  const [qtyText, setQty] = useState('')
  const qty = Math.max(1, Number(qtyText) || projectQty || 10)
  const [layout, setLayout] = useState<'cards' | 'table'>('cards')
  const [part, setPart] = useState<PartOffer | null>(null)
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  const text = view.q.trim()
  const ds = useLibraryTool(repo, 'datasheets.list', { ...(text ? { query: text } : {}), limit: 100, status: 'all' })
  const parts = useLibraryTool<SearchAnswer>(repo, 'parts.search', { query: text, limit: 30 }, { enabled: text.length >= 2 })
  const sheets = useMemo(() => readDatasheets(ds.data), [ds.data])
  const offers = useMemo(() => readOffers(parts.data), [parts.data])
  const missing = (parts.data?.providers ?? []).filter((p) => !p.ok)
  useTraceContext({ label: 'Shared library', description: 'Datasheets and parts the person is looking at', value: { query: text, parts: offers.slice(0, 10).map((o) => o.mpn), datasheets: sheets.slice(0, 10).map((d) => d.mpn), buildQuantity: qty } }, 'library')

  if (!repo)
    return <EmptyState>The shared library is read through one of your projects, and you are not on one yet. Ask an admin to add you to a project.</EmptyState>

  return (
    <div className="space-y-8">
      <section aria-labelledby="lib-parts">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <h2 id="lib-parts" className="section-label flex-1">Parts{text.length >= 2 && offers.length ? ` (${offers.length})` : ''}</h2>
          <div className="flex items-center gap-2">
            <Label htmlFor="qty" className="text-sm font-normal text-muted-foreground">Build quantity</Label>
            <Input id="qty" inputMode="numeric" className="h-8 w-20" value={qtyText} placeholder={String(projectQty ?? 10)} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
          </div>
          <ToggleGroup type="single" variant="outline" size="sm" value={layout} onValueChange={(v) => v && setLayout(v as 'cards' | 'table')} aria-label="Show parts as">
            <ToggleGroupItem value="cards" aria-label="Cards"><LayoutGrid /></ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label="Table"><Table2 /></ToggleGroupItem>
          </ToggleGroup>
        </div>
        {text.length < 2 ? (
          <EmptyState>Search above for a part: a part number, an LCSC code, or words like “2.2 µF 0603 X5R”. Stock is checked for {qty} boards{projectQty ? ` (${projectName(repo)}'s build quantity)` : ''}.</EmptyState>
        ) : parts.isError ? (
          <ErrorState title="Could not search parts." onRetry={() => void parts.refetch()} detail={parts.error instanceof Error ? parts.error.message : String(parts.error)} />
        ) : parts.isLoading ? (
          <Loading><SkeletonRows rows={3} /></Loading>
        ) : (
          <>
            {missing.length > 0 && <Partial>Searched without {missing.map((m) => m.provider.toUpperCase()).join(', ')}: {missing[0]?.note ?? 'not set up'}. Stock and prices from the others are shown.</Partial>}
            {offers.length === 0 ? (
              <EmptyState className="mt-3">No parts match “{text}”. Try the maker's part number or fewer words.</EmptyState>
            ) : layout === 'cards' ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {offers.map((o) => (
                  <button key={`${o.mpn}:${o.provider}`} type="button" className="block w-full text-left [&>*]:my-0 [&>*]:h-full hover:[&>*]:border-foreground/30" onClick={() => setPart(o)}>
                    <PartCard data={{ mpn: o.mpn, manufacturer: o.manufacturer ?? undefined, description: o.description ?? undefined, stock: o.stock ?? undefined, needed: qty, price: priceAt(o.priceBreaks, qty) ?? undefined, lifecycle: (o.lifecycle as 'active' | 'nrnd' | 'eol') ?? undefined }} />
                  </button>
                ))}
              </div>
            ) : (
              <DataTable id="knowledge-parts" className="mt-3" data={offers} columns={partColumns(qty)} getRowId={(r) => `${r.mpn}:${r.provider}`} noun="parts" persist={false} onRowClick={setPart} />
            )}
          </>
        )}
      </section>

      <section aria-labelledby="lib-ds">
        <h2 id="lib-ds" className="section-label mb-3">Datasheets{sheets.length ? ` (${sheets.length})` : ''}</h2>
        {ds.isError ? (
          <ErrorState title="Could not read the datasheet library." onRetry={() => void ds.refetch()} detail={ds.error instanceof Error ? ds.error.message : String(ds.error)} />
        ) : ds.isLoading ? (
          <Loading><SkeletonRows rows={3} /></Loading>
        ) : (
          <DataTable
            id="knowledge-datasheets"
            data={sheets}
            columns={dsColumns}
            getRowId={(r) => r.mpn}
            noun="datasheets"
            persist={false}
            onRowClick={(d) => setSheet({ repo, mpn: d.mpn, page: 1 })}
            empty={text ? `No datasheet in the library matches “${text}”.` : 'The library has no datasheets yet. trace adds one whenever a part is chosen.'}
          />
        )}
      </section>

      <PartSheet part={part} qty={qty} repo={repo} onOpenChange={(o) => !o && setPart(null)} onDatasheet={(mpn) => setSheet({ repo, mpn, page: 1 })} />
      <DatasheetSheet target={sheet} onOpenChange={(o) => !o && setSheet(null)} />
    </div>
  )
}

interface Alternatives {
  candidates?: { mpn: string; manufacturer?: string; stock?: number; package?: string; note?: string }[]
}

function PartSheet({ part, qty, repo, onOpenChange, onDatasheet }: { part: PartOffer | null; qty: number; repo: string; onOpenChange: (o: boolean) => void; onDatasheet: (mpn: string) => void }) {
  const alts = useLibraryTool<Alternatives>(repo, 'parts.alternatives', { mpn: part?.mpn ?? '', limit: 5 }, { enabled: !!part })
  const ds = useLibraryTool(repo, 'datasheets.list', { query: (part?.mpn ?? '').slice(0, 6), limit: 5 }, { enabled: !!part })
  const sheet = readDatasheets(ds.data).find((d) => part && (part.mpn.toUpperCase().startsWith(d.mpn.toUpperCase()) || d.mpn.toUpperCase().startsWith(part.mpn.toUpperCase().slice(0, 6))))
  useTraceContext(part ? { label: part.mpn, description: 'The part the person has open', value: { mpn: part.mpn, stock: part.stock, buildQuantity: qty }, mono: true } : null, 'part')
  if (!part) return null
  const unit = priceAt(part.priceBreaks, qty)
  const enough = part.stock !== null ? part.stock >= qty : null
  return (
    <SideSheet open={!!part} onOpenChange={onOpenChange} title={<span className="font-mono">{part.mpn}</span>} description={[part.manufacturer, part.description].filter(Boolean).join(' · ')}>
      <Facts
        items={[
          ['Stock', part.stock === null ? 'Not given' : <StatusBadge key="s" plain status={enough ? 'met' : 'not_met'} label={`${count(part.stock)} · ${enough ? `enough for ${qty} boards` : `short for ${qty} boards`}`} />],
          [`Price at ${qty}`, unit === null ? 'Not given' : `${money(unit)} each · ${money(unit * qty)} for ${qty}`],
          ['Lifecycle', part.lifecycle === 'eol' ? <Term key="l" term="End of life">End of life</Term> : lifecycleWord(part.lifecycle)],
          ['Package', part.package ?? '—'],
          ['Minimum order', part.moq ? count(part.moq) : '—'],
          ['From', part.provider ? part.provider.toUpperCase() : '—'],
        ]}
      />
      {part.priceBreaks.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {part.priceBreaks.map((b) => (
            <Badge key={b.qty} variant={b.qty <= qty ? 'secondary' : 'outline'} className="font-normal">{count(b.qty)}+ · {money(b.price)}</Badge>
          ))}
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        {sheet ? (
          <Button variant="outline" size="sm" onClick={() => onDatasheet(sheet.mpn)}>
            <BookOpen /> Open the datasheet{sheet.pages ? ` (${sheet.pages} pages)` : ''}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">{ds.isLoading ? 'Looking for its datasheet…' : 'Its datasheet is not in the library yet; trace adds it when the part is chosen.'}</span>
        )}
        <Button variant="outline" size="sm" onClick={() => askTrace(`Is ${part.mpn} a good choice for ${projectName(repo)} at ${qty} boards?`)}>Ask about this part</Button>
      </div>
      <Separator className="my-5" />
      <h3 className="text-sm font-semibold">Alternatives</h3>
      <p className="text-xs text-muted-foreground">Candidates only: compare datasheets before any replaces it; none is a drop-in.</p>
      {alts.isError ? (
        <p className="mt-2 text-sm text-muted-foreground">Alternatives could not be found just now.</p>
      ) : alts.isLoading ? (
        <SkeletonRows rows={2} className="mt-2" />
      ) : (alts.data?.candidates ?? []).length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No candidates in stock with the same package and key values.</p>
      ) : (
        <ul className="mt-2 divide-y rounded-lg border">
          {alts.data!.candidates!.map((c) => (
            <li key={c.mpn} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-mono">{c.mpn}</span>
              <span className={cn('flex-1 text-xs text-muted-foreground')}>{[c.manufacturer, c.note].filter(Boolean).join(' · ')}</span>
              {c.stock !== undefined && <StatusBadge plain status={c.stock >= qty ? 'met' : 'not_met'} label={count(c.stock)} />}
            </li>
          ))}
        </ul>
      )}
    </SideSheet>
  )
}
