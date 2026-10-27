/**
 * Knowledge › All results: one ranked list across documents, datasheet pages in the projects' knowledge bases and
 * agent memory, cut at a relevance threshold with Show weaker matches; beside it Ask trace about these results, the
 * sync line and what the person can see. Without a search it says what to search for and offers recent examples.
 */
import { createFileRoute } from '@tanstack/react-router'
import { AskAboutResults, KbSyncLine, WhatYouSee } from '@/components/knowledge/aside'
import { ResultsList } from '@/components/knowledge/results'
import { useKnowledgeSearch, useKnowledgeView, useScopeRepos } from '@/components/knowledge/use-knowledge'
import { LibraryResults } from '@/components/knowledge/library'
import { EmptyState, QueryError } from '@/components/states'

export const Route = createFileRoute('/_app/knowledge/')({
  component: AllResults,
})

const EXAMPLES = ['LDO output capacitor stability', 'antenna placement', 'transmit power', 'battery life']

export function KnowledgeColumns({ children, aside }: { children: React.ReactNode; aside: React.ReactNode }) {
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">{children}</div>
      <aside className="space-y-4">{aside}</aside>
    </div>
  )
}

function AllResults() {
  const [view, set] = useKnowledgeView()
  const { repos, all, error, loading } = useScopeRepos(view)
  const outcome = useKnowledgeSearch(view, { enabled: view.scope !== 'library' })
  const syncRepo = view.scope === 'project' ? view.repo : undefined

  const aside = (
    <>
      <AskAboutResults results={[...outcome.strong]} query={view.q} />
      {syncRepo && (
        <section className="rounded-xl border px-5 py-2">
          <KbSyncLine repo={syncRepo} />
        </section>
      )}
      <WhatYouSee />
    </>
  )

  if (error) return <div className="mt-6"><QueryError error={error} what="your projects" /></div>
  if (!loading && all.length === 0 && view.scope !== 'library')
    return <KnowledgeColumns aside={<WhatYouSee />}><EmptyState>You are not on a project yet, so there is nothing of a project's to search. The shared library is open to everyone: choose Shared library.</EmptyState></KnowledgeColumns>

  if (view.scope === 'library') return <KnowledgeColumns aside={aside}><LibraryResults view={view} all={all} /></KnowledgeColumns>

  if (view.q.trim().length < 2)
    return (
      <KnowledgeColumns aside={aside}>
        <EmptyState
          action={
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button key={e} type="button" className="rounded-full border bg-background px-3 py-1 text-sm text-foreground hover:bg-accent" onClick={() => set({ q: e })}>
                  {e}
                </button>
              ))}
            </div>
          }
        >
          Search {repos.length === 1 ? 'this project' : `your ${repos.length} projects`}' documents, datasheets and what the agents remember. Results are ranked by how well they match, strongest first.
        </EmptyState>
      </KnowledgeColumns>
    )

  return (
    <KnowledgeColumns aside={aside}>
      <ResultsList outcome={outcome} query={view.q} weak={view.weak} onWeak={(w) => set({ weak: w })} includeInactive={view.inactive} all={all} />
    </KnowledgeColumns>
  )
}
