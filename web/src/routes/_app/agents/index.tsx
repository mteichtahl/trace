/**
 * Agents and tools (/agents): every agent and every tool trace has, what is happening right now, and whether each can
 * work. What the API gives today: the work running and queued on the person's projects (journey.get jobs, live
 * through job.updated events), what needs a person (inbox), each agent's memories, and the tool list with runs. What
 * it does not give yet (each agent's own status, its queue, today's numbers, the instruction layer in force) is shown
 * as "Not reported" with one line saying so, never invented.
 */
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Info } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { ToolsCatalogue } from '@/components/agents/tools-catalogue'
import { useWork } from '@/components/agents/use-agents'
import { useTraceContext } from '@/components/chat/context'
import { RunLine } from '@/components/run-line'
import { Column, Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { NeedsBuilding } from '@/components/side-sheet'
import { EmptyState, Loading, Partial, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
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
  const questions = (inbox.data ?? []).filter((i) => i.kind === 'question')

  const rows: Row[] = AGENTS.map((a) => ({ id: a.id, name: a.name, does: a.does, status: 'Not reported', now: '', queue: '', today: '', instructions: '' }))
  const columns: ColumnDef<Row, any>[] = [
    { accessorKey: 'name', header: 'Agent', size: 200, meta: { label: 'Agent', kind: 'text' }, cell: ({ row }) => <Link to="/agents/$agent" params={{ agent: row.original.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}><Highlight text={row.original.name} /></Link> },
    { accessorKey: 'status', header: 'Status', size: 150, meta: { label: 'Status', kind: 'enum' }, cell: () => <StatusBadge status="idle" label="Not reported" /> },
    { accessorKey: 'does', header: 'Does', size: 340, meta: { label: 'Does', kind: 'text' }, cell: ({ row }) => <span className="text-muted-foreground"><Highlight text={row.original.does} /></span> },
    { accessorKey: 'queue', header: 'Queue', size: 90, meta: { label: 'Queue', kind: 'text' }, cell: () => <span className="text-muted-foreground">—</span> },
    { accessorKey: 'today', header: 'Today', size: 110, meta: { label: 'Today', kind: 'text' }, cell: () => <span className="text-muted-foreground">—</span> },
    { accessorKey: 'instructions', header: 'Instructions', size: 140, meta: { label: 'Instructions', kind: 'text' }, cell: () => <span className="text-muted-foreground">—</span> },
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
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label="trace is doing now" count={work.running.length + work.queued.length} className="mt-8">
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
                run={w.run}
                project={w.project}
                onPause={!reviewerOnly && w.run.state === 'running' ? () => { toast('Pause is not available from the app yet', { description: 'The API has no pause for a job; it can be cancelled from its run page.' }) } : undefined}
                onMoveUp={!reviewerOnly && w.run.state === 'queued' ? () => { toast('Move up is not available yet', { description: 'The API does not reorder queues yet.' }) } : undefined}
              />
            ))}
          </div>
        )}
      </Section>

      <Section label="Agents" count={AGENTS.length} className="mt-10">
        <div id="agents" className="scroll-mt-20" />
        <p className="mb-3 flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Each agent's own status, queue, today's numbers and which instructions are in force are not reported by trace's API yet, so they show as “Not reported” and dashes. What is running is listed above with its project.
          </span>
        </p>
        <DataTable id="agents" data={rows} columns={columns} getRowId={(r) => r.id} url={url} noun="agents" onRowClick={(r) => void navigate({ to: '/agents/$agent', params: { agent: r.id } })} />
        <NeedsBuilding className="mt-2">agent status (Working, Idle, Queued, Waiting on a person, Stuck, Unavailable), its queue with Move up, today's runs and success rate, and the instruction layer in force.</NeedsBuilding>
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
