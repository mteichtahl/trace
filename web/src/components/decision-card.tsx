/**
 * Every decision comes with a recommendation. The recommended option is first and marked "trace recommends", with
 * why (cited evidence chips) and what it gives up; the alternatives are folded below. Choosing anything other than
 * the recommendation opens "Your reason", which must be filled before the choice is sent.
 *
 * Used in chat (HITL `ask_person`), in skills, at gates and for agents' questions.
 */
import { ChevronRight, Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { EvidenceChip } from '@/components/evidence-chip'
import { Rich } from '@/components/rich'
import type { EvidenceRef } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface DecisionOption {
  id: string
  /** the button's words ("Change C2 to 2.2 µF", "Use 4.2 A") */
  label: string
  /** one line on what it means */
  detail?: string
  /** an answer in the person's own words: choosing it asks for "Your answer" as well as "Your reason" */
  free?: boolean
}

export interface Decision {
  /** the question, when there is one ("Which antenna connector?") */
  question?: string
  /** the recommended option's id */
  recommended: string
  options: DecisionOption[]
  /** why the recommendation, in a sentence */
  why?: string
  evidence?: EvidenceRef[]
  /** what the recommendation gives up */
  givesUp?: string
  /** what it blocks while unanswered */
  blocks?: string
}

export interface DecisionChoice {
  option: string
  recommended: boolean
  /** required when not the recommendation */
  reason?: string
  /** the person's own answer, for a `free` option */
  answer?: string
}

export interface DecisionCardProps {
  decision: Decision
  onChoose: (c: DecisionChoice) => void | Promise<void>
  /** the choice already made (the card turns into its receipt) */
  chosen?: DecisionChoice
  /** short: option and why; full: trade-off and alternatives open (Preferences › Chat › Recommendations) */
  detail?: 'short' | 'full'
  /** the accent label above the recommendation */
  label?: string
  /** primary button words for the recommendation (defaults to the option's label) */
  acceptLabel?: string
  className?: string
}

/** May this choice be sent? A reason is required when it is not the recommendation. */
export function canSubmit(decision: Decision, option: string | null, reason: string, answer = ''): boolean {
  if (!option) return false
  if (option === decision.recommended) return true
  if (decision.options.find((o) => o.id === option)?.free && !answer.trim()) return false
  return reason.trim().length >= 3
}

export function DecisionCard({ decision, onChoose, chosen, detail = 'short', label = 'trace recommends', acceptLabel, className }: DecisionCardProps) {
  const rec = decision.options.find((o) => o.id === decision.recommended) ?? decision.options[0]!
  const alternatives = decision.options.filter((o) => o.id !== rec.id)
  const [other, setOther] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const free = !!decision.options.find((o) => o.id === other)?.free
  const [open, setOpen] = useState(detail === 'full')
  const reasonId = useId()

  const send = async (c: DecisionChoice) => {
    setBusy(true)
    try {
      await onChoose(c)
    } finally {
      setBusy(false)
    }
  }

  if (chosen) {
    const opt = decision.options.find((o) => o.id === chosen.option)
    return (
      <div className={cn('rounded-xl border bg-card p-4 text-sm', className)}>
        {decision.question && <p className="text-muted-foreground">{decision.question}</p>}
        <p className="mt-1">
          <span className="font-medium">Chosen: </span>
          {chosen.answer ?? opt?.label ?? chosen.option}
          {chosen.recommended ? <Badge variant="secondary" className="ml-2">Recommended</Badge> : null}
        </p>
        {chosen.reason && <p className="mt-1 text-muted-foreground">Reason: {chosen.reason}</p>}
      </div>
    )
  }

  return (
    <div className={cn('rounded-xl border bg-card p-4 md:p-5', className)} role="group" aria-label={decision.question ?? 'Decision'}>
      {decision.question && <p className="mb-3 text-sm font-medium">{decision.question}</p>}
      <Badge className="rounded-sm border-transparent bg-primary/10 font-normal text-primary">{label}</Badge>
      <p className="mt-2 text-[15px]">
        <span className="font-semibold">{rec.label}</span>
        {rec.detail && <span className="text-foreground/80"> {rec.detail}</span>}
      </p>
      {(decision.why || decision.evidence?.length) && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">Why</p>
          {decision.why && (
            <p className="mt-0.5 text-sm">
              <Rich text={decision.why} />
            </p>
          )}
          {decision.evidence && decision.evidence.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {decision.evidence.map((e, i) => (
                <EvidenceChip key={i} evidence={e} />
              ))}
            </div>
          )}
        </div>
      )}
      {decision.givesUp && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">What it gives up</p>
          <p className="mt-0.5 text-sm">{decision.givesUp}</p>
        </div>
      )}

      {alternatives.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
            {alternatives.length} alternative{alternatives.length > 1 ? 's' : ''}
            {!open && <span className="truncate">: {alternatives.map((a) => a.label).join(', ')}</span>}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <RadioGroup value={other ?? ''} onValueChange={(v) => setOther(v)} aria-label="Alternatives">
              {alternatives.map((a) => (
                <Label key={a.id} htmlFor={`${reasonId}-${a.id}`} className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 font-normal has-[[data-state=checked]]:border-primary">
                  <RadioGroupItem id={`${reasonId}-${a.id}`} value={a.id} className="mt-0.5" />
                  <span>
                    <span className="font-medium">{a.label}</span>
                    {a.detail && <span className="block text-xs text-muted-foreground">{a.detail}</span>}
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </CollapsibleContent>
        </Collapsible>
      )}

      {other && free && (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={`${reasonId}-answer`}>Your answer</Label>
          <Textarea id={`${reasonId}-answer`} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="What the agent should do, with a number and unit for a quantity" rows={2} aria-required />
        </div>
      )}
      {other && (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={reasonId}>Your reason</Label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="One line: why not the recommendation"
            rows={2}
            aria-required
          />
          <p className="text-xs text-muted-foreground">Required when you choose something other than the recommendation. It is kept with the decision.</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {other ? (
          <>
            <Button disabled={!canSubmit(decision, other, reason, answer) || busy} onClick={() => void send({ option: other, recommended: false, reason: reason.trim(), ...(free ? { answer: answer.trim() } : {}) })}>
              {busy && <Loader2 className="animate-spin" />}
              {free ? 'Send this answer' : `Choose ${decision.options.find((o) => o.id === other)?.label}`}
            </Button>
            <Button variant="ghost" onClick={() => { setOther(null); setReason(''); setAnswer('') }}>
              Back to the recommendation
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={() => void send({ option: rec.id, recommended: true })}>
              {busy && <Loader2 className="animate-spin" />}
              {acceptLabel ?? rec.label}
            </Button>
            {alternatives.length > 0 && (
              <Button variant="outline" onClick={() => setOpen(true)}>
                Choose another
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
