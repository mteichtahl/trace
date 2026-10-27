/**
 * Requirements (/p/:id/requirements): the traceability view in its Canvas frame (intent → requirement → evidence,
 * failing chains coloured back to the intent; filter to one status), then the requirements as a Data table. A
 * requirement opens in a side sheet at its own address (/p/:id/requirements/:rid, the child route).
 *
 * Data: verify.coverage through the `tool` action (requirements, verdicts, tests); the intent lines (each accepted by
 * a person or still proposed by an agent) and each requirement's derived_from link come from requirements.trace.
 * While no intent statement is recorded it answers `intent_note`, and the view draws requirements and evidence only.
 */
import { Link, Outlet, createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTraceContext } from '@/components/chat/context'
import { openPanel } from '@/components/chat/chat-state'
import { CanvasFrame } from '@/components/canvas/canvas-frame'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { NeedsBuilding, TabSkeleton, VERDICT, notBuilt, useCoverage } from '@/components/project/shared'
import { TRACE_WIDTH, type TraceNode, Traceability } from '@/components/project/traceability'
import { useCommands } from '@/components/shell/command-menu'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, Partial, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAction } from '@/lib/queries'
import type { CoverageRow, TraceView, Verdict } from '@/lib/types-s1'

export const Route = createFileRoute('/_app/p/$id/requirements')({
  staticData: { crumb: 'Requirements' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: Requirements,
})

const FILTERS: { id: 'all' | Verdict; label: string }[] = [
  { id: 'all', label: 'Every status' },
  { id: 'failing', label: 'Failing' },
  { id: 'verified', label: 'Verified' },
  { id: 'untested', label: 'Untested' },
  { id: 'waived', label: 'Waived' },
]

const columns: ColumnDef<CoverageRow, any>[] = [
  { accessorKey: 'id', header: 'Requirement', size: 120, meta: { label: 'Requirement', kind: 'text', mono: true } },
  { accessorKey: 'text', header: 'What it says', size: 320, meta: { label: 'What it says', kind: 'text' }, cell: ({ row }) => <Highlight text={row.original.text} /> },
  { accessorKey: 'acceptance', header: 'Criterion', size: 240, meta: { label: 'Criterion', kind: 'text' } },
  { accessorKey: 'kind', header: 'Kind', size: 110, meta: { label: 'Kind', kind: 'enum' } },
  {
    id: 'verdict', accessorFn: (r) => VERDICT[r.verdict].label, header: 'Status', size: 140, meta: { label: 'Status', kind: 'enum' },
    cell: ({ row }) => <StatusBadge status={VERDICT[row.original.verdict].status} label={VERDICT[row.original.verdict].label} />,
  },
  { id: 'tests', accessorFn: (r) => r.tests.map((t) => t.id).join(', '), header: 'Tests', size: 130, meta: { label: 'Tests', kind: 'text', mono: true } },
]

function Requirements() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const navigate = useNavigate()
  const cov = useCoverage(repo)
  const trace = useAction('requirements.trace', { repo })
  const [status, setStatus] = useState<'all' | Verdict>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const url = useUrlView('requirements')
  const rows = cov.data?.requirements ?? []
  const s = cov.data?.summary ?? {}
  const filter = useMemo(() => (status === 'all' ? undefined : (r: CoverageRow) => (status === 'untested' ? r.verdict === 'untested' || r.verdict === 'no_test' : r.verdict === status)), [status])
  const failing = rows.filter((r) => r.verdict === 'failing')
  const open = (rid: string) => void navigate({ to: '/p/$id/requirements/$rid', params: { id, rid } })

  const onSelect = (n: TraceNode) => {
    setSelected(n.kind === 'evidence' ? `ev:${n.id}` : n.id)
    if (n.kind === 'requirement') open(n.id)
    if (n.kind === 'evidence') {
      const run = rows.find((r) => r.id === n.id)?.tests[0]?.last_run
      if (run) void navigate({ to: '/p/$id/runs/$run', params: { id, run } })
      else open(n.id)
    }
  }

  useTraceContext({ label: 'Requirements', description: 'The project tab on screen', value: { tab: 'requirements', filter: status, failing: failing.map((r) => r.id) } }, 'screen')
  useCommands([
    { id: 'req-failing', label: 'Show failing requirements', run: () => setStatus('failing') },
    ...rows.slice(0, 30).map((r) => ({ id: `req-${r.id}`, label: `Open ${r.id}`, keywords: [r.text], run: () => open(r.id) })),
  ])

  if (cov.isError) return <div className="mt-6"><QueryError error={cov.error} what="the requirements" onRetry={() => void cov.refetch()} /></div>
  if (!cov.data) return <TabSkeleton loading={cov.isLoading} />

  return (
    <div className="pb-12">
      <p className="mt-6 text-[15px]">
        <span className="font-semibold">{rows.length} requirements.</span>{' '}
        {failing.length ? <>{failing.length} failing: <span className="font-medium">{failing.map((r) => r.id).join(', ')}</span>, which puts the intent line behind {failing.length > 1 ? 'them' : 'it'} at risk. </> : 'Nothing is failing. '}
        {(s.verified ?? 0)} verified, {(s.untested ?? 0) + (s.no_test ?? 0)} untested, {s.waived ?? 0} waived.
      </p>

      {rows.length === 0 ? (
        <EmptyState className="mt-6" action={<Button asChild><Link to="/p/$id/do/$skill" params={{ id, skill: 'intent-builder' }}>Open the Intent builder</Link></Button>}>
          No requirements yet. They come from the intent: once it is written, trace drafts candidates for Requirements review.
        </EmptyState>
      ) : (
        <>
          <CanvasFrame
            className="mt-4"
            title="Traceability"
            subtitle={`intent → requirement → evidence${status !== 'all' ? ` · ${FILTERS.find((f) => f.id === status)?.label.toLowerCase()} only` : ''}`}
            height={Math.min(600, 120 + (filter ? rows.filter(filter).length : rows.length) * 70)}
            onAsk={() => openPanel(true)}
            filter={
              <RadioGroup value={status} onValueChange={(v) => setStatus(v as typeof status)} aria-label="Show">
                {FILTERS.map((f) => (
                  <Label key={f.id} className="flex items-center gap-2 font-normal">
                    <RadioGroupItem value={f.id} /> {f.label}
                  </Label>
                ))}
              </RadioGroup>
            }
          >
            <div className="origin-top scale-[0.62] sm:scale-90 lg:scale-100" style={{ width: TRACE_WIDTH }}>
              <Traceability rows={rows} trace={trace.data} filter={filter} selected={selected} onSelect={onSelect} />
            </div>
          </CanvasFrame>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <StatusBadge plain status="failing" label="Failing: its whole chain is red" />
            <span>Dashed: no test planned yet</span>
            <span>Drag to pan; Ctrl and scroll to zoom</span>
          </div>
          {trace.data && !trace.data.intent.length && trace.data.intent_note && <div className="mt-3"><NeedsBuilding>{trace.data.intent_note}</NeedsBuilding></div>}
          {trace.data && trace.data.intent.length > 0 && <IntentLine trace={trace.data} id={id} />}
          {trace.isError && (notBuilt(trace.error) ? (
            <div className="mt-3"><NeedsBuilding>The intent column needs the planned link from each requirement to its intent line (requirements.trace); until then the view shows requirements and their evidence.</NeedsBuilding></div>
          ) : (
            <div className="mt-3"><Partial onRetry={() => void trace.refetch()}>The intent lines could not be loaded; requirements and evidence are shown.</Partial></div>
          ))}

          <div className="mt-8">
            <DataTable id="requirements" url={url} data={rows} columns={columns} getRowId={(r) => r.id} noun="requirements" onRowClick={(r) => open(r.id)} />
          </div>
        </>
      )}
      <Outlet />
    </div>
  )
}

/** One line under the view: how much of the intent a person accepted, what no requirement covers, what is unlinked. */
function IntentLine({ trace, id }: { trace: TraceView; id: string }) {
  const s = trace.summary
  const proposed = trace.intent.filter((i) => i.state === 'proposed').length
  const uncovered = trace.intent.filter((i) => !i.covered && i.uncovered === undefined)
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span>{trace.intent.length} intent lines{proposed ? `, ${proposed} still proposed by trace` : ', all accepted'}.</span>
      {uncovered.length > 0 && <StatusBadge status="warning" label={`${uncovered.length} not covered by a requirement`} />}
      {(s?.unlinked ?? 0) > 0 && <StatusBadge status="warning" label={`${s!.unlinked} requirements not linked to an intent line`} />}
      {(proposed > 0 || uncovered.length > 0) && (
        <Link className="text-primary hover:underline" to="/p/$id/do/$skill" params={{ id, skill: proposed > 0 ? 'intent-builder' : 'requirements-review' }}>
          {proposed > 0 ? 'Review the intent' : 'Cover the intent'}
        </Link>
      )}
    </p>
  )
}
