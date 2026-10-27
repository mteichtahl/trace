/**
 * What the agent knows about where the person is. Each screen registers entries with `useTraceContext` (project,
 * revision, stage, tab, the item selected); they show as removable chips above the message box, and only the entries
 * the person has not removed are given to the agent (synced into CopilotKit's context by <ContextBridge/>, the
 * same store `useAgentContext` writes to).
 */
import { useCopilotKit } from '@copilotkit/react-core/v2'
import { useEffect, useId } from 'react'
import { createStore, useStore } from '@/lib/store'

export interface ContextEntry {
  id: string
  /** the chip's words ("Soil sensor", "Power sheet", "R-006") */
  label: string
  /** what it is, for the agent ("The project the person is looking at") */
  description: string
  value: string | number | boolean | Record<string, unknown>
  /** mono chip (ids, refs) */
  mono?: boolean
}

interface ContextState {
  entries: ContextEntry[]
  removed: Set<string>
}

export const contextStore = createStore<ContextState>({ entries: [], removed: new Set() })
export const useContextEntries = () => useStore(contextStore)

/** Tell the agent about something on this screen while it is mounted. */
export function useTraceContext(entry: Omit<ContextEntry, 'id'> | null, key?: string) {
  const auto = useId()
  const id = key ?? auto
  const json = entry ? JSON.stringify(entry) : null
  useEffect(() => {
    if (!json) return
    const e = { ...(JSON.parse(json) as Omit<ContextEntry, 'id'>), id }
    contextStore.set((s) => ({ ...s, entries: [...s.entries.filter((x) => x.id !== id), e] }))
    return () => contextStore.set((s) => ({ ...s, entries: s.entries.filter((x) => x.id !== id) }))
  }, [id, json])
}

export const removeContext = (id: string) => contextStore.set((s) => ({ ...s, removed: new Set([...s.removed, id]) }))
export const restoreContext = () => contextStore.set((s) => ({ ...s, removed: new Set() }))

/** Keeps CopilotKit's context in step with the chips. Mount once inside the CopilotKit provider. */
export function ContextBridge() {
  const { copilotkit } = useCopilotKit()
  const { entries, removed } = useContextEntries()
  useEffect(() => {
    const ids = entries
      .filter((e) => !removed.has(e.id))
      .map((e) => copilotkit.addContext({ description: e.description, value: typeof e.value === 'string' ? e.value : JSON.stringify(e.value) }))
    return () => ids.forEach((i) => copilotkit.removeContext(i))
  }, [copilotkit, entries, removed])
  return null
}
