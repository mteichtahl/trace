/**
 * The quality bar along the foot of Focus mode: the skill's checks as short items (Met, Not met, Waived) live from
 * the checker, "4 of 6 met" on the left and Submit on the right. Submit submits only once every check is met or
 * waived, but never ignores a click (#210): pressed before, it says which checks are left, each one jumping to where it
 * is fixed; hovering it lists them too. On a phone it is a sticky footer "4 of 6 met · Submit" whose count opens the
 * list. `blocked` holds Submit whatever the checks say, with its reason beside it (the project's agent is not set up
 * yet, so nothing could be saved). `saving`: the person's last change is still being saved, and the bar is checked on
 * the saved draft (a tick pressed just before Submit would otherwise be checked as not there yet, test-esp32 #64), so
 * a Submit pressed meanwhile waits for the save and then submits. Only the bar for the screen's width is drawn, so
 * there is one Submit in the page.
 */
import { Check, Circle, CircleMinus, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/use-media-query'
import type { CriterionStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface QualityCheck {
  id: string
  text: string
  status: CriterionStatus
  /** jump to where it is fixed */
  onJump?: () => void
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

function Item({ c, wrap = false }: { c: QualityCheck; wrap?: boolean }) {
  const met = c.status === 'met'
  const waived = c.status === 'waived'
  return (
    <button
      type="button"
      onClick={c.onJump}
      disabled={!c.onJump}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-left text-xs',
        wrap ? 'max-w-full' : 'whitespace-nowrap',
        met ? 'bg-verified/10 text-verified' : waived ? 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {met ? <Check className="size-3 shrink-0" aria-hidden /> : waived ? <CircleMinus className="size-3 shrink-0" aria-hidden /> : <Circle className="size-3 shrink-0" aria-hidden />}
      <span className="sr-only">{met ? 'Met: ' : waived ? 'Waived: ' : 'Not met: '}</span>
      {c.text}
    </button>
  )
}

export function QualityBar({ checks, onSubmit, submitLabel = 'Submit', blocked, saving = false, className }: QualityBarProps) {
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState(false)
  // one bar at a time: the desktop one or the phone one, never both in the page with one hidden, so Submit is one
  // button wherever it is looked for (#198: a hidden copy listed first did nothing when pressed)
  const wide = useMediaQuery('(min-width: 768px)')
  const met = checks.filter((c) => c.status !== 'not_met').length
  const todo = missing(checks)
  const ready = todo.length === 0 && !blocked
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
            <Item key={c.id} c={c} wrap />
          ))}
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
            {met} of {checks.length} met
          </p>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {checks.map((c) => (
              <Item key={c.id} c={c} />
            ))}
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
                          <li key={c.id}>{c.text}</li>
                        ))}
                      </ul>
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
            {met} of {checks.length} met
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
              <Item key={c.id} c={c} wrap />
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </footer>
  )
}
