/**
 * What a person can do about a job that ended without finishing (test-esp32 log #46): Start again (job.control restart:
 * the same request on the same branch, as a new attempt) and Dismiss (job.control dismiss, with an optional reason in
 * one line, recorded in the project's history). Under its line in the overview's "Ended without finishing", and as the
 * next step's button. Only the ops its job view offers (`controls`) are drawn, so a reviewer sees none. Either one looks
 * at the journey and the jobs again, so the card goes and the new job shows.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { call } from '@/lib/api'
import type { RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

export const START_AGAIN = 'Start again'

/** The dismissal's reason as the API takes it: one line, at most 300 characters; null when none was given. */
export function lostReason(text: string): string | null {
  const r = text.replace(/\s+/g, ' ').trim()
  return r ? r.slice(0, 300) : null
}

/** job.control restart or dismiss, then the journey and the jobs again. Throws the API's reason when it is refused. */
export function useLostJob(repo: string) {
  const qc = useQueryClient()
  return async (jobId: string, op: 'restart' | 'dismiss', reason?: string | null): Promise<string> => {
    const r = await call('job.control', { id: jobId, op, repo, ...(reason ? { reason } : {}) })
    if (!r.ok) throw new Error(r.reason ?? 'It could not be done.')
    for (const k of [['journey.get', repo], ['jobs.list', repo]]) void qc.invalidateQueries({ queryKey: k })
    return r.kept ?? ''
  }
}

export interface LostJobActionsProps {
  run: Pick<RunSummary, 'id' | 'title' | 'controls'>
  /** sends it (useLostJob); throws to keep the form open with what was typed */
  onAct: (jobId: string, op: 'restart' | 'dismiss', reason?: string | null) => Promise<string>
  /** the next step's card: Start again large and first; under the job's line: small */
  size?: 'sm' | 'lg'
  className?: string
}

export function LostJobActions({ run, onAct, size = 'sm', className }: LostJobActionsProps) {
  const [busy, setBusy] = useState<'restart' | 'dismiss' | null>(null)
  const [asking, setAsking] = useState(false)
  const [text, setText] = useState('')
  const id = useId()
  const restart = run.controls?.includes('restart') ?? false
  const dismiss = run.controls?.includes('dismiss') ?? false
  if (!restart && !dismiss) return null

  const act = async (op: 'restart' | 'dismiss') => {
    if (busy) return
    setBusy(op)
    try {
      const kept = await onAct(run.id, op, op === 'dismiss' ? lostReason(text) : null)
      toast(op === 'restart' ? `Started again: ${run.title}` : `Dismissed: ${run.title}`, kept ? { description: kept } : undefined)
      setAsking(false)
      setText('')
    } catch (e) {
      toast.error(op === 'restart' ? `Could not start ${run.title.toLowerCase()} again` : `Could not dismiss ${run.title.toLowerCase()}`, { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  if (asking) {
    return (
      <form className={cn('flex w-full flex-col gap-2 sm:flex-row sm:items-center', className)} onSubmit={(e) => { e.preventDefault(); void act('dismiss') }}>
        <label htmlFor={id} className="sr-only">Why it is no longer needed (optional)</label>
        <Input
          id={id}
          autoFocus
          maxLength={300}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setAsking(false) }}
          placeholder="Why it is no longer needed (optional)"
          className="min-w-0 flex-1"
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy !== null}>
            {busy === 'dismiss' && <Loader2 className="animate-spin" aria-hidden />}
            Dismiss
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={busy !== null}>Cancel</Button>
        </div>
      </form>
    )
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {restart && (
        <Button size={size} variant={size === 'lg' ? 'default' : 'outline'} disabled={busy !== null} onClick={() => void act('restart')}>
          {busy === 'restart' ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
          {START_AGAIN}
        </Button>
      )}
      {dismiss && <Button size={size} variant="ghost" disabled={busy !== null} onClick={() => setAsking(true)}>Dismiss</Button>}
    </div>
  )
}
