/**
 * The Wait line: anything trace checks on a timer. "Waiting for JLCPCB to confirm the order. Checked 2 minutes ago;
 * next check in 13 minutes. Check now". The countdown ticks live; when checks slow down the line says so; Check now
 * shows a spinner until the check answers.
 */
import { Clock, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ago, until } from '@/lib/format'
import type { Wait } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useNow } from './use-now'

export interface WaitLineProps {
  wait: Wait
  /** bold prefix, as on Home ("Bench supply:") */
  project?: string
  /** runs the check (job.check_now / tools.check_now); the spinner shows until it resolves */
  onCheckNow?: (wait: Wait) => Promise<unknown>
  className?: string
}

export function waitDetail(w: Wait, now: number): string {
  const parts: string[] = []
  if (w.lastCheckedAt) parts.push(`Checked ${ago(w.lastCheckedAt, now)}`)
  if (w.nextCheckAt) parts.push(w.slowed ? `checking less often while nothing changes: next ${until(w.nextCheckAt, now)}` : `next check ${until(w.nextCheckAt, now)}`)
  return parts.join(' · ')
}

export function WaitLine({ wait, project, onCheckNow, className }: WaitLineProps) {
  const now = useNow(1000)
  const [checking, setChecking] = useState(false)
  const detail = waitDetail(wait, now)
  const what = wait.what || wait.text
  return (
    <div className={cn('flex items-center gap-4 px-5 py-4', className)} data-density-item>
      <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {project && <span className="font-semibold">{project}: </span>}
          {what}
        </p>
        {detail ? <p className="mt-0.5 text-xs text-muted-foreground" aria-live="off">{detail}</p> : wait.text !== what && <p className="mt-0.5 text-xs text-muted-foreground">{wait.text}</p>}
      </div>
      {onCheckNow && (
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            try {
              await onCheckNow(wait)
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking && <Loader2 className="animate-spin" />}
          {checking ? 'Checking' : 'Check now'}
        </Button>
      )}
    </div>
  )
}
