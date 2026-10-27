/**
 * Small pieces the project tabs share: the verdict → status mapping, coverage from verify.coverage, a tab's loading
 * skeleton, and the honest "needs building" line for data no action provides yet.
 */
import { useQuery } from '@tanstack/react-query'
import { Construction } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { type Status } from '@/components/status-badge'
import { Loading } from '@/components/states'
import { ApiError, call } from '@/lib/api'
import { keys } from '@/lib/queries'
import type { CoverageResult, Verdict } from '@/lib/types-s1'

export const VERDICT: Record<Verdict, { status: Status; label: string }> = {
  verified: { status: 'verified', label: 'Verified' },
  failing: { status: 'failing', label: 'Failing' },
  waived: { status: 'waived', label: 'Waived' },
  untested: { status: 'untested', label: 'Untested' },
  no_test: { status: 'untested', label: 'No test yet' },
  partial: { status: 'warning', label: 'Partly tested' },
  coverage_gap: { status: 'warning', label: 'Coverage gap' },
}

/** The coverage matrix (verify.coverage, a read-only tool run through the `tool` action). */
export function useCoverage(repo: string) {
  return useQuery({
    queryKey: [...keys.action('tool', { repo, name: 'verify.coverage' }), 'coverage'],
    queryFn: async ({ signal }) => (await call('tool', { repo, name: 'verify.coverage', args: { code: false } }, { signal })) as CoverageResult,
    staleTime: 60_000,
  })
}

/** True when an action is simply not there yet (the backend answers "no …" or 404). */
export const notBuilt = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || /^mock: no fixture|unknown action|no action|not (yet )?built/i.test(e.message))

/** The design's own "What needs building" line, said on screen rather than faked. */
export function NeedsBuilding({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <Construction className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

export function TabSkeleton({ loading }: { loading: boolean }) {
  return (
    <Loading loading={loading}>
      <div className="mt-6 space-y-4">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </Loading>
  )
}

/** A tab's heading row: title, one-line summary, actions at the right. */
export function TabHeader({ title, summary, actions }: { title: string; summary?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mt-6 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="sr-only">{title}</h2>
        {summary && <p className="text-[15px]">{summary}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}
