import { describe, expect, it } from 'vitest'
import { noteEvent, toolRuns } from './tool-runs'

describe('trace.tool_run names a tool call\'s run', () => {
  it('keeps the run by tool call id, and when the call started', () => {
    noteEvent({ type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'sim' } as never, 1_000)
    noteEvent({ type: 'CUSTOM', name: 'trace.tool_run', value: { toolCallId: 'c1', repo: 'a/b', run: 'tool:t1' } } as never, 2_000)
    expect(toolRuns.get().runs.c1).toEqual({ repo: 'a/b', run: 'tool:t1' })
    expect(toolRuns.get().started.c1).toBe(1_000)
  })
  it('ignores other custom events and malformed values', () => {
    noteEvent({ type: 'CUSTOM', name: 'something.else', value: { toolCallId: 'c2', repo: 'a/b', run: 'tool:t2' } } as never)
    noteEvent({ type: 'CUSTOM', name: 'trace.tool_run', value: { toolCallId: 'c3' } } as never)
    expect(toolRuns.get().runs.c2).toBeUndefined()
    expect(toolRuns.get().runs.c3).toBeUndefined()
  })
})
