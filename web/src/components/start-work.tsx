/**
 * "Start it" for trace's criterion that nothing is working on (journey.start_work, src/api/owned-work.ts; test-esp32
 * log #161): the next step's button once trace has started that work once on its own and it ended without meeting the
 * criterion, or trace could not start it. The stage's specialist is started on that criterion, and the journey and the
 * job list are looked at again (lib/after-write.ts) so the job shows as running. A reviewer is not offered it.
 */
import { Loader2, Play } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/api'

export const START_WORK = 'Start it'

export function StartWork({ repo, size = 'default', className }: { repo: string; size?: 'default' | 'lg'; className?: string }) {
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const r = await call('journey.start_work', { repo })
      toast.success('trace started the work', { description: r.started[0] })
    } catch (e) {
      toast.error('Could not start the work', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size={size} className={className} disabled={busy} onClick={() => void go()}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
      {START_WORK}
    </Button>
  )
}
