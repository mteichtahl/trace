/**
 * A cited piece of evidence as a small chip ("TLV755 datasheet p.12", "run_4a11"): hovering shows its summary, and
 * tapping opens it in a side sheet so the person keeps their place. `onOpen` replaces the sheet (a gate records
 * that the evidence was opened, for example).
 */
import { Link } from '@tanstack/react-router'
import { BookOpen, ExternalLink, FileText, FlaskConical, ListChecks, MessageSquare, Brain, Cpu } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { EvidenceRef } from '@/lib/types'
import { cn } from '@/lib/utils'

const ICON: Record<EvidenceRef['kind'], ComponentType<{ className?: string }>> = {
  run: FlaskConical,
  datasheet: BookOpen,
  requirement: ListChecks,
  file: FileText,
  record: ListChecks,
  memory: Brain,
  part: Cpu,
  chat: MessageSquare,
}

export interface EvidenceChipProps {
  evidence: EvidenceRef
  onOpen?: (e: EvidenceRef) => void
  className?: string
}

export function EvidenceChip({ evidence: e, onOpen, className }: EvidenceChipProps) {
  const [open, setOpen] = useState(false)
  const Icon = ICON[e.kind] ?? FileText
  const mono = e.kind === 'run' || /^[a-z]+_[0-9a-f]{3,}$/i.test(e.label)
  const chip = (
    <button
      type="button"
      onClick={() => (onOpen ? onOpen(e) : setOpen(true))}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-xs text-foreground/80 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className={cn('truncate', mono && 'font-mono')}>{e.label}</span>
    </button>
  )
  return (
    <>
      {e.summary ? (
        <HoverCard openDelay={300}>
          <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
          <HoverCardContent className="w-72 text-sm">{e.summary}</HoverCardContent>
        </HoverCard>
      ) : (
        chip
      )}
      {!onOpen && (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent className="w-full sm:max-w-[480px] xl:max-w-[560px]">
            <SheetHeader>
              <SheetTitle className={cn(mono && 'font-mono')}>{e.label}</SheetTitle>
              <SheetDescription>{e.summary ?? 'Evidence cited here.'}</SheetDescription>
            </SheetHeader>
            {e.to && (
              <div className="px-4">
                <Button asChild variant="outline" size="sm">
                  <Link to={e.to}>
                    <ExternalLink /> Open
                  </Link>
                </Button>
              </div>
            )}
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}
