/**
 * A person's task its specialist declined (test log R26): it changed nothing and said the work is another specialist's.
 * Under the job's line: Send it to <specialist> (job.control send: the same request, as a new task for that one), only
 * when the job's view offers it (`controls`), so a reviewer, or a job sent on already, shows none. It looks at the
 * journey and the jobs again, so the new job shows.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Forward, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/api'
import type { RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

/** "Send it to Verification" */
export const sendWords = (toName: string): string => `Send it to ${toName}`

export function DeclinedJobActions({ run, className }: { run: Pick<RunSummary, 'id' | 'repo' | 'title' | 'controls' | 'declined'>; className?: string }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const d = run.declined
  if (!d || !run.controls?.includes('send')) return null
  const send = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await call('job.control', { id: run.id, op: 'send', ...(run.repo ? { repo: run.repo } : {}) })
      if (!r.ok) throw new Error(r.reason ?? 'It could not be sent on.')
      toast(`Sent to the ${d.toName} specialist: ${run.title}`, r.kept ? { description: r.kept } : undefined)
      for (const k of [['journey.get', run.repo], ['jobs.list', run.repo]]) void qc.invalidateQueries({ queryKey: k })
    } catch (e) {
      toast.error(`Could not send ${run.title.toLowerCase()} to the ${d.toName} specialist`, { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="outline" className={cn('shrink-0', className)} disabled={busy} onClick={() => void send()}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Forward aria-hidden />}
      {sendWords(d.toName)}
    </Button>
  )
}
