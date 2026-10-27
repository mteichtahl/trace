/**
 * The five states every screen is designed in (docs/ui-design.md, "Empty, loading, error and offline states"):
 * Loading (skeletons only after 150 ms), Empty (why, and the action that fills it), Partial (what did not arrive, with
 * Try again), Error (what happened, whether anything was lost, the one thing to do, detail folded with Copy) and
 * Offline (what was true when, actions wait). Plus NotShared, the one answer for a page you cannot see.
 */
import { ChevronRight, Copy, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { time } from '@/lib/format'
import { useLiveStatus } from '@/lib/live'
import { cn } from '@/lib/utils'

/** True once `ms` has passed while `active`: fast loads never flash a skeleton. */
export function useDelayed(active: boolean, ms = 150): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const t = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(t)
  }, [active, ms])
  return shown
}

/** Renders its skeleton children only after 150 ms of loading; nothing before. */
export function Loading({ children, loading = true, delay = 150 }: { children: ReactNode; loading?: boolean; delay?: number }) {
  const shown = useDelayed(loading, delay)
  if (!loading || !shown) return null
  return <div aria-busy="true" aria-live="polite">{children}</div>
}

/** A stack of line skeletons, for lists. */
export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-y rounded-xl border', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="size-4 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-dashed px-5 py-6 text-sm text-muted-foreground', className)}>
      <p>{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title,
  kept,
  action,
  onRetry,
  detail,
  className,
}: {
  /** what happened, in plain words */
  title: ReactNode
  /** whether anything was lost ("Your text is kept.") */
  kept?: ReactNode
  /** the one thing to do (defaults to Try again when onRetry is given) */
  action?: ReactNode
  onRetry?: () => void
  /** technical detail, folded */
  detail?: string
  className?: string
}) {
  return (
    <div role="alert" className={cn('rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm', className)}>
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p>
            {title} {kept}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {action ?? (onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RefreshCw /> Try again
              </Button>
            ))}
          </div>
          {detail && (
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" /> Technical detail
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{detail}</pre>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 h-7 text-xs"
                  onClick={() => void navigator.clipboard?.writeText(detail).then(() => toast('Copied for support'))}
                >
                  <Copy /> Copy for support
                </Button>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </div>
  )
}

/** An error from a query, worded for a person, with the API's message as the folded detail. */
export function QueryError({ error, what, onRetry }: { error: unknown; what: string; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg === 'no access') return <NotShared />
  return <ErrorState title={`Could not load ${what}.`} onRetry={onRetry} detail={msg} />
}

export function Partial({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      <TriangleAlert className="size-4 text-warning-foreground" aria-hidden />
      <span className="flex-1">{children}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" className="h-7" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Shown under the top bar while the live connection is not live: the screen keeps what it had. */
export function OfflineBanner() {
  const s = useLiveStatus()
  if (s.state === 'live' || s.state === 'connecting') return null
  const at = s.liveSince ?? s.lastUpdate
  return (
    <div role="status" className="flex items-center gap-2 border-b bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
      <WifiOff className="size-3.5" aria-hidden />
      {at ? `Showing what was true at ${time(at)}.` : 'Showing what was last loaded.'} {s.state === 'offline' ? 'Offline: anything you send waits until you are back.' : 'Reconnecting.'}
    </div>
  )
}

/** The same words whether the project exists or not. */
export function NotShared() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">This page doesn't exist, or isn't shared with you</h1>
      <p className="mt-2 text-sm text-muted-foreground">If you need it, ask an admin on your team to add you to the project.</p>
    </div>
  )
}
