/**
 * A pull request's status, live: open, merged or closed, its checks (running, passed, failing by name) and whether it
 * can merge. While it is open it is asked for again every POLL_MS (and when the window regains focus), so the card
 * follows CI and a merge without a reload; once merged or closed it stops, and the inbox is refreshed so the item goes.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { CircleCheck, CircleX, GitMerge, GitPullRequestClosed, Loader2 } from 'lucide-react'
import { q } from '@/lib/queries'
import type { PullStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

/** How often an open pull request is asked for again (GitHub's API allows this comfortably for a few cards). */
export const POLL_MS = 15_000

export type PullTone = 'running' | 'good' | 'bad' | 'done' | 'muted'

/** The status in words, and its tone: what is happening first (failing, running), then whether it can merge. */
export function pullWords(s: PullStatus): { text: string; tone: PullTone } {
  if (s.state === 'merged') return { text: 'Merged', tone: 'done' }
  if (s.state === 'closed') return { text: 'Closed without merging', tone: 'muted' }
  const c = s.checks
  const parts: string[] = []
  if (s.draft) parts.push('Draft')
  if (c && c.failed) {
    parts.push(`${c.failed} ${c.failed === 1 ? 'check' : 'checks'} failing: ${c.failing.slice(0, 3).join(', ')}${c.failing.length > 3 ? ', …' : ''}`)
    return { text: parts.join(' · '), tone: 'bad' }
  }
  if (c && c.running) {
    parts.push(`Checks running: ${c.passed} of ${c.total - c.skipped} passed`)
    return { text: parts.join(' · '), tone: 'running' }
  }
  if (c && c.total) parts.push(`${c.passed === c.total - c.skipped ? 'All' : c.passed} ${c.passed === 1 ? 'check' : 'checks'} passed`)
  const merge: Record<string, [string, PullTone]> = {
    clean: ['ready to merge', 'good'], unstable: ['can merge, but a check is not passing', 'bad'], dirty: ['conflicts with its base branch', 'bad'],
    behind: ['behind its base branch', 'muted'], blocked: ['waiting on a review or a required check', 'muted'], unknown: ['GitHub is still working out if it can merge', 'running'],
  }
  const [words, tone] = merge[s.mergeable] ?? [`mergeable: ${s.mergeable}`, 'muted' as PullTone]
  parts.push(parts.length ? words : words.charAt(0).toUpperCase() + words.slice(1))
  return { text: parts.join(' · '), tone }
}

const ICON = { running: Loader2, good: CircleCheck, bad: CircleX, done: GitMerge, muted: GitPullRequestClosed } as const
const TONE = { running: 'text-muted-foreground', good: 'text-verified', bad: 'text-destructive', done: 'text-primary', muted: 'text-muted-foreground' } as const

export function PullStatusLine({ repo, number, className }: { repo: string; number: number; className?: string }) {
  const qc = useQueryClient()
  const res = useQuery({
    ...q('pull.status', { repo, number }),
    refetchInterval: (query) => (query.state.data?.state === 'open' || query.state.data === undefined ? POLL_MS : false),
    refetchOnWindowFocus: true,
  })
  const state = res.data?.state
  // merged or closed: the inbox no longer lists it
  useEffect(() => { if (state === 'merged' || state === 'closed') void qc.invalidateQueries({ queryKey: ['inbox'] }) }, [state, qc])
  if (res.isPending) return <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}><Loader2 className="size-3.5 animate-spin" aria-hidden />Checking the pull request…</p>
  if (res.isError || !res.data) return <p className={cn('text-xs text-muted-foreground', className)}>Its status could not be read just now.</p>
  const w = pullWords(res.data)
  const Icon = ICON[w.tone]
  return (
    <p className={cn('flex items-center gap-1.5 text-xs', TONE[w.tone], className)} aria-live="polite">
      <Icon className={cn('size-3.5 shrink-0', w.tone === 'running' && 'animate-spin')} aria-hidden />
      <span>#{res.data.number}: {w.text}</span>
      {state === 'open' && <span className="text-muted-foreground">· live</span>}
    </p>
  )
}
