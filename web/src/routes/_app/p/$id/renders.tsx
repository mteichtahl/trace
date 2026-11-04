/**
 * Renders (/p/:id/renders): each revision's photorealistic renders (docs/revision-renders.md), newest first, from
 * renders.list. The newest revision opens as a gallery; earlier ones as a row each. A revision whose renders are still
 * being made shows what the rendering agent is doing and opens its log. The viewer steps through a revision's pictures;
 * one picture or all of them (a zip made in the browser) download from the gallery or the viewer.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { TabSkeleton } from '@/components/project/shared'
import { MakingCard, RendersViewer, RevisionCard } from '@/components/renders/gallery'
import { RunSheet } from '@/components/run-sheet'
import { Section } from '@/components/shell/app-shell'
import { EmptyState, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAction, useCall } from '@/lib/queries'
import type { MakingRenders, RevisionRenders } from '@/lib/types-renders'

export const Route = createFileRoute('/_app/p/$id/renders')({
  staticData: { crumb: 'Renders' },
  component: Renders,
})

function Renders() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const r = useAction('renders.list', { repo })
  const [open, setOpen] = useState<{ rev: RevisionRenders; i: number } | null>(null)
  const [log, setLog] = useState<MakingRenders | null>(null)
  const data = r.data
  // opening the tab is seeing each revision's renders: their "renders ready" items leave this person's Next
  const seen = useCall('renders.seen', () => [['inbox']])
  const marked = useRef(new Set<string>())
  useEffect(() => {
    for (const x of data?.revisions ?? []) {
      if (marked.current.has(x.revision)) continue
      marked.current.add(x.revision)
      seen.mutate({ repo, revision: x.revision }, { onError: () => marked.current.delete(x.revision) })
    }
  }, [data, repo, seen])
  useTraceContext({
    label: 'Renders', description: 'The project tab on screen',
    value: { tab: 'renders', revisions: data?.revisions.map((x) => ({ revision: x.revision, date: x.date, pictures: x.pictures.length })) ?? [], making: data?.making.map((m) => m.revision) ?? [] },
  }, 'screen')

  if (r.isError) return <div className="mt-6"><QueryError error={r.error} what="the renders" onRetry={() => void r.refetch()} /></div>
  if (!data) return <TabSkeleton loading={r.isLoading} />
  const [newest, ...older] = data.revisions
  return (
    <div className="pt-6 pb-12">
      <Section label="Renders of each revision" count={data.revisions.length + data.making.filter((m) => !data.revisions.some((x) => x.revision === m.revision)).length}>
        <div className="space-y-3">
          {data.making.map((m) => <MakingCard key={m.job} m={m} onLog={() => setLog(m)} />)}
          {!newest && !data.making.length && (
            <EmptyState>No renders yet. When a revision is cut, trace renders the board and, once the case is built, the case, the board in the case and an exploded view. You get a notification when they're ready.</EmptyState>
          )}
          {newest && <RevisionCard repo={repo} r={newest} onOpen={(i) => setOpen({ rev: newest, i })} />}
          {older.map((x) => <RevisionCard key={x.run} repo={repo} r={x} compact onOpen={(i) => setOpen({ rev: x, i })} />)}
        </div>
      </Section>
      <RendersViewer repo={repo} r={open?.rev ?? null} index={open?.i ?? 0} onIndex={(i) => setOpen((o) => (o ? { ...o, i } : o))} onClose={() => setOpen(null)} />
      <RunSheet repo={repo} run={log ? `job:${log.job}` : ''} title={log ? `Rev ${log.revision}'s renders` : ''} open={!!log} onOpenChange={(o) => { if (!o) setLog(null) }} />
    </div>
  )
}
