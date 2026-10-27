import { CircleCheck, CircleDashed, CircleMinus, CircleX, Clock, Loader2, TriangleAlert, PauseCircle, CircleDot, Circle } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

/**
 * A status as an icon and a word, never colour alone (it reads in greyscale and to colour-blind readers).
 * Tones map to the design tokens: verified (green), warning (amber), destructive (red), waived (grey), primary (your move).
 */
export type Status =
  | 'verified' | 'met' | 'passed' | 'opened' | 'clean' | 'done'
  | 'failing' | 'not_met' | 'blocks'
  | 'untested' | 'waived' | 'queued' | 'idle'
  | 'warning' | 'stuck' | 'fix'
  | 'running' | 'working' | 'waiting' | 'paused'
  | 'yours'

type Tone = 'verified' | 'warning' | 'destructive' | 'waived' | 'primary' | 'neutral'

const STATUS: Record<Status, { word: string; icon: ComponentType<{ className?: string }>; tone: Tone; spin?: boolean }> = {
  verified: { word: 'Verified', icon: CircleCheck, tone: 'verified' },
  met: { word: 'Met', icon: CircleCheck, tone: 'verified' },
  passed: { word: 'Passed', icon: CircleCheck, tone: 'verified' },
  opened: { word: 'Opened', icon: CircleCheck, tone: 'verified' },
  clean: { word: 'Clean', icon: CircleCheck, tone: 'verified' },
  done: { word: 'Done', icon: CircleCheck, tone: 'verified' },
  failing: { word: 'Failing', icon: CircleX, tone: 'destructive' },
  not_met: { word: 'Not met', icon: CircleX, tone: 'destructive' },
  blocks: { word: 'Blocks the gate', icon: CircleX, tone: 'destructive' },
  untested: { word: 'Untested', icon: CircleDashed, tone: 'waived' },
  waived: { word: 'Waived', icon: CircleMinus, tone: 'waived' },
  queued: { word: 'Queued', icon: Circle, tone: 'waived' },
  idle: { word: 'Idle', icon: Circle, tone: 'waived' },
  warning: { word: 'Warning', icon: TriangleAlert, tone: 'warning' },
  fix: { word: 'Fix or waive', icon: TriangleAlert, tone: 'warning' },
  stuck: { word: 'Stuck', icon: TriangleAlert, tone: 'warning' },
  running: { word: 'Running', icon: Loader2, tone: 'neutral', spin: true },
  working: { word: 'Working', icon: Loader2, tone: 'neutral', spin: true },
  waiting: { word: 'Waiting', icon: Clock, tone: 'neutral' },
  paused: { word: 'Paused', icon: PauseCircle, tone: 'neutral' },
  yours: { word: 'Waiting on you', icon: CircleDot, tone: 'primary' },
}

const TONE: Record<Tone, string> = {
  verified: 'text-verified bg-verified/10',
  warning: 'text-warning-foreground bg-warning/15',
  destructive: 'text-destructive bg-destructive/10',
  waived: 'text-muted-foreground bg-muted',
  primary: 'text-primary bg-primary/10',
  neutral: 'text-foreground bg-muted',
}

export interface StatusBadgeProps {
  status: Status
  /** replaces the word ("Met (1 waived)", "Failing · 1.4 km") */
  label?: string
  /** no background: just icon and word */
  plain?: boolean
  className?: string
}

export function StatusBadge({ status, label, plain, className }: StatusBadgeProps) {
  const s = STATUS[status]
  const Icon = s.icon
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md text-xs font-medium',
        plain ? TONE[s.tone].split(' ')[0] : cn('px-1.5 py-0.5', TONE[s.tone]),
        className,
      )}
    >
      <Icon className={cn('size-3.5 shrink-0', s.spin && 'animate-spin')} aria-hidden />
      {label ?? s.word}
    </span>
  )
}

export const statusWord = (s: Status): string => STATUS[s].word
