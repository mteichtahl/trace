/**
 * The project's one next step: the largest thing on the page. It names the action, whose move it is, where it sits in
 * its stage ("Step 3 of 5 in Capture"), trace's recommendation with its reason (in its own box), and what happens
 * after ("After you accept: …"). The person's own move wears the accent; trace's or someone else's stays neutral. A
 * reviewer sees the reading form ("…waiting for a contributor", Read the change). A change ready to accept can be
 * accepted straight from the card (`onAccept`), when this person may.
 */
import { Link } from '@tanstack/react-router'
import { Loader2, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Rich } from '@/components/rich'
import { RunLine } from '@/components/run-line'
import { WaitLine } from '@/components/wait-line'
import { stepWords } from '@/lib/guided'
import type { NextStep, Part, RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

const OWNER: Record<NextStep['owner'], string> = {
  you: 'Your move',
  trace: 'trace is working',
  person: 'Waiting on someone else',
  outside: 'Waiting on outside',
}

export interface NextStepCardProps {
  step: NextStep
  /** the person's part on this project: reviewers see the reading form */
  part?: Part
  /** the running job, for kind "working" */
  run?: RunSummary
  /** where the step sits in its stage: "Step 3 of 5 in Capture" (lib/guided nextPlace) */
  place?: { index: number; total: number; stage?: string } | null
  /** a change ready to accept, and this person may: "Accept now" beside the primary action */
  onAccept?: () => void
  accepting?: boolean
  /** extra content under the summary */
  children?: ReactNode
  /** a guided skill left part-way: "Continue: Schematic finish, step 4 of 6" (Focus mode keeps drafts) */
  resume?: { label: string; to: string }
  className?: string
}

export function NextStepCard({ step, part, run, place, onAccept, accepting, children, resume, className }: NextStepCardProps) {
  const reviewer = part === 'reviewer' && step.reviewer
  const boxed = !reviewer && !!step.recommend
  const summary = reviewer ? step.reviewer!.summary : boxed ? (step.lead ?? step.summary) : step.summary
  const action = reviewer ? step.reviewer!.action : step.action
  const yours = !reviewer && step.owner === 'you'
  const failed = step.kind === 'failed'
  const where = stepWords(place ?? null)

  return (
    <section
      aria-labelledby="next-step"
      className={cn(
        'rounded-xl border p-5 md:p-6',
        yours ? 'border-primary/40 bg-primary-soft' : failed ? 'border-destructive/30 bg-destructive/5' : 'bg-card',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p id="next-step" className={cn('flex items-center gap-2 text-xs font-semibold uppercase tracking-wide', yours ? 'text-primary' : 'text-muted-foreground')}>
          <span className={cn('size-2 rounded-full', yours ? 'bg-primary' : failed ? 'bg-destructive' : 'bg-muted-foreground/60')} aria-hidden />
          Next step · {reviewer ? 'For reading' : OWNER[step.owner]}
        </p>
        {where && <p className="text-xs text-muted-foreground">{where}</p>}
      </div>
      <p className="mt-3 text-lg leading-snug md:text-xl">
        <Rich text={summary} />
      </p>
      {boxed ? (
        <div className="mt-4 flex gap-3 rounded-lg border bg-background px-4 py-3 text-sm">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p>
            <span className="font-semibold text-primary">{step.recommend!.text}</span>
            {step.recommend!.why && <span> {step.recommend!.why}</span>}
          </p>
        </div>
      ) : (
        step.why && !reviewer && (
          <p className="mt-3 text-sm text-foreground/80">
            <span className="font-semibold">Why: </span>
            <Rich text={step.why} />
          </p>
        )
      )}
      {step.kind === 'working' && run && <RunLine run={run} className="mt-4 rounded-lg border bg-background" />}
      {step.kind === 'waiting_outside' && step.wait && <WaitLine wait={step.wait} className="mt-4 rounded-lg border bg-background" />}
      {children}
      {resume && !reviewer && (
        <p className="mt-4 text-sm">
          <Link to={resume.to} className="font-medium text-primary hover:underline">{resume.label}</Link>
          <span className="text-muted-foreground"> · your draft is kept</span>
        </p>
      )}
      {(action || step.secondary || onAccept) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {action && (
            <Button asChild={!!action.to} variant={yours ? 'default' : 'outline'} size="lg">
              {action.to ? <Link to={action.to}>{action.label}</Link> : <span>{action.label}</span>}
            </Button>
          )}
          {!reviewer && onAccept && (
            <Button variant="outline" size="lg" className="bg-background" onClick={onAccept} disabled={accepting}>
              {accepting && <Loader2 className="animate-spin" aria-hidden />}
              Accept now
            </Button>
          )}
          {!reviewer && !onAccept && step.secondary && (
            <Button asChild={!!step.secondary.to} variant="outline" size="lg" className="bg-background">
              {step.secondary.to ? <Link to={step.secondary.to}>{step.secondary.label}</Link> : <span>{step.secondary.label}</span>}
            </Button>
          )}
        </div>
      )}
      {step.after && !reviewer && <p className="mt-4 text-sm text-muted-foreground">{step.after}</p>}
    </section>
  )
}
