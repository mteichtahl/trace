/**
 * The review page's decision bar, kept in view at the bottom: Discard, Ask for changes, Accept into the design. Accept
 * is the primary act and goes at once (with the note box's words, if any). Discard and Ask for changes each open a
 * confirmation in the bar itself that needs a reason or a note before it sends, so neither happens by a stray tap.
 *
 * - A reviewer sees no buttons, and a sentence saying why (they can read changes; contributors decide).
 * - A change that cannot be accepted yet shows its blockers in plain words, and Accept stays disabled.
 * - A change already accepted or discarded says so.
 */
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { type DecisionMode, decisionMode } from '@/lib/guided'
import type { ChangeDetail, Part } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface DecisionBarProps {
  change: Pick<ChangeDetail, 'state' | 'may_accept' | 'blockers' | 'title' | 'from'>
  part?: Part
  /** the note box's words, carried into Accept and Ask */
  note: string
  /** "Accepting adds it to the design and moves Capture to step 4." */
  acceptSays?: string
  onAccept: (note: string) => void
  onAsk: (note: string) => void
  onDiscard: (reason: string) => void
  busy?: 'accept' | 'ask' | 'discard' | null
  className?: string
}

export const ASK_MAX = 4000
export const DISCARD_MAX = 2000

/** The words beside the buttons, for each mode. */
export function barWords(mode: DecisionMode, c: Pick<ChangeDetail, 'state' | 'blockers' | 'from'>, acceptSays?: string): string {
  switch (mode) {
    case 'read-only': return `You are a reviewer on this project, so you can read this change but not decide on it. A contributor accepts it, asks ${c.from} for changes, or discards it.`
    case 'closed': return c.state === 'merged' ? 'This change was accepted into the design.' : 'This change was discarded. Nothing in the design changed.'
    case 'blocked': return c.blockers.length ? `Not ready to accept: ${c.blockers.join(' ')}` : 'Not ready to accept yet.'
    default: return acceptSays ?? 'Accepting adds it to the design.'
  }
}

export function DecisionBar({ change, part, note, acceptSays, onAccept, onAsk, onDiscard, busy, className }: DecisionBarProps) {
  const mode = decisionMode(change, part)
  const [confirm, setConfirm] = useState<'ask' | 'discard' | null>(null)
  const [text, setText] = useState('')
  const open = (k: 'ask' | 'discard') => { setConfirm(k); setText(k === 'ask' ? note : '') }
  const max = confirm === 'ask' ? ASK_MAX : DISCARD_MAX
  const valid = text.trim().length > 0 && text.length <= max
  const decides = mode === 'ready' || mode === 'blocked'

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
          <p className={cn('min-w-0 flex-1 text-sm', mode === 'blocked' ? 'text-foreground' : 'text-muted-foreground')} aria-live="polite">{barWords(mode, change, acceptSays)}</p>
          {decides && (
            <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
              <Button variant="ghost" onClick={() => open('discard')} disabled={!!busy}>Discard</Button>
              <Button variant="outline" onClick={() => open('ask')} disabled={!!busy}>Ask for changes</Button>
              <Button size="lg" onClick={() => onAccept(note.trim())} disabled={mode !== 'ready' || !!busy}>
                {busy === 'accept' && <Loader2 className="animate-spin" aria-hidden />}
                Accept into the design
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
