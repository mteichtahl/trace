/**
 * Hand-offs between specialists (src/core/handoffs.ts): one specialist asked another, in writing, and the answer is
 * written down too. Shown on Agents and tools (who asked whom, open and answered), on a run page (the request a job
 * answers, or the ones it raised), and in chat's Hand-off row.
 *
 *   HandoffRow      who asked whom, the question, its state in words; unfolded: what it blocks, the evidence, the
 *                   asker's recommended answer, what a good answer contains, and the answer with its evidence,
 *                   confidence and whether the acceptance is met. A pending one (requested or queued) has Decline for
 *                   people who may change the project
 *   DeclineHandoff  the reason is required, one line; the asking specialist reads it (journey.status) and may ask a
 *                   person instead. handoff.decline is written in the journey record, never the agents' facts
 */
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ChevronRight, Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EvidenceChip } from '@/components/evidence-chip'
import { type Status, StatusBadge } from '@/components/status-badge'
import { call } from '@/lib/api'
import { ago } from '@/lib/format'
import type { Handoff, HandoffState } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Each state's badge and word. */
export const HANDOFF_STATUS: Record<HandoffState, { status: Status; label: string }> = {
  requested: { status: 'queued', label: 'Requested' },
  queued: { status: 'queued', label: 'Queued' },
  running: { status: 'working', label: 'Working on it' },
  answered: { status: 'done', label: 'Answered' },
  unanswered: { status: 'warning', label: 'Could not answer' },
  declined: { status: 'waived', label: 'Declined' },
  failed: { status: 'not_met', label: 'Not answered' },
}

/** Open (someone is still to act) or closed. */
export const isOpen = (h: Pick<Handoff, 'state'>): boolean => h.state === 'requested' || h.state === 'queued' || h.state === 'running'
/** A person may decline it now: it is not running yet and has not ended. */
export const declinable = (h: Pick<Handoff, 'state'>): boolean => h.state === 'requested' || h.state === 'queued'

/** The reason as the API takes it: one line, 3 to 300 characters. Null: not yet a reason. */
export function declineReason(text: string): string | null {
  const r = text.replace(/\s+/g, ' ').trim()
  return r.length >= 3 && r.length <= 300 ? r : null
}

/** "Asked by the Thermal specialist" (a hand-off job's line, wherever jobs are listed). */
export const askedBy = (fromName: string): string => `Asked by the ${fromName} specialist`

/** Send a decline (the hand-off's project named on each call), and have the screens that show hand-offs and jobs read them again. */
export function useDeclineHandoffs() {
  const qc = useQueryClient()
  return async (repo: string, h: Handoff, reason: string): Promise<string> => {
    const r = await call('handoff.decline', { repo, id: h.id, reason })
    void qc.invalidateQueries({ queryKey: ['jobs.list', repo] })
    void qc.invalidateQueries({ queryKey: ['journey.get', repo] })
    return [r.summary, r.job?.note].filter(Boolean).join(' ')
  }
}

export interface DeclineHandoffProps {
  handoff: Handoff
  /** sends it (useDeclineHandoffs); throws to keep the form open with what was typed; resolves to what happened */
  onDecline: (h: Handoff, reason: string) => Promise<string | void>
  className?: string
}

export function DeclineHandoff({ handoff, onDecline, className }: DeclineHandoffProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()
  const reason = declineReason(text)
  if (!open) return <Button size="sm" variant="ghost" className={className} onClick={() => setOpen(true)}>Decline</Button>
  const send = async () => {
    if (!reason || busy) return
    setBusy(true)
    try {
      const said = await onDecline(handoff, reason)
      toast('Declined. The asking specialist is told why.', said ? { description: said } : undefined)
      setOpen(false)
      setText('')
    } catch (e) {
      toast.error(`Could not decline it: ${e instanceof Error ? e.message : String(e)}. What you wrote is kept; try again.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className={cn('flex w-full flex-col gap-2 sm:flex-row sm:items-center', className)} onSubmit={(e) => { e.preventDefault(); void send() }}>
      <label htmlFor={id} className="sr-only">Why it is declined</label>
      <Input
        id={id} autoFocus required maxLength={300} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
        placeholder="Why, in one line (the asking specialist reads it)" className="min-w-0 flex-1"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!reason || busy}>
          {busy && <Loader2 className="animate-spin" />}
          Decline
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}

export interface HandoffRowProps {
  handoff: Handoff
  /** the project's name, where hand-offs of several projects mix */
  project?: string
  /** present for people who may change the project: a pending hand-off can be declined */
  onDecline?: (h: Handoff, reason: string) => Promise<string | void>
  /** start unfolded (a run page's own hand-off) */
  defaultOpen?: boolean
  className?: string
}

export function HandoffRow({ handoff: h, project, onDecline, defaultOpen = false, className }: HandoffRowProps) {
  const st = HANDOFF_STATUS[h.state]
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn('px-5 py-4 text-sm', className)} data-density-item>
      <div className="flex flex-wrap items-center gap-3">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-2 text-left" aria-label={`Hand-off from the ${h.fromName} specialist to the ${h.toName} specialist`}>
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5 font-medium">
              {project && <span>{project}:</span>}
              {h.fromName}
              <ArrowRight className="size-3.5 text-muted-foreground" aria-label="asked" />
              {h.toName}
            </span>
            <span className="mt-0.5 block">{h.question}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{h.says} · asked {ago(h.createdAt)}</span>
          </span>
        </CollapsibleTrigger>
        <StatusBadge status={st.status} label={st.label} />
        {onDecline && declinable(h) && <DeclineHandoff handoff={h} onDecline={onDecline} className="basis-full sm:basis-auto" />}
      </div>
      <CollapsibleContent>
        <HandoffDetail handoff={h} className="mt-3 ml-5" />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The request in full, and the answer when there is one. */
export function HandoffDetail({ handoff: h, className }: { handoff: Handoff; className?: string }) {
  return (
    <dl className={cn('space-y-3 text-sm', className)}>
      <div>
        <dt className="text-xs text-muted-foreground">It blocks</dt>
        <dd>{h.blocks}</dd>
      </div>
      {h.evidence.length > 0 && (
        <div>
          <dt className="text-xs text-muted-foreground">Evidence to start from</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">{h.evidence.map((e, i) => <EvidenceChip key={`${e.id ?? e.label}-${i}`} evidence={e} />)}</dd>
        </div>
      )}
      {h.recommendation && (
        <div>
          <dt className="text-xs text-muted-foreground">The {h.fromName} specialist's recommended answer</dt>
          <dd>{h.recommendation}</dd>
        </div>
      )}
      <div>
        <dt className="text-xs text-muted-foreground">A good answer contains</dt>
        <dd>
          <ol className="list-decimal pl-5">{h.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ol>
        </dd>
      </div>
      {h.answer && (
        <div className="rounded-lg bg-muted/50 p-3">
          <dt className="text-xs text-muted-foreground">
            {h.answer.answered ? `The ${h.toName} specialist's answer` : `Why the ${h.toName} specialist could not answer`}
            {h.answer.confidence !== undefined && ` · confidence ${Math.round(h.answer.confidence * 100)}%`}
            {h.answer.acceptanceMet === true && ' · everything asked for is there'}
            {h.answer.acceptanceMet === false && ' · not everything asked for is there'}
          </dt>
          <dd className="mt-1 whitespace-pre-line">{h.answer.text}</dd>
          {h.answer.unmet && <dd className="mt-1 text-xs text-muted-foreground">Missing: {h.answer.unmet}</dd>}
          {h.answer.evidence.length > 0 && <dd className="mt-2 flex flex-wrap gap-1.5">{h.answer.evidence.map((e, i) => <EvidenceChip key={`${e.id ?? e.label}-${i}`} evidence={e} />)}</dd>}
        </div>
      )}
      {h.declined && (
        <div>
          <dt className="text-xs text-muted-foreground">Declined by {h.declined.by}, {ago(h.declined.at)}</dt>
          <dd>{h.declined.reason}</dd>
        </div>
      )}
      {h.why && !h.declined && (
        <div>
          <dt className="text-xs text-muted-foreground">Why it was not answered</dt>
          <dd>{h.why}</dd>
        </div>
      )}
    </dl>
  )
}
