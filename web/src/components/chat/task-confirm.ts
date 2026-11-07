/**
 * A confirmed start_task, kept apart from the card and the chat run that drew it (test log R25).
 *
 * The person's Confirm calls `task` from here, not from the card: the call, its answer and what the person is told
 * do not depend on the card staying on screen or the chat's run going on. A card that unmounts while the call is on
 * its way (the person opened another step) still gets its answer here, and the answer is said in a toast: started,
 * queued, or not started and why. A failure is never silent.
 *
 *   key       the tool call's id: one confirm per offer, so a second click (or the card drawn again) never starts the
 *             work twice
 *   kept      the answer is kept in this browser per offer, so a kept conversation opened again (a reload, another
 *             visit) shows what the Confirm came to, not the offer as never confirmed
 *   respond   trace is answered with it when the conversation can still take it (the human-in-the-loop resume); when
 *             it cannot, the work has started all the same
 */
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { call } from '@/lib/api'
import type { TaskAnswer } from './cards'

export interface TaskConfirm { busy: boolean; answer?: TaskAnswer }

const PREFIX = 'trace.task-confirm.'
const state = new Map<string, TaskConfirm>()
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

const stored = (key: string): TaskAnswer | undefined => {
  try {
    const v = localStorage.getItem(PREFIX + key)
    return v ? (JSON.parse(v) as TaskAnswer) : undefined
  } catch {
    return undefined
  }
}
const store = (key: string, answer: TaskAnswer) => {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(answer)) } catch { /* private window: kept for this visit only */ }
}

/** Where a confirm stands: on its way, answered (here or kept from an earlier visit), or not confirmed (undefined). */
export function confirmOf(key: string | undefined): TaskConfirm | undefined {
  if (!key) return undefined
  const s = state.get(key)
  if (s) return s
  const answer = stored(key)
  if (!answer) return undefined
  const kept = { busy: false, answer }
  state.set(key, kept)
  return kept
}

export function useTaskConfirm(key: string | undefined): TaskConfirm | undefined {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => confirmOf(key))
}

/** What the person is told of the answer, at once, wherever they are in the app. */
export function tellAnswer(a: TaskAnswer): void {
  if (!a.confirmed) return
  if (a.accepted && a.queued) toast('The work is queued.', { description: [a.routed, a.reason ?? 'It starts by itself once the project\'s agent is ready.'].filter(Boolean).join(' ') })
  else if (a.accepted) toast('trace started the work.', { description: a.routed ? `${a.routed} It shows under Trace is doing on the project.` : 'It shows under Trace is doing on the project.' })
  else toast.error('trace could not start the work.', { description: a.reason ?? 'The job was not accepted.' })
}

export interface ConfirmTask { repo: string; request: string; agent?: string | undefined; branch?: string | undefined }

/**
 * Start the work once, as the person: `task`, then the answer kept, told and handed to trace (`respond`, when the
 * conversation can still take it). Answers the answer.
 */
export async function confirmTask(key: string, t: ConfirmTask, respond?: (a: TaskAnswer) => unknown): Promise<TaskAnswer | undefined> {
  const now = confirmOf(key)
  if (now) return now.answer
  state.set(key, { busy: true })
  emit()
  let answer: TaskAnswer
  try {
    const r = await call('task', { repo: t.repo, request: t.request, ...(t.agent ? { agent: t.agent } : {}), ...(t.branch ? { branch: t.branch } : {}) })
    answer = {
      confirmed: true, accepted: r.accepted, ...(r.jobId ? { jobId: r.jobId } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.queued ? { queued: true } : {}),
      // sent to the specialist that owns the record it changes, not the one offered (test log R26)
      ...(r.agent ? { agent: r.agent } : {}), ...(r.routed ? { routed: r.routed } : {}),
    }
  } catch (e) {
    answer = { confirmed: true, accepted: false, reason: e instanceof Error ? e.message : 'the task could not be started' }
  }
  state.set(key, { busy: false, answer })
  store(key, answer)
  emit()
  tellAnswer(answer)
  try {
    await respond?.(answer)
  } catch {
    // the conversation could not take the answer: the work is started (or not) all the same, and the card says which
  }
  return answer
}

/** The person cancelled the offer: kept like an answer, so it is not offered again on this offer. */
export function cancelTask(key: string | undefined, answer: TaskAnswer, respond?: (a: TaskAnswer) => unknown): void {
  if (key) {
    state.set(key, { busy: false, answer })
    store(key, answer)
    emit()
  }
  void Promise.resolve(respond?.(answer)).catch(() => undefined)
}

/** For tests: forget every confirm. */
export function resetTaskConfirms(): void {
  state.clear()
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k) } catch { /* none kept */ }
  emit()
}
