import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore'
import { beforeAll, describe, expect, it } from 'vitest'
import { AgentMemory, type SendClient, namespaceOf, personActor } from '../../src/agent/memory.js'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { Registry } from '../../src/core/registry.js'
import { tools as memoryTools } from '../../src/agent/tools.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'admin-1', email: 'admin@example.com', groups: ['trace-admins'] }
const GUEST = { sub: 'guest-1', email: 'guest-1@example.com', groups: ['trace-guests'] }

const mine = personActor('acme/board', 'guest-1@example.com')
const theirs = personActor('acme/board', 'someone@example.com')
const RECORDS = [
  { ns: '/trace/acme/board/worker/facts/', text: 'The board has a 3V3 LDO.' },
  { ns: '/trace/acme/board/render/preferences/', text: 'Renders at 1920x1200.' },
  { ns: namespaceOf(mine, 'preferences'), text: 'Guest likes terse PRs.' },
  { ns: namespaceOf(theirs, 'preferences'), text: 'Someone else likes long PRs.' },
  { ns: '/trace/acme/secret/worker/facts/', text: 'Secret project.' },
]

const sent: unknown[] = []
const client: SendClient = {
  send: async (cmd) => {
    sent.push(cmd)
    const ns = 'namespace' in cmd.input ? cmd.input.namespace ?? '' : ''
    return { memoryRecordSummaries: RECORDS.filter((r) => r.ns.startsWith(ns)).map((r, i) => ({ memoryRecordId: `r${i}`, content: { text: r.text }, namespaces: [r.ns], createdAt: new Date(i * 1000) })) }
  },
}

const deps = (memory: AgentMemory | null): ActionDeps => ({
  github: async () => new FakeGitHub(['acme/board', 'acme/secret']),
  cognito: () => new FakeCognito(),
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry(memoryTools),
  checkout: async () => { throw new Error('no clones here') },
  scratch: mkdtempSync(join(tmpdir(), 'trace-api-mem-')),
  memory: () => memory,
})
const ctx = (principal: Context['principal'], memory: AgentMemory | null = new AgentMemory('trace_memory-abcdefghij', client)): Context => ({ principal, deps: deps(memory) })
const texts = (r: unknown): string[] => (r as { records: { text: string }[] }).records.map((x) => x.text).sort()

beforeAll(async () => {
  await assign(ADMIN, { sub: 'guest-1', email: 'guest-1@example.com' }, 'acme/board')
})

describe('memory through the API', () => {
  it('lets a reader see the project memory: every agent, and only their own person-scoped preferences', async () => {
    const r = await perform('memory.list', { repo: 'acme/board' }, ctx(GUEST))
    expect(texts(r.result)).toEqual(['Guest likes terse PRs.', 'Renders at 1920x1200.', 'The board has a 3V3 LDO.'])
    expect((r.result as { records: { actor: string }[] }).records.map((x) => x.actor).sort()).toEqual([`person/${mine.name}`, 'render', 'worker'])
    const all = await perform('memory.list', { repo: 'acme/board' }, ctx(ADMIN))
    expect(texts(all.result)).toContain('Someone else likes long PRs.')
    expect(texts(all.result)).not.toContain('Secret project.')
  })

  it('narrows to one agent with that agent prefix, and recalls by query', async () => {
    sent.length = 0
    const r = await perform('memory.recall', { repo: 'acme/board', agent: 'render', query: 'render size' }, ctx(GUEST))
    expect(texts(r.result)).toEqual(['Renders at 1920x1200.'])
    const c = sent[0] as RetrieveMemoryRecordsCommand
    expect(c).toBeInstanceOf(RetrieveMemoryRecordsCommand)
    expect(c.input).toMatchObject({ namespace: '/trace/acme/board/render/', searchCriteria: { searchQuery: 'render size' } })
    sent.length = 0
    await perform('memory.list', { repo: 'acme/board', agent: 'worker' }, ctx(GUEST))
    expect((sent[0] as ListMemoryRecordsCommand).input.namespace).toBe('/trace/acme/board/worker/')
  })

  it('needs read access on the project, before memory is touched', async () => {
    sent.length = 0
    await expect(perform('memory.list', { repo: 'acme/secret' }, ctx(GUEST))).rejects.toThrow(AccessDenied)
    await expect(perform('memory.recall', { repo: 'acme/secret', query: 'x' }, ctx(GUEST))).rejects.toThrow(AccessDenied)
    expect(sent).toHaveLength(0)
    await expect(perform('memory.list', { repo: 'acme/board', agent: 'person' }, ctx(GUEST))).rejects.toThrow(/agent/)
  })

  it('answers enabled: false without memory', async () => {
    expect((await perform('memory.list', { repo: 'acme/board' }, ctx(GUEST, null))).result).toEqual({ repo: 'acme/board', enabled: false, records: [] })
  })

  it('never offers the session-scoped memory tools through the tool action', async () => {
    const list = (await perform('tools.list', { repo: 'acme/board' }, ctx(GUEST))).result as { name: string }[]
    expect(list.map((t) => t.name)).not.toContain('memory.recall')
    await expect(perform('tool', { repo: 'acme/board', name: 'memory.remember', args: { text: 'x' } }, ctx(ADMIN))).rejects.toThrow(/no tool memory\.remember/)
  })
})
