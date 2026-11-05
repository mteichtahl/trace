/**
 * Agents and tools (/agents), redesigned as a picture (docs/agents-screen.md): what every agent is doing on every
 * project and who has asked whom, at a glance.
 *
 * - **Project filter** (`?project=owner/name`): All projects summarises every project; one project shows only its
 *   work. The filter is in the address, so a link keeps it.
 * - **Projects at a glance** (All projects, more than one project): each project's agents by state, its jobs, its open
 *   hand-offs and what it has on Next, with "Show only this project".
 * - **The map** (agent-map.tsx): each agent a box listing its work one line per project (step, progress, queue and
 *   today), the hand-offs between agents as arrows counting the hand-offs on each. On a phone the boxes stack as cards.
 * - **Needs you or stuck**, beside the map: the questions and stuck reports on Next for the projects in view, answered
 *   or dismissed here.
 * - **Hand-offs**, grouped by arrow, each declinable (a reason in one line) by people who may change its project;
 *   older ones fold away.
 * - **trace is doing now**: the running, paused and queued jobs with their controls (Pause, Resume, Move up, Cancel).
 * - The tool catalogue, as before.
 *
 * Everything is live through job.updated events (jobs.list), as the screen it replaces was.
 */
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Info } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { AgentCards, AgentMap, type AgentView, LINK_LOOK, STATUS_OF } from '@/components/agents/agent-map'
import { type AgentLink, countsText, glanceOf, handoffText, linksOf, onMap, type ProjectGlance, projectTone } from '@/components/agents/map-model'
import { ToolsCatalogue } from '@/components/agents/tools-catalogue'
import { mergeAgents, useWork } from '@/components/agents/use-agents'
import { useTraceContext } from '@/components/chat/context'
import { useDismissStuck } from '@/components/dismiss-stuck'
import { FoldRows } from '@/components/fold-row'
import { HandoffRow, useDeclineHandoffs } from '@/components/handoff'
import { NeedsYouCard } from '@/components/needs-you-card'
import { offerPush } from '@/components/push-prompt'
import { RunLine, runControls } from '@/components/run-line'
import { useWatchRun } from '@/components/run-sheet'
import { Column, Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { EmptyState, Loading, Partial, QueryError, SkeletonRows } from '@/components/states'
import { useMediaQuery } from '@/hooks/use-media-query'
import { projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { plural } from '@/lib/format'
import { AGENTS } from '@/lib/knowledge'
import { useCall, useInbox, useProjects } from '@/lib/queries'
import type { InboxItem } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/agents/')({
  staticData: { crumb: 'Agents and tools' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Agents,
})

function Agents() {
  const work = useWork()
  const watch = useWatchRun()
  const inbox = useInbox()
  const projects = useProjects()
  const { user } = useAuth()
  const navigate = useNavigate()
  const search = Route.useSearch()
  const phone = useMediaQuery('(max-width: 767px)')
  const dismiss = useDismissStuck()
  const decline = useDeclineHandoffs()
  const answer = useCall('question.answer', (a) => [['inbox'], ['journey.get', a.repo], ['jobs.list', a.repo]])
  const admin = user?.class === 'admin'
  const reviewerOnly = !admin && (projects.data ?? []).every((p) => (p.part ?? 'contributor') === 'reviewer')

  // the filter: a project the person has, or All projects
  const repos = work.per.map((p) => p.repo)
  const asked = typeof search.project === 'string' ? search.project : null
  const only = asked && repos.includes(asked) ? asked : null
  const scope = useMemo(() => (only ? work.per.filter((p) => p.repo === only) : work.per), [work.per, only])
  const inScope = (repo: string) => !only || repo === only
  const setOnly = (repo: string | null) => void navigate({ to: '/agents', search: (s: Record<string, unknown>) => ({ ...s, project: repo ?? undefined }), replace: true })

  // each project's colour, by its place in the person's list, so it holds still when the filter changes
  const tones = useMemo(() => new Map(repos.map((r, i) => [r, projectTone(i)])), [repos.join(',')])
  const now = Date.now()
  const merged = useMemo(() => mergeAgents(scope), [scope])
  const views: AgentView[] = useMemo(() => {
    const known = AGENTS.map((a) => ({ id: a.id as string, name: a.name as string, does: a.does as string, work: merged.get(a.id) }))
    // agents trace reports that the app does not list yet still get a box, when they have work
    const extra = [...merged.values()].filter((w) => !AGENTS.some((a) => a.id === w.id) && w.status !== 'idle')
      .map((w) => ({ id: w.id, name: scope.flatMap((p) => p.agents).find((a) => a.id === w.id)?.name ?? w.id, does: '', work: w }))
    return [...known, ...extra]
  }, [merged, scope])
  const handoffs = work.handoffs.filter((x) => inScope(x.repo))
  const links = useMemo(() => linksOf(handoffs, now), [handoffs.map((x) => `${x.repo}:${x.handoff.id}:${x.handoff.state}`).join(',')])
  const earlier = handoffs.filter((x) => !onMap(x.handoff, now))
  const running = work.running.filter((x) => inScope(x.repo))
  const queued = work.queued.filter((x) => inScope(x.repo))
  const needs = (inbox.data ?? []).filter((i) => (i.kind === 'question' || i.kind === 'stuck') && inScope(i.repo))
  const glance = useMemo(() => glanceOf(work.per, inbox.data ?? [], now, tones), [work.per, inbox.data, tones])

  const counts = { working: 0, waiting_person: 0, stuck: 0, queued: 0, idle: 0 }
  for (const v of views) counts[v.work?.status ?? 'idle']++
  const open = handoffs.filter((x) => x.handoff.state === 'requested' || x.handoff.state === 'queued' || x.handoff.state === 'running').length
  const questions = needs.filter((i) => i.kind === 'question').length
  const where = only ? projectName(only) : scope.length === 1 ? scope[0]!.project : `across ${plural(scope.length, 'project')}`
  const summary = work.loading
    ? ' '
    : work.projectsError
      ? 'trace could not read your projects, so what its agents are doing is not known just now.'
      : `${running.length === 0 ? 'Nothing is running' : `${plural(running.length, 'job')} ${running.length === 1 ? 'is' : 'are'} running`}${queued.length ? `, ${queued.length} queued` : ''} ${only ? `on ${where}` : where}. ${questions === 0 ? 'No question is waiting on you' : `${questions === 1 ? 'One question is' : `${questions} questions are`} waiting on you`}${counts.stuck ? `, and ${plural(counts.stuck, 'agent is', 'agents are')} stuck` : ''}.`

  const onAnswer = (item: InboxItem) => {
    if (!item.questionId || !item.recommended) return
    answer.mutate(
      { repo: item.repo, question: item.questionId, option: item.recommended.id },
      {
        onSuccess: (r) => {
          toast(`Answered: ${item.recommended!.label}`, { description: `${item.project}: ${r.summary?.replace(/^Answered\. /, '') ?? 'the agent carries on.'}` })
          void offerPush()
        },
        onError: (e) => toast.error('Could not send the answer', { description: `${e.message} Nothing was lost; try again.` }),
      },
    )
  }

  useTraceContext({
    label: 'Agents and tools',
    description: 'The screen the person is on: every agent\'s work on each project, and the hand-offs between them',
    value: { project: only ? projectName(only) : 'All projects', running: running.map((w) => `${w.project}: ${w.run.title}`), queued: queued.length, stuck: counts.stuck, handoffsOpen: open },
  }, 'screen')
  useCommands([
    { id: 'a-tools', label: 'Search the tools', group: 'Agents', run: () => document.querySelector<HTMLInputElement>('[aria-label="Search tools"]')?.focus() },
    { id: 'a-all', label: 'Agents: show all projects', group: 'Agents', run: () => setOnly(null) },
    ...work.per.map((p) => ({ id: `a-p-${p.repo}`, label: `Agents: show only ${p.project}`, group: 'Agents', run: () => setOnly(p.repo) })),
    ...AGENTS.map((a) => ({ id: `a-${a.id}`, label: `Open the ${a.name} agent`, group: 'Agents', run: () => void navigate({ to: '/agents/$agent', params: { agent: a.id } }) })),
  ])

  return (
    <Column wide>
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1 basis-[420px]">
          <h1 className="text-2xl font-semibold tracking-tight">Agents and tools</h1>
          <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">{summary}</p>
        </div>
        {work.per.length > 1 && (
          <div role="radiogroup" aria-label="Projects shown" className="inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1 text-sm">
            <ProjectChip on={!only} onClick={() => setOnly(null)}>All projects</ProjectChip>
            {work.per.map((p) => (
              <ProjectChip key={p.repo} on={only === p.repo} onClick={() => setOnly(p.repo)}>
                <span className="size-2 rounded-full" style={{ background: tones.get(p.repo) }} aria-hidden />
                {p.project}
              </ProjectChip>
            ))}
          </div>
        )}
      </div>

      {work.projectsError && <div className="mt-6"><QueryError error={work.projectsError} what="your projects, so this page cannot show what the agents are doing" onRetry={work.retry} /></div>}
      {work.failed.length > 0 && <div className="mt-4"><Partial>Could not read what is running on {work.failed.map(projectName).join(', ')}.</Partial></div>}

      {!work.projectsError && (
        <div className="mt-5 flex flex-wrap gap-2 text-sm" aria-label="Agents by state">
          {(['working', 'waiting_person', 'stuck', 'queued', 'idle'] as const).map((s) => (
            <span key={s} className={cn('inline-flex items-center gap-2 rounded-lg border px-3 py-1.5',
              s === 'waiting_person' && counts[s] ? 'border-primary/30 bg-primary-soft text-primary' : s === 'stuck' && counts[s] ? 'border-warning/40 bg-warning/10 text-warning-foreground' : 'bg-card text-muted-foreground')}>
              <span className={cn('size-2.5 rounded-full', s === 'working' ? 'bg-foreground' : s === 'waiting_person' ? 'bg-primary' : s === 'stuck' ? 'bg-warning' : s === 'queued' ? 'border-2 border-muted-foreground' : 'bg-muted-foreground/30')} aria-hidden />
              <b className="text-foreground">{counts[s]}</b> {STATUS_OF[s].label}
            </span>
          ))}
          <a href="#handoffs" className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-muted-foreground hover:text-foreground"><b className="text-foreground">{open}</b> {open === 1 ? 'hand-off' : 'hand-offs'} open</a>
        </div>
      )}

      {!only && work.per.length > 1 && !work.loading && (
        <Section label="Projects at a glance" count={glance.length} className="mt-8">
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
            {glance.map((g) => <ProjectTile key={g.repo} g={g} onOnly={() => setOnly(g.repo)} />)}
          </div>
        </Section>
      )}

      {needs.length > 0 && (
        <section id="needs" aria-labelledby="needs-h" className="mt-8 scroll-mt-20 rounded-xl border border-primary/20 bg-primary-soft/60 p-3">
          <h2 id="needs-h" className="flex items-center gap-2 px-1 pb-2 text-sm font-semibold">
            <span className="size-2.5 rounded-full bg-primary" aria-hidden />Needs you or stuck
            <span className="ml-auto font-normal text-muted-foreground">{needs.length}</span>
          </h2>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr))]">
            {needs.map((i) => (
              <NeedsYouCard
                key={i.id} item={i} compact={phone}
                onAnswer={reviewerOnly ? undefined : onAnswer}
                answering={answer.isPending && answer.variables?.question === i.questionId}
                onDismiss={reviewerOnly ? undefined : dismiss}
                onOther={(it) => it.action.to && void navigate({ to: it.action.to })}
                className="bg-card"
              />
            ))}
          </div>
        </section>
      )}

      <section aria-label="Agents map" className="mt-8">
        {work.loading ? (
          <Loading><SkeletonRows rows={4} /></Loading>
        ) : phone ? (
          <>
            <h2 className="section-label mb-3">Agents ({views.length})</h2>
            <AgentCards views={views} tones={tones} showProject={!only} />
          </>
        ) : (
          <AgentMap views={views} links={links} tones={tones} showProject={!only} title="Who is working with whom" subtitle={only ? projectName(only) : 'All projects'} />
        )}
        {!phone && !work.loading && <MapLegend scope={only ? [] : scope.map((p) => ({ name: p.project, tone: tones.get(p.repo)! }))} />}
      </section>

      <Section label="Hand-offs" count={links.reduce((n, l) => n + l.items.length, 0)} className="mt-10">
        <div id="handoffs" className="scroll-mt-20" />
        <p className="mb-3 flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>A specialist asks another only through a recorded request; the asked one runs it as a queued job, and its answer is kept for the one that asked. Grouped by arrow, as on the map: open ones, and ones that ended in the last hour.</span>
        </p>
        {work.loading ? <Loading><SkeletonRows rows={2} /></Loading> : links.length === 0 ? (
          <EmptyState>No hand-off is open{only ? ` on ${projectName(only)}` : ''}. When one specialist needs another's answer, it asks in writing and the request shows here.</EmptyState>
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr))]">
            {links.map((l) => <LinkCard key={l.id} link={l} tones={tones} showProject={!only} write={work.write} onDecline={(repo, h, why) => decline(repo, h, why)} />)}
          </div>
        )}
        {earlier.length > 0 && (
          <FoldRows label={`Earlier hand-offs (${earlier.length})`} className="mt-3">
            <div className="divide-y rounded-xl border">
              {earlier.map((x) => <HandoffRow key={`${x.repo}:${x.handoff.id}`} handoff={x.handoff} project={only ? undefined : x.project} />)}
            </div>
          </FoldRows>
        )}
      </Section>

      <Section label="trace is doing now" count={running.length + queued.length} className="mt-10">
        {work.loading ? (
          <Loading><SkeletonRows rows={2} /></Loading>
        ) : work.projectsError ? (
          <EmptyState>Not known until trace can read your projects.</EmptyState>
        ) : running.length + queued.length === 0 ? (
          <EmptyState>Nothing is running or queued{only ? ` on ${projectName(only)}` : ' on your projects'}.</EmptyState>
        ) : (
          <div className="divide-y rounded-xl border">
            {[...running, ...queued].map((w) => (
              <RunLine
                key={`${w.repo}:${w.run.id}`}
                run={{ ...w.run, title: w.run.agentName ? `${w.run.agentName}: ${w.run.title}` : w.run.title }}
                project={only ? undefined : w.project}
                {...runControls(work.write.has(w.repo))}
                onWatch={(r) => watch.onWatch(r, w.repo)}
              />
            ))}
            {watch.sheet}
          </div>
        )}
      </Section>

      <div id="tools" className="scroll-mt-20" />
      <ToolsCatalogue />

      <p className="mt-8 flex gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        {admin
          ? 'You see every project\'s agents because you are an admin. Others see their projects\' work, and other projects\' work only as "Busy".'
          : reviewerOnly
            ? 'You review your projects, so you see the agents and the catalogue but no Try it and no controls.'
            : 'You see your projects\' work. Other projects\' work shows only as "Busy", never what it is.'}
      </p>
    </Column>
  )
}

function ProjectChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" role="radio" aria-checked={on} onClick={onClick}
      className={cn('inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5', on ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
    >
      {children}
    </button>
  )
}

/** One project in "Projects at a glance": its agents by state as a bar, its work and hand-offs in words. */
function ProjectTile({ g, onOnly }: { g: ProjectGlance; onOnly: () => void }) {
  const c = g.counts
  const segments = [
    { n: c.working, cls: 'bg-foreground' }, { n: c.waiting_person, cls: 'bg-primary' }, { n: c.stuck, cls: 'bg-warning' }, { n: c.queued, cls: 'bg-muted-foreground/40' },
  ].filter((s) => s.n > 0)
  const pressing = c.waiting_person > 0 || c.stuck > 0
  return (
    <article className={cn('rounded-xl border bg-card p-4', pressing && 'border-primary ring-1 ring-primary/40')}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: g.tone }} aria-hidden />
        <b className="min-w-0 flex-1 truncate" title={g.project}>{g.project}</b>
        {g.paused && <span className="shrink-0 rounded-full bg-muted px-2 text-xs leading-5 text-muted-foreground">Paused</span>}
        {g.needs > 0 && <span className="shrink-0 rounded-full bg-primary/15 px-2 text-xs leading-5 text-primary">{g.needs} on Next</span>}
      </div>
      <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={countsText(c)}>
        {segments.map((s, i) => <span key={i} className={s.cls} style={{ flex: s.n }} />)}
      </div>
      <p className="mt-2 truncate text-sm" title={countsText(c)}>{countsText(c)}</p>
      <p className="truncate text-xs text-muted-foreground">{plural(g.running, 'job')} running · {g.queued} queued · {handoffText(g.open, g.recent)}</p>
      <button type="button" onClick={onOnly} className="mt-2 inline-flex min-h-9 items-center gap-1 text-sm font-medium text-primary hover:underline">
        Show only this project<ArrowRight className="size-3.5" aria-hidden />
      </button>
    </article>
  )
}

/** One arrow's hand-offs: asker → asked, how many, and each hand-off with its project and Decline. */
function LinkCard({ link: l, tones, showProject, write, onDecline }: { link: AgentLink; tones: ReadonlyMap<string, string>; showProject: boolean; write: Set<string>; onDecline: (repo: string, h: AgentLink['items'][number]['handoff'], why: string) => Promise<string> }) {
  const look = LINK_LOOK[l.state]
  return (
    <article className={cn('overflow-hidden rounded-xl border bg-card', l.state === 'waiting' && 'border-dashed', l.state === 'answered' && 'border-verified/40')}>
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5 text-sm font-medium">
        <span className="rounded-md border bg-background px-2 py-0.5">{l.fromName}</span>
        <ArrowRight className="size-4" style={{ color: look.color }} aria-label="asked" />
        <span className="rounded-md border bg-background px-2 py-0.5">{l.toName}</span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">{look.word} · {l.items.length}</span>
      </header>
      <div className="divide-y">
        {l.items.map((x) => (
          <div key={`${x.repo}:${x.handoff.id}`} className="flex">
            {showProject && <span className="mt-[22px] ml-4 hidden size-2 shrink-0 rounded-full sm:block" style={{ background: tones.get(x.repo) }} aria-hidden />}
            <HandoffRow
              handoff={x.handoff} project={showProject ? x.project : undefined} className="min-w-0 flex-1 px-4 py-3"
              {...(write.has(x.repo) ? { onDecline: (h, why) => onDecline(x.repo, h, why) } : {})}
            />
          </div>
        ))}
      </div>
    </article>
  )
}

/** What the arrows' lines, their numbers and the dots mean. */
function MapLegend({ scope }: { scope: { name: string; tone: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs text-muted-foreground">
      {(['running', 'waiting', 'answered'] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-2">
          <span className="w-7 border-t-2" style={{ borderColor: LINK_LOOK[s].color, borderStyle: LINK_LOOK[s].dashed ? 'dashed' : 'solid' }} aria-hidden />
          {LINK_LOOK[s].word}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5"><span className="inline-flex size-[18px] items-center justify-center rounded-full border text-[10px] font-semibold text-foreground">2</span>Hand-offs on that arrow</span>
      {scope.map((p) => (
        <span key={p.name} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: p.tone }} aria-hidden />{p.name}</span>
      ))}
      <Link to="/agents" hash="handoffs" className="ml-auto text-primary hover:underline">All hand-offs</Link>
    </div>
  )
}

