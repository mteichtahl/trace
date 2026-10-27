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
  /** the line's words, where checking is not the verb (Operations: "Updated …; next update …", "Refresh now") */
  words?: WaitWords
  /** one line, no padding: the detail as the sentence (Operations' refresh line) */
  compact?: boolean
  className?: string
}

export interface WaitWords {
  /** "Checked" */
  last?: string
  /** "next check" */
  next?: string
  /** "Check now" */
  now?: string
  /** "Checking" */
  busy?: string
}

export function waitDetail(w: Wait, now: number, words: WaitWords = {}): string {
  const parts: string[] = []
  const next = words.next ?? 'next check'
  if (w.lastCheckedAt) parts.push(`${words.last ?? 'Checked'} ${ago(w.lastCheckedAt, now)}`)
  if (w.nextCheckAt) parts.push(w.slowed ? `${words.next ? `${next} less often while nothing changes` : 'checking less often while nothing changes'}: next ${until(w.nextCheckAt, now)}` : `${next} ${until(w.nextCheckAt, now)}`)
  return parts.join(words.next ? '; ' : ' · ')
}

export function WaitLine({ wait, project, onCheckNow, words, compact, className }: WaitLineProps) {
  const now = useNow(1000)
  const [checking, setChecking] = useState(false)
  const detail = waitDetail(wait, now, words)
  const what = wait.what || wait.text
  return (
    <div className={cn('flex items-center', compact ? 'flex-wrap gap-x-3 gap-y-1' : 'gap-4 px-5 py-4', className)} data-density-item>
      <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {compact ? (
        <p className="text-sm text-muted-foreground" aria-live="off">
          {what && <span className="text-foreground">{what} </span>}
          {detail ? `${detail}.` : wait.text}
        </p>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {project && <span className="font-semibold">{project}: </span>}
            {what}
          </p>
          {detail ? <p className="mt-0.5 text-xs text-muted-foreground" aria-live="off">{detail}</p> : wait.text !== what && <p className="mt-0.5 text-xs text-muted-foreground">{wait.text}</p>}
        </div>
      )}
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
          {checking ? (words?.busy ?? 'Checking') : (words?.now ?? 'Check now')}
        </Button>
      )}
    </div>
  )
}
