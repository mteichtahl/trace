/**
 * Memory › Long-term (the default view): search by meaning (memory.recall, the same recall the agents use), a Data
 * table of memories (kind, agent, where learned, when, status) with Active as the default and "Include switched off"
 * one click away, rows selected to switch several off at once, a side sheet per memory, the staleness note, and a Wait
 * line for memories still being extracted.
 */
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Sparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { SwitchOffForm, useMaySwitch, useMemorySwitch } from '@/components/memory/switch'
import { NeedsBuilding } from '@/components/side-sheet'
import { useCommands } from '@/components/shell/command-menu'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { WaitLine } from '@/components/wait-line'
import { call, repoOf } from '@/lib/api'
import { ago } from '@/lib/format'
import { type MemoryView, agentName, kindWord, readMemories } from '@/lib/knowledge'
import { useAction, useWaits } from '@/lib/queries'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useProjectMemories } from '../memory'

export const Route = createFileRoute('/_app/p/$id/memory/')({
  validateSearch: z.record(z.string(), z.unknown()),
  component: LongTerm,
})

interface Row {
  m: MemoryView
  id: string
  text: string
  kind: string
  agent: string
  learned: string
  at: string
  status: string
  score: number
}

/** Rows for the table: switched-off ones only when asked for; best match first while searching. */
export function memoryRows(records: MemoryView[], o: { includeOff: boolean; ranked: boolean }): Row[] {
  return records
    .filter((m) => o.includeOff || m.active)
    .map((m) => ({
      m,
      id: m.id,
      text: m.text,
      kind: kindWord(m.kind),
      agent: agentName(m.actor),
      learned: m.kind === 'sessions' ? 'Session' : 'Agent session',
      at: m.createdAt ?? '',
      status: m.active ? 'Active' : 'Switched off',
      score: m.score ?? 0,
    }))
    .sort((a, b) => (o.ranked ? b.score - a.score : b.at.localeCompare(a.at)))
}

function LongTerm() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const all = useProjectMemories(repo)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const recall = useAction('memory.recall', { repo, query, top_k: 50 }, { enabled: query.length >= 2 })
  const [includeOff, setIncludeOff] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<MemoryView | null>(null)
  const [bulk, setBulk] = useState(false)
  const may = useMaySwitch()
  const sw = useMemorySwitch(repo)
  const waits = useWaits(repo)
  const url = useUrlView('memories')
  const extracting = (waits.data?.waits ?? []).filter((w) => /memor|extract|summar/i.test(`${w.what} ${w.text} ${w.source ?? ''}`))

  const searching = query.length >= 2
  const source = searching ? readMemories(recall.data?.records, repo) : all.records
  // recall leaves switched-off memories out; show them from the list when asked for
  const merged = searching && includeOff ? [...source, ...all.records.filter((m) => !m.active && !source.some((s) => s.id === m.id))] : source
  const rows = useMemo(() => memoryRows(merged, { includeOff, ranked: searching }), [merged, includeOff, searching])
  const switchable = rows.filter((r) => may(r.m) && r.m.active)
  const canAny = switchable.length > 0
  useCommands([
    { id: 'm-search', label: 'Find what the agents remember', group: 'Memory', run: () => document.getElementById('memory-search')?.focus() },
    { id: 'm-off', label: 'Show switched-off memories', group: 'Memory', run: () => setIncludeOff(true) },
  ])

  const phone = useMediaQuery('(max-width: 639px)')
  const columns: ColumnDef<Row, any>[] = useMemo(() => {
    const select: ColumnDef<Row, any>[] = canAny
      ? [{
          id: 'select',
          header: () => (
            <Checkbox
              aria-label="Select every memory you may switch off"
              checked={switchable.length > 0 && switchable.every((r) => selected.has(r.id)) ? true : selected.size > 0 ? 'indeterminate' : false}
              onCheckedChange={(on) => setSelected(on ? new Set(switchable.map((r) => r.id)) : new Set())}
            />
          ),
          size: 44,
          minSize: 44,
          enableSorting: false,
          enableResizing: false,
          meta: { label: 'Select' },
          cell: ({ row }: { row: { original: Row } }) =>
            may(row.original.m) && row.original.m.active ? (
              <span onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  aria-label={`Select: ${row.original.text.slice(0, 40)}`}
                  checked={selected.has(row.original.id)}
                  onCheckedChange={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(row.original.id); else n.delete(row.original.id); return n })}
                />
              </span>
            ) : null,
        } as ColumnDef<Row, any>]
      : []
    const rest: ColumnDef<Row, any>[] = [
    {
      accessorKey: 'text', header: searching ? 'Memory · best match' : 'Memory', size: 360, meta: { label: 'Memory', kind: 'text' },
      cell: ({ row }) => (
        <div className={row.original.m.active ? '' : 'text-muted-foreground'}>
          <p className={row.original.m.active ? 'font-medium' : ''}><Highlight text={row.original.text} /></p>
          {row.original.m.inactive && <p className="mt-0.5 text-xs">Switched off by {row.original.m.inactive.byYou ? 'You' : 'Someone on the project'} {row.original.m.inactive.at ? ago(row.original.m.inactive.at) : ''}: “{row.original.m.inactive.reason}”</p>}
          {row.original.m.actor?.startsWith('person/') && <p className="mt-0.5 text-xs text-muted-foreground">Only you see this</p>}
        </div>
      ),
    },
    { accessorKey: 'kind', header: 'Kind', size: 140, meta: { label: 'Kind', kind: 'enum' } },
    { accessorKey: 'agent', header: 'Agent', size: 170, meta: { label: 'Agent', kind: 'enum' } },
    { accessorKey: 'learned', header: 'Learned from', size: 140, meta: { label: 'Learned from', kind: 'enum' } },
    { accessorKey: 'at', header: 'Learned', size: 110, meta: { label: 'Learned', kind: 'date' }, cell: ({ getValue }) => (getValue() ? new Date(getValue() as string).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—') },
    { accessorKey: 'status', header: 'Status', size: 130, meta: { label: 'Status', kind: 'enum' }, cell: ({ row }) => (row.original.m.active ? <StatusBadge plain status="met" label="Active" /> : <StatusBadge plain status="idle" label="Switched off" />) },
    ]
    // on a phone each row is a card titled by its first column: the memory, with the checkbox at the foot
    return phone ? [...rest, ...select] : [...select, ...rest]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAny, selected, switchable.length, searching, phone])

  if (all.isError) return <div className="mt-6"><QueryError error={all.error} what="what the agents remember" onRetry={() => void all.refetch()} /></div>

  return (
    <div className="mt-6">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(text.trim())
          setSelected(new Set())
        }}
      >
        <Label htmlFor="memory-search" className="font-medium">Find what the agents remember about…</Label>
        <div className="relative mt-2 max-w-2xl">
          <Sparkles className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="memory-search" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setQuery(text.trim())} className="h-11 pl-9 pr-9" placeholder="output capacitor" />
          {text && (
            <button type="button" aria-label="Clear the search" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => { setText(''); setQuery('') }}>
              <X className="size-4" />
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Searches by meaning, not exact words: “output capacitor” finds “must be at least 2.2 µF”.</p>
      </form>

      <div className="mt-4 rounded-xl border bg-muted/30">
        {extracting.length > 0 ? (
          extracting.map((w) => <WaitLine key={w.id} wait={w} onCheckNow={(x) => call('tools.check_now', { repo, waitId: x.id })} />)
        ) : (
          <div className="px-5 py-3 text-sm text-muted-foreground">
            New memories are extracted a few minutes after each session ends.
            <NeedsBuilding className="mt-1">trace does not report sessions still waiting to be extracted, so they are not counted here yet.</NeedsBuilding>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Label className="flex items-center gap-2 font-normal">
          <Switch checked={includeOff} onCheckedChange={setIncludeOff} /> Include switched off
        </Label>
        {selected.size > 0 && (
          <div className="flex flex-1 flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-sm" role="status">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" variant="outline" className="border-destructive/50 text-destructive hover:text-destructive" onClick={() => setBulk(true)}>Switch off…</Button>
            <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
        )}
      </div>

      <div className="mt-3">
        {(all.isLoading || (searching && recall.isLoading)) && rows.length === 0 ? (
          <Loading><SkeletonRows rows={5} /></Loading>
        ) : searching && recall.isError ? (
          <QueryError error={recall.error} what="the search" onRetry={() => void recall.refetch()} />
        ) : !all.enabled ? (
          <EmptyState>Memory is not turned on for this project, so the agents keep nothing between sessions.</EmptyState>
        ) : (
          <DataTable
            id="memories"
            data={rows}
            columns={columns}
            getRowId={(r) => r.id}
            url={url}
            noun="memories"
            onRowClick={(r) => setOpen(r.m)}
            empty={searching ? `Nothing the agents remember is close to “${query}”.` : 'The agents have not remembered anything here yet. Memories appear a few minutes after an agent session ends.'}
          />
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Memories are what the agents extracted; they may be stale. Switching one off never deletes it.</p>

      <MemorySheet memory={open ? (all.records.find((m) => m.id === open.id) ?? open) : null} onOpenChange={(o) => !o && setOpen(null)} />
      <Dialog open={bulk} onOpenChange={setBulk}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch off {selected.size} memories</DialogTitle>
            <DialogDescription>The agents stop using them from their next step. Nothing is deleted; each can be switched back on.</DialogDescription>
          </DialogHeader>
          <SwitchOffForm
            count={selected.size}
            autoFocus
            onSubmit={async (reason) => {
              await sw.off([...selected], reason)
              setSelected(new Set())
              setBulk(false)
            }}
            onCancel={() => setBulk(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
