/**
 * The review page's decision bar, kept in view at the bottom: Discard, Ask for changes, Accept into the design. Accept
 * is the primary act and goes at once (with the note box's words, if any). Discard and Ask for changes each open a
 * confirmation in the bar itself that needs a reason or a note before it sends, so neither happens by a stray tap.
 *
 * - A reviewer sees no buttons, and a sentence saying why (they can read changes; contributors decide).
 * - A change that cannot be accepted yet shows its blockers in plain words, and Accept stays disabled.
 * - A change already accepted or discarded says so.
 * - A change in conflict leads with "Bring it up to date" (change.resolve, src/api/conflicts.ts): trace makes an edit
 *   again on the newest design, or has its worker merge the newest design in, at once and even if it gave up before.
 *   Accept is not offered beside it: a change in conflict cannot be accepted until it is brought up to date.
 * - An edit a person made in the app (docs/stay-in-trace.md) has no specialist to ask, so no Ask for changes; its author
 *   or an admin may discard it; one trace applies by itself (an admin's own edit, a hand-in) has no Accept: the bar says
 *   trace applies it once its checks pass.
 */
import { Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { type DecisionMode, answersLine, decisionMode } from '@/lib/guided'
import type { ChangeDetail, Part } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface DecisionBarProps {
  change: Pick<ChangeDetail, 'state' | 'may_accept' | 'blockers' | 'title' | 'from'> & {
    verdict?: ChangeDetail['verdict']; awaiting?: string[] | undefined
    may_ask?: boolean | undefined; may_discard?: boolean | undefined; applies?: ChangeDetail['applies']
  }
  part?: Part
  /** the note box's words, carried into Accept and Ask */
  note: string
  /** "Accepting adds it to the design and moves Capture to step 4." */
  acceptSays?: string
  /** "next look in 4 s": when trace looks at it again, while it waits on GitHub */
  nextLook?: string | null
  onAccept: (note: string) => void
  onAsk: (note: string) => void
  onDiscard: (reason: string) => void
  /** a change in conflict: trace brings it up to date now (change.resolve). Absent: no button */
  onResolve?: () => void
  busy?: 'accept' | 'ask' | 'discard' | 'resolve' | null
  className?: string
}

export const ASK_MAX = 4000
export const DISCARD_MAX = 2000

/** The words beside the buttons, for each mode. */
export function barWords(mode: DecisionMode, c: Pick<ChangeDetail, 'state' | 'blockers' | 'from'> & { verdict?: ChangeDetail['verdict']; awaiting?: string[] | undefined; applies?: ChangeDetail['applies']; answers?: ChangeDetail['answers'] }, acceptSays?: string): string {
  const who = `${c.from[0]?.toUpperCase() ?? ''}${c.from.slice(1)}`
  // trace applies it by itself: nobody accepts it, and the bar says what it waits for
  if (c.applies === 'auto' && c.state === 'open') {
    if (c.verdict === 'applying') return 'Its checks passed: trace applies it now. Nothing for you to do.'
    const rest = c.blockers.filter((b) => !/nobody needs to accept it/.test(b))
    return `trace applies it once its checks pass, with nothing for anyone to do.${rest.length ? ` For now: ${rest.join(' ')}` : ''}`
  }
  // an answer of yours is not in it yet: trace applies it (or, when it will not on its own, you ask for it)
  if (mode === 'ready' && c.verdict === 'unfinished' && c.answers?.length) return answersLine(c.answers)
  // it waits on a person's approval, not on more work: say what to approve; it updates by itself once approved
  if (mode === 'ready' && c.verdict === 'unfinished' && c.awaiting?.length) return `${who} says this waits for ${c.awaiting.join(' and ')} to be approved. Once it is, this updates by itself.`
  if (mode === 'ready' && c.verdict === 'unfinished') return `${c.from[0]?.toUpperCase() ?? ''}${c.from.slice(1)} says this is not finished. trace recommends asking for changes; accepting adds it to the design as it is.`
  if (c.verdict === 'conflict' && c.state === 'open' && mode !== 'read-only') return 'It conflicts with changes accepted since it was made. trace brings it up to date by itself; Bring it up to date starts that now, even if trace gave up on it before.'
  switch (mode) {
    case 'read-only': return `You are a reviewer on this project, so you can read this change but not decide on it. A contributor accepts it, asks ${c.from} for changes, or discards it.`
    case 'closed': return c.state === 'merged' ? 'This change was accepted into the design.' : 'This change was discarded. Nothing in the design changed.'
    case 'blocked': return c.blockers.length ? `Not ready to accept: ${c.blockers.join(' ')}` : 'Not ready to accept yet.'
    default: return acceptSays ?? 'Accepting adds it to the design.'
  }
}

/** Whether the bar offers "Bring it up to date": an open change in conflict, for someone who may decide on it. */
export const offersResolve = (mode: DecisionMode, c: Pick<ChangeDetail, 'state'> & { verdict?: ChangeDetail['verdict'] }): boolean =>
  c.state === 'open' && c.verdict === 'conflict' && mode !== 'read-only' && mode !== 'closed'

export function DecisionBar({ change, part, note, acceptSays, nextLook, onAccept, onAsk, onDiscard, onResolve, busy, className }: DecisionBarProps) {
  const mode = decisionMode(change, part)
  const [confirm, setConfirm] = useState<'ask' | 'discard' | null>(null)
  const [text, setText] = useState('')
  const open = (k: 'ask' | 'discard') => { setConfirm(k); setText(k === 'ask' ? note : '') }
  const max = confirm === 'ask' ? ASK_MAX : DISCARD_MAX
  const valid = text.trim().length > 0 && text.length <= max
  const decides = mode === 'ready' || mode === 'blocked'
  // what this person may do here (an older API says nothing: everything, as before)
  const mayAsk = change.may_ask !== false
  const mayDiscard = change.may_discard !== false
  const mayAccept = change.applies !== 'auto'
  // the specialist says it is not finished: asking for changes is the step trace recommends, so it leads
  // the specialist says it is not finished and has more to do (not merely waiting on an approval)
  // (while trace applies an answer, nothing is for this person to do: asking for changes leads only once it will not)
  const unfinished = change.verdict === 'unfinished' && !change.awaiting?.length && (!change.answers?.length || change.answers.some((a) => a.stopped))
  // in conflict: the step to take is bringing it up to date, so it leads; accepting waits for it
  const resolvable = !!onResolve && offersResolve(mode, change)

  return (
    <div role="region" aria-label="Your decision" className={cn('sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 max-md:bottom-16', className)}>
      {confirm ? (
        <div className="space-y-2">
          <Label htmlFor="decision-text" className="text-sm font-medium">
            {confirm === 'ask' ? `What should ${change.from} change?` : 'Why discard it?'}
          </Label>
          <Textarea
            id="decision-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-required autoFocus maxLength={max}
            placeholder={confirm === 'ask' ? 'For example: use a 1 A regulator, we may add a radio later.' : 'For example: we are dropping USB-C for this revision.'}
          />
          <p className="text-xs text-muted-foreground">
            {confirm === 'ask'
              ? `Your note goes to ${change.from}, who revises the change. It comes back to you to review.`
              : 'The change is closed and nothing in the design changes. Your reason is kept in the decisions log.'}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Keep reviewing</Button>
            <Button
              variant={confirm === 'discard' ? 'destructive' : 'default'}
              disabled={!valid || !!busy}
              onClick={() => (confirm === 'ask' ? onAsk(text.trim()) : onDiscard(text.trim()))}
            >
              {busy === confirm && <Loader2 className="animate-spin" aria-hidden />}
              {confirm === 'ask' ? 'Send it back with this note' : 'Discard this change'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className={cn('min-w-0 flex-1 text-sm', mode === 'blocked' || unfinished ? 'text-foreground' : 'text-muted-foreground')} aria-live="polite">
            {barWords(mode, change, acceptSays)}
            {mode === 'blocked' && nextLook && <span aria-hidden className="ml-1 text-muted-foreground">trace looks again by itself ({nextLook}).</span>}
          </p>
          {decides && (
            <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
              {mayDiscard && <Button variant="ghost" onClick={() => open('discard')} disabled={!!busy}>Discard</Button>}
              {resolvable && (
                <Button size="lg" onClick={() => onResolve?.()} disabled={!!busy}>
                  {busy === 'resolve' ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                  Bring it up to date
                </Button>
              )}
              {mayAsk && <Button variant={unfinished ? 'default' : 'outline'} size={unfinished ? 'lg' : 'default'} onClick={() => open('ask')} disabled={!!busy}>Ask for changes</Button>}
              {mayAccept && !resolvable && (
                <Button variant={unfinished ? 'outline' : 'default'} size={unfinished ? 'default' : 'lg'} onClick={() => onAccept(note.trim())} disabled={mode !== 'ready' || !!busy}>
                  {busy === 'accept' && <Loader2 className="animate-spin" aria-hidden />}
                  Accept into the design
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
