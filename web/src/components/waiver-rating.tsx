/**
 * A waiver's rating, in the Waiver form's own words (cosmetic, degraded, failure, safety), each with its own marker and
 * tone, so a safety waiver never reads like a failure one (test-esp32 #157: J1, rated safety, and U1, rated failure,
 * both read "Major"). Not colour alone: the word and the icon carry it too.
 */
import { CircleMinus, CircleX, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { ComponentType } from 'react'
import type { WaiverRating as Rating } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The form's four ratings, in its order, with what each means. */
export const RATINGS: readonly { id: Rating; label: string; detail: string }[] = [
  { id: 'cosmetic', label: 'Cosmetic', detail: 'Looks wrong, works right' },
  { id: 'degraded', label: 'Degraded', detail: 'Works, but worse than required' },
  { id: 'failure', label: 'Failure', detail: 'A function stops working' },
  { id: 'safety', label: 'Safety', detail: 'Someone or something could be harmed' },
]

const LOOK: Record<Rating, { icon: ComponentType<{ className?: string }>; className: string }> = {
  cosmetic: { icon: CircleMinus, className: 'text-muted-foreground bg-muted' },
  degraded: { icon: TriangleAlert, className: 'text-warning-foreground bg-warning/15' },
  failure: { icon: CircleX, className: 'text-destructive bg-destructive/10' },
  // the strongest: filled, with a ring, so it stands apart from failure in greyscale too
  safety: { icon: ShieldAlert, className: 'bg-destructive text-white ring-1 ring-destructive' },
}

/** "Rated cosmetic" … "Rated safety": the badge, with the rating's meaning as its tooltip. */
export function WaiverRating({ rating, className }: { rating: Rating; className?: string }) {
  const r = RATINGS.find((x) => x.id === rating) ?? RATINGS[1]!
  const look = LOOK[r.id]
  const Icon = look.icon
  return (
    <span data-rating={r.id} title={r.detail} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium', look.className, className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {r.label}
    </span>
  )
}
