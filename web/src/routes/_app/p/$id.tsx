/**
 * A project: one header (name, revision badge, template, people, the rare-actions menu) and five tabs (Overview,
 * Design, Proof, Changes, More: docs/ui-simplify.md, "Five tabs"). A tab holds one or more sections, each a child
 * route under routes/_app/p/$id/ that appears only once the project has reached the stage that fills it
 * (visibleTabs); a tab with several shows them as a short row under the tab row. Overview is the index.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { Archive, MoreHorizontal, PauseCircle, Play } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTraceContext } from '@/components/chat/context'
import { useChanges } from '@/components/changes/changes-list'
import { AgentSetupNotice } from '@/components/project/agent-setup'
import { PauseDialog, PausedBanner, RetireDialog, mayPause, useLifecycle } from '@/components/project/lifecycle'
import { SectionsSheet } from '@/components/project/sections-sheet'
import { useCrumb } from '@/components/shell/breadcrumbs'
import { NotShared, QueryError } from '@/components/states'
import { ApiError, projectName, repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { initials } from '@/lib/format'
import { q, useCall, useJourney, useProjects } from '@/lib/queries'
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

export type TabGroupId = 'overview' | 'design' | 'proof' | 'changes' | 'more'

/** One of a project's sections: a page under /p/$id, shown inside one of the five tabs (docs/ui-simplify.md, "Five tabs"). */
export interface ProjectTab {
  id: string
  label: string
  /** the path under /p/$id */
  to: string
  /** the tab it sits in */
  group: TabGroupId
  /** other paths under /p/$id that belong to it (a run's page belongs to Evidence) */
  also?: string[]
}

const reached = (j: Journey, names: string[]): boolean =>
  j.stages.some((s) => names.includes(s.name.toLowerCase()) && s.state !== 'queued' && s.state !== 'skipped')

/**
 * The sections a project shows, each once it has reached the stage that fills it, in the order of the five tabs:
 * Overview; Design (requirements, the design, the build, renders); Proof (evidence, decisions, documents); Changes;
 * More (files, cost and time, memory, settings).
 */
export function visibleTabs(j: Journey, o: { admin: boolean }): ProjectTab[] {
  const tabs: (ProjectTab & { show: boolean })[] = [
    { id: 'overview', label: 'Overview', to: '', group: 'overview', show: true },
    { id: 'requirements', label: 'Requirements', to: '/requirements', group: 'design', show: reached(j, ['define']) },
    { id: 'design', label: 'Design', to: '/design', group: 'design', show: reached(j, ['architect']) },
    { id: 'build', label: 'Build', to: '/build', group: 'design', show: reached(j, ['release']) },
    // each revision's renders, made when it is cut (docs/revision-renders.md)
    { id: 'renders', label: 'Renders', to: '/renders', group: 'design', show: reached(j, ['release']) },
    // from the first run on: Capture where the template has it (checks start running there), else Prove
    { id: 'evidence', label: 'Evidence', to: '/evidence', group: 'proof', also: ['/runs'], show: reached(j, ['capture', 'prove']) },
    { id: 'decisions', label: 'Decisions', to: '/decisions', group: 'proof', show: j.gates.some((g) => g.state === 'signed') },
    // the project's documents, which Scribe keeps from Architect on (docs/scribe.md)
    { id: 'docs', label: 'Documents', to: '/docs', group: 'proof', show: reached(j, ['architect']) },
    { id: 'changes', label: 'Changes', to: '/changes', group: 'changes', show: true },
    { id: 'files', label: 'Files', to: '/files', group: 'more', show: true },
    { id: 'cost', label: 'Cost and time', to: '/cost', group: 'more', show: o.admin },
    { id: 'memory', label: 'Memory', to: '/memory', group: 'more', show: !!j.hasMemory },
    { id: 'settings', label: 'Settings', to: '/settings', group: 'more', show: true },
  ]
  return tabs.filter((t) => t.show).map(({ show: _show, ...t }) => t)
}

export const GROUP_LABEL: Record<TabGroupId, string> = { overview: 'Overview', design: 'Design', proof: 'Proof', changes: 'Changes', more: 'More' }
const GROUP_ORDER: TabGroupId[] = ['overview', 'design', 'proof', 'changes', 'more']

export interface TabGroup {
  id: TabGroupId
  label: string
  /** where the tab goes: its first section */
  to: string
  sections: ProjectTab[]
}

/** The five tabs, each with the sections the project has reached; a tab with none yet is left out. */
export function tabGroups(sections: ProjectTab[]): TabGroup[] {
  return GROUP_ORDER.map((id) => ({ id, label: GROUP_LABEL[id], sections: sections.filter((t) => t.group === id) }))
    .filter((g) => g.sections.length > 0)
    .map((g) => ({ ...g, to: g.sections[0]!.to }))
}

/** Whether a path under the project (after /p/$id) is this section's. */
export const inSection = (t: ProjectTab, rest: string): boolean =>
  t.to === '' ? rest === '' || rest === '/' : [t.to, ...(t.also ?? [])].some((p) => rest === p || rest.startsWith(`${p}/`))

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
  const admin = user?.class === 'admin'
  const part = useProjects().data?.find((p) => p.repo.toLowerCase() === repo.toLowerCase())?.part
  const life = useLifecycle(repo)
  const paused = !!life.data?.paused
  const retired = !!life.data?.retired
  const canPause = mayPause({ admin, part })
  const [dialog, setDialog] = useState<'pause' | 'retire' | null>(null)
  const resume = useCall('project.resume', ({ repo: r }) => [['project.lifecycle', r], ['projects'], ['journey.get', r], ['inbox']])
  const doResume = () => resume.mutate({ repo }, { onSuccess: (r) => toast(r.summary), onError: (e) => toast.error(`Could not resume: ${e.message}`) })
  useTraceContext({ label: name, description: 'The project the person is looking at', value: { repo, name, revision: j.data?.revision ?? null, stage: current?.name ?? null, paused, retired } }, 'project')

  if (j.isError) return j.error instanceof ApiError && j.error.noAccess ? <NotShared /> : <div className="p-6"><QueryError error={j.error} what="this project" onRetry={() => void j.refetch()} /></div>

  const tabs = j.data ? visibleTabs(j.data, { admin: user?.class === 'admin' }) : []
  const ready = (changes.data?.changes ?? []).filter((c) => c.verdict === 'ready').length
  /** changes whose checks are still running: shown in orange beside the ready count */
  const checking = (changes.data?.changes ?? []).filter((c) => c.verdict === 'checking').length
  const groups = tabGroups(tabs)
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : ''
  /** the section the person is on, and the tab it sits in */
  const here = tabs.find((t) => inSection(t, rest))
  const group = groups.find((g) => g.id === here?.group)
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-4 md:px-6 md:pt-8">
      <header className="flex flex-wrap items-center gap-3 max-md:flex-nowrap">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 max-md:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight max-md:truncate max-md:text-xl">{name}</h1>
          {j.data ? (
            <>
              <Badge variant="outline" className="rounded-md">{j.data.revision}</Badge>
              <span className="text-sm text-muted-foreground max-md:hidden">{j.data.template === 'fpga' ? 'FPGA' : j.data.template.charAt(0).toUpperCase() + j.data.template.slice(1)} template</span>
            </>
          ) : (
            <Skeleton className="h-5 w-32" />
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 max-md:hidden">
          <People repo={repo} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild disabled={paused || retired}><Link to="/p/$id/do/$skill" params={{ id, skill: 'change-request' }}>Raise a change</Link></DropdownMenuItem>
              <DropdownMenuItem disabled={!admin || paused || retired}>Start next revision</DropdownMenuItem>
              <DropdownMenuItem>Export the record</DropdownMenuItem>
              {(canPause || admin) && <DropdownMenuSeparator />}
              {canPause && !retired && (paused
                ? <DropdownMenuItem onSelect={doResume}><Play />Resume project</DropdownMenuItem>
                : <DropdownMenuItem onSelect={() => setDialog('pause')}><PauseCircle />Pause project…</DropdownMenuItem>)}
              {admin && !retired && <DropdownMenuItem variant="destructive" onSelect={() => setDialog('retire')}><Archive />Retire project…</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* a phone: the sections open in a sheet rather than a row of tabs that scrolls out of sight */}
        <div className="shrink-0 md:hidden">
          <SectionsSheet
            name={name}
            base={base}
            tabs={tabs}
            journey={j.data}
            changes={changes.data?.changes.length ?? 0}
            ready={ready}
            checking={checking}
            actions={
              <>
                {!paused && !retired && (
                  <Button asChild variant="outline" size="sm">
                    <Link to="/p/$id/do/$skill" params={{ id, skill: 'change-request' }}>Raise a change</Link>
                  </Button>
                )}
                {canPause && !paused && !retired && <Button variant="outline" size="sm" onClick={() => setDialog('pause')}><PauseCircle />Pause</Button>}
                {admin && !retired && <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDialog('retire')}><Archive />Retire</Button>}
              </>
            }
          />
        </div>
      </header>
      <nav aria-label="Project" className="mt-5 flex items-end gap-1 overflow-x-auto border-b max-md:hidden">
        {groups.map((g) => {
          const active = g.id === here?.group
          return (
            <Link key={g.id} to={base + g.to} aria-current={active ? 'page' : undefined} className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm', active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {g.label}
              {g.id === 'changes' && ready > 0 && (
                <span className="flex size-[18px] items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground" aria-label={`${ready} ready for you`}>{ready}</span>
              )}
              {g.id === 'changes' && checking > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-orange-500 px-1 text-[11px] font-semibold text-white" aria-label={`${checking} being checked`}>{checking}</span>
                  </TooltipTrigger>
                  <TooltipContent>{checking} {checking === 1 ? 'change is' : 'changes are'} being checked</TooltipContent>
                </Tooltip>
              )}
            </Link>
          )
        })}
      </nav>
      {/* the sections inside the tab the person is on, when it has more than one */}
      {group && group.sections.length > 1 && (
        <nav aria-label={`${group.label} sections`} className="mt-3 flex flex-wrap gap-1 max-md:hidden">
          {group.sections.map((t) => {
            const active = t.id === here?.id
            return (
              <Link key={t.id} to={base + t.to} aria-current={active ? 'page' : undefined} className={cn('rounded-md px-2.5 py-1 text-sm', active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}>
                {t.label}
              </Link>
            )
          })}
        </nav>
      )}
      <PausedBanner repo={repo} part={part} className="mt-4" />
      <AgentSetupNotice repo={repo} className="mt-4" />
      <PauseDialog repo={repo} name={name} open={dialog === 'pause'} onOpenChange={(o) => setDialog(o ? 'pause' : null)} />
      <RetireDialog repo={repo} name={name} open={dialog === 'retire'} onOpenChange={(o) => setDialog(o ? 'retire' : null)} />
      <Outlet />
    </div>
  )
}
