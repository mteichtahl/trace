/** The live status dot: green Live, amber Reconnecting (with the time since the last update), grey Offline. */
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ago } from '@/lib/format'
import { useLiveStatus } from '@/lib/live'
import { cn } from '@/lib/utils'
import { useNow } from '@/components/use-now'

export function LiveDot({ className }: { className?: string }) {
  const s = useLiveStatus()
  const now = useNow(10_000)
  const word = s.state === 'live' ? 'Live' : s.state === 'offline' ? 'Offline' : s.state === 'connecting' ? 'Connecting' : 'Reconnecting'
  const tone = s.state === 'live' ? 'bg-verified' : s.state === 'offline' ? 'bg-waived' : 'bg-warning'
  const text = s.state === 'live' ? 'text-verified' : 'text-muted-foreground'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center gap-1.5 text-xs', text, className)} role="status" aria-live="polite">
          <span className={cn('size-2 rounded-full', tone, s.state === 'reconnecting' && 'animate-pulse')} aria-hidden />
          {word}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {s.state === 'live' ? 'Connected: every screen updates as the record changes.' : s.lastUpdate ? `Last update ${ago(s.lastUpdate, now)}.` : 'Not connected yet.'}
      </TooltipContent>
    </Tooltip>
  )
}
