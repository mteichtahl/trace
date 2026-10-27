/**
 * Long work, in one line: a spinner, the run's name in plain words, the current step, then a thin progress bar when
 * the size is known, otherwise elapsed and typical time ("12 min so far, usually 20"); where it runs, quietly. A menu
 * holds Pause, Cancel and Move up, each only when the job's view says job.control can do it (`run.controls`); Cancel
 * asks once, then says what was kept.
 */
import { Circle, Loader2, MoreHorizontal, PauseCircle, CircleX, CircleCheck } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { about, duration } from '@/lib/format'
import type { RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useNow } from './use-now'

export interface RunLineProps {
  run: RunSummary
  /** bold prefix ("Panel controller:") on Home, where runs from several projects mix */
  project?: string
  onPause?: (run: RunSummary) => Promise<void> | void
  /** resolves to what was kept ("Stage 1 kept: 48 nets routed and locked") */
  onCancel?: (run: RunSummary) => Promise<string | void> | string | void
  onMoveUp?: (run: RunSummary) => Promise<void> | void
  onOpen?: (run: RunSummary) => void
  className?: string
}

export function runDetail(run: RunSummary, now: number): string {
  if (run.state === 'queued') return run.startsWhen ? `Queued: ${run.startsWhen}` : 'Queued'
  const parts: string[] = []
  if (run.where) parts.push(run.where)
  if (run.stepIndex && run.stepCount) parts.push(`Step ${run.stepIndex} of ${run.stepCount}${run.step ? `: ${run.step}` : ''}`)
  else if (run.step) parts.push(run.step)
  if (run.etaS !== undefined) parts.push(`${about(run.etaS)} left`)
  else if (run.startedAt) {
    const el = (now - new Date(run.startedAt).getTime()) / 1000
    parts.push(`${duration(el, { short: true })} so far${run.typicalS ? `, usually ${duration(run.typicalS, { short: true })}` : ''}`)
  }
  return parts.join(' · ')
}

export function RunLine({ run, project, onPause, onCancel, onMoveUp, onOpen, className }: RunLineProps) {
  const now = useNow(run.etaS === undefined && run.startedAt ? 1000 : 60_000)
  const [confirm, setConfirm] = useState(false)
  const active = run.state === 'running'
  const Icon = run.state === 'running' ? Loader2 : run.state === 'paused' ? PauseCircle : run.state === 'failed' || run.state === 'cancelled' ? CircleX : run.state === 'done' ? CircleCheck : Circle
  // only what the job system can do for this job, when its view says (job.control answers ok: false for the rest)
  const can = (op: 'pause' | 'cancel' | 'move_up') => !run.controls || run.controls.includes(op)
  const pause = can('pause') ? onPause : undefined
  const cancelIt = can('cancel') ? onCancel : undefined
  const moveUp = can('move_up') ? onMoveUp : undefined
  const controls = (pause || cancelIt || moveUp) && (run.state === 'running' || run.state === 'queued' || run.state === 'paused')

  const cancel = async () => {
    setConfirm(false)
    const kept = await cancelIt?.(run)
    toast(`Cancelled: ${run.title}`, { description: kept || 'Nothing was kept.' })
  }

  return (
    <div className={cn('flex items-center gap-4 px-5 py-4', className)} data-density-item>
      <Icon className={cn('size-4 shrink-0', active ? 'animate-spin text-primary' : 'text-muted-foreground')} aria-hidden />
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
        <p className="mt-0.5 text-xs text-muted-foreground">{runDetail(run, now)}</p>
        {run.progress !== undefined && active && (
          <div className="mt-2 h-1 max-w-[360px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(run.progress * 100)} aria-label={`${run.title} progress`}>
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(run.progress * 100)}%` }} />
          </div>
        )}
      </div>
      {controls && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Controls for ${run.title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {pause && run.state === 'running' && <DropdownMenuItem onSelect={() => void pause(run)}>Pause</DropdownMenuItem>}
            {moveUp && run.state === 'queued' && <DropdownMenuItem onSelect={() => void moveUp(run)}>Move up the queue</DropdownMenuItem>}
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
            <AlertDialogDescription>It stops within seconds. Anything already finished is kept, and you will see what.</AlertDialogDescription>
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

/** Cancel a run's job through job.control: what was kept, or why it could not be cancelled (thrown, for the toast). */
export async function cancelRun(jobId: string): Promise<string> {
  const { call } = await import('@/lib/api')
  const r = await call('job.control', { id: jobId, op: 'cancel' })
  if (!r.ok) throw new Error(r.reason ?? 'The run could not be cancelled.')
  return r.kept ?? 'Nothing was kept.'
}
