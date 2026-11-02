/**
 * Changes (/p/:id/changes): the open changes trace's jobs made, as the one Data table (sortable, searchable,
 * filterable, kept per person). Each row opens its review page. What a change is, and why it waits, in one line above.
 *
 * Data: changes.list (asked for again every 30 s as a fallback for live events).
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { z } from 'zod'
import { useTraceContext } from '@/components/chat/context'
import { ChangePill, ChecksBadge, useChanges } from '@/components/changes/changes-list'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { TabSkeleton } from '@/components/project/shared'
import { EmptyState, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { ago } from '@/lib/format'
import { VERDICT_WORDS, changeLine } from '@/lib/guided'
import { useJourney } from '@/lib/queries'
import type { ChangeSummary } from '@/lib/types'

export const Route = createFileRoute('/_app/p/$id/changes/')({
  staticData: { crumb: 'Changes' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Changes,
})

const stageName = (id: string | null) => (id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ') : '—')

export const changeColumns: ColumnDef<ChangeSummary, any>[] = [
  {
    accessorKey: 'title', header: 'Change', size: 320, meta: { label: 'Change', kind: 'text' },
    cell: ({ row }) => (
      <span>
        <span className="font-medium"><Highlight text={row.original.title} /></span>
        <span className="block text-xs text-muted-foreground">{changeLine(row.original)}</span>
      </span>
    ),
  },
  { id: 'verdict', accessorFn: (c) => VERDICT_WORDS[c.verdict].pill, header: 'Where it is', size: 130, meta: { label: 'Where it is', kind: 'enum', options: Object.values(VERDICT_WORDS).map((v) => v.pill) }, cell: ({ row }) => <ChangePill verdict={row.original.verdict} /> },
  { id: 'checks', accessorFn: (c) => (c.checks ? c.checks.passed : -1), header: 'Checks', size: 170, meta: { label: 'Checks', kind: 'number' }, cell: ({ row }) => <ChecksBadge c={row.original.checks} /> },
  { accessorKey: 'from', header: 'Made by', size: 200, meta: { label: 'Made by', kind: 'enum' } },
  { id: 'stage', accessorFn: (c) => stageName(c.stage), header: 'Stage', size: 110, meta: { label: 'Stage', kind: 'enum' } },
  { id: 'opened', accessorFn: (c) => c.opened_at, header: 'Made', size: 120, meta: { label: 'Made', kind: 'date' }, cell: ({ row }) => ago(row.original.opened_at) },
  { id: 'updated', accessorFn: (c) => c.updated_at, header: 'Last update', size: 120, meta: { label: 'Last update', kind: 'date' }, cell: ({ row }) => ago(row.original.updated_at) },
  { id: 'number', accessorFn: (c) => c.number, header: 'Number', size: 90, meta: { label: 'Number', kind: 'number', align: 'right', mono: true } },
]

function Changes() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const navigate = useNavigate()
  const list = useChanges(repo)
  const j = useJourney(repo)
  const url = useUrlView('changes')
  useTraceContext({ label: 'Changes', description: 'The project tab on screen: changes trace made, waiting to be reviewed', value: { tab: 'changes', count: list.data?.changes.length ?? 0 } }, 'screen')
  if (list.isError) return <div className="mt-6"><QueryError error={list.error} what="the changes" onRetry={() => void list.refetch()} /></div>
  if (!list.data) return <TabSkeleton loading={list.isLoading} />
  const rows = list.data.changes
  const ready = rows.filter((c) => c.verdict === 'ready').length
  return (
    <div className="pb-12">
      <p className="mt-6 text-[15px]">
        <span className="font-semibold">{rows.length === 0 ? 'No open changes.' : `${rows.length} open ${rows.length === 1 ? 'change' : 'changes'} from trace${ready ? `, ${ready} ready for you` : ''}.`}</span>{' '}
        <span className="text-muted-foreground">When a specialist finishes a piece of work, it comes here as a change. Its work counts once someone accepts it into the design.</span>
      </p>
      {j.data?.changesUnavailable && <p className="mt-2 text-sm text-muted-foreground">trace could not reach GitHub just now, so this list may be out of date.</p>}
      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState>Nothing waits for review. trace adds a change here when one of its specialists finishes a piece of work.</EmptyState>
        ) : (
          <DataTable id="changes" url={url} data={rows} columns={changeColumns} getRowId={(r) => String(r.number)} noun="changes" onRowClick={(r) => void navigate({ to: '/p/$id/changes/$number', params: { id, number: String(r.number) } })} defaultView={{ sorting: [{ id: 'opened', desc: false }] }} />
        )}
      </div>
    </div>
  )
}
