/**
 * All projects, as a Data table. Reference for list screens: columns with meta (label, kind), the view in the URL
 * (useUrlView) and in preferences (the table's id), a row that opens the item.
 */
import { useQueries } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { Column } from '@/components/shell/app-shell'
import { StageRail } from '@/components/stage-rail'
import { Loading, QueryError, SkeletonRows } from '@/components/states'
import { useTraceContext } from '@/components/chat/context'
import { projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { q, useProjects } from '@/lib/queries'
import type { Journey, ProjectRef } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/projects/')({
  staticData: { crumb: 'Projects' },
  // the table's view in the address: projects.sort, projects.f, projects.q
  validateSearch: z.record(z.string(), z.unknown()),
  component: Projects,
})

interface Row {
  repo: string
  name: string
  revision: string
  template: string
  stage: string
  criteria: string
  next: string
  yours: boolean
  part: string
  journey?: Journey
}

const columns: ColumnDef<Row, any>[] = [
  { accessorKey: 'name', header: 'Project', size: 200, meta: { label: 'Project', kind: 'text' }, cell: ({ row }) => <span className="font-medium"><Highlight text={row.original.name} /></span> },
  { accessorKey: 'revision', header: 'Revision', size: 96, meta: { label: 'Revision', kind: 'enum' } },
  { accessorKey: 'template', header: 'Template', size: 110, meta: { label: 'Template', kind: 'enum' } },
  {
    accessorKey: 'stage',
    header: 'Stage',
    size: 220,
    meta: { label: 'Stage', kind: 'enum' },
    cell: ({ row }) => (row.original.journey ? <StageRail stages={row.original.journey.stages} variant="compact" /> : <Highlight text={row.original.stage} />),
  },
  { accessorKey: 'next', header: 'Next step', size: 320, meta: { label: 'Next step', kind: 'text' }, cell: ({ row }) => <span className={cn(row.original.yours && 'font-medium text-primary')}><Highlight text={row.original.next} /></span> },
  { accessorKey: 'part', header: 'Your part', size: 120, meta: { label: 'Your part', kind: 'enum' } },
  { accessorKey: 'repo', header: 'Repository', size: 220, meta: { label: 'Repository', kind: 'text', mono: true } },
]

function toRow(p: ProjectRef, j?: Journey): Row {
  const cur = j?.stages.find((s) => s.state === 'current' || s.state === 'reopened')
  return {
    repo: p.repo,
    name: j?.name ?? projectName(p.repo),
    revision: j?.revision ?? '',
    template: j ? (j.template === 'fpga' ? 'FPGA' : j.template.charAt(0).toUpperCase() + j.template.slice(1)) : '',
    stage: cur?.name ?? '',
    criteria: cur ? `${cur.criteria.met} of ${cur.criteria.total}` : '',
    next: j ? j.next.short ?? j.next.summary.replace(/\*\*/g, '') : '',
    yours: j?.next.owner === 'you',
    part: p.part === 'reviewer' ? 'Reviewer' : 'Contributor',
    journey: j,
  }
}

function Projects() {
  const projects = useProjects()
  const { user } = useAuth()
  const navigate = useNavigate()
  const url = useUrlView('projects')
  const list = projects.data ?? []
  const journeys = useQueries({ queries: list.map((p) => q('journey.get', { repo: p.repo })) })
  const rows = list.map((p, i) => toRow(p, journeys[i]?.data))
  useTraceContext({ label: 'Projects', description: 'The screen the person is on', value: 'All projects list' }, 'screen')

  return (
    <Column wide>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        {user?.class === 'admin' && (
          <Button asChild>
            <Link to="/projects/new">
              <Plus /> New project
            </Link>
          </Button>
        )}
      </div>
      {projects.isError ? (
        <QueryError error={projects.error} what="your projects" onRetry={() => void projects.refetch()} />
      ) : projects.isLoading ? (
        <Loading>
          <SkeletonRows rows={4} />
        </Loading>
      ) : (
        <DataTable
          id="projects"
          data={rows}
          columns={columns}
          getRowId={(r) => r.repo}
          url={url}
          noun="projects"
          onRowClick={(r) => void navigate({ to: '/p/$id', params: { id: projectId(r.repo) } })}
          empty={user?.class === 'admin' ? 'No projects yet. Start one with New project.' : 'You are not on a project yet. Ask an admin to add you.'}
        />
      )}
    </Column>
  )
}
