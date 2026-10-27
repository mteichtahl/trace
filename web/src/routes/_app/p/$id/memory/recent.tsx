/**
 * Memory › Recent activity: sessions grouped by day, newest first, each with its agent, a summary and when its events
 * expire. trace's API gives each session's summary (memory.list, the "sessions" kind) but not the session's own
 * events, who started it, or the project's retention setting, so those parts say so ("Needs building") rather than
 * inventing them. Filters: agent, date range and words.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronDown, Clock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NeedsBuilding } from '@/components/side-sheet'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { useAuth } from '@/lib/auth'
import { repoOf } from '@/lib/api'
import { time } from '@/lib/format'
import { AGENTS, DEFAULT_RETENTION_DAYS, type MemoryView, agentName, byDay, expiresInDays } from '@/lib/knowledge'
import { cn } from '@/lib/utils'
import { useProjectMemories } from '../memory'

export const Route = createFileRoute('/_app/p/$id/memory/recent')({
  staticData: { crumb: 'Recent activity' },
  component: Recent,
})

const RANGES = [
  { id: '1', label: 'Today', days: 1 },
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'Everything kept', days: 3650 },
]

function Recent() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const m = useProjectMemories(repo)
  const { user } = useAuth()
  const [agent, setAgent] = useState('all')
  const [range, setRange] = useState('7')
  const [words, setWords] = useState('')
  const [more, setMore] = useState<Set<string>>(new Set())
  const days = RANGES.find((r) => r.id === range)?.days ?? 7
  const sessions = useMemo(() => {
    const since = Date.now() - days * 86_400_000
    const w = words.trim().toLowerCase()
    return m.records.filter((r) => r.kind === 'sessions' && (agent === 'all' || r.actor === agent) && (!r.createdAt || new Date(r.createdAt).getTime() >= since) && (!w || r.text.toLowerCase().includes(w)))
  }, [m.records, agent, days, words])
  const groups = byDay(sessions, (s) => s.createdAt)

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        {user?.class === 'admin' && <Link to="/p/$id/$" params={{ id, _splat: 'settings' }} className="text-sm text-primary hover:underline">Change how long (Settings)</Link>}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="r-agent" className="text-xs text-muted-foreground">Agent</Label>
            <select id="r-agent" className="h-9 w-48 rounded-md border bg-background px-2 text-sm" value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="all">All agents</option>
              {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="r-when" className="text-xs text-muted-foreground">When</Label>
            <select id="r-when" className="h-9 rounded-md border bg-background px-2 text-sm" value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="r-words" className="text-xs text-muted-foreground">Search sessions</Label>
            <Input id="r-words" value={words} onChange={(e) => setWords(e.target.value)} placeholder="Search…" />
          </div>
          <span className="pb-2 text-sm text-muted-foreground" aria-live="polite">{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} in this range</span>
        </div>

        {m.isError ? (
          <QueryError error={m.error} what="recent activity" onRetry={() => void m.refetch()} />
        ) : m.isLoading ? (
          <Loading><SkeletonRows rows={3} className="mt-4" /></Loading>
        ) : groups.length === 0 ? (
          <EmptyState className="mt-4">{m.records.some((r) => r.kind === 'sessions') ? 'No sessions match these filters.' : 'No agent sessions on this project yet. Each session shows here once its summary is extracted.'}</EmptyState>
        ) : (
          <div className="mt-4 space-y-2">
            {groups.map((g, gi) => {
              const shown = more.has(g.key) ? g.items : g.items.slice(0, 3)
              return (
                <Collapsible key={g.key} defaultOpen={gi < 2}>
                  <CollapsibleTrigger className="group flex items-center gap-2 py-2 text-sm">
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" aria-hidden />
                    <span className="font-semibold uppercase tracking-wide">{g.label}</span>
                    <span className="text-muted-foreground">· {g.items.length} {g.items.length === 1 ? 'session' : 'sessions'}{gi >= 2 ? ` · ${[...new Set(g.items.map((s) => agentName(s.actor)))].slice(0, 3).join(', ')}` : ''}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3">
                    {shown.map((s) => <SessionCard key={s.id} s={s} id={id} />)}
                    {g.items.length > 3 && !more.has(g.key) && (
                      <button type="button" className="text-sm text-primary hover:underline" onClick={() => setMore((x) => new Set([...x, g.key]))}>
                        Show {g.items.length - 3} more {g.items.length - 3 === 1 ? 'session' : 'sessions'} from {g.label === 'Today' ? 'today' : g.label}
                      </button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <section className="rounded-xl border p-5">
          <h2 className="font-semibold">Retention</h2>
          <p className="mt-2 text-sm"><span className="text-2xl font-semibold">{DEFAULT_RETENTION_DAYS} days</span> (installation default) · events older than this are removed automatically.</p>
          <NeedsBuilding className="mt-2">the project's own retention is set when its memory is created and is not returned by the API yet; changing it from the app would run as a tracked stack update.</NeedsBuilding>
          <p className="mt-2 text-xs text-muted-foreground">Recent events can't be switched off or deleted one by one today; they expire.</p>
          {user?.class === 'admin' && <Link to="/p/$id/$" params={{ id, _splat: 'settings' }} className="mt-2 inline-block text-sm text-primary hover:underline">Change how long (Settings)</Link>}
        </section>
        <section className="rounded-xl border p-5">
          <h2 className="font-semibold">What's waiting</h2>
          <p className="mt-2 text-sm text-muted-foreground">Sessions are summarised into long-term memory a few minutes after they end.</p>
          <NeedsBuilding className="mt-1">trace does not report sessions still being summarised yet.</NeedsBuilding>
        </section>
        <section className="rounded-xl border p-5">
          <h2 className="font-semibold">Who sees what</h2>
          <p className="mt-2 text-sm text-muted-foreground">Everyone on the project sees agents' sessions. Your own chat sessions show your words; others see them only on projects they're on.</p>
        </section>
      </aside>
    </div>
  )
}

function SessionCard({ s, id }: { s: MemoryView; id: string }) {
  const left = s.createdAt ? expiresInDays(s.createdAt, DEFAULT_RETENTION_DAYS) : null
  const [open, setOpen] = useState(false)
  return (
    <article className="rounded-xl border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{agentName(s.actor)}</h3>
          <p className="text-xs text-muted-foreground">Session {s.createdAt ? time(s.createdAt) : ''} · started by <span className="italic">not recorded yet</span></p>
        </div>
        {left !== null && (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <Clock className="size-3" aria-hidden /> Events expire in {left} {left === 1 ? 'day' : 'days'}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm leading-relaxed">{s.text}</p>
      <button type="button" className={cn('mt-3 text-sm text-primary hover:underline')} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide events' : 'Show its events'}
      </button>
      {open && (
        <div className="mt-2 rounded-lg bg-muted/50 p-3">
          <NeedsBuilding>the API does not return a session's events (Asked, Tool, Result, Answer) or its link to the conversation or run yet; this summary is what trace keeps long term.</NeedsBuilding>
          <Link to="/p/$id/memory" params={{ id }} className="mt-2 inline-block text-xs text-primary hover:underline">See the long-term memories</Link>
        </div>
      )}
    </article>
  )
}
