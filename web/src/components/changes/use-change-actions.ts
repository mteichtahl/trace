/**
 * Accept, ask for changes, discard, bring a change in conflict up to date, and run again a check that did not run
 * properly (GitHub busy, the runner lost: change.rerun): one place for the acts on a change, wherever they are taken
 * (the review page, the next-step card, Home's Needs you). Each refreshes the change, its project's list, the journey and the inbox,
 * and confirms with a toast that says what moved and what trace starts next.
 *
 * Accepting sends the head commit the person was shown (change.get's head.sha): the API refuses a change that moved
 * since ("It changed since you looked at it"), so nobody accepts work they did not see. A card that shows no change
 * detail (Needs you) reads change.get first and sends what that says.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { call } from '@/lib/api'
import { q } from '@/lib/queries'
import type { ChangeAccepted, InboxItem } from '@/lib/types'
import { showAfterAccept } from './after-accept'

/** The toast after accepting: what moved, and what trace starts next. */
export function acceptedWords(title: string, r: Pick<ChangeAccepted, 'next' | 'stage'>, step?: { index: number; total: number; stage: string } | null): { title: string; description: string } {
  const moved = step ? `${step.stage} is now on step ${Math.min(step.total, step.index + 1)} of ${step.total}.` : `"${title}" is part of the design now.`
  return { title: 'Accepted into the design', description: `${moved} ${r.next || 'trace carries on with the next step.'}`.trim() }
}

/** Accept a change from a Needs you card (any project): the same toast, and the item leaves the list. */
/** After an accept: on a phone the "What happens next" screen; on wider screens the toast, whose action opens it. */
export function confirmAccepted(a: { repo: string; project?: string; title: string; result: Pick<ChangeAccepted, 'next' | 'stage' | 'warning'> }, step?: { index: number; total: number; stage: string } | null) {
  const phone = typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches
  showAfterAccept(a, phone)
  // merged, but the decision was not written down: said, never hidden (it is not a failure: nothing is to be redone)
  if (a.result.warning) toast.warning('Accepted, with a note', { description: a.result.warning })
  if (phone) return
  const w = acceptedWords(a.title, a.result, step)
  toast.success(w.title, { description: `${a.project ? `${a.project}: ` : ''}${w.description}`, action: { label: 'What happens next', onClick: () => showAfterAccept(a, true) } })
}

export function useAcceptFromInbox() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const run = (item: InboxItem, title: string) => {
    if (!item.change) return
    const { repo, number } = item.change
    setBusy(item.id)
    // the card shows no head of its own: what change.get says now is what is accepted (the same query the card's
    // Accept button was shown from, read again)
    qc.fetchQuery({ ...q('change.get', { repo, number }), staleTime: 0 })
      .then((d) => call('change.accept', { repo, number, head_sha: d.head.sha }))
      .then((r) => {
        confirmAccepted({ repo, project: item.project, title, result: r })
        qc.setQueryData<InboxItem[]>(['inbox', {}], (xs) => xs?.filter((x) => x.id !== item.id))
      })
      .catch((e: unknown) => toast.error('Could not accept the change', { description: `${e instanceof Error ? e.message : String(e)} Nothing changed.` }))
      .finally(() => {
        setBusy(null)
        for (const k of [['inbox'], ['journey.get', repo], ['changes.list', repo], ['change.get', repo]]) void qc.invalidateQueries({ queryKey: k })
      })
  }
  return { run, busy }
}

export function useChangeActions(repo: string) {
  const qc = useQueryClient()
  const refresh = (number?: number) => {
    void qc.invalidateQueries({ queryKey: ['changes.list', repo] })
    if (number !== undefined) void qc.invalidateQueries({ queryKey: ['change.get', repo] })
    void qc.invalidateQueries({ queryKey: ['journey.get', repo] })
    void qc.invalidateQueries({ queryKey: ['inbox'] })
  }
  const accept = useMutation({
    /** `head`: the head commit the person was shown (change.get's head.sha) */
    mutationFn: (a: { number: number; head: string; title: string; note?: string; step?: { index: number; total: number; stage: string } | null }) =>
      call('change.accept', { repo, number: a.number, head_sha: a.head, ...(a.note ? { note: a.note } : {}) }),
    onSuccess: (r, a) => confirmAccepted({ repo, title: a.title, result: r }, a.step),
    onError: (e) => toast.error('Could not accept the change', { description: `${e instanceof Error ? e.message : String(e)} Nothing changed.` }),
    onSettled: (_d, _e, a) => refresh(a.number),
  })
  const ask = useMutation({
    mutationFn: (a: { number: number; title: string; note: string; from: string }) => call('change.ask', { repo, number: a.number, note: a.note }),
    onSuccess: (_r, a) => toast.success('Sent back with your note', { description: `${a.from.charAt(0).toUpperCase()}${a.from.slice(1)} is revising "${a.title}". The checks run again when it pushes, and it comes back to you to review.` }),
    onError: (e) => toast.error('Could not send your note', { description: `${e instanceof Error ? e.message : String(e)} Your note is kept; try again.` }),
    onSettled: (_d, _e, a) => refresh(a.number),
  })
  const discard = useMutation({
    mutationFn: (a: { number: number; title: string; reason: string }) => call('change.discard', { repo, number: a.number, reason: a.reason }),
    // what happened to the jobs that were working on it goes first: the person sees it nowhere else at once
    onSuccess: (r, a) => toast(`Discarded "${a.title}"`, { description: [...(r.jobs ?? []), 'Nothing in the design changed. Your reason is in the decisions log, and trace will not open this change again.'].join(' ') }),
    onError: (e) => toast.error('Could not discard the change', { description: `${e instanceof Error ? e.message : String(e)} Your reason is kept; try again.` }),
    onSettled: (_d, _e, a) => refresh(a.number),
  })
  const resolve = useMutation({
    mutationFn: (a: { number: number; title: string }) => call('change.resolve', { repo, number: a.number }),
    onSuccess: (r, a) => (r.conflict
      ? toast.success(r.remade ? 'Made again on the newest design' : 'Bringing it up to date', { description: `"${a.title}": ${r.text}` })
      : toast(`"${a.title}" is up to date`, { description: r.text })),
    onError: (e) => toast.error('Could not bring the change up to date', { description: `${e instanceof Error ? e.message : String(e)}` }),
    onSettled: (_d, _e, a) => refresh(a.number),
  })
  const rerun = useMutation({
    mutationFn: (a: { number: number; title: string }) => call('change.rerun', { repo, number: a.number }),
    onSuccess: (r, a) => toast.success(r.checks.length === 1 ? 'Running the check again' : 'Running the checks again', { description: `"${a.title}": ${r.checks.join(' and ')} ${r.checks.length === 1 ? 'runs' : 'run'} again now. This page updates when ${r.checks.length === 1 ? 'it finishes' : 'they finish'}.` }),
    onError: (e) => toast.error('Could not run the check again', { description: `${e instanceof Error ? e.message : String(e)}` }),
    onSettled: (_d, _e, a) => refresh(a.number),
  })
  return { accept, ask, discard, resolve, rerun }
}
