/**
 * A criterion's evidence, opened in place so the signer keeps their place (docs/ui-design.md, "Gates and signing"):
 * the run behind it (its verdict, its table, plots and findings) or the record it names. The gate records that it was
 * opened (journey.criterion.open); the row's "Opened" tick can come no other way.
 */
import { Link } from '@tanstack/react-router'
import { ExternalLink, X } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/data-table'
import { StatusBadge } from '@/components/status-badge'
import { Loading, QueryError } from '@/components/states'
import { Skeleton } from '@/components/ui/skeleton'
import { projectId } from '@/lib/api'
import { time } from '@/lib/format'
import { useAction } from '@/lib/queries'
import type { Criterion } from '@/lib/types'
import type { RunRecordView } from '@/lib/types-s1'
import { FindingsList } from './findings'

const PlotCard = lazy(() => import('@/components/chat/cards').then((m) => ({ default: m.PlotCard })))

export function EvidenceBody({ repo, criterion, opened }: { repo: string; criterion: Criterion; opened: boolean }) {
  const ev = criterion.evidence
  const isRun = ev?.kind === 'run' && !!ev.id
  const run = useAction('run', { repo, id: ev?.id ?? '' }, { enabled: isRun })
  const r = run.data as RunRecordView | undefined
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {opened && <StatusBadge status="opened" />}
        <StatusBadge status={criterion.status === 'met' ? 'met' : criterion.status === 'waived' ? 'waived' : 'not_met'} />
      </div>
      {!isRun && <p>{ev?.summary ?? 'This criterion is checked against the project record.'}</p>}
      {isRun && run.isError && <QueryError error={run.error} what="the run" onRetry={() => void run.refetch()} />}
      {isRun && !r && (
        <Loading loading={run.isLoading}>
          <div className="space-y-2"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-40" /></div>
        </Loading>
      )}
      {r && (
        <>
          <p>{r.summary ?? ev?.summary}</p>
          {r.table && (
            <>
              <DataTable
                id={`evidence-${r.id}`}
                persist={false}
                data={r.table.rows}
                noun="rows"
                maxHeight="40vh"
                columns={r.table.columns.map((c) => ({ accessorKey: c.id, header: c.label, size: c.mono ? 150 : 90, meta: { label: c.label, mono: c.mono, align: c.align, kind: 'text' as const } }))}
              />
              {r.table.note && <p className="text-xs text-muted-foreground">{r.table.note}</p>}
            </>
          )}
          {r.plots?.map((p) => (
            <Suspense key={p.title} fallback={<Skeleton className="h-52" />}>
              <PlotCard data={p} />
            </Suspense>
          ))}
          {r.findings && r.findings.length > 0 && <FindingsList findings={r.findings} />}
          <p className="text-xs text-muted-foreground">
            Ran {time(r.started * 1000)}
            {r.git_sha ? ` on push ${r.git_sha}` : ''}.{' '}
            <Link to="/p/$id/runs/$run" params={{ id: projectId(repo), run: r.id }} className="inline-flex items-center gap-1 text-primary hover:underline">
              Open the run <ExternalLink className="size-3" />
            </Link>
          </p>
        </>
      )}
    </div>
  )
}

/** The docked form (wide screens): a column beside the gate, with its own close. */
export function EvidencePanel({ repo, criterion, opened, onClose }: { repo: string; criterion: Criterion; opened: boolean; onClose: () => void }) {
  const ev = criterion.evidence
  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-background" aria-label="Evidence">
      <div className="flex items-start gap-2 border-b px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            {ev?.kind === 'run' ? 'Run' : 'Record'} · <span className="font-mono">{ev?.label}</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Criterion: {criterion.text}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close the evidence">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <EvidenceBody repo={repo} criterion={criterion} opened={opened} />
      </div>
    </aside>
  )
}
