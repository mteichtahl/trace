/**
 * Ask trace: the chat panel docked on the right (desktop, 380–560 px, resizable, open across routes), sliding over
 * the content on tablets, and the full-screen Ask tab on phones. Header: history and close; voice controls; the
 * context strip (what trace will look at, as removable chips). Body: the conversation, or the history list.
 */
import { useQuery } from '@tanstack/react-query'
import { History, Plus, Search, Sparkles, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { projectName } from '@/lib/api'
import { ago } from '@/lib/format'
import { useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { AGENT_ID } from './agent'
import { openPanel, setPanelWidth, setThread, showHistory, usePanel, useThreads } from './chat-state'
import { ChatView } from './chat-view'
import { removeContext, restoreContext, useContextEntries } from './context'
import { PlayerBar, VoiceControls } from './voice/voice-controls'

/** The project in view: the context entry the project screens register with id "project", else the first project. */
function useActiveRepo(): string | undefined {
  const { entries } = useContextEntries()
  const projects = useProjects()
  const e = entries.find((x) => x.id === 'project')
  const repo = e && typeof e.value === 'object' ? String((e.value as { repo?: string }).repo ?? '') : undefined
  return repo || projects.data?.[0]?.repo
}

export function ContextStrip() {
  const { entries, removed } = useContextEntries()
  const shown = entries.filter((e) => !removed.has(e.id))
  if (entries.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Context</span>
      {shown.map((e) => (
        <span key={e.id} className={cn('inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5', e.mono && 'font-mono')}>
          {e.label}
          <button type="button" aria-label={`Leave out ${e.label}`} className="rounded-sm text-muted-foreground hover:text-foreground" onClick={() => removeContext(e.id)}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      {removed.size > 0 && (
        <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={restoreContext}>
          + Add back
        </button>
      )}
    </div>
  )
}

function ThreadList({ repo }: { repo: string }) {
  const threads = useThreads(repo)
  const [qtext, setQ] = useState('')
  const list = useMemo(() => (threads.data ?? []).filter((t) => t.title.toLowerCase().includes(qtext.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [threads.data, qtext])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={qtext} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" className="pl-8" />
        </div>
        <Button variant="outline" size="sm" className="w-full" onClick={() => setThread(repo, undefined)}>
          <Plus /> New conversation
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.isLoading && <li className="p-2 text-sm text-muted-foreground">Loading conversations…</li>}
        {!threads.isLoading && list.length === 0 && <li className="p-2 text-sm text-muted-foreground">No conversations on {projectName(repo)} yet.</li>}
        {list.map((t) => (
          <li key={t.id}>
            <button type="button" className="w-full rounded-md px-2 py-2 text-left hover:bg-accent" onClick={() => setThread(repo, t.id)}>
              <p className="truncate text-sm">{t.title}</p>
              <p className="text-xs text-muted-foreground">{ago(t.updatedAt)}{t.author ? ` · ${t.author}` : ''}</p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AskTrace({ onClose, className }: { onClose?: () => void; className?: string }) {
  const p = usePanel()
  const repo = useActiveRepo()
  const thread = repo ? p.threads[repo] : undefined
  // reopen the last thread on this project
  useQuery({
    queryKey: ['chats.list', repo ?? '', 'last'],
    enabled: !!repo && !(repo in p.threads),
    queryFn: async () => {
      const { call } = await import('@/lib/api')
      const ts = await call('chats.list', { repo: repo! })
      const last = [...ts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      setThread(repo!, last?.id)
      return ts
    },
  })
  return (
    <section className={cn('flex h-full min-h-0 flex-col bg-background', className)} aria-label="Ask trace">
      <header className="space-y-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden />
          <h2 className="flex-1 font-semibold">Ask trace</h2>
          <Button variant="outline" size="icon" className="size-8" aria-label="Conversations" aria-pressed={p.history} onClick={() => showHistory(!p.history)}>
            <History />
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" className="size-8" aria-label="Close Ask trace" onClick={onClose}>
              <X />
            </Button>
          )}
        </div>
        <VoiceControls />
        <ContextStrip />
      </header>
      {p.history && repo ? (
        <ThreadList repo={repo} />
      ) : (
        <>
          <ChatView key={`${repo}:${thread ?? 'new'}`} agentId={AGENT_ID} repo={repo} threadId={thread} intro={<p className="text-sm text-muted-foreground">Ask anything about {repo ? projectName(repo) : 'your projects'}. trace sees the screen you are on.</p>} />
          <div className="px-3 pb-2">
            <PlayerBar />
          </div>
        </>
      )}
    </section>
  )
}

/** The docked panel with a drag handle on its left edge (380–560 px). */
export function DockedAskTrace() {
  const p = usePanel()
  const start = useRef<{ x: number; w: number } | null>(null)
  if (!p.open) return null
  return (
    <aside className="relative hidden shrink-0 border-l lg:block" style={{ width: p.width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Ask trace"
        aria-valuemin={380}
        aria-valuemax={560}
        aria-valuenow={p.width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setPanelWidth(p.width + 20)
          if (e.key === 'ArrowRight') setPanelWidth(p.width - 20)
        }}
        onPointerDown={(e) => {
          start.current = { x: e.clientX, w: p.width }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => start.current && setPanelWidth(start.current.w + start.current.x - e.clientX)}
        onPointerUp={() => (start.current = null)}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      />
      <div className="sticky top-0 h-dvh">
        <AskTrace onClose={() => openPanel(false)} />
      </div>
    </aside>
  )
}
