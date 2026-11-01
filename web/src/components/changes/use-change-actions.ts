/**
 * Accept, ask for changes, discard: one place for the three acts on a change, wherever they are taken (the review
 * page, the next-step card, Home's Needs you). Each refreshes the change, its project's list, the journey and the inbox,
 * and confirms with a toast that says what moved and what trace starts next.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { call } from '@/lib/api'
import type { ChangeAccepted, InboxItem } from '@/lib/types'

/** The toast after accepting: what moved, and what trace starts next. */
export function acceptedWords(title: string, r: Pick<ChangeAccepted, 'next' | 'stage'>, step?: { index: number; total: number; stage: string } | null): { title: string; description: string } {
  const moved = step ? `${step.stage} is now on step ${Math.min(step.total, step.index + 1)} of ${step.total}.` : `"${title}" is part of the design now.`
  return { title: 'Accepted into the design', description: `${moved} ${r.next || 'trace carries on with the next step.'}`.trim() }
}

/** Accept a change from a Needs you card (any project): the same toast, and the item leaves the list. */
export function useAcceptFromInbox() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const run = (item: InboxItem, title: string) => {
    if (!item.change) return
    const { repo, number } = item.change
    setBusy(item.id)
    call('change.accept', { repo, number })
      .then((r) => {
        const w = acceptedWords(title, r)
        toast.success(w.title, { description: `${item.project}: ${w.description}` })
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
    mutationFn: (a: { number: number; title: string; note?: string; step?: { index: number; total: number; stage: string } | null }) =>
      call('change.accept', { repo, number: a.number, ...(a.note ? { note: a.note } : {}) }),
    onSuccess: (r, a) => { const w = acceptedWords(a.title, r, a.step); toast.success(w.title, { description: w.description }) },
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
    onSuccess: (_r, a) => toast(`Discarded "${a.title}"`, { description: 'Nothing in the design changed. Your reason is in the decisions log, and trace will not start this work again on its own.' }),
    onError: (e) => toast.error('Could not discard the change', { description: `${e instanceof Error ? e.message : String(e)} Your reason is kept; try again.` }),
    onSettled: (_d, _e, a) => refresh(a.number),
  })
  return { accept, ask, discard }
}
