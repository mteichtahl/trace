/**
 * Data for Agents and tools: the tool list (tools.list, per project, the same for every project of an installation),
 * each project's runs (runs: tool runs with kind, status, times and the agent that made each, for "last used" and the
 * error rate), and each project's jobs and agents (jobs.list: its job index, kept current by job.updated events),
 * merged across the person's projects into one status per agent, and the hand-offs between agents (jobs.list
 * `handoffs`): who asked whom, open first. Which instruction layer is in force is not reported
 * by the API yet; the screen says so.
 */
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { projectName } from '@/lib/api'
import { q, useProjects } from '@/lib/queries'
import type { AgentState, Handoff, RunSummary } from '@/lib/types'
import type { ToolInfo } from '@/lib/tools-catalogue'

export interface ToolRun {
  id: string
  repo: string
  kind: string
  status: string
  started: number
  finished: number | null
  summary: string | null
  /** the agent whose session made it (null: a person's own run, or one from before agents were recorded) */
  agent: string | null
}

export interface ToolUse {
  lastUsed: number | null
  runs: number
  failed: number
  /** 0..1, over the runs read */
  errorRate: number | null
}

export function useCatalogue() {
  const projects = useProjects()
  const repos = useMemo(() => (projects.data ?? []).map((p) => p.repo), [projects.data])
  // tools.list is per project but the same across an installation: read it through the first project, falling back
  const lists = useQueries({ queries: repos.slice(0, 2).map((repo) => ({ ...q('tools.list', { repo }), retry: false, staleTime: 5 * 60_000 })) })
  const runs = useQueries({ queries: repos.map((repo) => ({ ...q('runs', { repo, limit: 200 }), retry: false })) })
  const tools: ToolInfo[] = (lists.find((l) => l.data)?.data ?? []) as ToolInfo[]
  const allRuns: ToolRun[] = useMemo(
    () =>
      repos.flatMap((repo, i) =>
        ((runs[i]?.data ?? []) as Record<string, unknown>[]).flatMap((r) =>
          typeof r.id === 'string' && typeof r.kind === 'string'
            ? [{ id: r.id, repo, kind: r.kind, status: String(r.status ?? ''), started: Number(r.started ?? 0), finished: r.finished == null ? null : Number(r.finished), summary: typeof r.summary === 'string' ? r.summary : null, agent: typeof r.agent === 'string' ? r.agent : null }]
            : [],
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs.map((r) => r.dataUpdatedAt).join(','), repos.join(',')],
  )
  const use = useMemo(() => {
    const m = new Map<string, ToolUse>()
    for (const r of allRuns) {
      const u = m.get(r.kind) ?? { lastUsed: null, runs: 0, failed: 0, errorRate: null }
      u.runs++
      // an error is the tool failing to run; a fail is a check that ran and did not pass, which is not the tool's error
      if (r.status === 'error') u.failed++
      u.lastUsed = Math.max(u.lastUsed ?? 0, r.started)
      m.set(r.kind, u)
    }
    for (const u of m.values()) u.errorRate = u.runs ? u.failed / u.runs : null
    return m
  }, [allRuns])
  return {
    repos,
    tools,
    use,
    runs: allRuns,
    loading: projects.isLoading || lists.some((l) => l.isLoading),
    error: projects.error ?? (lists.length && lists.every((l) => l.isError) ? lists[0]!.error : null),
    runsFailed: repos.filter((_, i) => runs[i]?.isError),
    retry: () => [...lists, ...runs].forEach((x) => x.isError && void x.refetch()),
  }
}

/** One hand-off between specialists, with its project. */
export interface HandoffItem { repo: string; project: string; handoff: Handoff }

const isOpenHandoff = (h: Pick<Handoff, 'state'>): boolean => h.state === 'requested' || h.state === 'queued' || h.state === 'running'

export interface WorkItem {
  repo: string
  project: string
  run: RunSummary
}

const RANK: Record<AgentState['status'], number> = { stuck: 0, waiting_person: 1, working: 2, queued: 3, idle: 4 }

/** One agent across the person's projects: the most pressing status, its work and queue, and its day summed. */
export interface AgentWork {
  id: string
  status: AgentState['status']
  /** the status's line on the project it comes from, with that project */
  says: string
  project: string | null
  now: WorkItem[]
  queue: WorkItem[]
  today: { runs: number; succeeded: number; medianS: number | null }
}

/** Merge each project's agent states (jobs.list `agents`) into one per agent. */
export function mergeAgents(per: { repo: string; project: string; agents: AgentState[]; jobs: RunSummary[] }[]): Map<string, AgentWork> {
  const out = new Map<string, AgentWork>()
  const most = new Map<string, number>()
  for (const p of per) {
    const byId = new Map(p.jobs.map((j) => [j.id, j]))
    for (const a of p.agents) {
      const w = out.get(a.id) ?? { id: a.id, status: 'idle' as const, says: 'Idle', project: null, now: [], queue: [], today: { runs: 0, succeeded: 0, medianS: null } }
      if (RANK[a.status] < RANK[w.status]) { w.status = a.status; w.says = a.says; w.project = p.project }
      for (const id of a.now) { const run = byId.get(id); if (run) w.now.push({ repo: p.repo, project: p.project, run }) }
      for (const id of a.queue) { const run = byId.get(id); if (run) w.queue.push({ repo: p.repo, project: p.project, run }) }
      // a median of medians is not a median: the median of the project where it ran most stands for its day
      const busiest = a.today.medianS !== null && a.today.runs > (most.get(a.id) ?? 0)
      if (busiest) most.set(a.id, a.today.runs)
      w.today = { runs: w.today.runs + a.today.runs, succeeded: w.today.succeeded + a.today.succeeded, medianS: busiest ? a.today.medianS : w.today.medianS }
      out.set(a.id, w)
    }
  }
  return out
}

/** What trace is doing and has queued, across the person's projects (jobs.list), and each agent's state. */
export function useWork() {
  const projects = useProjects()
  const repos = (projects.data ?? []).map((p) => p.repo)
  const lists = useQueries({ queries: repos.map((repo) => ({ ...q('jobs.list', { repo }), retry: false })) })
  const per = repos.map((repo, i) => ({ repo, project: projectName(repo), agents: lists[i]?.data?.agents ?? [], jobs: lists[i]?.data?.jobs ?? [] }))
  const items: WorkItem[] = per.flatMap((p) => p.jobs.map((run) => ({ repo: p.repo, project: p.project, run })))
  // the hand-offs between agents on every project: open ones first, then the newest
  const handoffs: HandoffItem[] = repos.flatMap((repo, i) => (lists[i]?.data?.handoffs ?? []).map((handoff) => ({ repo, project: projectName(repo), handoff })))
    .sort((a, b) => Number(isOpenHandoff(b.handoff)) - Number(isOpenHandoff(a.handoff)) || b.handoff.createdAt.localeCompare(a.handoff.createdAt))
  return {
    handoffs,
    running: items.filter((x) => x.run.state === 'running' || x.run.state === 'paused'),
    queued: items.filter((x) => x.run.state === 'queued'),
    /** the jobs that ended (done, failed, cancelled) or were lost, newest first: how each went */
    ended: items.filter((x) => x.run.state !== 'running' && x.run.state !== 'paused' && x.run.state !== 'queued')
      .sort((a, b) => (b.run.endedAt ?? b.run.startedAt ?? '').localeCompare(a.run.endedAt ?? a.run.startedAt ?? '')),
    agents: mergeAgents(per),
    write: new Set((projects.data ?? []).filter((p) => (p.part ?? 'contributor') !== 'reviewer').map((p) => p.repo)),
    loading: lists.some((j) => j.isLoading),
    failed: repos.filter((_, i) => lists[i]?.isError),
  }
}
