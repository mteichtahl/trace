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

export const panel = createStore<PanelState>({ open: false, width: typeof window === 'undefined' ? 380 : readWidth(), threads: {}, history: false })
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
export const setThread = (repo: string, id: string | undefined) => panel.set((s) => ({ ...s, threads: { ...s.threads, [repo]: id }, history: false }))
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

export const loadThread = (repo: string, id: string) => call('chats.get', { repo, id })
