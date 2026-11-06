/**
 * A change's checks, saying which step each is on (docs/progress-and-logs.md, "2."). The jobs come from change.runs
 * (GitHub's jobs API, live): a running one shows step n of m in plain words, a progress bar when the size is known
 * (else its time so far and the usual), how recently it spoke (Heartbeat) and its newest line, and Watch (the
 * RunSheet). One still waiting for a build machine says so and how long that usually takes. A finished one keeps its
 * log one tap away. Checks change.runs has no job for (commit statuses, other apps' checks) keep their line from
 * change.get as before.
 */
import { CircleCheck, CircleDashed, CircleMinus, CircleX, Clock, Loader2, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { checksHeading } from '@/lib/guided'
import { duration } from '@/lib/format'
import type { ChangeCheck, ChangeDetail, CheckJob } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Heartbeat } from '../heartbeat'
import { timeAgainstUsual } from '../log-view'
import { RunSheet } from '../run-sheet'
import { CheckRow } from './check-sheet'
import { useNow } from '../use-now'

const CHECK_ICON: Record<ChangeCheck['state'], { icon: typeof CircleCheck; cls: string; word: string }> = {
  passed: { icon: CircleCheck, cls: 'text-verified', word: 'passed' },
  failed: { icon: CircleX, cls: 'text-destructive', word: 'failed' },
  running: { icon: Loader2, cls: 'animate-spin text-muted-foreground', word: 'running' },
  skipped: { icon: CircleMinus, cls: 'text-waived', word: 'skipped' },
}

const norm = (s: string) => s.trim().toLowerCase()

/** The checks change.get lists that no job of change.runs stands for (GitHub names a job's check run after the job). Pure. */
export function checksWithoutJob(list: readonly ChangeCheck[], jobs: readonly CheckJob[]): ChangeCheck[] {
  const names = new Set(jobs.flatMap((j) => [norm(j.name), norm(`${j.workflow} / ${j.name}`)]))
  return list.filter((k) => !names.has(norm(k.name)))
}

/** The job change.runs has for one of change.get's checks, if any. Pure. */
export function jobFor(k: Pick<ChangeCheck, 'name'> | undefined, jobs: readonly CheckJob[] | undefined): CheckJob | undefined {
  if (!k || !jobs) return undefined
  const n = norm(k.name)
  return jobs.find((j) => norm(j.name) === n || norm(`${j.workflow} / ${j.name}`) === n)
}

/** "2 running · 1 waiting for a build machine · 1 passed". Pure. */
export function jobsWords(jobs: readonly CheckJob[]): string {
  const n = (s: CheckJob['state'][]) => jobs.filter((j) => s.includes(j.state)).length
  const parts: string[] = []
  const run = n(['running'])
  const q = n(['queued'])
  const failed = n(['failed', 'cancelled'])
  const passed = n(['passed'])
  if (run) parts.push(`${run} running`)
  if (q) parts.push(`${q} waiting for a build machine`)
  if (failed) parts.push(`${failed} failed`)
  if (passed) parts.push(`${passed} passed`)
  return parts.join(' · ') || 'No checks yet'
}

/** The step in plain words, from the job's step name ("Checking the routed board…"). */
const stepText = (j: CheckJob): string | null => j.step ?? null

function Progress({ j, now }: { j: CheckJob; now: number }) {
  const t = timeAgainstUsual(j.startedAt, j.typicalS, now)
  const known = j.stepIndex && j.stepCount ? (j.stepIndex - 1) / j.stepCount : j.typicalS && j.startedAt ? Math.min(0.95, (now - Date.parse(j.startedAt)) / 1000 / j.typicalS) : null
  if (known === null) return t ? <p className="mt-1.5 text-xs text-muted-foreground">{t}</p> : null
  return (
    <div className="mt-2 flex items-center gap-3">
      <div className="h-1 max-w-[320px] flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${j.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(known * 100)}>
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(2, Math.round(known * 100))}%` }} />
      </div>
      {t && <span className="shrink-0 text-xs text-muted-foreground">{t}</span>}
    </div>
  )
}

function JobRow({ j, now, onWatch, onOpen }: { j: CheckJob; now: number; onWatch: (j: CheckJob) => void; onOpen?: (() => void) | undefined }) {
  if (j.state === 'queued') {
    const waited = j.queuedS
    return (
      <li className="flex items-start gap-3 py-3">
        <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm"><span className="font-medium">{j.name}</span><span className="text-muted-foreground"> · waiting for a build machine</span></p>
          <p className="mt-0.5 text-xs text-muted-foreground">Starts when one is free. Usually under a minute{waited !== null ? `; waiting ${duration(waited, { short: true })}` : ''}.</p>
        </div>
      </li>
    )
  }
  if (j.state === 'running') {
    const text = stepText(j)
    return (
      <li className="flex items-start gap-3 py-3">
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{j.name}</span>
            {j.stepIndex && j.stepCount ? <span className="rounded-full border border-primary/30 bg-primary-soft px-2 py-px text-xs text-primary">Step {j.stepIndex} of {j.stepCount}</span> : null}
          </p>
          {text && <p className="mt-0.5 text-sm">{text}</p>}
          <Progress j={j} now={now} />
          {(j.heardAt || j.newest) && (
            <p className="mt-1.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Heartbeat beat={{ heardAt: j.heardAt, usualQuietS: j.usualQuietS, startedAt: j.startedAt }} words={(_st, said) => said.charAt(0).toUpperCase() + said.slice(1)} className="shrink-0" />
              {j.newest && <span className="min-w-0 truncate font-mono">· {j.newest}</span>}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => onWatch(j)} aria-label={`Watch ${j.name}`}>
          <SquareTerminal /> Watch
        </Button>
      </li>
    )
  }
  const I = j.state === 'passed' ? CHECK_ICON.passed : j.state === 'skipped' ? CHECK_ICON.skipped : CHECK_ICON.failed
  const took = j.startedAt && j.completedAt ? (Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 1000 : null
  const word = j.state === 'cancelled' ? 'cancelled' : I.word
  return (
    <li className="flex items-center gap-3 py-3">
      <I.icon className={cn('size-4 shrink-0', I.cls)} aria-hidden />
      <p className="min-w-0 flex-1 text-sm"><span className="font-medium">{j.name}</span><span className="text-muted-foreground"> · {word}{took !== null && j.state !== 'skipped' ? ` in ${duration(took, { short: true })}` : ''}</span></p>
      {/* a finished check opens its result (report, findings, log: CheckSheet) where the page has it, else its log */}
      {j.state !== 'skipped' && <Button variant="ghost" size="sm" onClick={() => (onOpen ? onOpen() : onWatch(j))} aria-label={`${onOpen ? 'Result' : 'Log'} of ${j.name}`}>{onOpen ? 'Result' : 'Log'}</Button>}
    </li>
  )
}

/** The Checks card: change.runs's jobs when there are any, then the checks with no job, as before. */
export function ChangeChecks({ d, jobs, repo, onOpenCheck }: { d: ChangeDetail; jobs: CheckJob[] | undefined; repo: string; onOpenCheck?: (index: number) => void }) {
  const [all, setAll] = useState(false)
  const [watch, setWatch] = useState<CheckJob | null>(null)
  const now = useNow(1000)
  const withJobs = !!jobs?.length
  // the newest attempt's own copy of a job, while the API might list one twice
  const live = watch ? (jobs?.find((j) => j.id === watch.id) ?? watch) : null
  const list = withJobs ? checksWithoutJob(d.checks_list, jobs) : d.checks_list
  const shown = all || withJobs ? list : list.slice(0, 3)
  const rest = list.length - shown.length
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="checks">
      <h3 id="checks" className="section-label">Checks · <span className="font-normal normal-case tracking-normal">{withJobs ? jobsWords(jobs) : checksHeading(d)}</span></h3>
      {withJobs && (
        <ul className="mt-1 divide-y">
          {jobs.map((j) => {
            const i = d.checks_list.findIndex((k) => jobFor(k, [j]) !== undefined)
            return <JobRow key={j.id} j={j} now={now} onWatch={setWatch} onOpen={onOpenCheck && i >= 0 ? () => onOpenCheck(i) : undefined} />
          })}
        </ul>
      )}
      {list.length === 0 && !withJobs ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><CircleDashed className="size-4" aria-hidden />{d.checks === null ? 'trace could not read the checks.' : 'No checks have run yet.'}</p>
      ) : list.length > 0 && (
        <ul className={cn('space-y-1.5 text-sm', withJobs ? 'mt-1 border-t pt-3' : 'mt-2')}>
          {shown.map((k) => {
            const I = CHECK_ICON[k.state]
            const i = d.checks_list.indexOf(k)
            if (onOpenCheck && i >= 0) return <li key={k.name} className="-mx-2"><CheckRow check={k} onOpen={() => onOpenCheck(i)} /></li>
            return (
              <li key={k.name} className="flex items-start gap-2">
                <I.icon className={cn('mt-0.5 size-4 shrink-0', I.cls)} aria-hidden />
                <span>{k.name}{k.summary && <span className="text-muted-foreground">: {k.summary}</span>}<span className="sr-only"> ({I.word})</span></span>
              </li>
            )
          })}
          {rest > 0 && (
            <li>
              <button type="button" onClick={() => setAll(true)} className="flex items-center gap-2 text-sm">
                <CircleCheck className={cn('size-4', list.slice(3).every((k) => k.state === 'passed') ? 'text-verified' : 'text-muted-foreground')} aria-hidden />
                {rest} more {rest === 1 ? 'check' : 'checks'} <span className="text-primary">show</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {live && (
        <RunSheet
          repo={repo} run={live.run} title={live.name} open onOpenChange={(o) => !o && setWatch(null)}
          facts={{ check: live, finished: !['queued', 'running'].includes(live.state) }}
        />
      )}
    </section>
  )
}
