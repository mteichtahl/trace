/**
 * "Run the checks again" for checks no runner picked up (changes.rerun_stuck, src/api/stuck-checks.ts; test-esp32 log
 * #146): the next step's button once an admin has fixed the runner. The stuck runs are cancelled, which frees the
 * concurrency group they hold, and the newest of each runs again; if the runner is still broken they wait again, and
 * the change says why.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/api'

export const RERUN_STUCK = 'Run the checks again'

export function RerunStuck({ repo, size = 'default', className }: { repo: string; size?: 'default' | 'lg'; className?: string }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const r = await call('changes.rerun_stuck', { repo })
      toast.success('Running the checks again', { description: r.summary })
      for (const k of [['journey.get', repo], ['changes.list', repo]]) void qc.invalidateQueries({ queryKey: k })
    } catch (e) {
      toast.error('Could not run the checks again', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size={size} className={className} disabled={busy} onClick={() => void go()}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
      {RERUN_STUCK}
    </Button>
  )
}
