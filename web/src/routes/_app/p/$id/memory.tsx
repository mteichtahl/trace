/**
 * A project's Memory tab (/p/:id/memory, /recent, /changes): what its agents remember, in two layers. The summary
 * line and the switch between Long-term, Recent activity and Changes sit above each view. The screen does only what
 * trace's memory supports today and names the gaps ("Needs building") rather than faking them.
 */
import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { useTraceContext } from '@/components/chat/context'
import { Skeleton } from '@/components/ui/skeleton'
import { projectName, repoOf } from '@/lib/api'
import { DEFAULT_RETENTION_DAYS, readMemories } from '@/lib/knowledge'
import { useAction, useJourney } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/p/$id/memory')({
  staticData: { crumb: 'Memory' },
  component: MemoryLayout,
})

/** The project's long-term memories, switched-off ones included (the views filter them). */
export function useProjectMemories(repo: string) {
  const q = useAction('memory.list', { repo, includeInactive: true, limit: 200 })
  return { ...q, records: readMemories(q.data?.records, repo), enabled: q.data?.enabled ?? true }
}

function MemoryLayout() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const j = useJourney(repo)
  const m = useProjectMemories(repo)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const base = `/p/${id}/memory`
  const view = pathname.endsWith('/recent') ? 'recent' : pathname.endsWith('/changes') ? 'changes' : 'long'
  const name = j.data?.name ?? projectName(repo)
  const active = m.records.filter((r) => r.active).length
  const sessions = m.records.filter((r) => r.kind === 'sessions').length
  const changes = m.records.filter((r) => !r.active).length
  const capped = (m.data?.records.length ?? 0) >= 200
  useTraceContext({ label: 'Memory', description: 'The screen the person is on: the project\'s agent memory', value: { repo, view, longTerm: active } }, 'screen')

  const tabs = [
    { id: 'long', label: 'Long-term', count: active, to: base },
    { id: 'recent', label: 'Recent activity', count: sessions, to: `${base}/recent` },
    { id: 'changes', label: 'Changes', count: changes, to: `${base}/changes` },
  ]

  return (
    <div className="pb-12 pt-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-80 text-[15px]" aria-live="polite">
          {m.isLoading ? (
            <Skeleton className="h-5 w-80" />
          ) : view === 'recent' ? (
            <>Recent events are what each agent saw and did in a session. They are kept for {DEFAULT_RETENTION_DAYS} days, then removed.</>
          ) : !m.enabled ? (
            <>Memory is not turned on for {name}. An admin turns it on with the project's settings in the stack.</>
          ) : (
            <>
              {name}'s agents remember <span className="font-semibold">{capped ? `at least ${active}` : active} {active === 1 ? 'thing' : 'things'}</span> long term
              . Recent events are kept for {DEFAULT_RETENTION_DAYS} days unless an admin set the project's own period.
            </>
          )}
        </div>
        <nav aria-label="Memory" className="inline-flex shrink-0 rounded-lg bg-muted p-1">
          {tabs.map((t) => (
            <Link key={t.id} to={t.to} aria-current={view === t.id ? 'page' : undefined} className={cn('rounded-md px-3 py-1.5 text-sm', view === t.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {t.label}
              {!m.isLoading && ` (${t.count}${capped && t.id === 'long' ? '+' : ''})`}
            </Link>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  )
}
