/**
 * Accept, ask for changes, discard, bring a change in conflict up to date, and run again a check that did not run
 * properly (GitHub busy, the runner lost: change.rerun): one place for the acts on a change, wherever they are taken
 * (the review page, the next-step card, Home's Needs you). Each refreshes the change, its project's list, the journey and the inbox,
 * and confirms with a toast that says what moved and what trace starts next.
 *
 * Accepting sends the head commit the person was shown (change.get's head.sha): the API refuses a change that moved
 * since ("It changed since you looked at it"), so nobody accepts work they did not see. A card that shows no change
 * detail (Needs you, the Overview's next step) reads change.get again first and sends what that says (acceptLatest).
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { ApiError, type ResultOf, call } from '@/lib/api'
import { isUpdating } from '@/lib/http'
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

/** Why an accept did not go through, in the API's words (or the read's), for the toast and the card. */
export function refusalWords(e: unknown): string {
  const said = (e instanceof Error ? e.message : String(e ?? '')).trim()
  const why = said || 'trace did not say why.'
  // trace updating: its words say what is known of the change (acceptWhileUpdating), and "Nothing changed" may not be
  if (isUpdating(e)) return `${why}${/[.!?]$/.test(why) ? '' : '.'}`
  return `${why}${/[.!?]$/.test(why) ? '' : '.'} Nothing changed.`
}

/** The waits before looking again at a change whose accept met trace updating: about a minute in all. */
export const ACCEPT_AGAIN_MS = [3_000, 6_000, 12_000, 20_000, 20_000] as const

/** Said when trace is still updating after ACCEPT_AGAIN_MS: whether the change is known to be still open or not. */
export const ACCEPT_UPDATING = {
  open: 'trace is updating, so the change was not accepted yet. It is still waiting for you: try again in a minute.',
  unknown: 'trace is updating, so it could not tell yet whether the change was accepted. Look at it again in a minute before you accept it again.',
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Accept the head the person was shown, through a redeploy of the API (test-esp32 #223: "424" while three builds were
 * in flight). An answer that says trace is updating does not say whether the merge happened, so the accept is never
 * sent again blindly: trace waits, reads the change, and sends it again only while it is still open at that same
 * head (the API refuses any other head, and GitHub merges only that commit). Merged in the meantime: it is accepted.
 * Any other refusal is thrown at once, as it was.
 */
export async function acceptWhileUpdating(
  a: { repo: string; number: number; head: string; note?: string },
  o: { again?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ChangeAccepted> {
  const again = o.again ?? ACCEPT_AGAIN_MS
  const sleep = o.sleep ?? pause
  const send = () => call('change.accept', { repo: a.repo, number: a.number, head_sha: a.head, ...(a.note ? { note: a.note } : {}) })
  let wait = 0
  for (;;) {
    try {
      return await send()
    } catch (e) {
      if (!isUpdating(e)) throw e
    }
    // look at the change until trace answers, then send it again only if it is still open at the same head
    for (;;) {
      if (wait >= again.length) throw new ApiError(ACCEPT_UPDATING.unknown, 503, 'updating')
      await sleep(again[wait++]!)
      let d: ResultOf<'change.get'>
      try {
        d = await call('change.get', { repo: a.repo, number: a.number })
      } catch (e) {
        if (isUpdating(e)) continue
        throw e
      }
      if (d.state === 'merged') return { merged: true, sha: a.head, stage: '', next: '' }
      if (d.state === 'closed') throw new Error('It was discarded, so there is nothing to accept.')
      if (d.head?.sha !== a.head) throw new Error('It changed since you looked at it. Look again before accepting.')
      // still open, as it was: sent again while there is time left; otherwise said as it is
      if (wait >= again.length) throw new ApiError(ACCEPT_UPDATING.open, 503, 'updating')
      break
    }
  }
}

/**
 * Accept a change from a card that shows no detail of its own (the Overview's next step, Home's Needs you): read
 * change.get again now (a copy kept in the cache can be minutes old: a "bring up to date" since moved its head, test-esp32
 * #185, #203), then accept the head that read says. A change that is no longer open, or that the read says cannot be
 * accepted now, is refused here with the API's own blockers, never sent and never dropped without a word.
 */
export async function acceptLatest(qc: QueryClient, repo: string, number: number): Promise<ChangeAccepted> {
  const d = await qc.fetchQuery({ ...q('change.get', { repo, number }), staleTime: 0 })
  if (d.state === 'merged') throw new Error('It is already accepted.')
  if (d.state === 'closed') throw new Error('It was discarded, so there is nothing to accept.')
  if (!d.head?.sha) throw new Error('trace could not read which version of it to accept. Open the change and accept it there.')
  if (!d.may_accept) throw new Error(`It cannot be accepted now. ${(d.blockers ?? []).join(' ')}`.trim())
  return acceptWhileUpdating({ repo, number, head: d.head.sha })
}

const refreshAfterAccept = (qc: QueryClient, repo: string) => {
  for (const k of [['inbox'], ['journey.get', repo], ['changes.list', repo], ['change.get', repo]]) void qc.invalidateQueries({ queryKey: k }, { cancelRefetch: false })
}

export function useAcceptFromInbox() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const run = (item: InboxItem, title: string) => {
    // the card draws its Accept only for an item with a change; anything else is said, not dropped
    if (!item.change) {
      toast.error('Could not accept the change', { description: 'This item names no change. Open it to review the change there.' })
      return
    }
    const { repo, number } = item.change
    setBusy(item.id)
    acceptLatest(qc, repo, number)
      .then((r) => {
        confirmAccepted({ repo, project: item.project, title, result: r })
        qc.setQueryData<InboxItem[]>(['inbox', {}], (xs) => xs?.filter((x) => x.id !== item.id))
      })
      .catch((e: unknown) => toast.error('Could not accept the change', { description: refusalWords(e) }))
      .finally(() => {
        setBusy(null)
        refreshAfterAccept(qc, repo)
      })
  }
  return { run, busy }
}

/**
 * The Overview's "Accept now" (the next-step card): the same accept as Needs you (acceptLatest), with its progress
 * (`busy` from the click until the API answers: the read, then the merge, up to about 20 s while GitHub takes the checks
 * in) and, when it is refused, the API's reason kept on the card (`refused`) as well as in a toast, until the next try.
 */
export function useAcceptNow(repo: string) {
  const qc = useQueryClient()
  const accept = useMutation({
    mutationFn: (a: { number: number; title: string; step?: { index: number; total: number; stage: string } | null }) => acceptLatest(qc, repo, a.number),
    onSuccess: (r, a) => confirmAccepted({ repo, title: a.title, result: r }, a.step),
    onError: (e) => toast.error('Could not accept the change', { description: refusalWords(e) }),
    onSettled: () => refreshAfterAccept(qc, repo),
  })
  return {
    run: (a: { number: number; title: string; step?: { index: number; total: number; stage: string } | null }) => {
      // one accept at a time: the button is disabled while one is on its way, so a second click has nothing to say
      if (accept.isPending) return
      accept.mutate(a)
    },
    busy: accept.isPending,
    /** the change the last refusal was for, and the reason in the API's words */
    refused: accept.isError && accept.variables ? { number: accept.variables.number, text: refusalWords(accept.error) } : null,
  }
}

export function useChangeActions(repo: string) {
  const qc = useQueryClient()
  // what an ok answer changed is read again by lib/after-write.ts; this covers a failed act too, without starting
  // again a refetch already on its way
  const refresh = (number?: number) => {
    const again = { cancelRefetch: false }
    void qc.invalidateQueries({ queryKey: ['changes.list', repo] }, again)
    if (number !== undefined) void qc.invalidateQueries({ queryKey: ['change.get', repo] }, again)
    void qc.invalidateQueries({ queryKey: ['journey.get', repo] }, again)
    void qc.invalidateQueries({ queryKey: ['inbox'] }, again)
  }
  const accept = useMutation({
    /** `head`: the head commit the person was shown (change.get's head.sha) */
    mutationFn: (a: { number: number; head: string; title: string; note?: string; step?: { index: number; total: number; stage: string } | null }) =>
      acceptWhileUpdating({ repo, number: a.number, head: a.head, ...(a.note ? { note: a.note } : {}) }),
    onSuccess: (r, a) => confirmAccepted({ repo, title: a.title, result: r }, a.step),
    onError: (e) => toast.error('Could not accept the change', { description: refusalWords(e) }),
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
    onSuccess: (r, a) => (r.summary
      // checks no runner picked up: cancelled and run again, in the API's words
      ? toast.success('Running the checks again', { description: `"${a.title}": ${r.summary}` })
      : toast.success(r.checks.length === 1 ? 'Running the check again' : 'Running the checks again', { description: `"${a.title}": ${r.checks.join(' and ')} ${r.checks.length === 1 ? 'runs' : 'run'} again now. This page updates when ${r.checks.length === 1 ? 'it finishes' : 'they finish'}.` })),
    onError: (e) => toast.error('Could not run the check again', { description: `${e instanceof Error ? e.message : String(e)}` }),
    onSettled: (_d, _e, a) => refresh(a.number),
  })
  return { accept, ask, discard, resolve, rerun }
}
