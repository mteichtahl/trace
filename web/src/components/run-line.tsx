/**
 * Long work, in one line: a spinner, the run's name in plain words, the current step, then a thin progress bar when
 * the size is known, otherwise elapsed and typical time ("12 min so far, usually 20"); where it runs, quietly. A menu
 * holds Pause, Resume, Move up and Cancel, each only when the job's view says job.control can do it (`run.controls`):
 * Pause stops a running job at its next safe point and keeps its work (a queued one is held); Resume carries a paused
 * job on from its branch (a held one is released); Move up takes it one place up its queue. Cancel asks once, then
 * says what was kept. Every control says what happened in a toast; what changes next arrives as a live event.
 *
 * A running job's view says when trace last heard from it (`heard`). A job whose runtime stops sends no event, so the
 * line reads that against the clock rather than trusting the screen's last look: past the overdue time it says plainly
 * that trace has not heard from it and when it will be declared lost, and past that time it shows as lost
 * (runState), the same as the Agents page and the job index say once they look again. A job waiting on a person's
 * answer (`waiting`, askingOf) says so and whose, with Answer it, rather than "still running" (#197).
 *
 * A finished job its specialist declined as another's work (`declined`, test log R26) is not shown done: it says so,
 * and offers Send it to <specialist> (DeclinedJobActions) until someone has.
 */
import { Circle, CircleAlert, CircleHelp, Loader2, MoreHorizontal, PauseCircle, CircleX, CircleCheck, SquareTerminal } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { about, duration, time } from '@/lib/format'
import type { Question, RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { DeclinedJobActions } from './declined-job'
import { timeAgainstUsual } from './log-view'
import { useNow } from './use-now'

export interface RunLineProps {
  run: RunSummary
  /** bold prefix ("Panel controller:") on Home, where runs from several projects mix */
  project?: string
  /** resolves to what happens next ("It stops before its next step…"), for the toast */
  onPause?: (run: RunSummary) => Promise<string | void> | string | void
  onResume?: (run: RunSummary) => Promise<string | void> | string | void
  /** resolves to what was kept ("Stage 1 kept: 48 nets routed and locked") */
  onCancel?: (run: RunSummary) => Promise<string | void> | string | void
  onMoveUp?: (run: RunSummary) => Promise<string | void> | string | void
  onOpen?: (run: RunSummary) => void
  /** Watch: open the run's log (RunSheet, run `job:<id>`); offered while it runs or is paused */
  onWatch?: (run: RunSummary) => void
  /**
   * the open question the job waits on (askingOf): the line says it is waiting on an answer, and whose, rather than
   * "still running", with `answer` (an "Answer it" link) beside it (#197)
   */
  waiting?: { question: Pick<Question, 'text' | 'to'>; answer?: ReactNode }
  className?: string
}

/**
 * The open question job `run` waits on: one asked in it (by the API's id, the job index's, or a handle ending in it),
 * the newest. Questions without a job are no job's. Pure.
 */
export function askingOf(run: Pick<RunSummary, 'id' | 'workerJobId' | 'state'>, questions: readonly Question[]): Question | undefined {
  if (run.state !== 'running' && run.state !== 'paused') return undefined
  const mine = questions.filter((q) => q.jobId && (q.jobId === run.id || q.jobId === run.workerJobId || run.id.endsWith(`.${q.jobId}`)))
  return mine.sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0]
}

/** Whose answer a job waits on: "Waiting on your answer", "Waiting on an answer from the admins". Pure. */
export const waitingWords = (q: Pick<Question, 'to'>): string => (q.to === 'you' ? 'Waiting on your answer' : `Waiting on an answer from ${q.to}`)

/**
 * Where a run stands now, by the clock: a running job not heard from since its overdue time is `silent`, and one past
 * the time it is declared lost is `lost`, whatever the screen's last look said. Pure.
 */
export function runState(run: Pick<RunSummary, 'state' | 'heard'>, now: number): RunSummary['state'] | 'silent' {
  if (run.state !== 'running' || !run.heard) return run.state
  if (now >= Date.parse(run.heard.lostAt)) return 'lost'
  if (now >= Date.parse(run.heard.overdueAt)) return 'silent'
  return 'running'
}

/** A run as it is now: one the clock says is lost reads as lost (no controls), with when trace last heard from it. */
export function lostNow(r: RunSummary, st: ReturnType<typeof runState>): RunSummary {
  if (st !== 'lost' || r.state === 'lost') return r
  return { ...r, state: 'lost', controls: [], step: r.heard ? `trace lost contact with it: nothing heard from it since ${time(r.heard.at)}.` : 'trace lost contact with it.' }
}

/**
 * A project's jobs as its Overview lists them, by the clock (runState): `doing` is what trace is doing (running, with a
 * silent one saying so, and paused); `ended` the jobs lost in the last day, which are over and need attention (Start
 * again or Dismiss), never shown as running, until a person settles them, and the ones of the last day its specialist
 * declined as another's work, until someone sends them on (Send it to <specialist>). Pure.
 */
export function splitRuns(jobs: readonly RunSummary[], now: number): { doing: RunSummary[]; ended: RunSummary[] } {
  const doing: RunSummary[] = []
  const ended: RunSummary[] = []
  for (const r of jobs) {
    // dismissed or started again: settled, so it is no longer a card (the new job shows on its own)
    if (r.settled) continue
    const st = runState(r, now)
    if (st === 'running' || st === 'silent' || st === 'paused') doing.push(r)
    else if (st === 'lost' && now - Date.parse(r.heard?.at ?? r.startedAt ?? '') < 24 * 3600_000) ended.push(lostNow(r, st))
    // declined by its specialist as another's work and not sent on yet: it ended without its work done (test log R26)
    else if (r.declined && !r.declined.sent && now - Date.parse(r.endedAt ?? r.startedAt ?? '') < 24 * 3600_000) ended.push(r)
  }
  return { doing, ended }
}

export function runDetail(run: RunSummary, now: number): string {
  const st = runState(run, now)
  if (st === 'silent' && run.heard) {
    return `trace has not heard from it since ${time(run.heard.at)} (${duration((now - Date.parse(run.heard.at)) / 1000, { short: true })} ago). If it stays silent, it is declared lost at ${time(run.heard.lostAt)}.`
  }
  if (st === 'lost' && run.state === 'running' && run.heard) return `trace lost contact with it: nothing heard since ${time(run.heard.at)}.`
  if (run.state === 'queued') {
    const where = run.position ? `${run.position === 1 ? 'Next' : `Number ${run.position}`} in the queue` : 'Queued'
    return run.startsWhen ? `${where}: ${run.startsWhen}` : where
  }
  if (run.state === 'paused') return `Paused${run.pausedBy ? ` by ${run.pausedBy}` : ''}: its work so far is kept${run.branch ? ` on ${run.branch}` : ''}. Resume carries on from there.`
  if (run.state === 'lost') return run.step ?? 'trace lost contact with it.'
  // finished: what it came to, not how long it has run
  if (run.declined) return run.step ?? `Declined: it says this is the ${run.declined.toName} specialist's work.`
  const parts: string[] = []
  if (run.where) parts.push(run.where)
  if (run.stepIndex && run.stepCount) parts.push(`Step ${run.stepIndex} of ${run.stepCount}${run.step ? `: ${run.step}` : ''}`)
  else if (run.step) parts.push(run.step)
  if (run.etaS !== undefined) parts.push(`${about(run.etaS)} left`)
  else if (run.startedAt) parts.push(timeAgainstUsual(run.startedAt, run.typicalS, now) as string)
  return parts.join(' · ')
}

export function RunLine({ run, project, onPause, onResume, onCancel, onMoveUp, onOpen, onWatch, waiting, className }: RunLineProps) {
  const now = useNow(run.etaS === undefined && run.startedAt ? 1000 : 60_000)
  const [confirm, setConfirm] = useState(false)
  const st = runState(run, now)
  const active = st === 'running'
  const Icon = waiting && st !== 'lost' ? CircleHelp : st === 'running' ? Loader2 : run.state === 'paused' || run.held ? PauseCircle : run.state === 'failed' || run.state === 'cancelled' ? CircleX : st === 'lost' || st === 'silent' || run.declined ? CircleAlert : run.state === 'done' ? CircleCheck : Circle
  // only what the job system can do for this job, when its view says (job.control answers ok: false for the rest)
  const can = (op: 'pause' | 'resume' | 'cancel' | 'move_up') => !run.controls || run.controls.includes(op)
  const pause = can('pause') ? onPause : undefined
  const resume = can('resume') ? onResume : undefined
  const cancelIt = can('cancel') ? onCancel : undefined
  const moveUp = can('move_up') ? onMoveUp : undefined
  const controls = (pause || resume || cancelIt || moveUp) && st !== 'lost' && (run.state === 'running' || run.state === 'queued' || run.state === 'paused')

  /** run one control and say what happened (or why not) */
  const act = async (what: string, fn: ((r: RunSummary) => Promise<string | void> | string | void) | undefined) => {
    try {
      const said = await fn?.(run)
      toast(`${what}: ${run.title}`, said ? { description: said } : undefined)
    } catch (e) {
      toast.error(`Could not ${what.toLowerCase()} ${run.title.toLowerCase()}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }
  const cancel = async () => {
    setConfirm(false)
    try {
      const kept = await cancelIt?.(run)
      toast(`Cancelled: ${run.title}`, { description: kept || 'Nothing was kept.' })
    } catch (e) {
      toast.error(`Could not cancel ${run.title.toLowerCase()}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className={cn('flex items-center gap-4 px-5 py-4', className)} data-density-item>
      <Icon className={cn('size-4 shrink-0', active && !waiting ? 'animate-spin text-primary' : waiting ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {onOpen ? (
            <button type="button" className="text-left hover:underline" onClick={() => onOpen(run)}>
              {project && <span className="font-semibold">{project}: </span>}
              {run.title}
            </button>
          ) : (
            <>
              {project && <span className="font-semibold">{project}: </span>}
              {run.title}
            </>
          )}
        </p>
        {waiting && st !== 'lost' ? (
          <p className="mt-0.5 text-xs text-muted-foreground"><span className="font-medium text-foreground">{waitingWords(waiting.question)}:</span> {waiting.question.text}</p>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">{runDetail(run, now)}</p>
        )}
        {/* under its words, so a phone keeps the line readable */}
        {run.declined && <DeclinedJobActions run={run} className="mt-2" />}
        {run.progress !== undefined && active && !waiting && (
          <div className="mt-2 h-1 max-w-[360px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(run.progress * 100)} aria-label={`${run.title} progress`}>
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(run.progress * 100)}%` }} />
          </div>
        )}
      </div>
      {waiting && st !== 'lost' && waiting.answer}
      {onWatch && (st === 'running' || st === 'silent' || run.state === 'paused') && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => onWatch(run)} aria-label={`Watch ${run.title}`}>
          <SquareTerminal /> Watch
        </Button>
      )}
      {controls && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Controls for ${run.title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {pause && (run.state === 'running' || (run.state === 'queued' && !run.held)) && (
              <DropdownMenuItem onSelect={() => void act(run.state === 'queued' ? 'Held' : 'Pausing', pause)}>{run.state === 'queued' ? 'Hold in the queue' : 'Pause'}</DropdownMenuItem>
            )}
            {resume && (run.state === 'paused' || run.held) && <DropdownMenuItem onSelect={() => void act('Resumed', resume)}>Resume</DropdownMenuItem>}
            {moveUp && run.state === 'queued' && <DropdownMenuItem onSelect={() => void act('Moved up', moveUp)}>Move up the queue</DropdownMenuItem>}
            {cancelIt && (
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                Cancel…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {run.title.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              {run.state === 'paused'
                ? 'It will not be resumed. Its work so far stays on its branch.'
                : run.state === 'queued' ? 'It leaves the queue and never starts.' : 'It stops within seconds. Anything already finished is kept, and you will see what.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction onClick={() => void cancel()} className="bg-destructive text-white hover:bg-destructive/90">
              Cancel the run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** One control of a run's job through job.control: what happens next, or why it could not be done (thrown, for the toast). */
export async function controlRun(jobId: string, op: 'pause' | 'resume' | 'cancel' | 'move_up'): Promise<string> {
  const { call } = await import('@/lib/api')
  const r = await call('job.control', { id: jobId, op })
  if (!r.ok) throw new Error(r.reason ?? 'It could not be done.')
  if (op === 'move_up') return r.position === 1 ? 'It is next.' : `It is number ${r.position ?? '?'} in the queue now.`
  return r.kept ?? (op === 'cancel' ? 'Nothing was kept.' : '')
}

/** Cancel a run's job through job.control: what was kept, or why it could not be cancelled (thrown, for the toast). */
export const cancelRun = (jobId: string): Promise<string> => controlRun(jobId, 'cancel')

/** The four controls of a run line, for people who may change the project (none for a reviewer). */
export function runControls(write: boolean): Pick<RunLineProps, 'onPause' | 'onResume' | 'onCancel' | 'onMoveUp'> {
  if (!write) return {}
  return {
    onPause: (r) => controlRun(r.id, 'pause'),
    onResume: (r) => controlRun(r.id, 'resume'),
    onCancel: (r) => controlRun(r.id, 'cancel'),
    onMoveUp: (r) => controlRun(r.id, 'move_up'),
  }
}
