/**
 * Spend by job (cost.get jobs and warning, admins): what each job cost, grouped by the stage it ran in, with work done
 * again (sent back, redone, duplicated) and jobs that ended without finishing marked, so the spend a person can cut is
 * plain to see; and the warning before a stage overruns its share of the budget, with its biggest jobs. Run 2 of the
 * test-esp32 project spent most of US$100 on reworks, duplicate jobs and repeated docs runs before any board, and
 * nothing showed it (issue log #72, #100, #113). The words are pure functions, tested on their own.
 */
import { Link } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'
import { StatusBadge, type Status } from '@/components/status-badge'
import { duration, money, plural } from '@/lib/format'
import type { JobSpendView, SpendByJobView, SpendWarning } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const OUTCOME: Partial<Record<JobSpendView['outcome'], { status: Status; label: string }>> = {
  failed: { status: 'failing', label: 'Failed' },
  cancelled: { status: 'waived', label: 'Cancelled' },
  lost: { status: 'stuck', label: 'Lost' },
  running: { status: 'running', label: 'Running' },
  paused: { status: 'paused', label: 'Paused' },
  queued: { status: 'queued', label: 'Queued' },
}
const REPEAT_LABEL: Record<NonNullable<JobSpendView['repeat']>['kind'], string> = { sent_back: 'Sent back', redone: 'Redone', duplicate: 'Duplicate' }

/** The section's opening line: the total, and how much of it was done again or lost. */
export function spendSummary(s: SpendByJobView, currency: string): string {
  const jobs = s.jobs.filter((j) => j.id !== null).length
  const parts = [`${money(s.total, currency)} of cloud use across ${plural(jobs, 'job')}.`]
  if (s.repeated > 0) parts.push(`${money(s.repeated, currency)} of it was work done again (sent back, redone or asked twice).`)
  if (s.wasted > 0) parts.push(`${money(s.wasted, currency)} went on jobs that failed, were cancelled or were lost.`)
  return parts.join(' ')
}

/** A job's line under its request: who did it, for how long, and its workers. */
export function jobMeta(j: JobSpendView): string {
  return [
    j.specialist ?? (j.id ? 'An agent' : null),
    j.seconds !== null ? `ran ${duration(j.seconds, { short: true })}` : null,
    j.workers ? `with ${plural(j.workers, 'worker job')}` : null,
  ].filter(Boolean).join(' · ')
}

/** The warning in words: where the stage is against its share, and why the share is what it is. */
export function warningText(w: SpendWarning, currency: string): { title: string; body: string } {
  const m = (n: number) => money(n, currency)
  if (w.left <= 0) {
    return {
      title: 'The budget has nothing left for cloud work',
      body: `What is spent, committed and forecast for the build already takes the whole budget (${m(-w.left)} over when ${w.stage} started). ${w.stage} has used ${m(w.spent)} so far. Raise the budget in Settings, or cut work done again.`,
    }
  }
  if (w.level === 'spent') {
    return {
      title: `${w.stage} has used all the budget left for cloud work`,
      body: `${m(w.spent)} so far, of ${m(w.left)} left for cloud work when it started, for it and the ${plural(w.stagesLeft - 1, 'stage')} after it. Raise the budget in Settings, or cut work done again.`,
    }
  }
  const share = `about ${m(w.share)} a stage: ${m(w.left)} was left for cloud work when it started, after the build's forecast, split across it and the ${plural(w.stagesLeft - 1, 'stage')} after it`
  return w.level === 'over'
    ? { title: `${w.stage} is past its share of the budget`, body: `${m(w.spent)} of cloud work so far, of ${share}.` }
    : { title: `${w.stage} is near its share of the budget`, body: `${m(w.spent)} of cloud work so far, of ${share}.` }
}

/** The warning card (Overview, Cost and time): the words, and the stage's biggest jobs. */
export function SpendWarningCard({ warning, currency, id, link = true, className }: { warning: SpendWarning; currency: string; id: string; link?: boolean; className?: string }) {
  const t = warningText(warning, currency)
  return (
    <div role="status" className={cn('rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm', className)}>
      <p className="flex items-start gap-2 font-semibold"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />{t.title}</p>
      <p className="mt-1 pl-6">{t.body}</p>
      {warning.top.length > 0 && (
        <div className="mt-2 pl-6">
          <p className="text-xs text-muted-foreground">Biggest jobs in {warning.stage}</p>
          <ul className="mt-1 space-y-1">
            {warning.top.map((j) => (
              <li key={j.id ?? 'none'} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{j.title}<span className="text-muted-foreground">{j.specialist ? ` · ${j.specialist}` : ''}{j.repeat ? ` · ${REPEAT_LABEL[j.repeat.kind]}` : ''}</span></span>
                <span className="shrink-0 font-medium tabular-nums">{money(j.amount, currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {link && (
        <div className="mt-3 flex flex-wrap gap-4 pl-6">
          <Link to="/p/$id/cost" params={{ id }} className="text-primary hover:underline">See what each job cost</Link>
          <Link to="/p/$id/settings" params={{ id }} className="text-primary hover:underline">Budget in Settings</Link>
        </div>
      )}
    </div>
  )
}

function JobLine({ j, currency }: { j: JobSpendView; currency: string }) {
  const outcome = OUTCOME[j.outcome]
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm">{j.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{jobMeta(j)}</span>
          {j.repeat && <StatusBadge status="warning" label={REPEAT_LABEL[j.repeat.kind]} className="text-[11px]" />}
          {outcome && <StatusBadge status={outcome.status} label={outcome.label} className="text-[11px]" />}
        </div>
        {j.repeat && <p className="mt-1 text-xs text-muted-foreground">{j.repeat.text}</p>}
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums">{money(j.amount, currency)}</span>
    </li>
  )
}

/** The jobs by stage, in the journey's order, newest job first in each; the spend no job claims at the end. */
export function SpendByJob({ spend, currency }: { spend: SpendByJobView; currency: string }) {
  const loose = spend.jobs.filter((j) => j.stageId === null)
  return (
    <div className="space-y-4">
      <p className="text-sm">{spendSummary(spend, currency)}</p>
      {spend.stages.map((s) => {
        const jobs = spend.jobs.filter((j) => j.stageId === s.id && j.id !== null)
        return (
          <section key={s.id} aria-label={`${s.stage}: ${money(s.amount, currency)}`} className="overflow-hidden rounded-xl border">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
              <h3 className="text-sm font-semibold">{s.stage}</h3>
              <p className="text-xs text-muted-foreground">
                {plural(s.jobs, 'job')}
                {s.repeated > 0 ? ` · ${money(s.repeated, currency)} done again` : ''}
                {s.wasted > 0 ? ` · ${money(s.wasted, currency)} lost` : ''}
                <span className="ml-2 text-sm font-semibold text-foreground tabular-nums">{money(s.amount, currency)}</span>
              </p>
            </header>
            {jobs.length > 0
              ? <ul className="divide-y">{jobs.map((j) => <JobLine key={j.id} j={j} currency={currency} />)}</ul>
              : <p className="px-4 py-3 text-xs text-muted-foreground">Graphics card, CPU and tools function jobs no job claims, by when they ran.</p>}
          </section>
        )
      })}
      {loose.length > 0 && (
        <section aria-label="Not tied to a job" className="overflow-hidden rounded-xl border">
          <ul className="divide-y">{loose.map((j) => <JobLine key="none" j={{ ...j, specialist: 'Graphics card, CPU and tools function jobs no job claims' }} currency={currency} />)}</ul>
        </section>
      )}
    </div>
  )
}
