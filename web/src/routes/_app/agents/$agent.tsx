/**
 * One agent (/agents/:agent): what it does, the questions it is waiting on and stuck items that name it (from the
 * inbox), what it remembers on each of the person's projects (memory.list with its name), and what the API does not
 * report about it yet. /agents/tools opens the catalogue.
 */
import { useQueries } from '@tanstack/react-query'
import { Link, Navigate, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { NeedsYouCard } from '@/components/needs-you-card'
import { Column, Section } from '@/components/shell/app-shell'
import { NeedsBuilding } from '@/components/side-sheet'
import { EmptyState, Loading, NotShared, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { projectId, projectName } from '@/lib/api'
import { ago } from '@/lib/format'
import { AGENTS, type MemoryView, kindWord, readMemories } from '@/lib/knowledge'
import { q, useInbox, useProjects } from '@/lib/queries'

export const Route = createFileRoute('/_app/agents/$agent')({
  staticData: { crumb: ({ agent }) => AGENTS.find((a) => a.id === agent)?.name ?? agent, parent: { label: 'Agents and tools', to: '/agents' } },
  component: Agent,
})

function Agent() {
  const { agent } = Route.useParams()
  const a = AGENTS.find((x) => x.id === agent)
  const projects = useProjects()
  const inbox = useInbox()
  const repos = (projects.data ?? []).map((p) => p.repo)
  const mems = useQueries({ queries: repos.map((repo) => ({ ...q('memory.list', { repo, agent, limit: 20 }), enabled: !!a, retry: false })) })
  const [open, setOpen] = useState<MemoryView | null>(null)
  useTraceContext(a ? { label: a.name, description: 'The agent the person is looking at', value: { agent: a.id, name: a.name } } : null, 'agent')
  if (agent === 'tools') return <Navigate to="/agents" hash="tools" />
  if (!a) return <NotShared />
  const named = (inbox.data ?? []).filter((i) => (i.kind === 'question' || i.kind === 'stuck') && i.summary.toLowerCase().includes(a.name.split(' ')[0]!.toLowerCase()))
  const records = repos.flatMap((repo, i) => readMemories(mems[i]?.data?.records, repo))

  return (
    <Column>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
        <StatusBadge status="idle" label="Status not reported" />
      </div>
      <p className="mt-2 text-[15px] text-muted-foreground">{a.does}</p>

      <Section label="Waiting on a person, or stuck" count={named.length} className="mt-10">
        {inbox.isLoading ? (
          <Loading><SkeletonRows rows={1} /></Loading>
        ) : named.length === 0 ? (
          <EmptyState>Nothing that names the {a.name} agent is waiting on anyone.</EmptyState>
        ) : (
          <div className="space-y-3">{named.map((i) => <NeedsYouCard key={i.id} item={i} />)}</div>
        )}
      </Section>

      <Section label="What it remembers" count={records.length}>
        {mems.some((m) => m.isLoading) && records.length === 0 ? (
          <Loading><SkeletonRows rows={2} /></Loading>
        ) : records.length === 0 ? (
          <EmptyState>The {a.name} agent has not remembered anything on your projects yet.</EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {records.slice(0, 12).map((m) => (
              <li key={`${m.repo}:${m.id}`}>
                <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/50" onClick={() => setOpen(m)}>
                  <span className="min-w-0 flex-1 text-sm">{m.text}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{kindWord(m.kind)} · {projectName(m.repo)}{m.createdAt ? ` · ${ago(m.createdAt)}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {repos.length > 0 && (
          <p className="mt-2 text-sm">
            Manage on each project:{' '}
            {repos.map((r, i) => (
              <span key={r}>
                {i > 0 && ', '}
                <Link to="/p/$id/memory" params={{ id: projectId(r) }} className="text-primary hover:underline">{projectName(r)}</Link>
              </span>
            ))}
          </p>
        )}
      </Section>

      <Section label="Recent runs and tools it used most">
        <NeedsBuilding>runs do not record which agent made them yet, so this agent's recent runs, the tools it used most and, when stuck, why it stopped are not shown. What is running across your projects is on <Link to="/agents" className="not-italic text-primary hover:underline">Agents and tools</Link>.</NeedsBuilding>
      </Section>

      <MemorySheet memory={open} onOpenChange={(o) => !o && setOpen(null)} />
    </Column>
  )
}
