/**
 * What a question card says beside the question itself: that it is out of date (what it asked about has moved on since:
 * test-esp32 #108), and, for a stuck agent's report shown in plain words, the agent's own words behind "Show detail"
 * (#35: run ids, a stack frame and tool names were the question).
 */
import { ChevronRight, CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/** The question is out of date: why, and that the agent that asked will ask again if it still needs to. */
export function OutOfDateNote({ why, compact, className }: { why: string; compact?: boolean; className?: string }) {
  return (
    <p className={cn(compact ? 'mt-1 flex items-start gap-1.5 text-xs' : 'flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm', className)} role="note">
      <CircleAlert className={cn('shrink-0 text-warning-foreground', compact ? 'mt-px size-3.5' : 'mt-0.5 size-4')} aria-hidden />
      <span>
        <span className="font-medium">Out of date: </span>
        {why}
        {!compact && ' Answer it only if it still stands; otherwise the agent that asked reads the record again and asks anew if it must.'}
      </span>
    </p>
  )
}

/** The agent's own words behind a plain summary, folded away until asked for. */
export function ShowDetail({ detail, className }: { detail: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('mt-1', className)}>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        {open ? 'Hide detail' : 'Show detail'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{detail}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}
