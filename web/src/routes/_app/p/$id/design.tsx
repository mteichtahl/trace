/**
 * Design (/p/:id/design): the block diagram, the schematic sheets, the pin plan and the board, each in its Canvas
 * frame with its findings drawn on it and listed beside it (tapping either selects both). All from design.get:
 *
 *   Block diagram  the architecture record: the option a person chose (else trace's recommendation), switchable
 *                  between options with the layout held still, the options compared on the criteria below it
 *   Sheets         each schematic file with its drawing (the SVG the latest kicad.export kept in its run, fetched with
 *                  files.url), the electrical rule check's findings placed on it, and the requirements it serves
 *   Pin plan       each pin's function, peripheral, net and status from the pin plan check against the schematic's
 *                  netlist, and which parts' plans a person agreed (stale when the plan changed since)
 *   Board          the board drawing (or render) with the design rule check's findings
 *
 * design.get's notes say what the record still does not hold; the tab shows them rather than drawing made-up content.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { useState } from 'react'
import { z } from 'zod'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTraceContext } from '@/components/chat/context'
import { openPanel } from '@/components/chat/chat-state'
import { CanvasFrame } from '@/components/canvas/canvas-frame'
import { DataTable, useUrlView } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { ArchitectureSummary, OptionSwitch, OptionsTable, drawn, useOption } from '@/components/project/architecture'
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
  { id: 'part', accessorFn: (p) => p.part ?? '', header: 'Part', size: 70, meta: { label: 'Part', kind: 'text', mono: true } },
  { accessorKey: 'pin', header: 'Pin', size: 70, meta: { label: 'Pin', kind: 'text', mono: true } },
  { id: 'name', accessorFn: (p) => p.name ?? '', header: 'Name', size: 80, meta: { label: 'Name', kind: 'text', mono: true } },
  { accessorKey: 'net', header: 'Net', size: 140, meta: { label: 'Net', kind: 'text', mono: true } },
  { accessorKey: 'fn', header: 'Function', size: 140, meta: { label: 'Function', kind: 'text', mono: true } },
  { id: 'use', accessorFn: (p) => [p.peripheral, p.use].filter(Boolean).join(' · '), header: 'Peripheral', size: 160, meta: { label: 'Peripheral', kind: 'text' } },
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
  const [option, setOption] = useOption(data?.architecture)
  const reqs = useAction('requirements.trace', { repo }, { enabled: tab === 'architecture' })
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

        <TabsContent value="architecture" className="mt-4 space-y-4">
          {data.architecture ? (
            <>
              <CanvasFrame
                title="Block diagram"
                subtitle={data.architecture.options?.find((o) => o.id === option)?.name ? `Option ${option}: ${data.architecture.options.find((o) => o.id === option)!.name}` : data.architecture.option}
                height={440}
                onAsk={() => openPanel(true)}
                detail={block ? { title: block.name, body: <BlockDetail block={block} /> } : null}
                onDetailClose={() => setBlock(null)}
              >
                <div className="origin-center scale-[0.42] sm:scale-75 lg:scale-100">
                  <BlockDiagram {...drawn(data.architecture, option)} selected={block?.id} onSelect={setBlock} />
                </div>
              </CanvasFrame>
              <div className="flex flex-wrap items-center gap-3">
                <OptionSwitch a={data.architecture} value={option} onChange={(o) => { setOption(o); setBlock(null) }} />
                <Button asChild size="sm" variant={data.architecture.chosen ? 'outline' : 'default'}><Link to="/p/$id/do/$skill" params={{ id, skill: 'architecture-choice' }}>{data.architecture.chosen ? 'Review the choice' : 'Choose an architecture'}</Link></Button>
              </div>
              <ArchitectureSummary a={data.architecture} current={option} requirements={(reqs.data?.requirements ?? []).map((r) => r.id)} />
              <OptionsTable a={data.architecture} current={option} />
            </>
          ) : (
            <EmptyState>No architecture record yet. The agents propose options in Architect, and Architecture choice records the one chosen.</EmptyState>
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
                  <FindingsPicture repo={repo} title={current.name} subtitle={`Sheet ${data.sheets.indexOf(current) + 1} of ${data.sheets.length}${current.block ? ` · block ${current.block}` : ''}`} path={current.path} findings={current.findings} selected={selected} onSelect={setSelected} onAsk={() => openPanel(true)} emptyText="No drawing of this sheet yet: kicad.export with sch_svg keeps one in its run." />
                  <p className="text-sm">
                    {current.serves?.length ? <>Serves <span className="font-mono">{current.serves.join(', ')}</span>.</>
                      : current.serves_none ? <>Serves no requirement: {current.serves_none}</>
                        : <StatusBadge status="warning" label="Names no requirement yet" />}
                  </p>
                  <FindingsList findings={current.findings} selected={selected} onSelect={setSelected} empty="This sheet is clean." />
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="pins" className="mt-4 space-y-3">
          {data.pins?.length ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {(data.pin_plan?.parts ?? []).map((p) => (
                  <span key={p.part} className="flex items-center gap-1.5">
                    <span className="font-mono">{p.part}</span>
                    {p.agreed ? <StatusBadge status={p.agreed.stale ? 'warning' : 'met'} label={p.agreed.stale ? `Agreed by ${p.agreed.by}, changed since` : `Agreed by ${p.agreed.by}`} /> : <StatusBadge status="yours" label="Not agreed yet" />}
                  </span>
                ))}
                <span className="text-muted-foreground">{data.pin_plan?.checked ? `Checked against the schematic in run ${data.pin_plan.checked.run.slice(0, 8)}.` : 'Not checked against the schematic yet.'}</span>
                <Button asChild size="sm" variant="outline" className="ml-auto"><Link to="/p/$id/do/$skill" params={{ id, skill: 'pin-plan-review' }}>Review the pin plan</Link></Button>
              </div>
              <DataTable id="pins" url={pinUrl} data={data.pins} columns={pinColumns} getRowId={(p) => `${p.part ?? ''}.${p.pin}`} noun="pins" />
              {(data.pin_plan?.findings ?? []).filter((f) => f.kind === 'missing_pin').length > 0 && (
                <ul className="space-y-1 text-sm">
                  {data.pin_plan!.findings.filter((f) => f.kind === 'missing_pin').map((f) => <li key={f.id} className="flex items-center gap-2"><StatusBadge plain status={f.severity === 'waived' ? 'waived' : 'fix'} />{f.text}</li>)}
                </ul>
              )}
            </>
          ) : (
            <EmptyState>No pin plan yet. The firmware track proposes it in Capture, and Pin plan review agrees it with the schematic.</EmptyState>
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
      {b.role && <><dt className="text-muted-foreground">Role</dt><dd>{b.role}</dd></>}
      <dt className="text-muted-foreground">Key part</dt><dd className="font-mono">{b.part ?? '—'}</dd>
      {(b.parts?.length ?? 0) > 1 && <><dt className="text-muted-foreground">Parts</dt><dd className="font-mono">{b.parts!.map((p) => p.mpn).join(', ')}</dd></>}
      <dt className="text-muted-foreground">Stock</dt><dd>{b.stock ? <StatusBadge status={b.stock === 'in_stock' ? 'met' : b.stock === 'low' ? 'warning' : 'failing'} label={b.stock === 'in_stock' ? 'In stock for the build' : b.stock === 'low' ? 'Low stock' : 'Out of stock'} /> : 'Not in the record: the parts check answers it'}</dd>
      <dt className="text-muted-foreground">Serves</dt><dd className="font-mono">{b.serves.join(', ') || 'No requirement: map one or remove the block'}</dd>
      <dt className="col-span-2 mt-2 text-xs text-muted-foreground">Price breaks and alternatives come from the parts search (Knowledge › Datasheets and parts).</dt>
    </dl>
  )
}
