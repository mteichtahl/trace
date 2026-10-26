/**
 * memory.deactivate / memory.reactivate through the API: who may mark what (the access matrix), that a record must
 * be the project's own and visible to the person (else the same 403 "no access"), that the project check comes
 * before any AWS call, and that memory.list / memory.recall leave inactive records out (or show them, marked).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GetMemoryRecordCommand, ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MemoryState } from '../../src/agents/runtime/memory-state.js'
import { AgentMemory, type ProjectMemories, type SendClient, agentActor, namespaceOf, personActor, personHash } from '../../src/agents/runtime/memory.js'
import { type ActionDeps, type Context, needOf, perform } from '../../src/api/actions.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'admin-1', email: 'admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'user-1', email: 'user-1@example.com', groups: ['trace-users'] }
const GUEST = { sub: 'guest-1', email: 'guest-1@example.com', groups: ['trace-guests'] }
const OUTSIDER = { sub: 'user-2', email: 'user-2@example.com', groups: ['trace-users'] }

const BOARD = 'acme/board'
const guestPerson = personActor(BOARD, GUEST.email)
const otherPerson = personActor(BOARD, 'someone@example.com')

interface Rec { id: string; ns: string; text: string }
const BY_MEMORY: Record<string, Rec[]> = {
  'trace_m_0000aaaa-abcdefghij': [
    { id: 'mem-fact', ns: namespaceOf(agentActor(BOARD, 'worker'), 'facts'), text: 'The board has a 3V3 LDO.' },
    { id: 'mem-render', ns: namespaceOf(agentActor(BOARD, 'render'), 'preferences'), text: 'Renders at 1920x1200.' },
    { id: 'mem-guest', ns: namespaceOf(guestPerson, 'preferences'), text: 'Guest likes terse PRs.' },
    { id: 'mem-other', ns: namespaceOf(otherPerson, 'preferences'), text: 'Someone else likes long PRs.' },
  ],
  'trace_m_0000bbbb-abcdefghij': [{ id: 'mem-secret', ns: '/trace/acme/secret/worker/facts/', text: 'Secret project.' }],
}

const sent: unknown[] = []
const clientFor = (memoryId: string): SendClient => ({
  send: async (cmd) => {
    sent.push(cmd)
    const recs = BY_MEMORY[memoryId] ?? []
    const view = (r: Rec, i: number) => ({ memoryRecordId: r.id, content: { text: r.text }, namespaces: [r.ns], createdAt: new Date(1000 * (i + 1)), score: 1 - i / 10 })
    if (cmd instanceof GetMemoryRecordCommand) {
      const i = recs.findIndex((r) => r.id === cmd.input.memoryRecordId)
      if (i < 0) throw Object.assign(new Error('no such record'), { name: 'ResourceNotFoundException' })
      return { memoryRecord: view(recs[i] as Rec, i) }
    }
    const ns = 'namespace' in cmd.input ? cmd.input.namespace ?? '' : ''
    const k = cmd instanceof RetrieveMemoryRecordsCommand ? cmd.input.searchCriteria?.topK ?? 20 : 100
    return { memoryRecordSummaries: recs.map(view).filter((r) => r.namespaces[0]?.startsWith(ns)).slice(0, k) }
  },
})
const memories: ProjectMemories = {
  forProject: (repo) => {
    const id = ({ 'acme/board': 'trace_m_0000aaaa-abcdefghij', 'acme/secret': 'trace_m_0000bbbb-abcdefghij' } as Record<string, string>)[repo.toLowerCase()]
    return id ? new AgentMemory(id, clientFor(id)) : null
  },
}
const deps: ActionDeps = {
  github: async () => new FakeGitHub([BOARD, 'acme/secret']),
  cognito: () => new FakeCognito(),
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]),
  scratch: mkdtempSync(join(tmpdir(), 'trace-api-inactive-')),
  memory: () => memories,
}
const ctx = (principal: Context['principal'], d: ActionDeps = deps): Context => ({ principal, deps: d })
const deactivate = (p: Context['principal'], recordId: string, repo = BOARD) => perform('memory.deactivate', { repo, recordId, reason: 'out of date' }, ctx(p))
const reactivate = (p: Context['principal'], recordId: string, repo = BOARD) => perform('memory.reactivate', { repo, recordId }, ctx(p))
const listed = async (p: Context['principal'], extra: Record<string, unknown> = {}) =>
  ((await perform('memory.list', { repo: BOARD, ...extra }, ctx(p))).result as { records: { id: string; active: boolean; inactive?: { reason: string; by: string; by_you: boolean } }[] }).records

beforeAll(async () => {
  for (const [sub, email] of [['user-1', USER.email], ['guest-1', GUEST.email]] as const) await assign(ADMIN, { sub, email }, BOARD)
  await assign(ADMIN, { sub: 'user-2', email: OUTSIDER.email }, 'acme/secret')
})
beforeEach(() => {
  // every test starts with no marks
  process.env.TRACE_MEMORY_STATE_HOME = mkdtempSync(join(tmpdir(), 'trace-api-ms-'))
  sent.length = 0
})

describe('who may mark a memory inactive', () => {
  it('publishes the actions as needing read; the rest is decided once the record is found', () => {
    expect(needOf('memory.deactivate')).toBe('read')
    expect(needOf('memory.reactivate')).toBe('read')
  })

  it('a user with write access: any agent record of the project', async () => {
    const r = (await deactivate(USER, 'mem-fact')).result
    expect(r).toMatchObject({ id: 'mem-fact', actor: 'worker', changed: true, active: false, inactive: { reason: 'out of date', by: personHash(USER.email), by_you: true } })
    expect((await deactivate(USER, 'mem-fact')).result).toMatchObject({ changed: false })
  })

  it('a guest: only their own preferences (decided: their person actor, readable only by them, is theirs to turn off)', async () => {
    await expect(deactivate(GUEST, 'mem-fact')).rejects.toThrow(AccessDenied)
    await expect(deactivate(GUEST, 'mem-render')).rejects.toThrow(/no write access/)
    expect((await deactivate(GUEST, 'mem-guest')).result).toMatchObject({ changed: true, actor: `person/${guestPerson.name}` })
    // and someone else's preferences are not even visible to them: "no access"
    await expect(deactivate(GUEST, 'mem-other')).rejects.toThrow(/^no access$/)
    expect(await new MemoryState(BOARD).inactive()).toEqual(new Map([['mem-guest', expect.objectContaining({ by: personHash(GUEST.email) })]]))
  })

  it('a user may not mark another person\'s preferences (they cannot see them); an admin may mark anything', async () => {
    await expect(deactivate(USER, 'mem-other')).rejects.toThrow(/^no access$/)
    expect((await deactivate(ADMIN, 'mem-other')).result).toMatchObject({ changed: true })
    expect((await deactivate(ADMIN, 'mem-secret', 'acme/secret')).result).toMatchObject({ changed: true })
  })

  it('refuses another project\'s record id with the same "no access", and writes no mark', async () => {
    for (const p of [USER, ADMIN]) await expect(deactivate(p, 'mem-secret')).rejects.toThrow(/^no access$/)
    await expect(reactivate(ADMIN, 'mem-secret')).rejects.toThrow(/^no access$/)
    await expect(deactivate(ADMIN, 'mem-made-up')).rejects.toThrow(/^no access$/)
    expect((await new MemoryState(BOARD).inactive()).size).toBe(0)
  })

  it('checks the project before any AWS call: not assigned, no memory, or not a project', async () => {
    await expect(deactivate(OUTSIDER, 'mem-fact')).rejects.toThrow(AccessDenied)
    await expect(deactivate(GUEST, 'mem-secret', 'acme/secret')).rejects.toThrow(AccessDenied)
    await expect(reactivate(OUTSIDER, 'mem-fact')).rejects.toThrow(AccessDenied)
    await expect(deactivate(ADMIN, 'mem-fact', 'acme/nothing')).rejects.toThrow(/^no access$/)
    expect(sent).toHaveLength(0)
    await expect(perform('memory.deactivate', { repo: BOARD, recordId: 'mem-fact' }, ctx(USER))).rejects.toThrow(/reason/)
    await expect(perform('memory.deactivate', { repo: BOARD, recordId: '../../x', reason: 'r' }, ctx(USER))).rejects.toThrow(/record id/)
  })

  it('says so without memory in the installation', async () => {
    await expect(perform('memory.deactivate', { repo: BOARD, recordId: 'mem-fact', reason: 'r' }, ctx(USER, { ...deps, memory: () => null }))).rejects.toThrow(/not enabled/)
  })
})

describe('inactive records through the API', () => {
  it('are left out of memory.list and memory.recall, and shown marked with includeInactive', async () => {
    await deactivate(USER, 'mem-fact')
    expect((await listed(GUEST)).map((r) => r.id).sort()).toEqual(['mem-guest', 'mem-render'])
    const all = await listed(GUEST, { includeInactive: true })
    expect(all.find((r) => r.id === 'mem-fact')).toMatchObject({ active: false, inactive: { reason: 'out of date', by: personHash(USER.email), by_you: false } })
    expect(all.find((r) => r.id === 'mem-render')).toMatchObject({ active: true })
    const recalled = (await perform('memory.recall', { repo: BOARD, query: 'ldo', top_k: 2 }, ctx(ADMIN))).result as { records: { id: string }[] }
    // refilled: two asked, two given, the inactive one not among them
    expect(recalled.records.map((r) => r.id)).toEqual(['mem-render', 'mem-guest'])
    const retrieve = sent.find((c): c is RetrieveMemoryRecordsCommand => c instanceof RetrieveMemoryRecordsCommand)
    expect(retrieve?.input.searchCriteria?.topK).toBe(3)
    expect(sent.some((c) => c instanceof ListMemoryRecordsCommand)).toBe(true)
  })

  it('come back on reactivation; the same rule decides who may', async () => {
    await deactivate(USER, 'mem-fact')
    await deactivate(GUEST, 'mem-guest')
    await expect(reactivate(GUEST, 'mem-fact')).rejects.toThrow(/no write access/)
    expect((await reactivate(GUEST, 'mem-guest')).result).toMatchObject({ changed: true, active: true })
    expect((await reactivate(USER, 'mem-fact')).result).toMatchObject({ changed: true, active: true })
    expect((await reactivate(USER, 'mem-fact')).result).toMatchObject({ changed: false, active: true })
    expect((await listed(USER)).map((r) => r.id)).toContain('mem-fact')
    expect((await new MemoryState(BOARD).log()).map((l) => `${l.action} ${l.recordId}`)).toEqual([
      'reactivate mem-fact', 'reactivate mem-guest', 'deactivate mem-guest', 'deactivate mem-fact',
    ])
  })
})
