/**
 * Files (/p/:id/files): every file in the project and its releases, grouped by kind (design, fabrication, evidence,
 * firmware, documents), newest first, with the release each belongs to; a release's files are frozen and marked so.
 * One Data table (searchable, filterable by kind and release); a row opens the file in a side sheet (a drawer on
 * phones), and the sheet's Full page goes to /p/:id/files/<path>. Run outputs listed here open through `artifact`.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { Term } from '@/components/term'
import { useTraceContext } from '@/components/chat/context'
import { type FileRef, type ListedFile, fileHref } from '@/components/files/data'
import { FileSheet } from '@/components/files/file-viewer'
import { GROUPS, type FileGroup, baseName } from '@/components/files/kinds'
import { fileFromList } from '@/components/files/use-file'
import { GROUP_LABEL, type FileRow as Row, toRows } from '@/components/files/rows'
import { repoOf } from '@/lib/api'
import { ago, eng } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/p/$id/files/')({
  staticData: { crumb: 'Files' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Files,
})

const columns: ColumnDef<Row, any>[] = [
  {
    accessorKey: 'name',
    header: 'File',
    size: 300,
    meta: { label: 'File', kind: 'text' },
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[13px] font-medium"><Highlight text={row.original.name} /></span>
          {row.original.frozen && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Frozen" />}
        </div>
        {row.original.folder && <div className="truncate font-mono text-xs text-muted-foreground"><Highlight text={row.original.folder} /></div>}
      </div>
    ),
  },
  { accessorKey: 'group', header: 'Group', size: 120, meta: { label: 'Group', kind: 'enum', options: GROUPS.map((g) => g.label) } },
  { accessorKey: 'kind', header: 'Kind', size: 130, meta: { label: 'Kind', kind: 'enum' } },
  {
    accessorKey: 'release',
    header: 'Release',
    size: 150,
    meta: { label: 'Release', kind: 'enum' },
    cell: ({ row }) =>
      row.original.release ? (
        <Badge variant="outline" className="gap-1 rounded-md font-normal">
          <Lock className="size-3" aria-hidden /> <Highlight text={row.original.release} />
        </Badge>
      ) : (
        <span className="text-xs text-muted-foreground">Working copy</span>
      ),
  },
  {
    accessorKey: 'at',
    header: 'Changed',
    size: 130,
    meta: { label: 'Changed', kind: 'date' },
    cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.at ? ago(row.original.at) : '–'}</span>,
  },
  { accessorKey: 'commit', header: 'Commit', size: 90, meta: { label: 'Commit', kind: 'text', mono: true } },
  {
    accessorKey: 'findings',
    header: 'Findings',
    size: 100,
    meta: { label: 'Findings', kind: 'number', align: 'right' },
    cell: ({ row }) => (row.original.findings ? <span className="tabular-nums">{row.original.findings} open</span> : <span className="text-muted-foreground">–</span>),
  },
  { accessorKey: 'size', header: 'Size', size: 90, meta: { label: 'Size', kind: 'number', align: 'right' }, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{eng(row.original.size, 'B')}</span> },
]

function Files() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const navigate = useNavigate()
  const url = useUrlView('files')
  const list = useAction('files.list', { repo })
  const files = (list.data ?? []) as ListedFile[]
  const rows = useMemo(() => toRows(files), [files])
  const [group, setGroup] = useState<FileGroup | 'all'>('all')
  const [open, setOpen] = useState<FileRef | null>(null)
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.group] = (c[r.group] ?? 0) + 1
    return c
  }, [rows])
  const shown = group === 'all' ? rows : rows.filter((r) => r.group === GROUP_LABEL[group])
  const releases = [...new Set(rows.map((r) => r.release).filter(Boolean))]

  useTraceContext({ label: 'Files', description: 'The screen the person is on', value: { screen: 'Files', repo, files: rows.length, group } }, 'screen')
  useCommands([
    ...GROUPS.map((g) => ({ id: `files-${g.id}`, label: `Show ${g.label.toLowerCase()} files`, group: 'Files', run: () => setGroup(g.id) })),
    { id: 'files-all', label: 'Show all files', group: 'Files', run: () => setGroup('all') },
  ])

  const openRow = (r: Row) => setOpen(fileFromList(repo, r.path, files))

  return (
    <div className="py-6">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-sm text-muted-foreground">
          {list.data
            ? `${rows.length} files${releases.length ? `; ${releases.length === 1 ? `release ${releases[0]} is` : `${releases.length} releases are`} frozen` : ''}. Open any file to read it here, without downloading.`
            : 'Every file in the project and its releases.'}
        </p>
      </div>

      {list.isError ? (
        <QueryError error={list.error} what="the project's files" onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <Loading>
          <SkeletonRows rows={6} />
        </Loading>
      ) : rows.length === 0 ? (
        <EmptyState>No files yet. Files appear here as trace and the team add them to the repository and as runs produce them.</EmptyState>
      ) : (
        <>
          <div role="tablist" aria-label="File groups" className="mb-4 flex flex-wrap gap-2">
            {[{ id: 'all' as const, label: 'All', blurb: 'Every file' }, ...GROUPS].map((g) => {
              const n = g.id === 'all' ? rows.length : (counts[g.label] ?? 0)
              const on = group === g.id
              return (
                <Button
                  key={g.id}
                  role="tab"
                  aria-selected={on}
                  title={g.blurb}
                  variant={on ? 'secondary' : 'outline'}
                  size="sm"
                  disabled={n === 0 && g.id !== 'all'}
                  className={cn('h-8 rounded-full', on && 'ring-1 ring-foreground/20')}
                  onClick={() => setGroup(g.id)}
                >
                  {g.label} <span className="tabular-nums text-muted-foreground">{n}</span>
                </Button>
              )
            })}
          </div>

          {group === 'all' ? (
            GROUPS.filter((g) => counts[g.label]).map((g) => (
              <Section key={g.id} label={g.label.toUpperCase()} count={counts[g.label]} className="mt-8">
                <p className="-mt-2 mb-3 text-xs text-muted-foreground">{g.blurb}</p>
                <DataTable
                  id={`files-${g.id}`}
                  data={rows.filter((r) => r.group === g.label)}
                  columns={columns.filter((c) => (c as { accessorKey?: string }).accessorKey !== 'group')}
                  getRowId={(r) => r.path}
                  noun="files"
                  pageSize={25}
                  maxHeight="none"
                  onRowClick={openRow}
                />
              </Section>
            ))
          ) : (
            <DataTable id="files" data={shown} columns={columns} getRowId={(r) => r.path} url={url} noun="files" onRowClick={openRow} empty="No files of this kind." />
          )}
          <p className="mt-6 text-xs text-muted-foreground">
            Files in a release are <Term term="Frozen" definition="kept exactly as the release was made; a later change makes a new version, never edits this one">frozen</Term>: they are the exact files that release was made from and cannot change. Links to files are signed and last a few minutes; Copy link gives the page's own address instead.
          </p>
        </>
      )}

      <FileSheet
        file={open}
        open={!!open}
        onOpenChange={(o) => {
          if (!o) setOpen(null)
        }}
      />
      {open && (
        <span className="sr-only" aria-live="polite">
          Opened {baseName(open.path)}. <a href={fileHref(open)} onClick={(e) => { e.preventDefault(); void navigate({ to: fileHref(open) }) }}>Full page</a>
        </span>
      )}
    </div>
  )
}
