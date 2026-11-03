/**
 * Which tool call is which run (docs/progress-and-logs.md, "Chat"). Before a backend tool runs, the chat stream sends
 * an AG-UI CUSTOM event `{ name: 'trace.tool_run', value: { toolCallId, repo, run: 'tool:<runId>' } }`. CopilotKit
 * has no hook that hands a tool renderer the custom events of its call, so trace's agent (agent.ts) watches its own
 * event stream and keeps them here, keyed by tool call id, with when each call started (TOOL_CALL_START), so the tool
 * card ticks its time from the real start even when it is drawn again. The card reads both with useToolRun.
 */
import type { BaseEvent } from '@ag-ui/client'
import { createStore, useStore } from '@/lib/store'

export interface ToolRun { repo: string; run: string }

interface ToolRunsState {
  runs: Record<string, ToolRun>
  /** epoch ms each tool call started, as this page saw it */
  started: Record<string, number>
}

export const toolRuns = createStore<ToolRunsState>({ runs: {}, started: {} })

/** The custom event's name. */
export const TOOL_RUN_EVENT = 'trace.tool_run'
/** Keep this many calls' entries (a long conversation). */
const KEEP = 300

const trim = <T,>(o: Record<string, T>): Record<string, T> => {
  const k = Object.keys(o)
  return k.length > KEEP ? Object.fromEntries(k.slice(k.length - KEEP).map((x) => [x, o[x]!])) : o
}

/** One event from the agent's stream: a trace.tool_run names a call's run; a TOOL_CALL_START starts its clock. Pure-ish. */
export function noteEvent(e: BaseEvent, now: number = Date.now()): void {
  const x = e as BaseEvent & { name?: unknown; value?: unknown; toolCallId?: unknown }
  if (x.type === 'CUSTOM' && x.name === TOOL_RUN_EVENT && x.value && typeof x.value === 'object') {
    const v = x.value as { toolCallId?: unknown; repo?: unknown; run?: unknown }
    if (typeof v.toolCallId !== 'string' || typeof v.repo !== 'string' || typeof v.run !== 'string') return
    const id = v.toolCallId
    const run: ToolRun = { repo: v.repo, run: v.run }
    toolRuns.set((s) => ({ runs: trim({ ...s.runs, [id]: run }), started: s.started[id] ? s.started : trim({ ...s.started, [id]: now }) }))
  } else if (x.type === 'TOOL_CALL_START' && typeof x.toolCallId === 'string') {
    const id = x.toolCallId
    toolRuns.set((s) => (s.started[id] ? s : { ...s, started: trim({ ...s.started, [id]: now }) }))
  }
}

/** A tool call's run (when the stream named one) and when it started (when this page saw it start). */
export function useToolRun(toolCallId: string | undefined): { run: ToolRun | null; startedAt: number | null } {
  const s = useStore(toolRuns)
  if (!toolCallId) return { run: null, startedAt: null }
  return { run: s.runs[toolCallId] ?? null, startedAt: s.started[toolCallId] ?? null }
}
