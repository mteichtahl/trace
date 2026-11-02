/**
 * A short celebration when a stage is finished: a small card that rises, holds for a moment and goes, saying which
 * stage is done and which starts. None at all when the person or their system asks for reduced motion (the toast
 * still says it). `useStageCelebration` watches the journey's current stage and fires when it moves forward.
 */
import { PartyPopper } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Journey } from '@/lib/types'

/** True when motion should be skipped: the person's preference, else the system's. */
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true
  const pref = document.documentElement.dataset.motion
  if (pref === 'reduced') return true
  if (pref === 'full') return false
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** The stage the project moved past, when its current stage moved forward between two journeys. */
export function finishedStage(before: Pick<Journey, 'stages'> | undefined, after: Pick<Journey, 'stages'>): { done: string; next: string | null } | null {
  if (!before) return null
  const idx = (j: Pick<Journey, 'stages'>) => j.stages.findIndex((s) => s.state === 'current' || s.state === 'reopened')
  const a = idx(before)
  const b = idx(after)
  const allDone = after.stages.length > 0 && after.stages.every((s) => s.state === 'done' || s.state === 'skipped')
  if (a < 0 || (b <= a && !allDone)) return null
  return { done: before.stages[a]!.name, next: b >= 0 ? after.stages[b]!.name : null }
}

export function useStageCelebration(j: Journey | undefined): { done: string; next: string | null } | null {
  const prev = useRef<Journey | undefined>(undefined)
  const [shown, setShown] = useState<{ done: string; next: string | null } | null>(null)
  useEffect(() => {
    if (!j) return
    const f = finishedStage(prev.current, j)
    prev.current = j
    if (!f || reducedMotion()) return
    setShown(f)
    const t = setTimeout(() => setShown(null), 2600)
    return () => clearTimeout(t)
  }, [j])
  return shown
}

export function StageCelebration({ shown }: { shown: { done: string; next: string | null } | null }) {
  if (!shown) return null
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4">
      <div className="flex animate-in items-center gap-3 rounded-xl border border-verified/40 bg-card px-5 py-3 shadow-lg fade-in slide-in-from-top-4 duration-200">
        <PartyPopper className="size-6 text-verified" aria-hidden />
        <div>
          <p className="font-semibold">{shown.done} is done</p>
          <p className="text-sm text-muted-foreground">{shown.next ? `${shown.next} starts now.` : 'Every stage is finished.'}</p>
        </div>
      </div>
    </div>
  )
}
