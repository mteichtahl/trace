/**
 * What the project is waiting for on GitHub, on every tab of the project: the open pull requests its jobs opened (the
 * inbox's review items for this repository), each with its live status (components/pull-status.tsx). A job's work
 * reaches the record only once its pull request is merged, so whichever screen the person is on says so, instead of
 * only Home's Needs you. Nothing is drawn when nothing is waiting.
 */
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { PullStatusLine } from '@/components/pull-status'
import { Button } from '@/components/ui/button'
import { q } from '@/lib/queries'
import type { InboxItem } from '@/lib/types'
import { cn } from '@/lib/utils'

/** How often the list itself is asked for again (a job that just finished opens a new pull request). */
export const LIST_POLL_MS = 30_000

/** This repository's pull requests waiting on GitHub, oldest first. */
export function githubWaits(items: readonly InboxItem[] | undefined, repo: string): InboxItem[] {
  return (items ?? []).filter((i) => i.kind === 'review' && i.repo === repo && i.pull).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** The pull request's own title, from the item's summary (`…opened pull request #1, "Title".`), else the summary. */
export function pullTitle(i: InboxItem): string {
  return /pull request #\d+, "(.*)"/.exec(i.summary)?.[1] ?? i.summary
}

export function GitHubWaits({ repo, className }: { repo: string; className?: string }) {
  const inbox = useQuery({ ...q('inbox', {}), refetchInterval: LIST_POLL_MS })
  const waits = githubWaits(inbox.data, repo)
  if (!waits.length) return null
  return (
    <section aria-label="Waiting on GitHub" className={cn('mt-4 rounded-xl border bg-card px-4 py-3', className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Waiting on GitHub ({waits.length}) · its work counts once merged
      </p>
      <ul className="mt-2 flex flex-col gap-2.5">
        {waits.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm" title={i.summary}>{pullTitle(i)}</span>
            <PullStatusLine repo={i.pull!.repo} number={i.pull!.number} />
            {i.action.href && (
              <Button size="sm" variant="outline" asChild>
                <a href={i.action.href} target="_blank" rel="noreferrer">
                  Open on GitHub <ExternalLink aria-hidden />
                </a>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
