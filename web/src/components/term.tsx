import { useState, type ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { define, splitTerms } from '@/lib/glossary'

const coarse = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches

/**
 * A technical term, dotted-underlined; hovering (desktop) or tapping (touch) shows its glossary line. A term with no
 * entry renders as plain text, so <Term> is safe to wrap around anything.
 */
export function Term({ children, term, definition }: { children: ReactNode; term?: string; definition?: string }) {
  const key = term ?? (typeof children === 'string' ? children : '')
  const line = definition ?? define(key)
  const [open, setOpen] = useState(false)
  if (!line) return <>{children}</>
  const body = (
    <>
      <span className="font-medium">{key}</span>
      <span className="text-muted-foreground"> · {line}</span>
    </>
  )
  if (coarse()) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="term inline p-0 text-inherit">{children}</button>
        </PopoverTrigger>
        <PopoverContent className="w-72 text-sm">{body}</PopoverContent>
      </Popover>
    )
  }
  return (
    <HoverCard openDelay={250} closeDelay={80}>
      <HoverCardTrigger asChild>
        <abbr className="term no-underline" title={undefined} tabIndex={0} aria-description={line}>
          {children}
        </abbr>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 text-sm">{body}</HoverCardContent>
    </HoverCard>
  )
}

/** Plain text with every glossary term in it explained (the first time only, when `once`). */
export function Explained({ text, once = true }: { text: string; once?: boolean }) {
  const seen = new Set<string>()
  return (
    <>
      {splitTerms(text).map((p, i) => {
        if (!p.term || (once && seen.has(p.term))) return <span key={i}>{p.text}</span>
        seen.add(p.term)
        return <Term key={i}>{p.text}</Term>
      })}
    </>
  )
}
