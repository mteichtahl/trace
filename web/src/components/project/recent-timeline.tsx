/**
 * The Overview's "Recently": the last few things that changed the record, on the same line through time as the
 * Decisions timeline, newest first, with a day label wherever the day changes. Each moment shows who (trace or a
 * person's initials), what happened, its reference and the time; one with somewhere to go opens there.
 */
import { Link } from '@tanstack/react-router'
import { timelineGroups } from '@/components/project/decision-timeline'
import { initials, time } from '@/lib/format'
import type { RecentItem } from '@/lib/types'
import { cn } from '@/lib/utils'

export function RecentTimeline({ items, limit = 5, now = Date.now() }: { items: RecentItem[]; limit?: number; now?: number }) {
  const groups = timelineGroups([...items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit), now)
  return (
    <div className="relative space-y-3 rounded-xl border px-4 py-4 sm:px-5">
      <span aria-hidden className="absolute bottom-6 left-[31.5px] top-6 w-px bg-border sm:left-[35.5px]" />
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h3 className="relative mb-1.5 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span aria-hidden className="flex w-8 shrink-0 justify-center"><span className="size-1.5 rounded-full bg-muted-foreground/50 ring-4 ring-background" /></span>
            {g.label}
          </h3>
          <ol>
            {g.items.map((r) => {
              const body = (
                <>
                  <p className="min-w-0 flex-1 text-sm">
                    {r.text} {r.ref && <code className="font-mono text-xs text-muted-foreground">{r.ref}</code>}
                  </p>
                  <time dateTime={r.at} className="shrink-0 text-xs tabular-nums text-muted-foreground">{time(r.at)}</time>
                </>
              )
              return (
                <li key={r.id} className="relative flex items-start gap-3 py-1.5" data-density-item>
                  <span
                    aria-label={r.who}
                    title={r.who}
                    className={cn(
                      'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-background text-[10px] font-semibold',
                      r.who === 'trace' ? 'bg-foreground font-mono text-background' : 'border bg-muted',
                    )}
                  >
                    {r.who === 'trace' ? 't' : initials(r.who)}
                  </span>
                  {r.to ? (
                    <Link to={r.to} className="-mx-2 -my-1 flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/60">{body}</Link>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-start gap-3 py-1">{body}</div>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
