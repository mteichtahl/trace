/**
 * One agent (/agents/:agent): its status across the person's projects and what it is doing now and has queued
 * (jobs.list, with Pause, Resume, Move up and Cancel where allowed), the questions it is waiting on and stuck items
 * that name it (from the inbox), its recent runs and the tools it used most (runs with its name: each run records the
 * agent that made it), and what it remembers on each project (memory.list with its name). /agents/tools opens the
 * catalogue.
 */
import { useQueries } from '@tanstack/react-query'
import { Link, Navigate, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { Markdown } from '@/components/chat/markdown'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { NeedsYouCard } from '@/components/needs-you-card'
import { useDismissStuck } from '@/components/dismiss-stuck'
import { Column, Section } from '@/components/shell/app-shell'
import { RunLine, runControls } from '@/components/run-line'
import { useWork } from '@/components/agents/use-agents'
import { EmptyState, Loading, NotShared, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { projectId, projectName } from '@/lib/api'
import { ago, duration } from '@/lib/format'
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
  const runs = useQueries({ queries: repos.map((repo) => ({ ...q('runs', { repo, agent, limit: 50 }), enabled: !!a, retry: false })) })
  const work = useWork()
  const [open, setOpen] = useState<MemoryView | null>(null)
  const dismiss = useDismissStuck()
  useTraceContext(a ? { label: a.name, description: 'The agent the person is looking at', value: { agent: a.id, name: a.name } } : null, 'agent')
  if (agent === 'tools') return <Navigate to="/agents" hash="tools" />
  if (!a) return <NotShared />
  const named = (inbox.data ?? []).filter((i) => (i.kind === 'question' || i.kind === 'stuck') && i.summary.toLowerCase().includes(a.name.split(' ')[0]!.toLowerCase()))
  const records = repos.flatMap((repo, i) => readMemories(mems[i]?.data?.records, repo))
  const w = work.agents.get(a.id)
  const STATUS = { working: ['working', 'Working'], queued: ['queued', 'Queued'], waiting_person: ['yours', 'Waiting on a person'], stuck: ['stuck', 'Stuck'], idle: ['idle', 'Idle'] } as const
  const [st, word] = STATUS[w?.status ?? 'idle']
  const recent = repos.flatMap((repo, i) => ((runs[i]?.data ?? []) as Record<string, unknown>[]).map((r) => ({
    repo, id: String(r.id), kind: String(r.kind), status: String(r.status), started: Number(r.started), finished: r.finished == null ? null : Number(r.finished), summary: typeof r.summary === 'string' ? r.summary : null,
  }))).sort((x, y) => y.started - x.started)
  const used = [...recent.reduce((m, r) => m.set(r.kind, (m.get(r.kind) ?? 0) + 1), new Map<string, number>())].sort((x, y) => y[1] - x[1]).slice(0, 5)
  const lines = [...(w?.now ?? []), ...(w?.queue ?? [])]
  const ended = work.ended.filter((x) => x.run.agent === a.id)

  return (
    <Column>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
        <StatusBadge status={st} label={work.loading ? 'Reading…' : word} />
      </div>
      <p className="mt-2 text-[15px] text-muted-foreground">{a.does}</p>
      {w && w.status !== 'idle' && <p className="mt-1 text-sm">{w.project ? `${w.project}: ` : ''}{w.says}</p>}

      <Section label="Now and queued" count={lines.length} className="mt-10">
        {work.loading ? (
          <Loading><SkeletonRows rows={1} /></Loading>
        ) : lines.length === 0 ? (
          <EmptyState>The {a.name} agent is not working on your projects and has nothing queued.</EmptyState>
        ) : (
          <div className="divide-y rounded-xl border">
            {lines.map((x) => <RunLine key={`${x.repo}:${x.run.id}`} run={x.run} project={x.project} {...runControls(work.write.has(x.repo))} />)}
          </div>
        )}
        {w && <p className="mt-2 text-sm text-muted-foreground">Last 24 hours: {w.today.runs === 0 ? 'no jobs ended' : `${w.today.runs} ${w.today.runs === 1 ? 'job' : 'jobs'} ended, ${w.today.succeeded} succeeded${w.today.medianS !== null ? `, median ${duration(w.today.medianS, { short: true })}` : ''}`}.</p>}
      </Section>

      <Section label="Recent jobs and how they ended" count={ended.length} className="mt-10">
        {work.loading ? (
          <Loading><SkeletonRows rows={2} /></Loading>
        ) : ended.length === 0 ? (
          <EmptyState>No job by the {a.name} agent has ended on your projects yet.</EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {ended.slice(0, 15).map((x) => <EndedJob key={`${x.repo}:${x.run.id}`} item={x} />)}
          </ul>
        )}
      </Section>

      <Section label="Waiting on a person, or stuck" count={named.length} className="mt-10">
        {inbox.isLoading ? (
          <Loading><SkeletonRows rows={1} /></Loading>
        ) : named.length === 0 ? (
          <EmptyState>Nothing that names the {a.name} agent is waiting on anyone.</EmptyState>
        ) : (
          <div className="space-y-3">{named.map((i) => <NeedsYouCard key={i.id} item={i} onDismiss={dismiss} />)}</div>
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

      <Section label="Recent runs and tools it used most" count={recent.length}>
        {runs.some((r) => r.isLoading) && recent.length === 0 ? (
          <Loading><SkeletonRows rows={2} /></Loading>
        ) : recent.length === 0 ? (
          <EmptyState>No runs by the {a.name} agent are recorded on your projects. Runs made before trace recorded which agent made them are not counted.</EmptyState>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">Most used: {used.map(([k, n]) => `${k} (${n})`).join(', ')}.</p>
            <ul className="divide-y rounded-xl border">
              {recent.slice(0, 10).map((r) => (
                <li key={`${r.repo}:${r.id}`}>
                  <Link to="/p/$id/runs/$run" params={{ id: projectId(r.repo), run: r.id }} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/50">
                    <StatusBadge plain status={r.status === 'pass' ? 'passed' : r.status === 'running' ? 'running' : r.status === 'fail' ? 'failing' : 'warning'} label={r.status === 'pass' ? 'Passed' : r.status === 'fail' ? 'Failed' : r.status === 'running' ? 'Running' : 'Error'} />
                    <code className="font-mono text-xs">{r.kind}</code>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.summary ?? ''}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{projectName(r.repo)} · {ago(new Date(r.started * 1000).toISOString())}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <MemorySheet memory={open} onOpenChange={(o) => !o && setOpen(null)} />
    </Column>
  )
}

const ENDED: Record<string, { status: 'passed' | 'failing' | 'warning' | 'idle'; label: string }> = {
  done: { status: 'passed', label: 'Done' }, failed: { status: 'failing', label: 'Failed' }, cancelled: { status: 'idle', label: 'Cancelled' }, lost: { status: 'warning', label: 'Lost' },
}

/** One ended job: how it went, what was asked, what it said (its summary, or why it failed or was lost), where, when. */
/** A job's report: three lines, and the whole of it (rendered) on asking. Its conclusion, what is still open, comes last. */
function Report({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 280 || text.includes('\n')
  return (
    <div className="text-muted-foreground">
      {open ? <div className="text-sm text-foreground"><Markdown text={text} /></div> : <p className="line-clamp-3">{text}</p>}
      {long && (
        <button type="button" className="mt-1 text-xs font-medium text-primary hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show the whole report'}
        </button>
      )}
    </div>
  )
}

function EndedJob({ item }: { item: { repo: string; project: string; run: import('@/lib/types').RunSummary } }) {
  const r = item.run
  const e = ENDED[r.state] ?? { status: 'idle' as const, label: r.state }
  const said = r.state === 'done' ? r.summary : r.error ?? r.summary ?? r.step
  const at = r.endedAt ?? r.startedAt
  return (
    <li className="space-y-1 px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <StatusBadge plain status={e.status} label={e.label} />
        <span className="min-w-0 flex-1 font-medium">{r.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{item.project}{at ? ` · ${ago(at)}` : ''}{r.startedAt && r.endedAt ? ` · ${duration((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000, { short: true })}` : ''}</span>
      </div>
      {said && <Report text={said} />}
      {r.branch && <p className="font-mono text-xs text-muted-foreground">{r.branch}</p>}
    </li>
  )
}
