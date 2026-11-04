/**
 * The Ask trace panel's own state (open, width, which project and thread) and the thread history hooks. The panel
 * stays open across routes; its width is kept per device.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { call } from '@/lib/api'
import { q } from '@/lib/queries'
import { createStore, useStore } from '@/lib/store'

export interface PanelState {
  open: boolean
  /** px, 380–560 */
  width: number
  /** the thread open per project */
  threads: Record<string, string | undefined>
  /**
   * per project, bumped each time a person opens a thread or a new conversation (or the last one is reopened): the
   * conversation view is rebuilt then, and only then. A first message that creates its thread keeps the view it was
   * typed in, so a reply already streaming into it is not thrown away.
   */
  opened: Record<string, number>
  /** the history list is showing */
  history: boolean
}

const WIDTH_KEY = 'trace.chat.width'
const readWidth = (): number => {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY))
    return w >= 380 && w <= 560 ? w : 380
  } catch {
    return 380
  }
}

export const panel = createStore<PanelState>({ open: false, width: typeof window === 'undefined' ? 380 : readWidth(), threads: {}, opened: {}, history: false })
export const usePanel = () => useStore(panel)

export const openPanel = (open?: boolean) => panel.set((s) => ({ ...s, open: open ?? !s.open }))

/** A question a screen hands to Ask trace ("Ask trace about these results"): the panel opens and sends it once. */
export const pendingAsk = createStore<{ id: number; text: string } | null>(null)
export function askTrace(text: string) {
  pendingAsk.set({ id: Date.now(), text })
  panel.set((s) => ({ ...s, open: true, history: false }))
}
export function setPanelWidth(width: number) {
  const w = Math.round(Math.min(560, Math.max(380, width)))
  panel.set((s) => ({ ...s, width: w }))
  try {
    localStorage.setItem(WIDTH_KEY, String(w))
  } catch {
    // per device only
  }
}
/** Open thread `id` (undefined: a new conversation) on the project, rebuilding the conversation view. */
export const setThread = (repo: string, id: string | undefined) =>
  panel.set((s) => ({ ...s, threads: { ...s.threads, [repo]: id }, opened: { ...s.opened, [repo]: (s.opened[repo] ?? 0) + 1 }, history: false }))
/** The conversation being shown just got its thread (its first message was kept): record it, keeping the view. */
export const threadCreated = (repo: string, id: string) => panel.set((s) => ({ ...s, threads: { ...s.threads, [repo]: id } }))
/**
 * Reopen the project's last thread, found by a lookup started when the panel opened: only when nothing has been chosen
 * or started on the project since. The lookup can answer after a person has already sent a message in the new
 * conversation the panel showed meanwhile; switching then would hide that message behind an older conversation.
 */
export const reopenLast = (repo: string, id: string | undefined) => {
  if (repo in panel.get().threads) return
  setThread(repo, id)
}
export const showHistory = (history: boolean) => panel.set((s) => ({ ...s, history }))

export const useThreads = (repo: string | undefined) => useQuery({ ...q('chats.list', { repo: repo ?? '' }), enabled: !!repo })

/** The person's own sent messages on this project, newest first (for Up/Down recall). */
export function useRecallHistory(repo: string | undefined) {
  const qc = useQueryClient()
  const query = useQuery({ ...q('chats.recall', { repo: repo ?? '', limit: 200 }), enabled: !!repo, staleTime: 60_000 })
  const push = useCallback(
    (text: string) => {
      if (!repo) return
      qc.setQueryData<string[]>(q('chats.recall', { repo, limit: 200 }).queryKey, (h) => [text, ...(h ?? []).filter((x, i) => !(i === 0 && x === text))])
    },
    [qc, repo],
  )
  return { history: query.data ?? [], push }
}

export const loadThread = (repo: string, id: string) => call('chats.get', { repo, thread: id })
