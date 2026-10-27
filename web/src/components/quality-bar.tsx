/**
 * The quality bar along the foot of Focus mode: the skill's checks as short items (Met, Not met, Waived) live from
 * the checker, "4 of 6 met" on the left and Submit on the right. Submit stays disabled until every check is met or
 * waived; hovering it lists exactly what is missing, and each missing item jumps to where it is fixed. On a phone it
 * is a sticky footer "4 of 6 met · Submit" whose count opens the list.
 */
import { Check, Circle, CircleMinus, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  className?: string
}

export const missing = (checks: QualityCheck[]): QualityCheck[] => checks.filter((c) => c.status === 'not_met')

function Item({ c }: { c: QualityCheck }) {
  const met = c.status === 'met'
  const waived = c.status === 'waived'
  return (
    <button
      type="button"
      onClick={c.onJump}
      disabled={!c.onJump}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs',
        met ? 'bg-verified/10 text-verified' : waived ? 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {met ? <Check className="size-3" aria-hidden /> : waived ? <CircleMinus className="size-3" aria-hidden /> : <Circle className="size-3" aria-hidden />}
      <span className="sr-only">{met ? 'Met: ' : waived ? 'Waived: ' : 'Not met: '}</span>
      {c.text}
    </button>
  )
}

export function QualityBar({ checks, onSubmit, submitLabel = 'Submit', className }: QualityBarProps) {
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState(false)
  const met = checks.filter((c) => c.status !== 'not_met').length
  const todo = missing(checks)
  const ready = todo.length === 0
  const submit = async () => {
    setBusy(true)
    try {
      await onSubmit()
    } finally {
      setBusy(false)
    }
  }
  const button = (
    <Button onClick={() => void submit()} disabled={!ready || busy} aria-describedby="quality-missing">
      {busy && <Loader2 className="animate-spin" />}
      {submitLabel}
    </Button>
  )
  return (
    <footer className={cn('sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur', className)} aria-label="Quality bar">
      {/* desktop */}
      <div className="hidden items-center gap-4 px-6 py-3 md:flex">
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
              <TooltipTrigger asChild>
                <span tabIndex={0}>{button}</span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="mb-1 font-medium">Still missing:</p>
                <ul className="list-disc pl-4">
                  {todo.map((c) => (
                    <li key={c.id}>{c.text}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
          {!ready && (
            <span id="quality-missing" className="text-xs text-muted-foreground">
              {todo.length} check{todo.length > 1 ? 's' : ''} left
            </span>
          )}
        </div>
      </div>
      {/* phone */}
      <div className="flex items-center gap-3 px-4 py-3 md:hidden">
        <button type="button" className="flex-1 text-left text-sm font-semibold underline-offset-4 hover:underline" onClick={() => setList(true)}>
          {met} of {checks.length} met
        </button>
        {button}
      </div>
      <Drawer open={list} onOpenChange={setList}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Quality checks</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-2 px-4 pb-6">
            {checks.map((c) => (
              <Item key={c.id} c={c} />
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </footer>
  )
}
