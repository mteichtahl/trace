/**
 * Decisions (/p/:id/decisions): gate records, change requests, answered questions, waivers and the decision log.
 * Shown as a timeline by default (newest first, grouped by day, gates as milestones; components/project/decision-
 * timeline), with the Data table one tap away for sorting and filtering by column; the choice is kept in this browser.
 * Each decision says who decided, what, whether it was trace's recommendation and, when it was not, the reason. A gate
 * opens its record (the receipt); the rest open where they live.
 *
 * Data: journey.get (gates, waivers; `decisions` is the assumed decisions log on the journey record).
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { z } from 'zod'
import { useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { DecisionTimeline, KIND as KINDS, STATE } from '@/components/project/decision-timeline'
import { TabSkeleton } from '@/components/project/shared'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { projectId, repoOf } from '@/lib/api'
import { ago } from '@/lib/format'
import { useJourney } from '@/lib/queries'
import type { DecisionEntry, JourneyMore } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/p/$id/decisions')({
  staticData: { crumb: 'Decisions' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Decisions,
})

const KIND = (k: DecisionEntry['kind']): string => KINDS[k].one

const columns: ColumnDef<DecisionEntry, any>[] = [
  { accessorKey: 'title', header: 'Decision', size: 340, meta: { label: 'Decision', kind: 'text' }, cell: ({ row }) => <span className="font-medium"><Highlight text={row.original.title} /></span> },
  { id: 'kind', accessorFn: (d) => KIND(d.kind), header: 'Kind', size: 150, meta: { label: 'Kind', kind: 'enum' } },
  {
    id: 'choice', accessorFn: (d) => d.choice ?? '', header: 'Choice', size: 240, meta: { label: 'Choice', kind: 'text' },
    cell: ({ row }) => {
      const d = row.original
      if (!d.choice && !d.reason) return <span className="text-muted-foreground">—</span>
      return (
        <span>
          {d.choice}
          {d.recommended !== undefined && <span className="ml-1.5 text-xs text-muted-foreground">{d.recommended ? '(trace recommended)' : '(not the recommendation)'}</span>}
          {d.reason && <span className="block text-xs text-muted-foreground">Reason: {d.reason}</span>}
        </span>
      )
    },
  },
  { accessorKey: 'by', header: 'Who', size: 150, meta: { label: 'Who', kind: 'enum' } },
  { id: 'state', accessorFn: (d) => (d.state ? STATE[d.state].label : ''), header: 'State', size: 120, meta: { label: 'State', kind: 'enum' }, cell: ({ row }) => (row.original.state ? <StatusBadge status={STATE[row.original.state].status} label={STATE[row.original.state].label} /> : null) },
  { id: 'at', accessorFn: (d) => d.at, header: 'When', size: 110, meta: { label: 'When', kind: 'date' }, cell: ({ row }) => (row.original.undated ? <span className="text-muted-foreground">No date</span> : ago(row.original.at)) },
]

/** Everything the record holds as decisions: the log, plus gate records and waivers the log may not repeat. */
export function decisionRows(j: JourneyMore): DecisionEntry[] {
  const out = [...(j.decisions ?? [])]
  const have = new Set(out.map((d) => d.title))
  for (const g of j.gates) {
    if (g.state !== 'signed' && g.state !== 'returned') continue
    const title = `${g.name.replace(/^the /, '').replace(/^./, (c) => c.toUpperCase())} ${g.state}`
    if (out.some((d) => d.kind === 'gate' && d.to?.endsWith(`/gates/${g.id}`)) || have.has(title)) continue
    out.push({ id: `gate-${g.id}`, kind: 'gate', title, by: g.signature?.by ?? 'An admin', at: g.signature?.at ?? new Date().toISOString(), state: g.state, to: `/p/${projectId(j.repo)}/gates/${g.id}`, ...(g.signature?.at ? {} : { undated: true }) })
  }
  for (const w of j.waivers) {
    if (out.some((d) => d.kind === 'waiver' && d.title.startsWith(w.id))) continue
    out.push({ id: `waiver-${w.id}`, kind: 'waiver', title: `${w.id}: ${w.title}`, by: '—', at: new Date().toISOString(), reason: w.reason, state: 'active', undated: true })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

type View = 'timeline' | 'table'
const VIEW_KEY = 'trace.decisions.view'

/** Timeline unless the person last chose the table (kept in this browser). */
function useView(): [View, (v: View) => void] {
  const [v, setV] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'timeline' } catch { return 'timeline' }
  })
  return [v, (next) => {
    setV(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* private window: remembered for this visit only */ }
  }]
}

function Decisions() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const navigate = useNavigate()
  const j = useJourney(repo)
  const url = useUrlView('decisions')
  const [view, setView] = useView()
  useTraceContext({ label: 'Decisions', description: 'The project tab on screen', value: { tab: 'decisions' } }, 'screen')
  if (j.isError) return <div className="mt-6"><QueryError error={j.error} what="the decisions" onRetry={() => void j.refetch()} /></div>
  if (!j.data) return <TabSkeleton loading={j.isLoading} />
  const rows = decisionRows(j.data as JourneyMore)
  const against = rows.filter((r) => r.recommended === false).length
  const open = (d: DecisionEntry) => d.to && void navigate({ to: d.to })
  return (
    <div className="pb-12">
      <div className="mt-6 flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-[15px]">
          <span className="font-semibold">{rows.length === 1 ? '1 decision' : `${rows.length} decisions`} in the record.</span>{' '}
          {rows.filter((r) => r.kind === 'gate').length} gate records; {against ? `${against} went against trace's recommendation, each with its reason.` : "every choice followed trace's recommendation."}
        </p>
        {rows.length > 0 && (
          <div role="group" aria-label="How to show the decisions" className="flex shrink-0 overflow-hidden rounded-md border text-xs">
            {(['timeline', 'table'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={cn('px-2.5 py-1', v === 'table' && 'border-l', view === v ? 'bg-accent font-medium' : 'hover:bg-accent/60')}>
                {v === 'timeline' ? 'Timeline' : 'Table'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState>No decisions yet. Gate records, answered questions, waivers and change requests collect here.</EmptyState>
        ) : view === 'timeline' ? (
          <DecisionTimeline rows={rows} onOpen={open} />
        ) : (
          <DataTable id="decisions" url={url} data={rows} columns={columns} getRowId={(r) => r.id} noun="decisions" onRowClick={open} defaultView={{ sorting: [{ id: 'at', desc: true }] }} />
        )}
      </div>
    </div>
  )
}
