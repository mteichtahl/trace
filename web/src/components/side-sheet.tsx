/**
 * Detail that opens beside the screen without leaving it: a right sheet (480 px, 560 px from xl) on wider screens and
 * a bottom drawer on phones (docs/ui-design.md, "Responsive layout").
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
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
}

export function SideSheet({ open, onOpenChange, title, description, children, footer, className }: SideSheetProps) {
  const phone = useMediaQuery('(max-width: 767px)')
  if (phone)
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[92dvh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
          </DrawerHeader>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pb-4', className)}>{children}</div>
          {footer && <div className="flex gap-2 border-t px-4 py-3 [&>*]:flex-1">{footer}</div>}
        </DrawerContent>
      </Drawer>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-[480px] xl:max-w-[560px]">
        <SheetHeader className="border-b">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className={cn('min-h-0 flex-1 overflow-y-auto p-4', className)}>{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t p-4">{footer}</div>}
      </SheetContent>
    </Sheet>
  )
}
