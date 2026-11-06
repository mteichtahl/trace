/**
 * Evidence (/p/:id/evidence): the coverage matrix (each requirement's verdict and the tests behind it, from
 * verify.coverage) and every run (from `runs`), both as Data tables. A run opens its page; the waivers in force sit
 * under the matrix. Operations, filtered to this project, is one link away.
 */
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'
import type { ColumnDef } from '@tanstack/react-table'
import { z } from 'zod'
import { useTraceContext } from '@/components/chat/context'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { Section } from '@/components/shell/app-shell'
import { TabSkeleton, VERDICT, useCoverage } from '@/components/project/shared'
import { useCommands } from '@/components/shell/command-menu'
import { StatusBadge } from '@/components/status-badge'
import { WaiverRating } from '@/components/waiver-rating'
import { EmptyState, Partial, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { ago, duration } from '@/lib/format'
import { useAction, useJourney } from '@/lib/queries'
import type { CoverageRow } from '@/lib/types-s1'

export const Route = createFileRoute('/_app/p/$id/evidence')({
  staticData: { crumb: 'Evidence' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Evidence,
})

export interface RunRow {
  id: string
  kind: string
  subject: string | null
  started: number
  finished: number | null
  status: 'running' | 'pass' | 'fail' | 'error'
  summary: string | null
}

export const RUN_STATUS: Record<RunRow['status'], { status: 'running' | 'passed' | 'failing' | 'warning'; label: string }> = {
  running: { status: 'running', label: 'Running' }, pass: { status: 'passed', label: 'Passed' }, fail: { status: 'failing', label: 'Failed' }, error: { status: 'warning', label: 'Error' },
}

const coverageColumns: ColumnDef<CoverageRow, any>[] = [
  { accessorKey: 'id', header: 'Requirement', size: 120, meta: { label: 'Requirement', kind: 'text', mono: true } },
  { accessorKey: 'text', header: 'What it says', size: 300, meta: { label: 'What it says', kind: 'text' }, cell: ({ row }) => <Highlight text={row.original.text} /> },
  { id: 'verdict', accessorFn: (r) => VERDICT[r.verdict].label, header: 'Verdict', size: 140, meta: { label: 'Verdict', kind: 'enum' }, cell: ({ row }) => <StatusBadge status={VERDICT[row.original.verdict].status} label={VERDICT[row.original.verdict].label} /> },
  { id: 'methods', accessorFn: (r) => [...new Set(r.tests.map((t) => t.method))].join(', ') || '—', header: 'Method', size: 110, meta: { label: 'Method', kind: 'enum' } },
  { id: 'tests', accessorFn: (r) => r.tests.map((t) => t.id).join(', ') || 'none planned', header: 'Tests', size: 140, meta: { label: 'Tests', kind: 'text', mono: true } },
  { id: 'run', accessorFn: (r) => r.tests.find((t) => t.last_run)?.last_run ?? '—', header: 'Last run', size: 110, meta: { label: 'Last run', kind: 'text', mono: true } },
]

const runColumns: ColumnDef<RunRow, any>[] = [
  { accessorKey: 'summary', header: 'Run', size: 340, meta: { label: 'Run', kind: 'text' }, cell: ({ row }) => <Highlight text={row.original.summary ?? row.original.kind} /> },
  { accessorKey: 'kind', header: 'Tool', size: 150, meta: { label: 'Tool', kind: 'enum', mono: true } },
  { id: 'status', accessorFn: (r) => RUN_STATUS[r.status].label, header: 'Result', size: 110, meta: { label: 'Result', kind: 'enum' }, cell: ({ row }) => <StatusBadge status={RUN_STATUS[row.original.status].status} label={RUN_STATUS[row.original.status].label} /> },
  { id: 'started', accessorFn: (r) => new Date(r.started * 1000).toISOString(), header: 'Started', size: 120, meta: { label: 'Started', kind: 'date' }, cell: ({ row }) => ago(row.original.started * 1000) },
  { id: 'took', accessorFn: (r) => (r.finished ? r.finished - r.started : null), header: 'Took', size: 90, meta: { label: 'Took', kind: 'number', align: 'right' }, cell: ({ row }) => (row.original.finished ? duration(row.original.finished - row.original.started, { short: true }) : '…') },
  { accessorKey: 'id', header: 'Id', size: 110, meta: { label: 'Id', kind: 'text', mono: true } },
]

function Evidence() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const navigate = useNavigate()
  const cov = useCoverage(repo)
  const runs = useAction('runs', { repo, limit: 200 })
  const j = useJourney(repo)
  const covUrl = useUrlView('coverage')
  const runUrl = useUrlView('runs')
  const rows = (runs.data ?? []) as unknown as RunRow[]
  const s = cov.data?.summary ?? {}
  const open = (run: string) => void navigate({ to: '/p/$id/runs/$run', params: { id, run } })
  const openReq = (r: CoverageRow) => { const run = r.tests.find((t) => t.last_run)?.last_run; if (run) open(run); else void navigate({ to: '/p/$id/requirements/$rid', params: { id, rid: r.id } }) }
  const phone = useMediaQuery('(max-width: 767px)')

  useTraceContext({ label: 'Evidence', description: 'The project tab on screen', value: { tab: 'evidence', summary: s } }, 'screen')
  useCommands(rows.slice(0, 20).map((r) => ({ id: `run-${r.id}`, label: `Open run ${r.id}`, keywords: [r.kind, r.summary ?? ''], run: () => open(r.id) })))

  if (cov.isError && runs.isError) return <div className="mt-6"><QueryError error={cov.error} what="the evidence" onRetry={() => { void cov.refetch(); void runs.refetch() }} /></div>
  if (!cov.data && !runs.data) return <TabSkeleton loading={cov.isLoading || runs.isLoading} />

  return (
    <div className="pb-12">
      {cov.data && (
        <p className="mt-6 text-[15px]">
          <span className="font-semibold">{s.verified ?? 0} of {cov.data.requirements.length} requirements verified.</span>{' '}
          {s.failing ? `${s.failing} failing, ` : ''}{(s.untested ?? 0) + (s.no_test ?? 0)} untested, {s.waived ?? 0} waived.{' '}
          <Link to="/ops" search={{ repo } as never} className="text-primary hover:underline">This project in Operations</Link>
        </p>
      )}

      <Section label="Coverage" count={cov.data?.requirements.length} className="mt-8">
        {cov.isError ? (
          <Partial onRetry={() => void cov.refetch()}>The coverage matrix could not be loaded; the runs are below.</Partial>
        ) : !cov.data ? null : cov.data.requirements.length === 0 ? (
          <EmptyState>No requirements to cover yet. Coverage fills in once the requirements baseline is signed and tests are planned.</EmptyState>
        ) : (
          phone ? <CoverageList rows={cov.data.requirements} onOpen={openReq} /> : (
          <DataTable id="coverage" url={covUrl} data={cov.data.requirements} columns={coverageColumns} getRowId={(r) => r.id} noun="requirements" onRowClick={openReq} />
          )
        )}
      </Section>

      <Section label="Runs" count={runs.data ? rows.length : undefined}>
        {runs.isError ? (
          <Partial onRetry={() => void runs.refetch()}>The runs could not be loaded.</Partial>
        ) : !runs.data ? null : rows.length === 0 ? (
          <EmptyState>No runs yet. trace starts the first when the requirements baseline is signed.</EmptyState>
        ) : (
          phone ? <RunList rows={rows} onOpen={open} /> :
          <DataTable id="runs" url={runUrl} data={rows} columns={runColumns} getRowId={(r) => r.id} noun="runs" onRowClick={(r) => open(r.id)} defaultView={{ sorting: [{ id: 'started', desc: true }] }} />
        )}
      </Section>

      {j.data && j.data.waivers.length > 0 && (
        <Section label="Waivers in force" count={j.data.waivers.length}>
          <ul className="divide-y rounded-xl border">
            {j.data.waivers.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
                <span className="rounded border bg-muted px-1.5 font-mono text-xs">{w.id}</span>
                <span className="min-w-0 flex-1">{w.title}</span>
                <WaiverRating rating={w.risk} />
                <span className="text-xs text-muted-foreground">Caught: {w.caught}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

/** The quick filters on a phone, in place of the table's controls. */
export const COVERAGE_CHIPS = [
  { id: 'all', label: 'All', has: () => true },
  { id: 'failing', label: 'Failing', has: (r: CoverageRow) => r.verdict === 'failing' },
  { id: 'untested', label: 'Untested', has: (r: CoverageRow) => r.verdict === 'untested' || r.verdict === 'no_test' || r.verdict === 'partial' || r.verdict === 'coverage_gap' },
  { id: 'verified', label: 'Verified', has: (r: CoverageRow) => r.verdict === 'verified' },
  { id: 'waived', label: 'Waived', has: (r: CoverageRow) => r.verdict === 'waived' },
] as const

/** Coverage on a phone: one line per requirement (status pill, id, its words, chevron) under quick filter chips. */
export function CoverageList({ rows, onOpen }: { rows: CoverageRow[]; onOpen: (r: CoverageRow) => void }) {
  const [chip, setChip] = useState<(typeof COVERAGE_CHIPS)[number]['id']>('all')
  const has = COVERAGE_CHIPS.find((c) => c.id === chip)!.has
  const shown = rows.filter(has)
  return (
    <div>
      <div role="group" aria-label="Show" className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4 pb-1">
        {COVERAGE_CHIPS.map((c) => {
          const n = rows.filter(c.has).length
          return (
            <button key={c.id} type="button" aria-pressed={chip === c.id} onClick={() => setChip(c.id)}
              className={cn('h-9 shrink-0 rounded-full border px-3 text-sm', chip === c.id ? 'border-foreground bg-foreground text-background' : 'bg-card text-foreground active:bg-muted')}>
              {c.label} <span className={cn('ml-0.5 text-xs', chip === c.id ? 'opacity-80' : 'text-muted-foreground')}>{n}</span>
            </button>
          )
        })}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">No requirements are {COVERAGE_CHIPS.find((c) => c.id === chip)!.label.toLowerCase()}.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Requirements">
          {shown.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onOpen(r)} className="flex min-h-[52px] w-full items-center gap-2.5 px-3 py-2.5 text-left active:bg-muted">
                <StatusBadge status={VERDICT[r.verdict].status} label={VERDICT[r.verdict].label} className="shrink-0" />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.id}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{r.text}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const DOT: Record<RunRow['status'], string> = { running: 'bg-primary animate-pulse', pass: 'bg-verified', fail: 'bg-destructive', error: 'bg-warning' }

/** Runs on a phone: newest first, one line each with a status dot (and the word for screen readers). */
export function RunList({ rows, onOpen }: { rows: RunRow[]; onOpen: (id: string) => void }) {
  const sorted = [...rows].sort((a, b) => b.started - a.started)
  return (
    <ul className="divide-y rounded-xl border bg-card" aria-label="Runs">
      {sorted.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)} className="flex min-h-[52px] w-full items-center gap-3 px-3 py-2.5 text-left active:bg-muted">
            <span className={cn('size-2.5 shrink-0 rounded-full', DOT[r.status])} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{r.summary ?? r.kind}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {RUN_STATUS[r.status].label} · {ago(r.started * 1000)} · <span className="font-mono">{r.kind}</span>
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
}
