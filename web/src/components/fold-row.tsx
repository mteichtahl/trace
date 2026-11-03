/**
 * The phone's folded sections (the phone redesign, "next step first"): one 48 px row per section — its name, a short
 * count on the right, and a chevron — that opens the section in a bottom drawer, or goes to its page (`to`). A group of
 * rows sits in one bordered box (FoldRows), so the next step stays the only large thing on the screen.
 */
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { cn } from '@/lib/utils'

export function FoldRows({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <nav aria-label={label} className={cn('divide-y overflow-hidden rounded-xl border bg-card', className)}>
      {children}
    </nav>
  )
}

const row = 'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-[15px] hover:bg-muted/50'

function Count({ count, accent }: { count?: ReactNode; accent?: boolean }) {
  if (count === undefined || count === null || count === '') return null
  return accent ? (
    <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">{count}</span>
  ) : (
    <span className="shrink-0 text-sm text-muted-foreground">{count}</span>
  )
}

/** A row that goes to a page. */
export function FoldLink({ label, count, accent, to, params }: { label: string; count?: ReactNode; accent?: boolean; to: string; params?: Record<string, string> }) {
  return (
    <Link to={to} params={params as never} className={row}>
      <span className="min-w-0 flex-1">{label}</span>
      <Count count={count} accent={accent} />
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  )
}

/** A row that opens its section in a drawer. */
export function FoldRow({ label, count, accent, description, children }: { label: string; count?: ReactNode; accent?: boolean; description?: string; children: ReactNode }) {
  return (
    <Drawer>
      <DrawerTrigger asChild>
        <button type="button" className={row}>
          <span className="min-w-0 flex-1">{label}</span>
          <Count count={count} accent={accent} />
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DrawerTrigger>
      <DrawerContent className="max-h-[85dvh]">
        <DrawerHeader className="text-left">
          <DrawerTitle>{label}</DrawerTitle>
          {description && <DrawerDescription>{description}</DrawerDescription>}
        </DrawerHeader>
        <div className="overflow-y-auto px-4 pb-6">{children}</div>
      </DrawerContent>
    </Drawer>
  )
}
