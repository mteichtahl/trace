/**
 * Design (/p/:id/design): the block diagram, the schematic sheets, the pin plan and the board, each in its Canvas
 * frame with its findings drawn on it and listed beside it (tapping either selects both). The drawings are the SVGs
 * runs stored, fetched with files.url; the sheets, the board and the latest checks' findings come from design.get,
 * whose notes say what the record does not hold yet (the architecture record, the pin plan, drawings of the sheets) —
 * the tab says so rather than drawing made-up content.
 */
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { useState } from 'react'
import { z } from 'zod'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTraceContext } from '@/components/chat/context'
import { openPanel } from '@/components/chat/chat-state'
import { CanvasFrame } from '@/components/canvas/canvas-frame'
import { DataTable, useUrlView } from '@/components/data-table'
import { BlockDiagram } from '@/components/project/block-diagram'
import { NeedsBuilding, TabSkeleton, notBuilt } from '@/components/project/shared'
import { useCommands } from '@/components/shell/command-menu'
import { FindingsList, FindingsPicture } from '@/components/skills/findings'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAction } from '@/lib/queries'
import type { Block, DesignView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/p/$id/design')({
  staticData: { crumb: 'Design' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Design,
})

type Pin = NonNullable<DesignView['pins']>[number]
const PIN_STATUS: Record<Pin['status'], { status: 'met' | 'failing' | 'idle' | 'waived'; label: string }> = {
  ok: { status: 'met', label: 'Agreed' }, conflict: { status: 'failing', label: 'Conflict' }, spare: { status: 'idle', label: 'Spare' }, waived: { status: 'waived', label: 'Waived' },
}
const pinColumns: ColumnDef<Pin, any>[] = [
  { accessorKey: 'pin', header: 'Pin', size: 80, meta: { label: 'Pin', kind: 'text', mono: true } },
  { accessorKey: 'net', header: 'Net', size: 140, meta: { label: 'Net', kind: 'text', mono: true } },
  { accessorKey: 'fn', header: 'Function', size: 140, meta: { label: 'Function', kind: 'text', mono: true } },
  { id: 'status', accessorFn: (p) => PIN_STATUS[p.status].label, header: 'Status', size: 120, meta: { label: 'Status', kind: 'enum' }, cell: ({ row }) => <StatusBadge status={PIN_STATUS[row.original.status].status} label={PIN_STATUS[row.original.status].label} /> },
  { accessorKey: 'note', header: 'Note', size: 280, meta: { label: 'Note', kind: 'text' } },
]

function Design() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const d = useAction('design.get', { repo })
  const [tab, setTab] = useState('sheets')
  const [sheet, setSheet] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [block, setBlock] = useState<Block | null>(null)
  const [layers, setLayers] = useState<Record<string, boolean>>({})
  const pinUrl = useUrlView('pins')
  const data = d.data
  const current = data?.sheets.find((s) => s.id === sheet) ?? data?.sheets[0]

  useTraceContext({ label: 'Design', description: 'The project tab on screen', value: { tab: 'design', view: tab, sheet: current?.name ?? null, finding: selected } }, 'screen')
  useCommands([
    { id: 'design-board', label: 'Show the board', run: () => setTab('board') },
    { id: 'design-arch', label: 'Show the block diagram', run: () => setTab('architecture') },
    ...(data?.sheets ?? []).map((s) => ({ id: `design-sheet-${s.id}`, label: `Show the ${s.name.toLowerCase()} sheet`, run: () => { setTab('sheets'); setSheet(s.id) } })),
  ])

  if (d.isError && !notBuilt(d.error)) return <div className="mt-6"><QueryError error={d.error} what="the design" onRetry={() => void d.refetch()} /></div>
  if (d.isError)
    return (
      <div className="mt-6 space-y-3">
        <EmptyState>The design's pictures appear here once trace has an architecture record and a KiCad export for this project.</EmptyState>
        <NeedsBuilding>This tab reads the sheets, the board and their findings from design.get, which could not be read.</NeedsBuilding>
      </div>
    )
  if (!data) return <TabSkeleton loading={d.isLoading} />

  const open = (data.sheets.reduce((n, s) => n + s.findings.filter((f) => f.severity !== 'waived').length, 0)) + (data.board?.findings.filter((f) => f.severity !== 'waived').length ?? 0)

  return (
    <div className="pb-12">
      <p className="mt-6 text-[15px]">
        {data.architecture ? <><span className="font-semibold">{data.architecture.option}.</span> </> : null}
        {data.sheets.length} schematic sheet{data.sheets.length === 1 ? '' : 's'}{data.board ? ', a board' : ''}; {open ? `${open} findings to fix or waive.` : 'no open findings.'}
      </p>
      {data.notes?.length ? <div className="mt-3 space-y-1">{data.notes.map((n) => <NeedsBuilding key={n}>{n}</NeedsBuilding>)}</div> : null}
      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="architecture">Block diagram</TabsTrigger>
          <TabsTrigger value="sheets">Sheets</TabsTrigger>
          <TabsTrigger value="pins">Pin plan</TabsTrigger>
          <TabsTrigger value="board">Board</TabsTrigger>
        </TabsList>

        <TabsContent value="architecture" className="mt-4">
          {data.architecture ? (
            <CanvasFrame
              title="Block diagram"
              subtitle={data.architecture.option}
              height={440}
              onAsk={() => openPanel(true)}
              detail={block ? { title: block.name, body: <BlockDetail block={block} /> } : null}
              onDetailClose={() => setBlock(null)}
            >
              <div className="origin-center scale-[0.42] sm:scale-75 lg:scale-100">
                <BlockDiagram blocks={data.architecture.blocks} connections={data.architecture.connections} selected={block?.id} onSelect={setBlock} />
              </div>
            </CanvasFrame>
          ) : (
            <EmptyState>No architecture record yet. Architecture choice writes it in Architect.</EmptyState>
          )}
        </TabsContent>

        <TabsContent value="sheets" className="mt-4">
          {data.sheets.length === 0 ? (
            <EmptyState>No schematic yet. trace drafts the sheets from the architecture in Capture.</EmptyState>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
              <nav aria-label="Sheets" className="flex gap-1 overflow-x-auto lg:flex-col">
                {data.sheets.map((s) => {
                  const n = s.findings.filter((f) => f.severity !== 'waived').length
                  return (
                    <button key={s.id} type="button" onClick={() => { setSheet(s.id); setSelected(null) }} aria-current={current?.id === s.id ? 'page' : undefined} className={cn('flex shrink-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm', current?.id === s.id ? 'bg-accent font-medium' : 'hover:bg-accent/60')}>
                      {s.name}
                      {n ? <StatusBadge plain status="fix" label={`${n} open`} /> : <StatusBadge plain status="clean" label="clean" />}
                    </button>
                  )
                })}
              </nav>
              {current && (
                <div className="min-w-0 space-y-4">
                  <FindingsPicture repo={repo} title={current.name} subtitle={`Sheet ${data.sheets.indexOf(current) + 1} of ${data.sheets.length}${current.serves?.length ? ` · serves ${current.serves.join(', ')}` : ''}`} path={current.path} findings={current.findings} selected={selected} onSelect={setSelected} onAsk={() => openPanel(true)} emptyText="No drawing of this sheet yet: trace exports it after the next push." />
                  <FindingsList findings={current.findings} selected={selected} onSelect={setSelected} empty="This sheet is clean." />
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="pins" className="mt-4">
          {data.pins?.length ? (
            <DataTable id="pins" url={pinUrl} data={data.pins} columns={pinColumns} getRowId={(p) => p.pin} noun="pins" />
          ) : (
            <EmptyState>No pin plan yet. Pin plan review agrees it with the firmware in Capture.</EmptyState>
          )}
        </TabsContent>

        <TabsContent value="board" className="mt-4">
          {data.board ? (
            <div className="space-y-4">
              <FindingsPicture
                repo={repo}
                title="Board · top"
                subtitle={data.board.size}
                path={data.board.path}
                findings={data.board.findings}
                selected={selected}
                onSelect={setSelected}
                height={420}
                onAsk={() => openPanel(true)}
                layers={(data.board.layers ?? []).map((l) => ({ id: l, label: l, on: layers[l] ?? true }))}
                onLayer={(l, on) => setLayers((s) => ({ ...s, [l]: on }))}
                emptyText="No board yet: trace places the parts after Board setup."
              />
              <FindingsList findings={data.board.findings} selected={selected} onSelect={setSelected} empty="The placement and design rule checks are clean." />
            </div>
          ) : (
            <EmptyState>No board yet. It starts in Layout, once the schematic gate is signed.</EmptyState>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function BlockDetail({ block: b }: { block: Block }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Key part</dt><dd className="font-mono">{b.part ?? '—'}</dd>
      <dt className="text-muted-foreground">Stock</dt><dd>{b.stock ? <StatusBadge status={b.stock === 'in_stock' ? 'met' : b.stock === 'low' ? 'warning' : 'failing'} label={b.stock === 'in_stock' ? 'In stock for the build' : b.stock === 'low' ? 'Low stock' : 'Out of stock'} /> : '—'}</dd>
      <dt className="text-muted-foreground">Serves</dt><dd className="font-mono">{b.serves.join(', ') || 'No requirement: map one or remove the block'}</dd>
      <dt className="col-span-2 mt-2 text-xs text-muted-foreground">Price breaks and alternatives come from the parts search (Knowledge › Datasheets and parts).</dt>
    </dl>
  )
}
