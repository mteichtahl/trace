/**
 * Admin › Connected systems (docs/external-access.md, "Managing connected systems"): the other systems and AI agents
 * that call trace with their own keys. A Data table like People (name, what it's for, what it can do, how many
 * projects, last used, status); Connect a system opens the create sheet, which shows the keys once. A row opens the
 * system's page. When the installation has external access off, a friendly note says how to turn it on.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Plug, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { Column } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { CreateSheet, KeysSheet } from '@/components/services/create-sheet'
import { ExternalOff } from '@/components/services/external-off'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { useTraceContext } from '@/components/chat/context'
import { type ServiceRow as Row, toRows, useServices } from '@/components/services/use-services'
import { plural } from '@/lib/format'
import { useProjects } from '@/lib/queries'
import { COST_NOTE, EXPLAINER, type ShownKeys, isExternalOff } from '@/lib/services'

export const Route = createFileRoute('/_app/admin/systems/')({
  staticData: { crumb: 'Connected systems' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Systems,
})

function Systems() {
  const services = useServices()
  const projects = useProjects()
  const url = useUrlView('systems')
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [keys, setKeys] = useState<ShownKeys | null>(null)
  const list = services.data?.services ?? []
  const rows = useMemo(() => toRows(list), [list])
  const off = services.isError && isExternalOff(services.error)
  const disabled = list.filter((s) => s.disabled).length
  const open = (name: string) => void navigate({ to: '/admin/systems/$name', params: { name } })

  useTraceContext({ label: 'Connected systems', description: 'The screen the person is on: Admin, the other systems connected to trace with their own keys', value: { systems: list.length, disabled, externalAccess: off ? 'off' : 'on' } }, 'screen')
  useCommands(off ? [] : [{ id: 'systems-connect', label: 'Connect a system', group: 'Admin', icon: Plug, keywords: ['service', 'api key', 'client', 'mcp', 'external'], run: () => setCreating(true) }])

  const columns: ColumnDef<Row, any>[] = [
    {
      accessorKey: 'name', header: 'Name', size: 200, meta: { label: 'Name', kind: 'text', mono: true },
      cell: ({ row: { original: r } }) => <span className="font-mono text-[13px] font-medium"><Highlight text={r.name} /></span>,
    },
    {
      accessorKey: 'description', header: "What it's for", size: 320, meta: { label: "What it's for", kind: 'text' },
      cell: ({ row: { original: r } }) => r.description ? <span className="line-clamp-2 text-sm"><Highlight text={r.description} /></span> : <span className="text-xs text-muted-foreground">Not said</span>,
    },
    { accessorKey: 'can', header: 'Can', size: 150, meta: { label: 'Can', kind: 'enum', options: ['Read only', 'Read and change'] } },
    {
      accessorKey: 'projectCount', header: 'Projects', size: 110, meta: { label: 'Projects', kind: 'number' },
      cell: ({ row: { original: r } }) => r.projectCount ? <span>{r.projectCount}</span> : <span className="text-xs text-muted-foreground">None yet</span>,
    },
    { accessorKey: 'usedAt', header: 'Last used', size: 140, meta: { label: 'Last used', kind: 'number' }, cell: ({ row: { original: r } }) => <span className={r.last_used ? '' : 'text-xs text-muted-foreground'}>{r.used}</span> },
    {
      accessorKey: 'status', header: 'Status', size: 120, meta: { label: 'Status', kind: 'enum', options: ['Active', 'Disabled'] },
      cell: ({ row: { original: r } }) => <StatusBadge status={r.disabled ? 'paused' : 'done'} label={r.status} />,
    },
  ]

  const connect = <Button onClick={() => setCreating(true)}><Plus /> Connect a system</Button>

  return (
    <Column wide>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Connected systems</h1>
          <p className="mt-1 max-w-[65ch] text-[15px] text-muted-foreground">{EXPLAINER}</p>
        </div>
      </div>
      {services.data && list.length > 0 && (
        <p className="mt-3 text-sm">
          {plural(list.length, 'system')} connected{disabled ? `, ${disabled} disabled` : ''}.
        </p>
      )}
      <div className="mt-6">
        {off ? (
          <ExternalOff />
        ) : services.isError ? (
          <QueryError error={services.error} what="the connected systems" onRetry={() => void services.refetch()} />
        ) : services.isLoading ? (
          <Loading><SkeletonRows rows={3} /></Loading>
        ) : list.length === 0 ? (
          <EmptyState action={<div className="space-y-2">{connect}<p className="text-xs">{COST_NOTE}</p></div>}>
            No systems are connected yet. Connect one to let a script, a pipeline or an AI agent read your projects with its own keys.
          </EmptyState>
        ) : (
          <>
            <DataTable
              id="systems"
              data={rows}
              columns={columns}
              getRowId={(r) => r.name}
              url={url}
              noun="systems"
              onRowClick={(r) => open(r.name)}
              defaultView={{ sorting: [{ id: 'name', desc: false }] }}
              actions={connect}
            />
            <p className="mt-3 text-xs text-muted-foreground">{COST_NOTE}</p>
          </>
        )}
      </div>

      <CreateSheet
        open={creating}
        onOpenChange={setCreating}
        projects={(projects.data ?? []).map((p) => p.repo)}
        taken={list.map((s) => s.name)}
        onCreated={setKeys}
      />
      <KeysSheet keys={keys} onDone={() => setKeys(null)} />
    </Column>
  )
}
