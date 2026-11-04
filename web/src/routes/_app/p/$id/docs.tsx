/**
 * Documents (/p/:id/docs): the project's documents as Scribe keeps them (docs/scribe.md), from documents.get: each one
 * with how current it is and why, its sections written, its newest print and its text; the Documentation agent's job
 * while it works; each revision's release copies, newest first; and when trace next checks them. PDFs open in the
 * file viewer, read by their hash (documents.pdf); the text opens as the repository's markdown.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { DocumentCard, NextCheck, ReleaseRow, type StageName, WritingCard } from '@/components/docs/documents'
import type { FileRef } from '@/components/files/data'
import { FileSheet } from '@/components/files/file-viewer'
import { TabSkeleton } from '@/components/project/shared'
import { RunSheet } from '@/components/run-sheet'
import { Section } from '@/components/shell/app-shell'
import { EmptyState, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAction, useJourney } from '@/lib/queries'

export const Route = createFileRoute('/_app/p/$id/docs')({
  staticData: { crumb: 'Documents' },
  component: Documents,
})

function Documents() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const r = useAction('documents.get', { repo })
  const j = useJourney(repo)
  const [file, setFile] = useState<FileRef | null>(null)
  const [log, setLog] = useState(false)
  const data = r.data
  const stage: StageName = (s) => j.data?.stages.find((x) => x.id === s)?.name ?? `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`
  useTraceContext({
    label: 'Documents', description: 'The project tab on screen',
    value: { tab: 'docs', documents: data?.documents.map((d) => ({ kind: d.kind, state: d.state, revision: d.revision, behind: d.behind })) ?? [], releases: data?.releases.map((x) => x.revision) ?? [], writing: !!data?.writing },
  }, 'screen')

  if (r.isError) return <div className="mt-6"><QueryError error={r.error} what="the documents" onRetry={() => void r.refetch()} /></div>
  if (!data) return <TabSkeleton loading={r.isLoading} />
  // the documents the project keeps now first, then those still to come
  const shown = [...data.documents].sort((a, b) => Number(!(a.exists || a.due)) - Number(!(b.exists || b.due)))
  const behind = data.documents.filter((d) => d.state === 'behind' || d.state === 'missing').length
  return (
    <div className="pt-6 pb-12">
      <div className="mb-6 space-y-3">
        {data.writing && <WritingCard w={data.writing} onLog={() => setLog(true)} />}
        <NextCheck at={data.next_check} />
      </div>
      <Section label="Documents" count={data.documents.filter((d) => d.exists).length} action={behind ? <span className="text-muted-foreground">{behind} to update</span> : undefined}>
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map((d) => <DocumentCard key={d.kind} repo={repo} d={d} stage={stage} writing={!!data.writing} onOpen={setFile} />)}
        </div>
      </Section>
      <Section label="Release copies" count={data.releases.length}>
        {data.releases.length ? (
          <div className="space-y-3">
            {data.releases.map((x) => <ReleaseRow key={x.revision} repo={repo} r={x} onOpen={setFile} />)}
          </div>
        ) : (
          <EmptyState>No release copies yet. When a revision is cut, trace prints every document for it and keeps those copies with the revision for good.</EmptyState>
        )}
      </Section>
      <FileSheet file={file} open={!!file} onOpenChange={(o) => { if (!o) setFile(null) }} />
      <RunSheet repo={repo} run={data.writing ? `job:${data.writing.job}` : ''} title="Updating the documents" open={log && !!data.writing} onOpenChange={(o) => { if (!o) setLog(false) }} />
    </div>
  )
}
