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

/** The most characters one entry's value may have: the server refuses a run with a longer one (CONTEXT_VALUE_MAX in
 * src/web/agui.ts; keep the two equal). */
export const CONTEXT_VALUE_MAX = 100_000

/** An entry's value as the agent is given it: JSON for objects, cut short (and saying so) past CONTEXT_VALUE_MAX so the
 * chat still runs when a screen's context grows large. */
export function contextValue(value: ContextEntry['value'], max = CONTEXT_VALUE_MAX): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= max) return text
  const note = `… [cut short: ${text.length - max} more characters not shown]`
  return text.slice(0, max - note.length) + note
}

/** Keeps CopilotKit's context in step with the chips. Mount once inside the CopilotKit provider. */
export function ContextBridge() {
  const { copilotkit } = useCopilotKit()
  const { entries, removed } = useContextEntries()
  useEffect(() => {
    const ids = entries
      .filter((e) => !removed.has(e.id))
      .map((e) => copilotkit.addContext({ description: e.description, value: contextValue(e.value) }))
    return () => ids.forEach((i) => copilotkit.removeContext(i))
  }, [copilotkit, entries, removed])
  return null
}
