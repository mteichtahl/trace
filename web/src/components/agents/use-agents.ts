/**
 * Data for Agents and tools, from what the API gives today: the tool list (tools.list, per project, the same for every
 * project of an installation), each project's runs (runs: tool runs with kind, status and times, for "last used" and
 * the error rate), and each project's live and queued work (journey.get jobs, kept current by job.updated events).
 * The API does not report agents' own live status, queues, today's numbers or which instruction layer is in force;
 * the screens say so.
 */
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { projectName } from '@/lib/api'
import { q, useProjects } from '@/lib/queries'
import type { RunSummary } from '@/lib/types'
import type { ToolInfo } from '@/lib/tools-catalogue'

export interface ToolRun {
  id: string
  repo: string
  kind: string
  status: string
  started: number
  finished: number | null
  summary: string | null
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
            ? [{ id: r.id, repo, kind: r.kind, status: String(r.status ?? ''), started: Number(r.started ?? 0), finished: r.finished == null ? null : Number(r.finished), summary: typeof r.summary === 'string' ? r.summary : null }]
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

export interface WorkItem {
  repo: string
  project: string
  run: RunSummary
}

/** What trace is doing and has queued, across the person's projects (journey.get jobs). */
export function useWork() {
  const projects = useProjects()
  const repos = (projects.data ?? []).map((p) => p.repo)
  const journeys = useQueries({ queries: repos.map((repo) => ({ ...q('journey.get', { repo }), retry: false })) })
  const items: WorkItem[] = repos.flatMap((repo, i) => (journeys[i]?.data?.jobs ?? []).map((run) => ({ repo, project: journeys[i]?.data?.name ?? projectName(repo), run })))
  return {
    running: items.filter((x) => x.run.state === 'running' || x.run.state === 'paused'),
    queued: items.filter((x) => x.run.state === 'queued'),
    loading: journeys.some((j) => j.isLoading),
    failed: repos.filter((_, i) => journeys[i]?.isError),
  }
}
