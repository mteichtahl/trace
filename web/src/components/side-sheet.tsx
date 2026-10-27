/**
 * Detail that opens beside the screen without leaving it: a right sheet (480 px, 560 px from 1280 px) on wider screens
 * and a bottom drawer on phones (docs/ui-design.md, "Responsive layout"). Title and an optional status sit in the
 * header; an optional footer holds the sheet's actions.
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
  /** the sheet's actions, kept in view below the scrolling content */
  footer?: ReactNode
  className?: string
}

export function SideSheet({ open, onOpenChange, title, status, description, children, footer, className }: SideSheetProps) {
  const phone = useMediaQuery('(max-width: 767px)')
  const heading = (Title: typeof SheetTitle | typeof DrawerTitle) => (
    <div className="flex items-start gap-2">
      <Title className="flex-1">{title}</Title>
      {status}
    </div>
  )
  if (phone)
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90dvh]">
          <DrawerHeader className="text-left">
            {heading(DrawerTitle)}
            {description ? <DrawerDescription>{description}</DrawerDescription> : <DrawerDescription className="sr-only">Details</DrawerDescription>}
          </DrawerHeader>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pb-6', className)}>{children}</div>
          {footer && <div className="flex gap-2 border-t px-4 py-3 [&>*]:flex-1">{footer}</div>}
        </DrawerContent>
      </Drawer>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-[480px] xl:max-w-[560px]">
        <SheetHeader className="border-b pr-10">
          {heading(SheetTitle)}
          {description ? <SheetDescription>{description}</SheetDescription> : <SheetDescription className="sr-only">Details</SheetDescription>}
        </SheetHeader>
        <div className={cn('min-h-0 flex-1 overflow-y-auto p-4 pb-8', className)}>{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t p-4">{footer}</div>}
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
