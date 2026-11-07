/**
 * The quality bar along the foot of Focus mode: the skill's checks as short items (Met, Not met, Waived) live from
 * the checker, "4 of 6 met" on the left and Submit on the right. Submit submits only once every check is met or
 * waived, but never ignores a click (#210): pressed before, it says which checks are left, each one jumping to where it
 * is fixed; hovering it lists them too. On a phone it is a sticky footer "4 of 6 met · Submit" whose count opens the
 * list. `blocked` holds Submit whatever the checks say, with its reason beside it (the project's agent is not set up
 * yet, so nothing could be saved). `saving`: the person's last change is still being saved, and the bar is checked on
 * the saved draft (a tick pressed just before Submit would otherwise be checked as not there yet, test-esp32 #64), so
 * a Submit pressed meanwhile waits for the save and then submits. Only the bar for the screen's width is drawn, so
 * there is one Submit in the page. The bar is in trace's assistant's context, as the person sees it.
 */
import { Check, Circle, CircleDashed, CircleMinus, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/use-media-query'
import type { CheckStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface QualityCheck {
  id: string
  text: string
  status: CheckStatus
  /** jump to where it is fixed */
  onJump?: () => void
  /** the step of the skill where it is met, if one: the rail marks that step done only once it is */
  step?: string
  /** the check's name alone, and the checker's reason it is not met: `text` is the two together */
  name?: string
  detail?: string
}

export interface QualityBarProps {
  checks: QualityCheck[]
  onSubmit: () => void | Promise<void>
  submitLabel?: string
  /** why Submit waits whatever the checks say, or null */
  blocked?: string | null
  /** the draft's last change is still being saved: Submit waits for it */
  saving?: boolean
  className?: string
}

export const missing = (checks: QualityCheck[]): QualityCheck[] => checks.filter((c) => c.status === 'not_met')

/**
 * The reason every check left gives, when two or more are left and all give the same one (no intent statement is
 * recorded yet, so none of the seven can be checked): said once, not after each check (test-esp32 #10).
 */
export function sharedReason(checks: readonly QualityCheck[]): string | null {
  const left = checks.filter((c) => c.status === 'not_met')
  const first = left[0]?.detail
  return left.length > 1 && first && left.every((c) => c.detail === first) ? first : null
}

/** A check's words as shown: its name alone where its reason is the shared one, said once beside the list. */
export const checkWords = (c: QualityCheck, shared: string | null): string => (shared && c.status === 'not_met' && c.detail === shared ? c.name ?? c.text : c.text)

/** The shared reason, once, as a sentence. */
const Shared = ({ reason, className }: { reason: string; className?: string }) => <p className={cn('text-xs text-muted-foreground', className)}>{reason}</p>

/**
 * One check. Its words wrap within the space it has, on every width: a long one (a check with the checker's reason
 * after it) on one line ran on under Submit and its count, and the end of the sentence was hidden (test-esp32 #239).
 */
function Item({ c, shared = null }: { c: QualityCheck; shared?: string | null }) {
  const met = c.status === 'met'
  const waived = c.status === 'waived'
  // asked for later in the skill: holds nothing back, and is not a risk accepted either (#227)
  const later = c.status === 'not_due'
  return (
    <button
      type="button"
      onClick={c.onJump}
      disabled={!c.onJump}
      className={cn(
        'inline-flex max-w-full items-start gap-1 rounded-md px-2 py-1 text-left text-xs',
        met ? 'bg-verified/10 text-verified' : waived || later ? 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {met ? <Check className="mt-0.5 size-3 shrink-0" aria-hidden /> : waived ? <CircleMinus className="mt-0.5 size-3 shrink-0" aria-hidden /> : later ? <CircleDashed className="mt-0.5 size-3 shrink-0" aria-hidden /> : <Circle className="mt-0.5 size-3 shrink-0" aria-hidden />}
      <span className="sr-only">{met ? 'Met: ' : waived ? 'Waived: ' : later ? 'Not due yet: ' : 'Not met: '}</span>
      <span className="min-w-0 break-words">{checkWords(c, shared)}</span>
    </button>
  )
}

export function QualityBar({ checks, onSubmit, submitLabel = 'Submit', blocked, saving = false, className }: QualityBarProps) {
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState(false)
  // one bar at a time: the desktop one or the phone one, never both in the page with one hidden, so Submit is one
  // button wherever it is looked for (#198: a hidden copy listed first did nothing when pressed)
  const wide = useMediaQuery('(min-width: 768px)')
  // a check not due yet is in neither count: it is neither met nor left to do
  const due = checks.filter((c) => c.status !== 'not_due').length
  const met = checks.filter((c) => c.status !== 'not_met' && c.status !== 'not_due').length
  const todo = missing(checks)
  const ready = todo.length === 0 && !blocked
  const shared = sharedReason(checks)
  // trace's assistant reads the bar in the person's own words: asked about an item on it, it knows what it says and
  // whether it is met (test-esp32 #53: it could not see "Firmware matches the schematic")
  useTraceContext(checks.length ? { label: `Quality bar · ${met} of ${due} met`, description: 'The quality bar along the foot of the screen, word for word as the person sees it, each check met, not met, waived or not due yet', value: { checks: checks.map((c) => ({ text: c.text, status: c.status })) } } : null, 'quality-bar')
  // Submit pressed before it could submit: say why, until it can
  const [asked, setAsked] = useState(false)
  // Submit pressed while the draft was being saved: submit once it is
  const [queued, setQueued] = useState(false)
  const latest = useRef(onSubmit)
  latest.current = onSubmit
  const run = async () => {
    setBusy(true)
    try {
      await latest.current()
    } finally {
      setBusy(false)
    }
  }
  const press = () => {
    if (busy || queued) return
    if (!ready) setAsked(true)
    else if (saving) setQueued(true)
    else void run()
  }
  useEffect(() => {
    if (ready) setAsked(false)
  }, [ready])
  useEffect(() => {
    if (!queued || saving) return
    setQueued(false)
    // the saved draft is checked again: still ready, it submits; else it says what is left
    if (ready) void run()
    else setAsked(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, saving, ready])
  const button = (
    <Button onClick={press} disabled={busy} aria-disabled={!ready || undefined} className={cn(!ready && 'opacity-50')} aria-describedby="quality-missing">
      {(busy || queued || (ready && saving)) && <Loader2 className="animate-spin" />}
      {submitLabel}
    </Button>
  )
  const why = asked && !ready ? (
    <div role="alert" className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 text-sm md:px-6">
      <span className="font-medium">Not submitted.</span>
      {blocked && <span>{blocked}</span>}
      {todo.length > 0 && (
        <>
          <span>{todo.length === 1 ? 'One check is left:' : `${todo.length} checks are left:`}</span>
          {todo.map((c) => (
            <Item key={c.id} c={c} shared={shared} />
          ))}
          {shared && <Shared reason={shared} className="basis-full" />}
        </>
      )}
    </div>
  ) : null
  return (
    <footer className={cn('sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur', className)} aria-label="Quality bar">
      {why}
      {/* desktop */}
      {wide && (
        <div className="flex items-center gap-4 px-6 py-3">
          <p className="shrink-0 text-sm font-semibold" aria-live="polite">
            {met} of {due} met
          </p>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-1.5">
              {checks.map((c) => (
                <Item key={c.id} c={c} shared={shared} />
              ))}
            </div>
            {shared && <Shared reason={shared} className="mt-1.5 px-2" />}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            {ready ? (
              button
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  {blocked && <p className={cn(todo.length > 0 && 'mb-1')}>{blocked}</p>}
                  {todo.length > 0 && (
                    <>
                      <p className="mb-1 font-medium">Still missing:</p>
                      <ul className="list-disc pl-4">
                        {todo.map((c) => (
                          <li key={c.id}>{checkWords(c, shared)}</li>
                        ))}
                      </ul>
                      {shared && <p className="mt-1">{shared}</p>}
                    </>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
            {ready && saving && <span id="quality-missing" className="text-xs text-muted-foreground">{queued ? 'Saving your draft, then submitting…' : 'Saving your draft…'}</span>}
            {!ready && (
              <span id="quality-missing" className="max-w-xs text-right text-xs text-muted-foreground">
                {blocked ? `Waits for the project's agent${todo.length ? ` · ${todo.length} check${todo.length > 1 ? 's' : ''} left` : ''}` : `${todo.length} check${todo.length > 1 ? 's' : ''} left`}
              </span>
            )}
          </div>
        </div>
      )}
      {/* phone */}
      {!wide && (
        <div className="flex items-center gap-3 px-4 py-3">
          <button type="button" className="flex-1 text-left text-sm font-semibold underline-offset-4 hover:underline" onClick={() => setList(true)}>
            {met} of {due} met
            {blocked ? (
              <span className="block text-xs font-normal text-muted-foreground">Waits for the project's agent</span>
            ) : !ready && (
              <span className="block text-xs font-normal text-muted-foreground">{todo.length} left before you can submit · <span className="text-primary">See which</span></span>
            )}
            {ready && queued && <span className="block text-xs font-normal text-muted-foreground">Saving your draft, then submitting…</span>}
          </button>
          {button}
        </div>
      )}
      <Drawer open={list} onOpenChange={setList}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Quality checks</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-2 px-4 pb-6">
            {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
            {checks.map((c) => (
              <Item key={c.id} c={c} shared={shared} />
            ))}
            {shared && <Shared reason={shared} />}
          </div>
        </DrawerContent>
      </Drawer>
    </footer>
  )
}
