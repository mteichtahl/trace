/**
 * "Draft the requirements again": the recovery when the job drafting the requirements from the submitted intent was
 * lost, failed or cancelled, or never started (journey.get `drafting.state` stopped). It calls requirements.draft (the
 * same request and agent as Intent builder's Submit, write access on the project), says that the drafting started, and
 * the journey and the job list are looked at again so the job shows as running. A reviewer is not offered it.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/api'

export const DRAFT_AGAIN = 'Draft the requirements again'

export function DraftAgain({ repo, size = 'default', variant = 'default', className }: { repo: string; size?: 'default' | 'lg'; variant?: 'default' | 'outline'; className?: string }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const r = await call('requirements.draft', { repo })
      toast('Drafting the requirements again', { description: r.started[0] ?? 'The Verification agent drafts them from your submitted intent.' })
      for (const k of [['journey.get', repo], ['jobs.list', repo], ['requirements.trace', repo]]) void qc.invalidateQueries({ queryKey: k })
    } catch (e) {
      toast.error('Could not start drafting the requirements', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size={size} variant={variant} className={className} disabled={busy} onClick={() => void go()}>
      {busy && <Loader2 className="animate-spin" aria-hidden />}
      {DRAFT_AGAIN}
    </Button>
  )
}
