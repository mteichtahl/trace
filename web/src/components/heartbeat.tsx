/**
 * Quiet is not stopped (docs/progress-and-logs.md, "5. Quiet is not stopped"): every running thing is in one of four
 * states, shown the same way everywhere by a dot and a few words.
 *
 *   working  a line in the last WORKING_S seconds                     green  "newest line 2 s ago"
 *   quiet    no lines, but no longer than this step usually goes quiet grey   "quiet for 1 min · normal for this step"
 *   late     past the step's usual quiet (or the job's overdue time)  amber  "later than usual · declared lost at 11:20…"
 *   lost     past the job's lost time                                 red    "lost: nothing heard since 10:42"
 *
 * quietState is pure, so it is tested on its own; Heartbeat draws it, ticking with the clock.
 */
import { duration, time } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useNow } from './use-now'

export type Quiet = 'working' | 'quiet' | 'late' | 'lost'

export interface Beat {
  /** when the newest line arrived; null: nothing heard yet */
  heardAt: string | null
  /** how long this step usually goes without a line (seconds) */
  usualQuietS: number
  /** jobs: when silence is late, and when it is declared lost */
  overdueAt?: string | null
  lostAt?: string | null
  /** when it started: the silence of a run that has said nothing yet is counted from here */
  startedAt?: string | null
}

/** A line this recent is "working". */
export const WORKING_S = 15

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** How long it has been silent (seconds), or null when there is nothing to count from. Pure. */
export function silenceS(b: Pick<Beat, 'heardAt' | 'startedAt'>, now: number): number | null {
  const from = ms(b.heardAt) ?? ms(b.startedAt)
  return from === null ? null : Math.max(0, (now - from) / 1000)
}

/** "just now", "2 s ago", "1 min ago": short, for lines that arrive every few seconds. Pure. */
export function agoShort(at: string | number, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000))
  return s < 2 ? 'just now' : `${duration(s, { short: true })} ago`
}

/** Which of the four states a running thing is in now. Pure. */
export function quietState(b: Beat, now: number): Quiet {
  const lost = ms(b.lostAt)
  if (lost !== null && now >= lost) return 'lost'
  const overdue = ms(b.overdueAt)
  if (overdue !== null && now >= overdue) return 'late'
  const s = silenceS(b, now)
  if (s === null) return 'quiet'
  if (b.heardAt && s <= WORKING_S) return 'working'
  // the job's own overdue time decides for jobs; otherwise the step's usual quiet
  if (overdue === null && s > Math.max(b.usualQuietS, WORKING_S)) return 'late'
  return 'quiet'
}

/** The words beside the dot. Pure. */
export function beatWords(b: Beat, now: number, st: Quiet = quietState(b, now)): string {
  const s = silenceS(b, now)
  switch (st) {
    case 'working':
      return `newest line ${agoShort(b.heardAt!, now)}`
    case 'quiet':
      if (s === null) return 'nothing said yet'
      if (!b.heardAt) return `nothing said yet · ${duration(s, { short: true })} in`
      return `quiet for ${duration(s, { short: true })} · normal for this step`
    case 'late': {
      const lost = b.lostAt ? ` · declared lost at ${time(b.lostAt)} if still silent` : ` · this step is usually quiet for at most ${duration(b.usualQuietS, { short: true })}`
      return `later than usual${s !== null ? `: no word for ${duration(s, { short: true })}` : ''}${lost}`
    }
    case 'lost':
      return b.heardAt ? `lost: nothing heard since ${time(b.heardAt)}` : 'lost: trace never heard from it'
  }
}

export const DOT: Record<Quiet, string> = {
  working: 'bg-verified',
  quiet: 'bg-waived',
  late: 'bg-warning',
  lost: 'bg-destructive',
}
export const WORDS_TONE: Record<Quiet, string> = {
  working: 'text-muted-foreground',
  quiet: 'text-muted-foreground',
  late: 'text-warning-foreground',
  lost: 'text-destructive',
}

/** The dot alone, for rows that say the words elsewhere. */
export function BeatDot({ state, className }: { state: Quiet; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', DOT[state], className)} aria-hidden />
}

/** The dot and its words, ticking each second. `words` replaces the words (the dot stays). */
export function Heartbeat({ beat, className, words }: { beat: Beat; className?: string; words?: (st: Quiet, said: string) => string }) {
  const now = useNow(1000)
  const st = quietState(beat, now)
  const said = beatWords(beat, now, st)
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', WORDS_TONE[st], className)} data-quiet={st}>
      <BeatDot state={st} />
      <span>{words ? words(st, said) : said}</span>
    </span>
  )
}
