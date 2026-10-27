/**
 * Knowledge's shared state and data: the search words, the scope (This project, All my projects, Shared library) and
 * Include inactive live in the address so a link shares the view; the reads fan out per project the person is on
 * (the API checks access on every call, so counts and "no results" are only ever worked out after its filter).
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { ApiError, call, projectName } from '@/lib/api'
import {
  type KnowledgeResult, type MemoryView, hitToResult, memoryToResult, queryTerms, rankResults, readHits, readMemories,
} from '@/lib/knowledge'
import { q, useProjects } from '@/lib/queries'

export type Scope = 'project' | 'mine' | 'library'

export interface KnowledgeView {
  q: string
  scope: Scope
  /** the project for "This project" */
  repo?: string
  inactive: boolean
  weak: boolean
}

export function useKnowledgeView(): [KnowledgeView, (patch: Partial<KnowledgeView>) => void] {
  const s = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const repo = typeof s.repo === 'string' ? s.repo : undefined
  const scope: Scope = s.scope === 'project' || s.scope === 'library' || s.scope === 'mine' ? s.scope : repo ? 'project' : 'mine'
  const view: KnowledgeView = { q: typeof s.q === 'string' ? s.q : '', scope, repo, inactive: s.inactive === true || s.inactive === 'true', weak: s.weak === true || s.weak === 'true' }
  const set = useCallback(
    (patch: Partial<KnowledgeView>) => {
      void navigate({
        to: '.',
        replace: true,
        search: ((prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev }
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === '' || v === false) delete next[k]
            else next[k] = v
          }
          if ('q' in patch) delete next.weak
          return next
        }) as never,
      })
    },
    [navigate],
  )
  return [view, set]
}

/** The projects a scope covers (the library scope reads the shared library through one of them). */
export function useScopeRepos(view: KnowledgeView): { repos: string[]; loading: boolean; error: unknown; all: string[] } {
  const projects = useProjects()
  const all = useMemo(() => (projects.data ?? []).map((p) => p.repo), [projects.data])
  const repos = view.scope === 'project' && view.repo ? [view.repo] : view.scope === 'library' ? [] : all
  return { repos, loading: projects.isLoading, error: projects.error, all }
}

/** The project the shared library is read through: the `tool` action runs on a project the person is on. */
export const libraryRepo = (view: KnowledgeView, all: string[]): string | undefined => (view.repo && all.includes(view.repo) ? view.repo : all[0])

export interface SearchOutcome {
  strong: KnowledgeResult[]
  weak: KnowledgeResult[]
  loading: boolean
  /** projects whose answer did not arrive */
  failed: { repo: string; what: string; error: unknown }[]
  /** projects where the knowledge base or memory is not turned on */
  off: { repo: string; what: string }[]
  retry: () => void
}

/** One search across documents, datasheet pages in project knowledge bases, and agent memory. */
export function useKnowledgeSearch(view: KnowledgeView, o: { kinds?: ('kb' | 'memory')[]; enabled?: boolean } = {}): SearchOutcome {
  const { repos } = useScopeRepos(view)
  const kinds = o.kinds ?? ['kb', 'memory']
  const text = view.q.trim()
  const enabled = (o.enabled ?? true) && text.length >= 2
  const kb = useQueries({ queries: repos.map((repo) => ({ ...q('kb.search', { repo, query: text, top_k: 10 }), enabled: enabled && kinds.includes('kb'), retry: false })) })
  const mem = useQueries({ queries: repos.map((repo) => ({ ...q('memory.recall', { repo, query: text, top_k: 10 }), enabled: enabled && kinds.includes('memory'), retry: false })) })
  const terms = useMemo(() => queryTerms(text), [text])
  return useMemo(() => {
    const all: KnowledgeResult[] = []
    const failed: SearchOutcome['failed'] = []
    const off: SearchOutcome['off'] = []
    repos.forEach((repo, i) => {
      const k = kb[i]
      const m = mem[i]
      if (kinds.includes('kb') && k) {
        if (k.isError) failed.push({ repo, what: 'documents', error: k.error })
        else if (k.data && !k.data.enabled) off.push({ repo, what: 'knowledge base' })
        else readHits(k.data?.results).forEach((h, j) => all.push(hitToResult(h, repo, terms, j)))
      }
      if (kinds.includes('memory') && m) {
        if (m.isError) failed.push({ repo, what: 'agent memory', error: m.error })
        else if (m.data && !m.data.enabled) off.push({ repo, what: 'agent memory' })
        else readMemories(m.data?.records, repo).forEach((r) => all.push(memoryToResult(r)))
      }
    })
    const { strong, weak } = rankResults(all)
    const loading = enabled && [...kb, ...mem].some((x) => x.isLoading)
    return {
      strong, weak, loading, failed, off,
      retry: () => [...kb, ...mem].forEach((x) => x.isError && void x.refetch()),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb, mem, repos.join(','), terms, enabled, kinds.join(',')])
}

/** memory.list across the scope's projects (Agent memory tab, browsing). */
export function useMemoryLists(repos: string[], includeInactive: boolean) {
  const lists = useQueries({ queries: repos.map((repo) => ({ ...q('memory.list', { repo, includeInactive, limit: 200 }), retry: false })) })
  return useMemo(() => {
    const records: MemoryView[] = []
    const failed: { repo: string; error: unknown }[] = []
    const off: string[] = []
    repos.forEach((repo, i) => {
      const l = lists[i]
      if (!l) return
      if (l.isError) failed.push({ repo, error: l.error })
      else if (l.data && !l.data.enabled) off.push(repo)
      else records.push(...readMemories(l.data?.records, repo))
    })
    return { records, failed, off, loading: lists.some((l) => l.isLoading), retry: () => lists.forEach((l) => l.isError && void l.refetch()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists, repos.join(',')])
}

/** A read-only library tool through the `tool` action, on the given project. */
export function useLibraryTool<T = unknown>(repo: string | undefined, name: string, args: Record<string, unknown>, o: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['tool', repo ?? '', name, args],
    queryFn: ({ signal }) => call('tool', { repo: repo!, name, args }, { signal }) as Promise<T>,
    enabled: !!repo && (o.enabled ?? true),
    retry: false,
    staleTime: 60_000,
  })
}

/** "Could not reach Motor driver's knowledge base" lines for a Partial. */
export const failedWords = (f: { repo: string; what?: string; error: unknown }[]): string =>
  f.map((x) => `${projectName(x.repo)}${x.what ? `'s ${x.what}` : ''}${x.error instanceof ApiError && x.error.noAccess ? ' (no longer shared with you)' : ''}`).join(', ')
