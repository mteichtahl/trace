/**
 * The Decisions tab's timeline: every decision in the record, newest first, grouped by day on one line through time.
 * Each moment says what was decided, the choice, whether it was trace's recommendation (and the reason when it was
 * not), who decided and where it stands. A signed or returned gate is a milestone on the line. Records with no time
 * of their own (a waiver in force) sit together at the end rather than pretending to have happened today.
 *
 * Kind chips and a search narrow the line; the table stays one tap away for sorting and filtering by column.
 */
import { CircleMinus, GitPullRequestArrow, MessageCircleQuestion, Scale, Search, ShieldCheck, X } from 'lucide-react'
import { type ComponentType, type ReactNode, useMemo, useState } from 'react'
import { Highlight } from '@/components/data-table'
import { SearchContext } from '@/components/data-table/highlight'
import { type Status, StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/states'
import { time } from '@/lib/format'
import type { DecisionEntry } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export type DecisionKind = DecisionEntry['kind']

export const KIND: Record<DecisionKind, { one: string; many: string; icon: ComponentType<{ className?: string }> }> = {
  gate: { one: 'Gate', many: 'Gates', icon: ShieldCheck },
  change: { one: 'Change request', many: 'Change requests', icon: GitPullRequestArrow },
  question: { one: 'Answered question', many: 'Questions', icon: MessageCircleQuestion },
  waiver: { one: 'Waiver', many: 'Waivers', icon: CircleMinus },
  decision: { one: 'Decision', many: 'Decisions', icon: Scale },
}

export const STATE: Record<NonNullable<DecisionEntry['state']>, { status: Status; label: string }> = {
  open: { status: 'waiting', label: 'Open' }, approved: { status: 'done', label: 'Approved' }, rejected: { status: 'failing', label: 'Rejected' },
  signed: { status: 'done', label: 'Signed' }, returned: { status: 'warning', label: 'Returned' }, answered: { status: 'done', label: 'Answered' },
  active: { status: 'waived', label: 'In force' }, closed: { status: 'done', label: 'Closed' },
}

/** The colour of a moment's marker: green when settled, amber when returned or against trace's advice, red when rejected. */
function tone(d: DecisionEntry): string {
  if (d.state === 'rejected') return 'border-destructive/40 bg-destructive/10 text-destructive'
  if (d.state === 'returned' || d.recommended === false) return 'border-warning/50 bg-warning/15 text-warning-foreground'
  if (d.state === 'open') return 'border-primary/40 bg-primary/10 text-primary'
  if (d.state === 'active') return 'border-border bg-muted text-muted-foreground'
  return 'border-verified/40 bg-verified/10 text-verified'
}

export interface TimelineGroup {
  key: string
  label: string
  items: DecisionEntry[]
}

/** Newest first, one group per day ("Today", "Yesterday", "Mon 2 Nov"), and the undated ones last. */
export function timelineGroups(rows: DecisionEntry[], now: number = Date.now()): TimelineGroup[] {
  const today = new Date(now).toDateString()
  const yesterday = new Date(now - 86400_000).toDateString()
  const thisYear = new Date(now).getFullYear()
  const dated = rows.filter((r) => !r.undated).sort((a, b) => b.at.localeCompare(a.at))
  const groups: TimelineGroup[] = []
  for (const r of dated) {
    const d = new Date(r.at)
    const key = d.toDateString()
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday'
        : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== thisYear ? { year: 'numeric' } : {}) })
      g = { key, label, items: [] }
      groups.push(g)
    }
    g.items.push(r)
  }
  const undated = rows.filter((r) => r.undated)
  if (undated.length) groups.push({ key: 'undated', label: 'In force, no date recorded', items: undated })
  return groups
}

/** Does a decision match the search words (title, choice, reason or who)? */
export function matches(d: DecisionEntry, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  return [d.title, d.choice, d.reason, d.by, KIND[d.kind].one].some((t) => t?.toLowerCase().includes(s))
}

export function DecisionTimeline({ rows, onOpen }: { rows: DecisionEntry[]; onOpen: (d: DecisionEntry) => void }) {
  const [kind, setKind] = useState<DecisionKind | 'all'>('all')
  const [q, setQ] = useState('')
  const counts = useMemo(() => {
    const c: Partial<Record<DecisionKind, number>> = {}
    for (const r of rows) c[r.kind] = (c[r.kind] ?? 0) + 1
    return c
  }, [rows])
  const shown = rows.filter((r) => (kind === 'all' || r.kind === kind) && matches(r, q))
  const groups = timelineGroups(shown)
  const kinds = (Object.keys(KIND) as DecisionKind[]).filter((k) => counts[k])

  return (
    <SearchContext.Provider value={q.trim()}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show only" className="-mx-4 flex max-w-[calc(100%+2rem)] gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Chip on={kind === 'all'} onClick={() => setKind('all')}>All <span className="text-muted-foreground">{rows.length}</span></Chip>
          {kinds.map((k) => (
            <Chip key={k} on={kind === k} onClick={() => setKind(kind === k ? 'all' : k)}>
              {KIND[k].many} <span className="text-muted-foreground">{counts[k]}</span>
            </Chip>
          ))}
        </div>
        <label className="relative ml-auto w-full sm:w-56">
          <span className="sr-only">Search decisions</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search decisions"
            className="h-8 w-full rounded-md border bg-background pl-8 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {q && (
            <button type="button" aria-label="Clear the search" onClick={() => setQ('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>

      {groups.length === 0 ? (
        <div className="mt-6"><EmptyState>No decisions match. Clear the search or choose All.</EmptyState></div>
      ) : (
        <div className="relative mt-5 space-y-5">
          {/* the line through time, behind every day and every moment */}
          <span aria-hidden className="absolute bottom-4 left-[15.5px] top-2 w-px bg-border" />
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h3 className="relative mb-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span aria-hidden className="flex w-8 shrink-0 justify-center"><span className="size-2 rounded-full bg-muted-foreground/50 ring-4 ring-background" /></span>
                <span>{g.label} <span className="font-normal normal-case tracking-normal">· {g.items.length === 1 ? '1 decision' : `${g.items.length} decisions`}</span></span>
              </h3>
              <ol>
                {g.items.map((d) => <Moment key={d.id} d={d} onOpen={onOpen} />)}
              </ol>
            </section>
          ))}
        </div>
      )}
    </SearchContext.Provider>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors', on ? 'border-foreground/20 bg-accent font-medium' : 'hover:bg-accent/60')}
    >
      {children}
    </button>
  )
}

/** One decision on the line. A gate is a milestone: a larger marker and a bolder title. */
function Moment({ d, onOpen }: { d: DecisionEntry; onOpen: (d: DecisionEntry) => void }) {
  const Icon = KIND[d.kind].icon
  const milestone = d.kind === 'gate'
  const state = d.state ? STATE[d.state] : undefined
  const body = (
    <>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {!d.undated && <time dateTime={d.at}>{time(d.at)}</time>}
        {!d.undated && <span aria-hidden>·</span>}
        <span>{KIND[d.kind].one}</span>
        {d.by && d.by !== '—' && <><span aria-hidden>·</span><span>{d.by}</span></>}
      </p>
      <p className={cn('mt-0.5 leading-snug', milestone ? 'text-[15px] font-semibold' : 'font-medium')}><Highlight text={d.title} /></p>
      {(d.choice || d.recommended !== undefined) && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
          {d.choice && <span><Highlight text={d.choice} /></span>}
          {d.recommended === true && <span className="rounded-full bg-verified/10 px-2 py-0.5 text-[11px] text-verified">trace recommended</span>}
          {d.recommended === false && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning-foreground">Not the recommendation</span>}
        </p>
      )}
      {d.reason && <p className="mt-1 text-sm text-muted-foreground">Reason: <Highlight text={d.reason} /></p>}
    </>
  )
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span aria-hidden className={cn('relative z-10 mt-0.5 shrink-0 rounded-full bg-background ring-4 ring-background', milestone ? 'size-8' : 'mx-0.5 size-7')}>
        <span className={cn('flex size-full items-center justify-center rounded-full border', tone(d))}>
          <Icon className={milestone ? 'size-4' : 'size-3.5'} />
        </span>
      </span>
      <div
        className={cn(
          'flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-2 -my-1',
          milestone && 'border bg-card',
          d.to && 'cursor-pointer hover:bg-accent/60 focus-within:bg-accent/60',
        )}
        {...(d.to ? { onClick: () => onOpen(d) } : {})}
      >
        <div className="min-w-0 flex-1">
          {d.to ? (
            <button type="button" className="block w-full text-left outline-none" onClick={(e) => { e.stopPropagation(); onOpen(d) }}>{body}</button>
          ) : body}
        </div>
        {state && <StatusBadge status={state.status} label={state.label} className="shrink-0" />}
      </div>
    </li>
  )
}
