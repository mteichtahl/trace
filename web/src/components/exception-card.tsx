/**
 * One shape for everything that goes wrong or goes back (docs/ui-simplify.md, "One exception card"): what happened,
 * what it sent back (when it reopened a stage), and the one thing to do, with the detail folded under it. A failing
 * build, gates to sign again, evidence out of date and a spend warning all draw through it, in the same place: under
 * the project's Next step card. ExceptionStack shows the most blocking one and folds the rest under "N more".
 */
import { ChevronDown, CircleAlert, RotateCcw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'

export type ExceptionTone = 'blocking' | 'warning' | 'back'

const TONE: Record<ExceptionTone, { box: string; icon: string; Icon: LucideIcon }> = {
  blocking: { box: 'border-destructive/50 bg-destructive/5', icon: 'text-destructive', Icon: CircleAlert },
  warning: { box: 'border-warning/50 bg-warning/10', icon: 'text-warning-foreground', Icon: TriangleAlert },
  back: { box: 'bg-card', icon: 'text-muted-foreground', Icon: RotateCcw },
}

export interface ExceptionCardProps {
  tone: ExceptionTone
  /** what happened, in a few words */
  title: ReactNode
  /** a small mark beside the title (a status badge, a time) */
  badge?: ReactNode
  /** one or two plain sentences */
  body?: ReactNode
  /** the stage it sent the project back to, when it did */
  sentBack?: string | undefined
  /** the one thing to do: a button or a link */
  action?: ReactNode
  /** the evidence behind it, folded until asked for */
  detail?: ReactNode
  detailLabel?: string
  /** open the detail from the start */
  open?: boolean
  label: string
  className?: string
  testId?: string
}

export function ExceptionCard({ tone, title, badge, body, sentBack, action, detail, detailLabel = 'Show detail', open = false, label, className, testId }: ExceptionCardProps) {
  const t = TONE[tone]
  const [shown, setShown] = useState(open)
  return (
    <section aria-label={label} data-testid={testId} className={cn('rounded-xl border p-4 text-sm', t.box, className)}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <t.Icon className={cn('mt-0.5 size-4 shrink-0', t.icon)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">{title}{badge}</p>
          {sentBack && <p className="mt-0.5 text-xs font-medium text-muted-foreground">Sent the project back to {sentBack}</p>}
          {body && <div className="mt-1 leading-relaxed">{body}</div>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2 max-md:w-full max-md:pl-7">{action}</div>}
      </div>
      {detail && (
        <div className="mt-2 pl-7">
          <button type="button" aria-expanded={shown} onClick={() => setShown(!shown)} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            {shown ? 'Hide detail' : detailLabel}
            <ChevronDown className={cn('size-3.5 transition-transform', shown && 'rotate-180')} aria-hidden />
          </button>
          {shown && <div className="mt-2">{detail}</div>}
        </div>
      )}
    </section>
  )
}

/** The exceptions under the Next step card: the first (most blocking) shown, the rest folded under "N more". */
export function ExceptionStack({ children, className }: { children: ReactNode[]; className?: string }) {
  const items = children.filter(Boolean)
  const [all, setAll] = useState(false)
  if (!items.length) return null
  const [first, ...rest] = items
  return (
    <div className={cn('space-y-2', className)}>
      {first}
      {rest.length > 0 && (
        <>
          <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="inline-flex items-center gap-1 px-1 text-sm text-muted-foreground hover:text-foreground">
            {all ? 'Show fewer' : `${rest.length} more ${rest.length === 1 ? 'thing' : 'things'} to know`}
            <ChevronDown className={cn('size-3.5 transition-transform', all && 'rotate-180')} aria-hidden />
          </button>
          {all && rest}
        </>
      )}
    </div>
  )
}
