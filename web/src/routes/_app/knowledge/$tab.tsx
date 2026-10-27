/**
 * Knowledge's tabs: Documents (each project's knowledge base: kb.search, and without a search the documents by project
 * from files.list with the sync line), Datasheets and parts (the shared library), Agent memory (memory.recall across the
 * person's projects, and without a search memory.list as memory cards with filters and Include inactive).
 */
import { useQueries } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { DataTable, Highlight } from '@/components/data-table'
import { AskAboutResults, KbSyncLine, WhatYouSee } from '@/components/knowledge/aside'
import { LibraryResults } from '@/components/knowledge/library'
import { Chip } from '@/components/knowledge/result-card'
import { ResultsList, useOpeners } from '@/components/knowledge/results'
import { failedWords, useKnowledgeSearch, useKnowledgeView, useMemoryLists, useScopeRepos } from '@/components/knowledge/use-knowledge'
import { useMaySwitch, useMemorySwitch } from '@/components/memory/switch'
import { EmptyState, Loading, NotShared, Partial, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { projectId, projectName } from '@/lib/api'
import { ago, plural } from '@/lib/format'
import { AGENTS, type MemoryView, agentName, kindWord, switchedBy } from '@/lib/knowledge'
import { q } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { KnowledgeColumns } from './index'

export const Route = createFileRoute('/_app/knowledge/$tab')({
  staticData: { crumb: ({ tab }) => ({ documents: 'Documents', library: 'Datasheets and parts', memory: 'Agent memory' })[tab] ?? tab },
  component: Tab,
})

function Tab() {
  const { tab } = Route.useParams()
  if (tab === 'documents') return <Documents />
  if (tab === 'library') return <Library />
  if (tab === 'memory') return <AgentMemory />
  return <NotShared />
}

// ------------------------------------------------------------------ Documents

interface DocRow {
  path: string
  repo: string
  project: string
  kind: string
  size: number
  release: string
}

const docColumns: ColumnDef<DocRow, any>[] = [
  { accessorKey: 'path', header: 'Document', size: 300, meta: { label: 'Document', kind: 'text', mono: true }, cell: ({ row }) => <span className="font-mono text-[13px]"><Highlight text={row.original.path} /></span> },
  { accessorKey: 'project', header: 'Project', size: 150, meta: { label: 'Project', kind: 'enum' } },
  { accessorKey: 'kind', header: 'Kind', size: 120, meta: { label: 'Kind', kind: 'enum' } },
  { accessorKey: 'release', header: 'Release', size: 100, meta: { label: 'Release', kind: 'enum' } },
  { accessorKey: 'size', header: 'Size', size: 90, meta: { label: 'Size', kind: 'number', align: 'right' }, cell: ({ getValue }) => `${Math.max(1, Math.round((getValue() as number) / 1024))} KB` },
]

function Documents() {
  const [view, set] = useKnowledgeView()
  const { repos, all } = useScopeRepos(view)
  const outcome = useKnowledgeSearch(view, { kinds: ['kb'], enabled: view.scope !== 'library' })
  const files = useQueries({ queries: repos.map((repo) => ({ ...q('files.list', { repo }), retry: false })) })
  const { open, sheets } = useOpeners(all)
  const rows: DocRow[] = useMemo(
    () => repos.flatMap((repo, i) => (files[i]?.data ?? []).filter((f) => /\.(md|markdown|txt|pdf|rst|adoc)$/i.test(f.path) || f.kind === 'documents').map((f) => ({ path: f.path, repo, project: projectName(repo), kind: f.kind, size: f.size, release: f.release ?? 'Working copy' }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, repos.join(',')],
  )
  const failed = repos.flatMap((repo, i) => (files[i]?.isError ? [{ repo, error: files[i]!.error }] : []))
  const aside = (
    <>
      <AskAboutResults results={outcome.strong} query={view.q} />
      {repos.length > 0 && (
        <section className="rounded-xl border px-5 py-2">
          {repos.map((r) => <KbSyncLine key={r} repo={r} />)}
        </section>
      )}
      <WhatYouSee />
    </>
  )
  if (view.scope === 'library') return <KnowledgeColumns aside={<WhatYouSee />}><EmptyState>Documents belong to projects. Choose This project or All my projects; the shared library holds datasheets and parts.</EmptyState></KnowledgeColumns>
  if (view.q.trim().length >= 2)
    return (
      <KnowledgeColumns aside={aside}>
        <ResultsList outcome={outcome} query={view.q} weak={view.weak} onWeak={(w) => set({ weak: w })} includeInactive={view.inactive} all={all} />
      </KnowledgeColumns>
    )
  return (
    <KnowledgeColumns aside={aside}>
      {failed.length > 0 && <Partial onRetry={() => files.forEach((f) => f.isError && void f.refetch())}>Could not list {failedWords(failed)}'s documents. The rest are shown.</Partial>}
      {files.some((f) => f.isLoading) && rows.length === 0 ? (
        <Loading><SkeletonRows rows={4} /></Loading>
      ) : (
        <DataTable
          id="knowledge-documents"
          className="mt-3"
          data={rows}
          columns={docColumns}
          getRowId={(r) => `${r.repo}:${r.path}`}
          noun="documents"
          onRowClick={(r) => open({ id: r.path, kind: 'document', repo: r.repo, score: null, summary: r.path, source: r.path, path: r.path })}
          empty="No documents in these projects' repositories yet. Add one to a repository, or attach it in chat; the knowledge base takes it in on the next push."
        />
      )}
      <p className="mt-3 text-xs text-muted-foreground">Documents removed from a repository disappear at the next sync. To add one, add it to the project's repository or attach it in chat (trace asks first).</p>
      {sheets}
    </KnowledgeColumns>
  )
}

// ------------------------------------------------------------------ Datasheets and parts

function Library() {
  const [view] = useKnowledgeView()
  const { all } = useScopeRepos(view)
  return (
    <KnowledgeColumns aside={<><WhatYouSee /><p className="text-sm text-muted-foreground">The shared library is open to everyone signed in: public datasheets and parts data only. Stock and prices bought under a distributor key show as trace shows them, never as the distributor's raw answer.</p></>}>
      <LibraryResults view={view} all={all} />
    </KnowledgeColumns>
  )
}

// ------------------------------------------------------------------ Agent memory

function AgentMemory() {
  const [view, set] = useKnowledgeView()
  const { repos, all } = useScopeRepos(view)
  const outcome = useKnowledgeSearch(view, { kinds: ['memory'], enabled: view.scope !== 'library' })
  const lists = useMemoryLists(view.q.trim().length >= 2 || view.scope === 'library' ? [] : repos, view.inactive)
  const { open, sheets } = useOpeners(all)
  const may = useMaySwitch()
  const sw = useMemorySwitch()
  const [kind, setKind] = useState<string>('all')
  const [agent, setAgent] = useState<string>('all')
  const shown = lists.records.filter((m) => (kind === 'all' || m.kind === kind) && (agent === 'all' || m.actor === agent || (agent === 'person' && m.actor?.startsWith('person/'))))
  const aside = (
    <>
      <AskAboutResults results={outcome.strong} query={view.q} />
      <WhatYouSee />
      <p className="text-sm text-muted-foreground">Memories from someone's private chat show only to them and to admins. Each project's Memory tab manages them in full.</p>
    </>
  )
  if (view.scope === 'library') return <KnowledgeColumns aside={<WhatYouSee />}><EmptyState>Agent memory belongs to projects. Choose This project or All my projects.</EmptyState></KnowledgeColumns>
  if (view.q.trim().length >= 2)
    return (
      <KnowledgeColumns aside={aside}>
        <ResultsList outcome={outcome} query={view.q} weak={view.weak} onWeak={(w) => set({ weak: w })} includeInactive={view.inactive} all={all} empty={`No memory matches “${view.q}” by meaning.`} />
      </KnowledgeColumns>
    )
  const select = 'h-9 rounded-md border bg-background px-2 text-sm'
  return (
    <KnowledgeColumns aside={aside}>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Kind" className={select} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">Every kind</option>
          <option value="facts">Facts</option>
          <option value="preferences">Preferences</option>
          <option value="sessions">Session summaries</option>
        </select>
        <select aria-label="Agent" className={select} value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="all">Every agent</option>
          {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value="person">Your own preferences</option>
        </select>
        <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">{plural(shown.length, 'memory', 'memories')}{view.inactive ? ', switched off included' : ''}</span>
      </div>
      {lists.failed.length > 0 && <Partial onRetry={lists.retry}>Could not read {failedWords(lists.failed)}'s memory. The rest is shown.</Partial>}
      {lists.off.length > 0 && <p className="mt-2 text-sm text-muted-foreground">Memory is not turned on for {lists.off.map(projectName).join(', ')}.</p>}
      {lists.loading && shown.length === 0 ? (
        <Loading><SkeletonRows rows={4} className="mt-3" /></Loading>
      ) : shown.length === 0 ? (
        <EmptyState className="mt-3">The agents have not remembered anything here yet. Memories appear a few minutes after an agent's session ends.</EmptyState>
      ) : (
        <ul className="mt-3 grid gap-3 md:grid-cols-2">
          {shown.map((m) => (
            <MemoryCard key={`${m.repo}:${m.id}`} m={m} onOpen={() => open({ id: m.id, kind: 'memory', repo: m.repo, score: null, summary: m.text, source: agentName(m.actor), memory: m })} onOn={may(m) && !m.active ? () => void sw.on(m.id, m.repo) : undefined} />
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Memories are what the agents extracted; they may be stale. Switching one off never deletes it.</p>
      {sheets}
    </KnowledgeColumns>
  )
}

function MemoryCard({ m, onOpen, onOn }: { m: MemoryView; onOpen: () => void; onOn?: () => void }) {
  return (
    <li className={cn('flex flex-col rounded-xl border bg-card p-4', !m.active && 'border-dashed bg-muted/30')}>
      <div className="flex flex-wrap items-center gap-1.5">
        {m.active ? <StatusBadge status="met" label="Active" /> : <StatusBadge status="idle" label="Switched off" />}
        <Chip>{kindWord(m.kind)}</Chip>
        <Chip>{agentName(m.actor)}</Chip>
        <Link to="/p/$id/memory" params={{ id: projectId(m.repo) }} className="text-xs text-muted-foreground hover:underline">{projectName(m.repo)}</Link>
      </div>
      <button type="button" onClick={onOpen} className={cn('mt-2 flex-1 text-left text-sm hover:underline', !m.active && 'text-muted-foreground line-through')}>
        {m.text}
      </button>
      {m.inactive && <p className="mt-1 text-xs text-muted-foreground">Switched off by {switchedBy(m)}: “{m.inactive.reason}”</p>}
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        {m.createdAt && <span>Learned {ago(m.createdAt)}</span>}
        {m.actor?.startsWith('person/') && <span>· only you see this</span>}
        {onOn && <Button variant="outline" size="sm" className="ml-auto h-7" onClick={onOn}>Switch back on</Button>}
      </div>
    </li>
  )
}
