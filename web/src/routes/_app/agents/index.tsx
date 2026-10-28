/**
 * Agents and tools (/agents): every agent and every tool trace has, what is happening right now, and whether each can
 * work. From the API: the work running, paused and queued on the person's projects and each agent's status there
 * (jobs.list: the projects' job indexes, with the journey's questions and stuck reports; live through job.updated
 * events), what needs a person (inbox), and the tool list with runs. Each agent's row: its status (Working, Queued,
 * Waiting on a person, Stuck, Idle; the most pressing across the person's projects), what it is doing now, its queue
 * (with Move up), and its last day's runs. The hand-offs between agents (jobs.list `handoffs`): who asked whom, for what,
 * open or answered, with Decline (a reason in one line) for people who may change the project. Which instruction
 * layer is in force is not reported yet: a dash, said so.
 */
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Info } from 'lucide-react'
import { z } from 'zod'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { ToolsCatalogue } from '@/components/agents/tools-catalogue'
import { useWork } from '@/components/agents/use-agents'
import { useTraceContext } from '@/components/chat/context'
import { RunLine, runControls } from '@/components/run-line'
import { Column, Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { NeedsBuilding } from '@/components/side-sheet'
import { EmptyState, Loading, Partial, SkeletonRows } from '@/components/states'
import { type Status, StatusBadge } from '@/components/status-badge'
import { type AgentWork } from '@/components/agents/use-agents'
import { duration } from '@/lib/format'
import { DismissStuck, useDismissStuck } from '@/components/dismiss-stuck'
import { HandoffRow, isOpen, useDeclineHandoffs } from '@/components/handoff'
import { useAuth } from '@/lib/auth'
import { projectName } from '@/lib/api'
import { AGENTS } from '@/lib/knowledge'
import { useInbox, useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/agents/')({
  staticData: { crumb: 'Agents and tools' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Agents,
})

interface Row {
  id: string
  name: string
  does: string
  status: string
  now: string
  queue: string
  today: string
  instructions: string
  work: AgentWork | undefined
}

const STATUS_WORD: Record<AgentWork['status'], { status: Status; label: string }> = {
  working: { status: 'working', label: 'Working' },
  queued: { status: 'queued', label: 'Queued' },
  waiting_person: { status: 'yours', label: 'Waiting on a person' },
  stuck: { status: 'stuck', label: 'Stuck' },
  idle: { status: 'idle', label: 'Idle' },
}

/** "3 runs, 2 succeeded, median 4 min" */
export function todayText(t: AgentWork['today'] | undefined): string {
  if (!t || t.runs === 0) return 'No runs'
  return `${t.runs} run${t.runs === 1 ? '' : 's'}, ${t.succeeded} succeeded${t.medianS !== null ? `, median ${duration(t.medianS, { short: true })}` : ''}`
}

function Agents() {
  const work = useWork()
  const inbox = useInbox()
  const projects = useProjects()
  const { user } = useAuth()
  const navigate = useNavigate()
  const url = useUrlView('agents')
  const admin = user?.class === 'admin'
  const reviewerOnly = !admin && (projects.data ?? []).every((p) => (p.part ?? 'contributor') === 'reviewer')
  const stuck = (inbox.data ?? []).filter((i) => i.kind === 'stuck')
  const dismiss = useDismissStuck()
  const questions = (inbox.data ?? []).filter((i) => i.kind === 'question')
  const decline = useDeclineHandoffs()
  const openHandoffs = work.handoffs.filter((h) => isOpen(h.handoff)).length

  const rows: Row[] = AGENTS.map((a) => {
    const w = work.agents.get(a.id)
    const st = STATUS_WORD[w?.status ?? 'idle']
    return {
      id: a.id, name: a.name, does: a.does, status: st.label, work: w,
      now: w?.now.map((x) => `${x.project}: ${x.run.title}`).join('; ') ?? '', queue: String(w?.queue.length ?? 0), today: todayText(w?.today), instructions: '',
    }
  })
  const columns: ColumnDef<Row, any>[] = [
    { accessorKey: 'name', header: 'Agent', size: 190, meta: { label: 'Agent', kind: 'text' }, cell: ({ row }) => <Link to="/agents/$agent" params={{ agent: row.original.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}><Highlight text={row.original.name} /></Link> },
    {
      accessorKey: 'status', header: 'Status', size: 190, meta: { label: 'Status', kind: 'enum' },
      cell: ({ row }) => {
        const w = row.original.work
        const st = STATUS_WORD[w?.status ?? 'idle']
        return (
          <span className="flex flex-col gap-1">
            <StatusBadge status={st.status} label={st.label} />
            {w && (w.status === 'stuck' || w.status === 'waiting_person') && <span className="line-clamp-2 text-xs text-muted-foreground">{w.project ? `${w.project}: ` : ''}{w.says.replace(/^(Stuck|Waiting on a person): /, '')}</span>}
          </span>
        )
      },
    },
    {
      accessorKey: 'now', header: 'Now', size: 300, meta: { label: 'Now', kind: 'text' },
      cell: ({ row }) => (row.original.now ? <span className="line-clamp-2"><Highlight text={row.original.now} /></span> : <span className="text-muted-foreground">{row.original.does}</span>),
    },
    { accessorKey: 'queue', header: 'Queue', size: 90, meta: { label: 'Queue', kind: 'text' }, cell: ({ row }) => <span className={row.original.queue === '0' ? 'text-muted-foreground' : ''}>{row.original.queue === '0' ? '—' : `${row.original.queue} waiting`}</span> },
    { accessorKey: 'today', header: 'Today', size: 200, meta: { label: 'Today', kind: 'text' }, cell: ({ row }) => <span className="text-muted-foreground">{row.original.today}</span> },
    { accessorKey: 'instructions', header: 'Instructions', size: 120, meta: { label: 'Instructions', kind: 'text' }, cell: () => <span className="text-muted-foreground">—</span> },
  ]

  const summary = work.loading
    ? ' '
    : `${work.running.length === 0 ? 'Nothing is running' : `${work.running.length} ${work.running.length === 1 ? 'job is' : 'jobs are'} running`}${work.queued.length ? `, ${work.queued.length} queued` : ''}${stuck.length ? `, and ${stuck.length} ${stuck.length === 1 ? 'agent is' : 'agents are'} stuck` : ''}. ${questions.length === 0 ? 'No question is waiting on a person.' : `${questions.length === 1 ? 'One question is' : `${questions.length} questions are`} waiting on a person.`}`

  useTraceContext({ label: 'Agents and tools', description: 'The screen the person is on: agents, their work, and the tools', value: { running: work.running.map((w) => `${w.project}: ${w.run.title}`), queued: work.queued.length, stuck: stuck.length } }, 'screen')
  useCommands([
    { id: 'a-tools', label: 'Search the tools', group: 'Agents', run: () => document.querySelector<HTMLInputElement>('[aria-label="Search tools"]')?.focus() },
    ...AGENTS.map((a) => ({ id: `a-${a.id}`, label: `Open the ${a.name} agent`, group: 'Agents', run: () => void navigate({ to: '/agents/$agent', params: { agent: a.id } }) })),
  ])

  return (
    <Column wide>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Agents and tools</h1>
          <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">{summary}</p>
        </div>
        <nav aria-label="Jump to" className="inline-flex rounded-lg bg-muted p-1 text-sm">
          <a href="#agents" className="rounded-md bg-background px-3 py-1.5 font-medium shadow-sm">Agents ({AGENTS.length})</a>
          <a href="#tools-h" className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground">Tools</a>
        </nav>
      </div>

      {stuck.length > 0 && (
        <Section label="Stuck" count={stuck.length} className="mt-8">
          <ul className="space-y-2">
            {stuck.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
                <StatusBadge status="stuck" />
                <span className="font-medium">{s.project}</span>
                <span className="min-w-0 flex-1">{s.summary.replace(/\*\*/g, '')}</span>
                {s.action.to && <Link to={s.action.to} className="text-primary hover:underline">{s.action.label}</Link>}
                {!reviewerOnly && s.questionId && <DismissStuck item={s} onDismiss={dismiss} className="basis-full sm:basis-auto" />}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label="trace is doing now" count={work.running.length + work.queued.length} className="mt-8">
        {/* running and paused first, then each agent's queue in order; the controls each job's view allows */}
        {work.failed.length > 0 && <Partial>Could not read what is running on {work.failed.map(projectName).join(', ')}.</Partial>}
        {work.loading ? (
          <Loading><SkeletonRows rows={2} /></Loading>
        ) : work.running.length + work.queued.length === 0 ? (
          <EmptyState>Nothing is running or queued on your projects.</EmptyState>
        ) : (
          <div className="divide-y rounded-xl border">
            {[...work.running, ...work.queued].map((w) => (
              <RunLine
                key={`${w.repo}:${w.run.id}`}
                run={{ ...w.run, title: w.run.agentName ? `${w.run.agentName}: ${w.run.title}` : w.run.title }}
                project={w.project}
                {...runControls(work.write.has(w.repo))}
              />
            ))}
          </div>
        )}
      </Section>

      <Section label="Hand-offs between agents" count={work.handoffs.length} className="mt-10">
        {/* one specialist asked another, in writing: open ones first; a pending one can be declined with a reason */}
        <p className="mb-3 flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {work.handoffs.length === 0
              ? 'When one specialist needs another\'s answer, it asks in writing and the answer is recorded here.'
              : `${openHandoffs === 0 ? 'None open' : `${openHandoffs} open`}. A specialist asks another only through a recorded request; the asked one runs as a queued job, and its answer is kept for the one that asked.`}
          </span>
        </p>
        {work.handoffs.length > 0 && (
          <div className="divide-y rounded-xl border">
            {work.handoffs.map((x) => (
              <HandoffRow key={`${x.repo}:${x.handoff.id}`} handoff={x.handoff} project={x.project} {...(work.write.has(x.repo) ? { onDecline: (h, why) => decline(x.repo, h, why) } : {})} />
            ))}
          </div>
        )}
      </Section>

      <Section label="Agents" count={AGENTS.length} className="mt-10">
        <div id="agents" className="scroll-mt-20" />
        <p className="mb-3 flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Each agent's status is the most pressing one across your projects: Stuck, then Waiting on a person, Working, Queued, Idle. Today is the last 24 hours. Its queue, with Move up, is on its page and above.
          </span>
        </p>
        <DataTable id="agents" data={rows} columns={columns} getRowId={(r) => r.id} url={url} noun="agents" onRowClick={(r) => void navigate({ to: '/agents/$agent', params: { agent: r.id } })} />
        <NeedsBuilding className="mt-2">which layer of each agent's instructions is in force (trace's default, the installation's, the project's): trace's API does not report it yet.</NeedsBuilding>
      </Section>

      <div id="tools" className="scroll-mt-20" />
      <ToolsCatalogue />

      <p className={cn('mt-8 flex gap-2 text-sm text-muted-foreground')}>
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
