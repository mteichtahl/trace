/**
 * The shell every signed-in screen sits in (Focus mode excepted):
 *   left rail (Sidebar) · top bar (breadcrumb, ⌘K, live dot, bell, Ask trace, person) · the screen · Ask trace docked
 * Widths: ≥1280 px the rail has labels and Ask trace docks (380–560 px); 768–1279 the rail is icons and Ask trace
 * slides over; <768 a bottom tab bar (Home, Projects, Ask, Inbox), Ask full screen.
 */
import { Link, useRouterState } from '@tanstack/react-router'
import { FolderClosed, House, Inbox as InboxIcon, Search, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { OfflineBanner } from '@/components/states'
import { DockedAskTrace, AskTrace } from '@/components/chat/chat-panel'
import { openPanel, usePanel } from '@/components/chat/chat-state'
import { useMediaQuery } from '@/hooks/use-media-query'
import { dismissSessionEnded, useAuth } from '@/lib/auth'
import { useInbox } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { AppSidebar, Wordmark } from './app-sidebar'
import { Breadcrumbs } from './breadcrumbs'
import { CommandMenu, commandOpen } from './command-menu'
import { LiveDot } from './live-dot'
import { NotificationsBell } from './notifications'
import { PersonMenu } from './person-menu'
import { ShortcutsDialog, useShortcuts } from './shortcuts'

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function SessionEnded() {
  const { sessionEnded } = useAuth()
  const pathname = useRouterState({ select: (s) => s.location.href })
  if (!sessionEnded) return null
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-warning/40 bg-warning/15 px-4 py-2 text-sm">
      <span className="flex-1">Your session has ended. Sign in again to keep working; anything you typed stays where it is.</span>
      <Button asChild size="sm">
        <Link to="/sign-in" search={{ next: pathname }} target="_blank" onClick={dismissSessionEnded}>
          Sign in again
        </Link>
      </Button>
    </div>
  )
}

function TopBar() {
  const p = usePanel()
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur md:gap-3 md:px-6">
      <Link to="/" className="md:hidden" aria-label="Home">
        <Wordmark />
      </Link>
      <div className="hidden min-w-0 flex-1 md:block">
        <Breadcrumbs />
      </div>
      <div className="flex-1 md:hidden" />
      <button
        type="button"
        onClick={() => commandOpen.set(true)}
        className="hidden h-9 w-64 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground hover:bg-accent lg:flex xl:w-72"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search or run a command</span>
        <kbd className="rounded border bg-muted px-1.5 font-mono text-[11px]">{mod}K</kbd>
      </button>
      <Button variant="outline" size="icon" className="lg:hidden max-md:hidden" aria-label="Search" onClick={() => commandOpen.set(true)}>
        <Search />
      </Button>
      <LiveDot className="px-1" />
      <NotificationsBell />
      <Button variant="outline" className="hidden md:inline-flex" onClick={() => openPanel()} aria-pressed={p.open}>
        <Sparkles /> Ask trace <kbd className="ml-1 hidden font-mono text-[11px] text-muted-foreground xl:inline">{mod}J</kbd>
      </Button>
      <PersonMenu />
    </header>
  )
}

function PhoneTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const inbox = useInbox()
  const p = usePanel()
  const n = inbox.data?.length ?? 0
  const tab = (active: boolean) => cn('flex flex-1 flex-col items-center gap-0.5 pb-1 pt-2 text-[11px]', active ? 'text-primary' : 'text-muted-foreground')
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <Link to="/" className={tab(pathname === '/' && !p.open)}>
        <House className="size-6" aria-hidden /> Home
      </Link>
      <Link to="/projects" className={tab((pathname.startsWith('/projects') || pathname.startsWith('/p/')) && !p.open)}>
        <FolderClosed className="size-6" aria-hidden /> Projects
      </Link>
      <button type="button" className={tab(p.open)} onClick={() => openPanel()}>
        <Sparkles className="size-6" aria-hidden /> Ask
      </button>
      <Link to="/inbox" className={cn(tab(pathname === '/inbox' && !p.open), 'relative')}>
        <InboxIcon className="size-6" aria-hidden />
        {n > 0 && <span className="absolute left-1/2 top-1 ml-2 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{n}</span>}
        Inbox
      </Link>
    </nav>
  )
}

/** Ask trace on narrower screens: slides over on tablets, full screen on phones. */
function OverlayAskTrace() {
  const p = usePanel()
  const phone = useMediaQuery('(max-width: 767px)')
  const wide = useMediaQuery('(min-width: 1280px)')
  if (wide) return null
  if (phone)
    return (
      <Drawer open={p.open} onOpenChange={(o) => openPanel(o)}>
        <DrawerContent className="h-[100dvh] max-h-none rounded-none">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Ask trace</DrawerTitle>
          </DrawerHeader>
          <AskTrace onClose={() => openPanel(false)} className="min-h-0 flex-1" />
        </DrawerContent>
      </Drawer>
    )
  return (
    <Sheet open={p.open} onOpenChange={(o) => openPanel(o)}>
      <SheetContent className="w-[420px] max-w-[90vw] p-0 sm:max-w-[420px] [&>button]:hidden">
        <SheetHeader className="sr-only">
          <SheetTitle>Ask trace</SheetTitle>
        </SheetHeader>
        <AskTrace onClose={() => openPanel(false)} />
      </SheetContent>
    </Sheet>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  useShortcuts()
  const wide = useMediaQuery('(min-width: 1280px)')
  return (
    <SidebarProvider defaultOpen style={{ '--sidebar-width': '232px' } as React.CSSProperties} open={wide ? undefined : false}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <TopBar />
        <SessionEnded />
        <OfflineBanner />
        <main id="main" className="flex-1 pb-20 md:pb-0">{children}</main>
      </SidebarInset>
      {wide && <DockedAskTrace />}
      <OverlayAskTrace />
      <PhoneTabs />
      <CommandMenu />
      <ShortcutsDialog />
    </SidebarProvider>
  )
}

/** The one reading column (at most 960 px), with the page's padding. */
export function Column({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-6 md:px-6 md:py-10', wide ? 'max-w-[1200px]' : 'max-w-[880px]', className)}>{children}</div>
}

/** A section with its label ("NEEDS YOU") and an optional link at the right ("See all"). */
export function Section({ label, count, action, children, className }: { label: string; count?: number; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = `s-${label.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={id} className={cn('mt-10 first:mt-0', className)}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 id={id} className="section-label">
          {label}
          {count !== undefined && ` (${count})`}
        </h2>
        {action && <div className="text-sm">{action}</div>}
      </div>
      {children}
    </section>
  )
}
