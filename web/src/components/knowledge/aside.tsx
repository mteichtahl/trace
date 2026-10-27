/**
 * Knowledge's side column: Ask trace about these results (the question goes to Ask trace with the results as
 * context, so its answer cites them), the knowledge base's sync Wait line with Sync now (kb.status and kb.sync), and
 * what the person can see.
 */
import { ArrowUp, Eye } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { askTrace } from '@/components/chat/chat-state'
import { useTraceContext } from '@/components/chat/context'
import { WaitLine } from '@/components/wait-line'
import { call, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago } from '@/lib/format'
import type { KnowledgeResult } from '@/lib/knowledge'
import { useCall, useProjects, useWaits } from '@/lib/queries'
import type { Wait } from '@/lib/types'
import { useLibraryTool } from './use-knowledge'

export function AskAboutResults({ results, query }: { results: KnowledgeResult[]; query: string }) {
  const [text, setText] = useState('')
  useTraceContext(
    results.length ? { label: `${results.length} results`, description: `The Knowledge search results on screen for "${query}"; answer from these and cite them`, value: { query, results: results.slice(0, 12).map((r) => ({ kind: r.kind, source: r.source, project: r.repo, summary: r.summary, passage: r.passage })) } } : null,
    'knowledge-results',
  )
  return (
    <section className="rounded-xl border p-5">
      <h2 className="font-semibold">Ask trace about these results</h2>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          askTrace(text.trim())
          setText('')
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={query ? `Is C7 big enough?` : 'Search first, then ask'} aria-label="Ask trace about these results" disabled={!results.length} />
        <Button type="submit" size="icon" aria-label="Ask" disabled={!text.trim() || !results.length}>
          <ArrowUp />
        </Button>
      </form>
      <p className="mt-3 text-xs text-muted-foreground">{results.length ? `trace answers from these ${results.length} results and cites them.` : 'trace answers from the results on screen and cites them.'}</p>
    </section>
  )
}

interface KbStatus {
  documents?: number | null
  last_ingestion?: { status: string; updated_at: string | null } | null
}

/** The sync line for one project's knowledge base. */
export function KbSyncLine({ repo }: { repo: string }) {
  const projects = useProjects()
  const { user } = useAuth()
  const writer = user?.class === 'admin' || projects.data?.find((p) => p.repo === repo)?.part === 'contributor'
  const status = useLibraryTool<KbStatus>(repo, 'kb.status', {})
  const waits = useWaits(repo)
  const sync = useCall('kb.sync', (a) => [['tool', a.repo, 'kb.status'], ['tools.waits', a.repo], ['kb.search', a.repo]])
  const pending = (waits.data?.waits ?? []).filter((w) => /knowledge|ingest|kb/i.test(`${w.what} ${w.source ?? ''}`))
  const last = status.data?.last_ingestion
  const at = last?.updated_at
  const wait: Wait = {
    id: `kb-${repo}`,
    what: status.isError
      ? `${projectName(repo)}'s knowledge base: its sync time could not be read.`
      : at
        ? `${projectName(repo)}'s knowledge base last synced ${ago(at)}; syncs on every push.`
        : status.isLoading
          ? `${projectName(repo)}'s knowledge base: reading when it last synced…`
          : `${projectName(repo)}'s knowledge base has not synced yet; it syncs on every push.`,
    text: '',
  }
  return (
    <div className="divide-y">
      <WaitLine
        wait={wait}
        className="px-0 py-3"
        checkLabel="Sync now"
        onCheckNow={
          writer
            ? () =>
                sync
                  .mutateAsync({ repo })
                  .then(() => toast('Sync started', { description: `${projectName(repo)}'s knowledge base takes in the default branch; new results appear once it finishes.` }))
                  .catch((e: Error) => toast.error('Could not start the sync', { description: e.message }))
            : undefined
        }
      />
      {pending.map((w) => (
        <WaitLine key={w.id} wait={w} className="px-0 py-3" onCheckNow={(x) => call('tools.check_now', { repo, waitId: x.id })} />
      ))}
    </div>
  )
}

export function WhatYouSee() {
  return (
    <p className="flex gap-2 text-sm text-muted-foreground">
      <Eye className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-foreground">What you see:</span> results only from projects you're on, plus the shared library. Counts are worked out after that, so other projects' entries are never shown or counted.
      </span>
    </p>
  )
}
