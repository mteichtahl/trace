/**
 * Opening Knowledge entries without leaving the page: a document from a project's repository (files.url, rendered
 * markdown or text) and a datasheet at its cited page (the read-only datasheets.text tool, page by page, with the
 * query's words marked). Both sit in the shared side sheet. The datasheet viewer is also registered as the chat's
 * File viewer for kind "datasheet", so a datasheet card in a conversation shows the cited page.
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, ExternalLink, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Markdown } from '@/components/chat/markdown'
import { registerFileViewer } from '@/components/chat/cards'
import { askTrace } from '@/components/chat/chat-state'
import { useTraceContext } from '@/components/chat/context'
import { SideSheet } from '@/components/side-sheet'
import { ErrorState } from '@/components/states'
import { call, projectName } from '@/lib/api'
import { Marked } from './result-card'

export interface DocTarget {
  repo: string
  path: string
}

export interface SheetTarget {
  /** the project the library tool runs on */
  repo: string
  mpn: string
  page: number
  terms?: string[]
}

export function DocumentSheet({ doc, onOpenChange }: { doc: DocTarget | null; onOpenChange: (o: boolean) => void }) {
  const q = useQuery({
    queryKey: ['files.url', doc?.repo ?? '', doc?.path ?? '', 'text'],
    enabled: !!doc,
    retry: false,
    queryFn: async () => {
      const { url } = await call('files.url', { repo: doc!.repo, path: doc!.path })
      const r = await fetch(url)
      if (!r.ok) throw new Error(`the file could not be read (${r.status})`)
      return { url, text: await r.text() }
    },
  })
  useTraceContext(doc ? { label: doc.path.split('/').pop() ?? doc.path, description: 'The document the person has open', value: { repo: doc.repo, path: doc.path }, mono: true } : null, 'document')
  if (!doc) return null
  const md = /\.(md|markdown)$/i.test(doc.path)
  return (
    <SideSheet open={!!doc} onOpenChange={onOpenChange} title={<span className="font-mono text-base">{doc.path}</span>} description={`${projectName(doc.repo)} · from the project's repository`}>
      <div className="mb-3 flex flex-wrap gap-2">
        {q.data && (
          <Button asChild variant="outline" size="sm">
            <a href={q.data.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open in a new tab
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => askTrace(`Summarise ${doc.path} on ${projectName(doc.repo)} for me.`)}>
          <Sparkles /> Ask about this file
        </Button>
      </div>
      {q.isError ? (
        <ErrorState title="Could not open this document." onRetry={() => void q.refetch()} detail={q.error instanceof Error ? q.error.message : String(q.error)} />
      ) : !q.data ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : md ? (
        <Markdown text={q.data.text} />
      ) : (
        <pre className="whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs">{q.data.text.slice(0, 40_000)}</pre>
      )}
    </SideSheet>
  )
}

interface PageText {
  mpn: string
  page_count: number
  pages: { page: number; text: string; chars: number }[]
}

export function DatasheetPage({ target, compact }: { target: SheetTarget; compact?: boolean }) {
  const [page, setPage] = useState(target.page)
  const q = useQuery({
    queryKey: ['tool', target.repo, 'datasheets.text', target.mpn, page],
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: () => call('tool', { repo: target.repo, name: 'datasheets.text', args: { mpn: target.mpn, pages: [page] } }) as Promise<PageText>,
  })
  const text = q.data?.pages[0]?.text ?? ''
  const total = q.data?.page_count
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <Button variant="outline" size="icon" className="size-8" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft />
        </Button>
        <span>
          Page {page}
          {total ? ` of ${total}` : ''}
          {page === target.page && <span className="ml-1 text-muted-foreground">(cited)</span>}
        </span>
        <Button variant="outline" size="icon" className="size-8" aria-label="Next page" disabled={!!total && page >= total} onClick={() => setPage((p) => p + 1)}>
          <ChevronRight />
        </Button>
      </div>
      {q.isError ? (
        <ErrorState title={`Could not read ${target.mpn} page ${page}.`} onRetry={() => void q.refetch()} detail={q.error instanceof Error ? q.error.message : String(q.error)} />
      ) : q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : text.trim() ? (
        <pre className={compact ? 'max-h-48 overflow-hidden whitespace-pre-wrap font-sans text-xs' : 'whitespace-pre-wrap rounded-lg border bg-background p-4 font-sans text-sm leading-relaxed'}>
          <Marked text={text} terms={target.terms ?? []} />
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">This page has no text layer (a scanned page). Ask trace to look at the page's picture.</p>
      )}
    </div>
  )
}

export function DatasheetSheet({ target, onOpenChange }: { target: SheetTarget | null; onOpenChange: (o: boolean) => void }) {
  useTraceContext(target ? { label: `${target.mpn} p.${target.page}`, description: 'The datasheet page the person has open', value: { mpn: target.mpn, page: target.page } } : null, 'datasheet')
  if (!target) return null
  return (
    <SideSheet open={!!target} onOpenChange={onOpenChange} title={`${target.mpn} datasheet`} description="Shared library · shown as the maker published it; the text is read from the document's text layer">
      <div className="mb-3">
        <Button variant="outline" size="sm" onClick={() => askTrace(`What does the ${target.mpn} datasheet say on page ${target.page}?`)}>
          <Sparkles /> Ask about this page
        </Button>
      </div>
      <DatasheetPage key={`${target.mpn}:${target.page}`} target={target} />
    </SideSheet>
  )
}

// a datasheet card in a chat ({ path, kind: 'datasheet', … }) shows its cited page
registerFileViewer('datasheet', ({ file }) => {
  const f = file as typeof file & { mpn?: string; page?: number; repo?: string }
  if (!f.mpn || !f.repo) return null
  return <DatasheetPage compact target={{ repo: f.repo, mpn: f.mpn, page: f.page ?? 1 }} />
})
