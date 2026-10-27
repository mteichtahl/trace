/**
 * Memory › Changes: the log of switches off and on, with the memory, the reason, when, and who as "You" or "Someone on
 * the project" (trace records only a fingerprint of the person). The API keeps the current switch of each memory
 * (memory.list with includeInactive); earlier switches of a memory switched back on are not returned, which this
 * screen says.
 */
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { DataTable, Highlight } from '@/components/data-table'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { NeedsBuilding } from '@/components/side-sheet'
import { Loading, QueryError, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { repoOf } from '@/lib/api'
import { ago } from '@/lib/format'
import { type MemoryView, agentName, switchedBy } from '@/lib/knowledge'
import { useProjectMemories } from '../memory'

export const Route = createFileRoute('/_app/p/$id/memory/changes')({
  staticData: { crumb: 'Changes' },
  component: Changes,
})

interface Row {
  id: string
  m: MemoryView
  memory: string
  change: string
  reason: string
  who: string
  at: string
  agent: string
}

function Changes() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const m = useProjectMemories(repo)
  const [open, setOpen] = useState<MemoryView | null>(null)
  const rows: Row[] = useMemo(
    () => m.records.filter((r) => !r.active && r.inactive).map((r) => ({ id: r.id, m: r, memory: r.text, change: 'Switched off', reason: r.inactive!.reason, who: switchedBy(r), at: r.inactive!.at, agent: agentName(r.actor) })),
    [m.records],
  )
  const columns: ColumnDef<Row, any>[] = [
    { accessorKey: 'memory', header: 'Memory', size: 340, meta: { label: 'Memory', kind: 'text' }, cell: ({ row }) => <span className="text-muted-foreground line-through decoration-muted-foreground/50"><Highlight text={row.original.memory} /></span> },
    { accessorKey: 'change', header: 'Change', size: 140, meta: { label: 'Change', kind: 'enum' }, cell: () => <StatusBadge status="idle" label="Switched off" /> },
    { accessorKey: 'reason', header: 'Reason', size: 260, meta: { label: 'Reason', kind: 'text' }, cell: ({ row }) => <span>“<Highlight text={row.original.reason} />”</span> },
    { accessorKey: 'who', header: 'Who', size: 170, meta: { label: 'Who', kind: 'enum' } },
    { accessorKey: 'at', header: 'When', size: 120, meta: { label: 'When', kind: 'date' }, cell: ({ getValue }) => (getValue() ? ago(getValue() as string) : '—') },
    { accessorKey: 'agent', header: 'Agent', size: 160, meta: { label: 'Agent', kind: 'enum' } },
  ]
  return (
    <div className="mt-6">
      <p className="text-sm text-muted-foreground">Every switch off and on, with its reason. Who is shown as “You” or “Someone on the project”, because trace records only a fingerprint of the person, never their name.</p>
      <NeedsBuilding className="mt-1">the API returns each memory's current switch only; a memory switched back on drops out of this log, and switches back on are not listed yet.</NeedsBuilding>
      <div className="mt-4">
        {m.isError ? (
          <QueryError error={m.error} what="the change log" onRetry={() => void m.refetch()} />
        ) : m.isLoading ? (
          <Loading><SkeletonRows rows={3} /></Loading>
        ) : (
          <DataTable id="memory-changes" data={rows} columns={columns} getRowId={(r) => r.id} noun="changes" onRowClick={(r) => setOpen(r.m)} defaultView={{ sorting: [{ id: 'at', desc: true }] }} empty="No memory has been switched off on this project." />
        )}
      </div>
      <MemorySheet memory={open ? (m.records.find((x) => x.id === open.id) ?? open) : null} onOpenChange={(o) => !o && setOpen(null)} />
    </div>
  )
}
