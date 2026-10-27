/** The memory commands: `tracectl remote memory …` (what it asks the API) and `tracectl memory …` on a local installation. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BedrockAgentCoreClient, GetMemoryRecordCommand } from '@aws-sdk/client-bedrock-agentcore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryState } from '../../src/agents/runtime/memory-state.js'

const calls: { action: string; args: unknown }[] = []
vi.mock('../../src/login/invoke.js', () => ({
  ApiError: class ApiError extends Error {},
  invokeApi: async (action: string, args: unknown) => {
    calls.push({ action, args })
    if (action === 'memory.list') {
      return { enabled: true, records: [
        { id: 'mem-a', strategy: 'facts', actor: 'worker', text: 'A fact.', created_at: '2026-10-01T00:00:00.000Z', active: true },
        { id: 'mem-b', strategy: 'facts', actor: 'worker', text: 'Old fact.', created_at: '2026-09-01T00:00:00.000Z', active: false, inactive: { reason: 'wrong', by: 'abcd', by_you: true, at: '2026-10-02T00:00:00.000Z' } },
      ] }
    }
    return { id: (args as { recordId: string }).recordId, changed: true }
  },
}))

const { cmdMemory, remoteMemory } = await import('../../src/login/memory.js')
const { cmdRemote } = await import('../../src/login/commands.js')

let printed: string[] = []
beforeEach(() => {
  calls.length = 0
  printed = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { printed.push(String(s)); return true }) as never)
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { printed.push(String(s)); return true }) as never)
})
afterEach(() => { vi.restoreAllMocks() })

describe('tracectl remote memory', () => {
  it('lists (with --all, inactive ones marked), deactivates with a reason, reactivates', async () => {
    expect(await cmdRemote(['memory', 'list', 'Acme/Board', '--all'])).toBe(0)
    expect(calls[0]).toEqual({ action: 'memory.list', args: { repo: 'Acme/Board', includeInactive: true } })
    expect(printed.join('')).toMatch(/mem-b .*\[inactive\] Old fact\.[\s\S]*inactive since 2026-10-02 00:00 by you: wrong/)
    expect(await remoteMemory(['deactivate', 'acme/board', 'mem-a', '--reason', 'stale'])).toBe(0)
    expect(calls[1]).toEqual({ action: 'memory.deactivate', args: { repo: 'acme/board', recordId: 'mem-a', reason: 'stale' } })
    expect(await remoteMemory(['reactivate', 'acme/board', 'mem-a'])).toBe(0)
    expect(calls[2]).toEqual({ action: 'memory.reactivate', args: { repo: 'acme/board', recordId: 'mem-a' } })
  })

  it('needs a reason to deactivate, and says how to use it', async () => {
    expect(await remoteMemory(['deactivate', 'acme/board', 'mem-a'])).toBe(2)
    expect(await remoteMemory(['forget', 'acme/board'])).toBe(2)
    expect(calls).toHaveLength(0)
    expect(printed.join('')).toMatch(/--reason/)
  })
})

describe('tracectl memory (local)', () => {
  it('marks this project\'s records in the local store, after finding them in its memory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'trace-cli-ms-'))
    const env = { TRACE_MEMORY_ID: 'trace_m_0000aaaa-abcdefghij', AWS_REGION: 'us-east-1', TRACE_MEMORY_STATE_HOME: home }
    const ns = '/trace/acme/board/local/facts/'
    vi.spyOn(BedrockAgentCoreClient.prototype, 'send').mockImplementation((async (c: unknown) => {
      if (c instanceof GetMemoryRecordCommand) {
        if (c.input.memoryRecordId !== 'mem-a') throw Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' })
        return { memoryRecord: { memoryRecordId: 'mem-a', content: { text: 'A fact.' }, namespaces: [ns] } }
      }
      return { memoryRecordSummaries: [{ memoryRecordId: 'mem-a', content: { text: 'A fact.' }, namespaces: [ns] }] }
    }) as never)
    process.env.TRACE_MEMORY_STATE_HOME = home
    expect(await cmdMemory(['deactivate', 'mem-a', '--reason', 'wrong', '--repo', 'acme/board'], env)).toBe(0)
    expect((await new MemoryState('acme/board').get('mem-a'))?.namespace).toBe(ns)
    expect(await cmdMemory(['deactivate', 'mem-zzz', '--reason', 'wrong', '--repo', 'acme/board'], env)).toBe(1)
    printed = []
    expect(await cmdMemory(['list', '--repo', 'acme/board'], env)).toBe(0)
    expect(printed.join('')).toContain('(no records)')
    expect(await cmdMemory(['reactivate', 'mem-a', '--repo', 'acme/board'], env)).toBe(0)
    expect(await new MemoryState('acme/board').get('mem-a')).toBeNull()
    expect(await cmdMemory(['list', '--repo', 'acme/board'], {})).toBe(1)
    delete process.env.TRACE_MEMORY_STATE_HOME
  })
})
