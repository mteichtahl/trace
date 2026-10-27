/**
 * A side sheet that keeps the person's place: a right sheet (480 px, 560 px from 1280 px) on desktops and a bottom
 * drawer on phones (docs/ui-design.md, "Responsive layout"). Title and an optional status sit in the header.
 */
import type { ReactNode } from 'react'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'

export interface SideSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** a status beside the title (a StatusBadge) */
  status?: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}

export function SideSheet({ open, onOpenChange, title, status, description, children, className }: SideSheetProps) {
  const phone = useMediaQuery('(max-width: 767px)')
  if (phone)
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[88dvh]">
          <DrawerHeader className="text-left">
            <div className="flex items-start gap-2">
              <DrawerTitle className="flex-1">{title}</DrawerTitle>
              {status}
            </div>
            {description ? <DrawerDescription>{description}</DrawerDescription> : <DrawerDescription className="sr-only">Details</DrawerDescription>}
          </DrawerHeader>
          <div className={cn('min-h-0 overflow-y-auto px-4 pb-6', className)}>{children}</div>
        </DrawerContent>
      </Drawer>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-[480px] xl:max-w-[560px]">
        <SheetHeader className="pr-10">
          <div className="flex items-start gap-2">
            <SheetTitle className="flex-1">{title}</SheetTitle>
            {status}
          </div>
          {description ? <SheetDescription>{description}</SheetDescription> : <SheetDescription className="sr-only">Details</SheetDescription>}
        </SheetHeader>
        <div className={cn('px-4 pb-8', className)}>{children}</div>
      </SheetContent>
    </Sheet>
  )
}

/** A label and value list for sheets ("Kind · Fact"). */
export function Facts({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** "Needs building: …" — the design's honest line where the API does not give something yet. */
export function NeedsBuilding({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-xs italic text-muted-foreground', className)}>Needs building: {children}</p>
}
