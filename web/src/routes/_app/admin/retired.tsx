/**
 * Admin › Retired projects: the projects an admin retired (project.retire). A retired project is hidden from everyone
 * and does no work, but nothing of it was deleted; Restore brings it back into everyone's lists as it was (still
 * paused, if it was paused when it was retired). Data: projects.retired (admins only).
 */
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArchiveRestore, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { DataTable, Highlight } from '@/components/data-table'
import { useTraceContext } from '@/components/chat/context'
import { Column } from '@/components/shell/app-shell'
import { EmptyState, NotShared, QueryError, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago } from '@/lib/format'
import { useAction, useCall } from '@/lib/queries'
import type { RetiredProject } from '@/lib/types'

export const Route = createFileRoute('/_app/admin/retired')({
  staticData: { crumb: 'Retired projects' },
  component: Retired,
})

interface Row { repo: string; name: string; retiredBy: string; retiredAt: number; reason: string; paused: string }

const toRow = (p: RetiredProject): Row => ({
  repo: p.repo,
  name: p.name ?? projectName(p.repo),
  retiredBy: p.retired.by,
  retiredAt: p.retired.at,
  reason: p.retired.reason ?? '',
  paused: p.paused ? `Yes, by ${p.paused.by}` : 'No',
})

function RestoreButton({ repo, name }: { repo: string; name: string }) {
  const restore = useCall('project.restore', ({ repo: r }) => [['projects.retired'], ['projects'], ['project.lifecycle', r]])
  return (
    <Button
      size="sm" variant="outline" disabled={restore.isPending}
      onClick={(e) => {
        e.stopPropagation()
        restore.mutate({ repo }, { onSuccess: (r) => toast(`${name}: ${r.summary}`), onError: (err) => toast.error(`Could not restore ${name}: ${err.message}`) })
      }}
    >
      {restore.isPending ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}Restore
    </Button>
  )
}

const columns: ColumnDef<Row, any>[] = [
  { accessorKey: 'name', header: 'Project', size: 200, meta: { label: 'Project', kind: 'text' }, cell: ({ row }) => <span className="font-medium"><Highlight text={row.original.name} /></span> },
  { id: 'restore', header: '', size: 120, enableSorting: false, enableResizing: false, meta: { label: 'Restore' }, cell: ({ row }) => <RestoreButton repo={row.original.repo} name={row.original.name} /> },
  { accessorKey: 'retiredBy', header: 'Retired by', size: 200, meta: { label: 'Retired by', kind: 'enum' } },
  { accessorKey: 'retiredAt', header: 'When', size: 120, meta: { label: 'When', kind: 'number' }, cell: ({ row }) => ago(row.original.retiredAt * 1000) },
  { accessorKey: 'reason', header: 'Why', size: 260, meta: { label: 'Why', kind: 'text' }, cell: ({ row }) => <span className="text-muted-foreground"><Highlight text={row.original.reason || '—'} /></span> },
  { accessorKey: 'paused', header: 'Paused too', size: 150, meta: { label: 'Paused too', kind: 'enum' } },
  { accessorKey: 'repo', header: 'Repository', size: 200, meta: { label: 'Repository', kind: 'text', mono: true } },
]

function Retired() {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const r = useAction('projects.retired', {}, { enabled: admin })
  const rows = (r.data?.projects ?? []).map(toRow)
  useTraceContext({ label: 'Retired projects', description: 'The screen the person is on: Admin, the projects that were retired (hidden from everyone) and can be restored', value: { retired: rows.map((x) => ({ repo: x.repo, name: x.name, by: x.retiredBy })) } }, 'screen')
  if (!admin) return <Column><NotShared /></Column>
  return (
    <Column>
      <h1 className="text-2xl font-semibold tracking-tight">Retired projects</h1>
      <p className="mt-1 text-[15px] text-muted-foreground">Projects hidden from everyone. Nothing in them was deleted: restoring one puts it back in everyone's lists, as it was.</p>
      <div className="mt-6">
        {r.isError ? (
          <QueryError error={r.error} what="the retired projects" onRetry={() => void r.refetch()} />
        ) : r.isLoading ? (
          <SkeletonRows rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState>No retired projects. Retire one from its page's More menu when it is no longer needed.</EmptyState>
        ) : (
          <DataTable id="admin.retired" data={rows} columns={columns} getRowId={(x) => x.repo} noun="retired projects" defaultView={{ sorting: [{ id: 'retiredAt', desc: true }], visibility: { repo: false, paused: false } }} />
        )}
      </div>
    </Column>
  )
}
