/**
 * A project: one header (name, revision badge, template, people, the rare-actions menu) and a short row of tabs that
 * appear only once the project has reached the stage that fills them (visibleTabs). Each tab is a child route under
 * routes/_app/p/$id/; Overview is the index.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTraceContext } from '@/components/chat/context'
import { useChanges } from '@/components/changes/changes-list'
import { useCrumb } from '@/components/shell/breadcrumbs'
import { NotShared, QueryError } from '@/components/states'
import { ApiError, projectName, repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { initials } from '@/lib/format'
import { q, useJourney } from '@/lib/queries'
import type { Journey } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/p/$id')({
  staticData: { crumb: 'Project', parent: { label: 'Projects', to: '/projects' } },
  loader: ({ context, params }) => {
    // warm the cache so the header and stage rail draw from it while the lists load
    void context.queryClient.prefetchQuery(q('journey.get', { repo: repoOf(params.id) }))
  },
  component: ProjectLayout,
})

export interface ProjectTab {
  id: string
  label: string
  /** the path under /p/$id */
  to: string
}

const reached = (j: Journey, names: string[]): boolean =>
  j.stages.some((s) => names.includes(s.name.toLowerCase()) && s.state !== 'queued' && s.state !== 'skipped')

/** The tabs a project shows (docs/ui-design.md, "Inside a project"). */
export function visibleTabs(j: Journey, o: { admin: boolean }): ProjectTab[] {
  const tabs: (ProjectTab & { show: boolean })[] = [
    { id: 'overview', label: 'Overview', to: '', show: true },
    { id: 'requirements', label: 'Requirements', to: '/requirements', show: reached(j, ['define']) },
    { id: 'design', label: 'Design', to: '/design', show: reached(j, ['architect']) },
    { id: 'changes', label: 'Changes', to: '/changes', show: true },
    { id: 'evidence', label: 'Evidence', to: '/evidence', show: reached(j, ['prove']) },
    { id: 'build', label: 'Build', to: '/build', show: reached(j, ['release']) },
    { id: 'decisions', label: 'Decisions', to: '/decisions', show: j.gates.some((g) => g.state === 'signed') },
    { id: 'files', label: 'Files', to: '/files', show: true },
    { id: 'settings', label: 'Settings', to: '/settings', show: true },
    { id: 'cost', label: 'Cost and time', to: '/cost', show: o.admin },
    { id: 'memory', label: 'Memory', to: '/memory', show: !!j.hasMemory },
  ]
  return tabs.filter((t) => t.show)
}

function People({ repo }: { repo: string }) {
  const members = useQuery(q('project.members', { repo }))
  return (
    <div className="flex -space-x-1.5">
      {(members.data ?? []).slice(0, 5).map((m) => (
        <Tooltip key={m.sub}>
          <TooltipTrigger asChild>
            <span className="flex size-8 items-center justify-center rounded-full border-2 border-background bg-muted text-[11px] font-semibold">{initials(m.name ?? m.email)}</span>
          </TooltipTrigger>
          <TooltipContent>
            {m.name ?? m.email} · {m.admin ? 'Admin' : m.part === 'contributor' ? 'Contributor' : 'Reviewer'}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

function ProjectLayout() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const j = useJourney(repo)
  const changes = useChanges(repo)
  const { user } = useAuth()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const base = `/p/${id}`
  const name = j.data?.name ?? projectName(repo)
  useCrumb('/_app/p/$id', j.data ? `${name} · ${j.data.revision}` : name)
  const current = j.data?.stages.find((s) => s.state === 'current' || s.state === 'reopened')
  useTraceContext({ label: name, description: 'The project the person is looking at', value: { repo, name, revision: j.data?.revision ?? null, stage: current?.name ?? null } }, 'project')

  if (j.isError) return j.error instanceof ApiError && j.error.noAccess ? <NotShared /> : <div className="p-6"><QueryError error={j.error} what="this project" onRetry={() => void j.refetch()} /></div>

  const tabs = j.data ? visibleTabs(j.data, { admin: user?.class === 'admin' }) : []
  const ready = (changes.data?.changes ?? []).filter((c) => c.verdict === 'ready').length
  const all = 9
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 md:px-6 md:pt-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        {j.data ? (
          <>
            <Badge variant="outline" className="rounded-md">{j.data.revision}</Badge>
            <span className="text-sm text-muted-foreground">{j.data.template === 'fpga' ? 'FPGA' : j.data.template.charAt(0).toUpperCase() + j.data.template.slice(1)} template</span>
          </>
        ) : (
          <Skeleton className="h-5 w-32" />
        )}
        <div className="ml-auto flex items-center gap-2">
          <People repo={repo} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild><Link to="/p/$id/do/$skill" params={{ id, skill: 'change-request' }}>Raise a change</Link></DropdownMenuItem>
              <DropdownMenuItem disabled={user?.class !== 'admin'}>Start next revision</DropdownMenuItem>
              <DropdownMenuItem>Export the record</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <nav aria-label="Project" className="mt-5 flex items-end gap-1 overflow-x-auto border-b">
        {tabs.map((t) => {
          const to = base + t.to
          const active = t.to === '' ? pathname === base || pathname === `${base}/` : pathname.startsWith(to)
          return (
            <Link key={t.id} to={to} aria-current={active ? 'page' : undefined} className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm', active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t.label}
              {t.id === 'changes' && ready > 0 && (
                <span className="flex size-[18px] items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground" aria-label={`${ready} ready for you`}>{ready}</span>
              )}
            </Link>
          )
        })}
        {j.data && tabs.length < all && <span className="hidden pb-2.5 pl-3 text-xs text-muted-foreground lg:inline">More tabs appear as the project reaches later stages</span>}
      </nav>
      <Outlet />
    </div>
  )
}
