/**
 * "Changes from trace" on the overview (in place of "Waiting on GitHub"): each open change a trace job made, with its
 * pill (For you, In progress, Needs a fix, Out of date), its title, how many files, who made it and when, and its
 * checks. A row opens the change's review page. The list is asked for again every 30 s as a fallback for live events.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { Section } from '@/components/shell/app-shell'
import { changeLine, checksWords, VERDICT_WORDS } from '@/lib/guided'
import { projectId } from '@/lib/api'
import { ago } from '@/lib/format'
import { q } from '@/lib/queries'
import type { ChangeSummary, ChangeVerdict } from '@/lib/types'
import { cn } from '@/lib/utils'

export const CHANGES_POLL_MS = 30_000

const PILL_TONE = {
  primary: 'bg-primary/10 text-primary',
  neutral: 'bg-muted text-muted-foreground',
  bad: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/15 text-warning-foreground',
} as const

export function ChangePill({ verdict, className }: { verdict: ChangeVerdict; className?: string }) {
  const v = VERDICT_WORDS[verdict]
  return <span className={cn('inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs font-medium', PILL_TONE[v.tone], className)}>{v.pill}</span>
}

/** The checks as a small badge: passed (green), running (spinner), failing (red). */
export function ChecksBadge({ c }: { c: ChangeSummary['checks'] }) {
  if (!c || !c.total) return <span className="text-xs text-muted-foreground">No checks yet</span>
  const Icon = c.failed ? CircleX : c.running ? Loader2 : CircleCheck
  const tone = c.failed ? 'bg-destructive/10 text-destructive' : c.running ? 'bg-muted text-muted-foreground' : 'bg-verified/10 text-verified'
  const words = c.failed ? checksWords(c) : c.running ? 'Checking' : checksWords(c)
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium', tone)}>
      <Icon className={cn('size-3.5', c.running && !c.failed && 'animate-spin')} aria-hidden />
      {words}
    </span>
  )
}

/** The open changes of a project, oldest first (shared by the overview and the Changes tab). */
export function useChanges(repo: string) {
  return useQuery({ ...q('changes.list', { repo }), refetchInterval: CHANGES_POLL_MS })
}

/** The line under a change's title: "3 files · from the schematic specialist · 20 min ago", or what it waits for. */
export function changeMeta(c: ChangeSummary, files?: number): string {
  if (c.verdict !== 'ready') return changeLine(c)
  return [files !== undefined ? `${files} ${files === 1 ? 'file' : 'files'}` : null, `from ${c.from}`, ago(c.opened_at)].filter(Boolean).join(' · ')
}

export function ChangesFromTrace({ repo, unavailable, className }: { repo: string; unavailable?: string; className?: string }) {
  const list = useChanges(repo)
  const changes = list.data?.changes ?? []
  if (unavailable && !changes.length)
    return (
      <Section label="Changes from trace" className={className}>
        <p className="text-sm text-muted-foreground">trace could not reach GitHub just now, so its changes are not listed. It tries again in a minute.</p>
      </Section>
    )
  if (!changes.length) return null
  const id = projectId(repo)
  return (
    <Section label="Changes from trace" count={changes.length} className={className} action={<Link to="/p/$id/changes" params={{ id }} className="text-primary hover:underline">All changes</Link>}>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {changes.map((c) => (
          <li key={c.number}>
            <Link to="/p/$id/changes/$number" params={{ id, number: String(c.number) }} className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/50" data-density-item>
              <ChangePill verdict={c.verdict} className="justify-center sm:w-[84px]" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold sm:truncate">{c.title}</p>
                <p className="text-sm text-muted-foreground sm:truncate">{changeMeta(c)}</p>
              </div>
              <span className="max-sm:hidden"><ChecksBadge c={c.checks} /></span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  )
}
