/**
 * Inactive memories on the agents' side: the overlay store (local and S3), and that an inactive record is not
 * considered anywhere an agent uses memory — the job's recall and its prompt block, and the memory_recall tool —
 * with topK refilled, the count (never the ids) on the span, and failing closed when the marks cannot be read.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BedrockAgentCoreClient, GetMemoryRecordCommand, ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MEMORY_STATE, MemoryState, memoryStateHome } from '../../src/agents/runtime/memory-state.js'
import {
  AgentMemory, type MemoryRecord, type SendClient, agentActor, memoryBlock, namespaceOf, openJobMemory, personActor,
} from '../../src/agents/runtime/memory.js'
import { Central } from '../../src/core/central.js'
import { Registry } from '../../src/core/registry.js'
import { span } from '../../src/core/telemetry.js'
import { tools as memoryTools } from '../../src/tools/memory/tools.js'
import { FakeS3 } from '../core/fake-s3.js'

const REPO = 'acme/board'
const MEMORY_ID = 'trace_m_0000aaaa-abcdefghij'
const worker = agentActor(REPO, 'worker')
const FACTS = namespaceOf(worker, 'facts')
const PREFS = namespaceOf(worker, 'preferences')

let n = 0
const freshHome = (): string => mkdtempSync(join(tmpdir(), `trace-memstate-${++n}-`))
const state = (): MemoryState => new MemoryState(REPO, { home: freshHome() })

interface Rec { id: string; ns: string; text: string; score: number }
/** Ten facts ranked by score, two preferences. */
const RECS: Rec[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: `mem-f${i}`, ns: FACTS, text: `fact ${i}`, score: 1 - i / 100 })),
  { id: 'mem-p0', ns: PREFS, text: 'pref 0', score: 0.9 },
  { id: 'mem-p1', ns: PREFS, text: 'pref 1', score: 0.8 },
]

/** A fake AgentCore that honours topK/maxResults, prefix namespaces and GetMemoryRecord, and records what it was asked. */
function fake(recs: Rec[] = RECS): SendClient & { sent: unknown[] } {
  const sent: unknown[] = []
  const summary = (r: Rec, i: number) => ({ memoryRecordId: r.id, content: { text: r.text }, namespaces: [r.ns], score: r.score, createdAt: new Date(1000 + i) })
  return {
    sent,
    send: async (cmd) => {
      sent.push(cmd)
      if (cmd instanceof GetMemoryRecordCommand) {
        const i = recs.findIndex((r) => r.id === cmd.input.memoryRecordId)
        const r = recs[i]
        if (!r) throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })
        return { memoryRecord: summary(r, i) }
      }
      if (cmd instanceof RetrieveMemoryRecordsCommand) {
        const k = cmd.input.searchCriteria?.topK ?? 20
        return { memoryRecordSummaries: recs.map(summary).filter((r) => r.namespaces[0]?.startsWith(cmd.input.namespace ?? '')).sort((a, b) => b.score - a.score).slice(0, k) }
      }
      if (cmd instanceof ListMemoryRecordsCommand) {
        return { memoryRecordSummaries: recs.map(summary).filter((r) => r.namespaces[0]?.startsWith(cmd.input.namespace ?? '')).slice(0, cmd.input.maxResults ?? 20) }
      }
      return { events: [] }
    },
  }
}

const ids = (rs: readonly MemoryRecord[]): string[] => rs.map((r) => r.id)
const retrieves = (f: { sent: unknown[] }): RetrieveMemoryRecordsCommand[] => f.sent.filter((c): c is RetrieveMemoryRecordsCommand => c instanceof RetrieveMemoryRecordsCommand)

describe('the memory state store', () => {
  it('lives beside the project data: s3://<bucket>/projects/<slug>/memory-state, or $TRACE_HOME/projects/<slug>/memory-state', () => {
    expect(memoryStateHome('Acme/Board', { TRACE_HOME: 's3://bkt/central' })).toBe(`s3://bkt/projects/acme/board/${MEMORY_STATE}`)
    expect(memoryStateHome('acme/board', { TRACE_HOME: 's3://bkt' })).toBe('s3://bkt/projects/acme/board/memory-state')
    expect(memoryStateHome('acme/board', { TRACE_HOME: '/home/me/.trace' })).toBe('/home/me/.trace/projects/acme/board/memory-state')
    expect(memoryStateHome('acme/board', { TRACE_MEMORY_STATE_HOME: '/x' })).toBe('/x/acme/board')
    expect(() => memoryStateHome('../etc', {})).toThrow()
  })

  it('marks, keeps the first mark, unmarks, and logs both', async () => {
    let t = 100
    const s = new MemoryState(REPO, { home: freshHome(), now: () => t })
    expect(await s.inactive()).toEqual(new Map())
    const a = await s.deactivate({ recordId: 'mem-f0', namespace: FACTS, reason: 'wrong rail voltage', by: 'aaaa000000000000' })
    expect(a).toEqual({ changed: true, mark: { recordId: 'mem-f0', namespace: FACTS, reason: 'wrong rail voltage', by: 'aaaa000000000000', at: 100 } })
    t = 200
    expect((await s.deactivate({ recordId: 'mem-f0', namespace: FACTS, reason: 'again', by: 'bbbb000000000000' })).changed).toBe(false)
    expect((await s.get('mem-f0'))?.reason).toBe('wrong rail voltage')
    expect((await s.reactivate('mem-f0', 'bbbb000000000000'))?.recordId).toBe('mem-f0')
    expect(await s.reactivate('mem-f0', 'bbbb000000000000')).toBeNull()
    expect(await s.get('mem-f0')).toBeNull()
    expect((await s.log()).map((l) => [l.action, l.by])).toEqual([['reactivate', 'bbbb000000000000'], ['deactivate', 'aaaa000000000000']])
    await expect(s.deactivate({ recordId: 'mem-f1', namespace: FACTS, reason: '  ', by: 'x' })).rejects.toThrow(/reason/)
    await expect(s.deactivate({ recordId: '../x', namespace: FACTS, reason: 'r', by: 'x' })).rejects.toThrow(/record id/)
  })

  it('works on S3 with conditional writes, even where a missing object answers 403 (no unconditional ListBucket)', async () => {
    class Denying extends FakeS3 {
      listDenied = false
      private deny(): Error { return Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }) }
      override async getObject(i: { Bucket: string; Key: string }) { if (!this.objects.has(`${i.Bucket}/${i.Key}`)) throw this.deny(); return super.getObject(i) }
      override async headObject(i: { Bucket: string; Key: string }) { if (!this.objects.has(`${i.Bucket}/${i.Key}`)) throw this.deny(); return super.headObject(i) }
      override async listObjectsV2(i: { Bucket: string; Prefix: string }) { if (this.listDenied) throw this.deny(); return super.listObjectsV2(i) }
    }
    const s3 = new Denying()
    const home = `s3://bkt/projects/acme/board/memory-state-${++n}`
    const s = new MemoryState(REPO, { store: new Central({ home, s3 }) })
    expect((await s.inactive()).size).toBe(0)
    await s.deactivate({ recordId: 'mem-f0', namespace: FACTS, reason: 'stale', by: 'h' })
    expect([...s3.objects.keys()]).toEqual([`bkt/projects/acme/board/memory-state-${n}/central.db`])
    expect((await new MemoryState(REPO, { store: new Central({ home, s3 }) }).inactive()).has('mem-f0')).toBe(true)
    // a 403 that a listing cannot explain stays an error: nobody gets memory without knowing what is inactive
    const other = new Denying()
    other.listDenied = true
    await expect(new MemoryState(REPO, { store: new Central({ home: 's3://bkt/projects/acme/board/ms-denied', s3: other }) }).inactive()).rejects.toThrow(/AccessDenied/)
  })
})

describe('recall leaves inactive records out', () => {
  it('after retrieval, asking for as many more as there are inactive records under the namespace', async () => {
    const s = state()
    for (const id of ['mem-f0', 'mem-f2']) await s.deactivate({ recordId: id, namespace: FACTS, reason: 'wrong', by: 'h' })
    await s.deactivate({ recordId: 'mem-p0', namespace: PREFS, reason: 'old', by: 'h' })
    const f = fake()
    const m = new AgentMemory(MEMORY_ID, f, Date.now, () => s)
    const got = await m.longTerm.recall(worker, 'rails', { strategies: ['facts'], topK: 3 })
    expect(ids(got)).toEqual(['mem-f1', 'mem-f3', 'mem-f4'])
    // two inactive under facts/: 3 + 2 asked for (the preference's mark does not count here)
    expect(retrieves(f)[0]?.input).toMatchObject({ namespace: FACTS, searchCriteria: { topK: 5 }, maxResults: 5 })
    // per strategy, each refilled on its own
    const both = await m.longTerm.recall(worker, 'rails', { strategies: ['facts', 'preferences'], topK: 1 })
    expect(ids(both)).toEqual(['mem-f1', 'mem-p1'])
  })

  it('even when the server returns them anyway, and with the ask capped at the API maximum of 100', async () => {
    const s = state()
    await s.deactivate({ recordId: 'mem-f1', namespace: FACTS, reason: 'r', by: 'h' })
    // a server that ignores topK and returns everything, inactive or not
    const loud: SendClient = { send: async () => ({ memoryRecordSummaries: RECS.filter((r) => r.ns === FACTS).map((r) => ({ memoryRecordId: r.id, content: { text: r.text }, namespaces: [r.ns] })) }) }
    const got = await new AgentMemory(MEMORY_ID, loud, Date.now, () => s).longTerm.recall(worker, 'q', { strategies: ['facts'], topK: 4 })
    expect(ids(got)).toEqual(['mem-f0', 'mem-f2', 'mem-f3', 'mem-f4'])
    const f = fake()
    await new AgentMemory(MEMORY_ID, f, Date.now, () => s).longTerm.recall(worker, 'q', { strategies: ['facts'], topK: 100 })
    expect(retrieves(f)[0]?.input.searchCriteria?.topK).toBe(100)
  })

  it('in listings too, unless inactive ones are asked for, and then each is marked', async () => {
    const s = state()
    await s.deactivate({ recordId: 'mem-f3', namespace: FACTS, reason: 'superseded', by: 'h' })
    const m = new AgentMemory(MEMORY_ID, fake(), Date.now, () => s)
    expect(ids(await m.longTerm.listProject(REPO, { limit: 50 }))).not.toContain('mem-f3')
    expect(ids(await m.longTerm.list(worker))).not.toContain('mem-f3')
    const all = await m.longTerm.listProject(REPO, { limit: 50, includeInactive: true })
    expect(all.find((r) => r.id === 'mem-f3')?.inactive).toMatchObject({ reason: 'superseded', by: 'h' })
    expect(all.filter((r) => r.inactive)).toHaveLength(1)
    // reactivated: considered again (it was never deleted)
    await s.reactivate('mem-f3', 'h')
    expect(ids(await m.longTerm.listProject(REPO, { limit: 50 }))).toContain('mem-f3')
  })

  it('finds one record of the project, by GetMemoryRecord or else by listing; never another project\'s', async () => {
    const f = fake()
    const m = new AgentMemory(MEMORY_ID, f, Date.now, () => state())
    expect((await m.longTerm.find(REPO, 'mem-p1'))?.namespace).toBe(PREFS)
    expect(f.sent[0]).toBeInstanceOf(GetMemoryRecordCommand)
    expect((f.sent[0] as GetMemoryRecordCommand).input).toMatchObject({ memoryId: MEMORY_ID, memoryRecordId: 'mem-p1', namespace: '/trace/acme/board/' })
    expect(await m.longTerm.find(REPO, 'mem-nope')).toBeNull()
    // a record filed under another project's namespace is not this project's, however it got here
    const stray = new AgentMemory(MEMORY_ID, fake([{ id: 'mem-x', ns: '/trace/acme/secret/worker/facts/', text: 'x', score: 1 }]), Date.now, () => state())
    expect(await stray.longTerm.find(REPO, 'mem-x')).toBeNull()
    // GetMemoryRecord refused (say, how it reads its namespace): the listing finds it
    const refusing: SendClient = { send: async (c) => { if (c instanceof GetMemoryRecordCommand) throw Object.assign(new Error('bad namespace'), { name: 'ValidationException' }); return fake().send(c) } }
    expect((await new AgentMemory(MEMORY_ID, refusing, Date.now, () => state()).longTerm.find(REPO, 'mem-f7'))?.text).toBe('fact 7')
  })

  it('never puts an inactive record in the prompt block, even if one is handed to it', () => {
    const rec = (id: string, text: string, inactive = false): MemoryRecord => ({
      id, strategy: 'facts', namespace: FACTS, text, score: null, createdAt: null, ...(inactive ? { inactive: { recordId: id, namespace: FACTS, reason: 'r', by: 'h', at: 1 } } : {}),
    })
    const b = memoryBlock({ records: [rec('a', 'keep me'), rec('b', 'drop me', true)], person: [rec('c', 'drop me too', true)] })
    expect(b).toContain('keep me')
    expect(b).not.toContain('drop me')
    expect(memoryBlock({ records: [rec('b', 'drop me', true)] })).toBe('')
  })
})

describe('a job\'s memory', () => {
  it('starts without inactive records, the person\'s own included', async () => {
    const s = state()
    const person = personActor(REPO, 'guest@example.com')
    const PP = namespaceOf(person, 'preferences')
    const recs = [...RECS, { id: 'mem-pp0', ns: PP, text: 'person likes terse PRs', score: 0.9 }, { id: 'mem-pp1', ns: PP, text: 'person likes Rust', score: 0.8 }]
    await s.deactivate({ recordId: 'mem-f0', namespace: FACTS, reason: 'wrong', by: 'h' })
    await s.deactivate({ recordId: 'mem-pp0', namespace: PP, reason: 'no longer', by: 'h' })
    const jm = await openJobMemory(new AgentMemory(MEMORY_ID, fake(recs), Date.now, () => s), { actor: worker, person, session: 'pr-1', query: 'q', request: 'do it' }, { log: () => undefined })
    expect(jm.context).toContain('fact 1')
    expect(jm.context).not.toContain('fact 0')
    expect(jm.context).toContain('person likes Rust')
    expect(jm.context).not.toContain('terse')
    // still five facts: refilled
    expect(jm.context.split('\n').filter((l) => l.startsWith('- [fact]'))).toHaveLength(5)
  })

  it('runs without long-term memory when the marks cannot be read, rather than hand them out unchecked', async () => {
    const logs: string[] = []
    const broken = { inactive: async () => { throw new Error('AccessDenied on memory-state') } }
    const jm = await openJobMemory(new AgentMemory(MEMORY_ID, fake(), Date.now, () => broken), { actor: worker, session: 'pr-1', query: 'q', request: 'r' }, { log: (l) => logs.push(l) })
    expect(jm.context).not.toContain('fact')
    expect(logs.join('\n')).toMatch(/memory: recall failed, continuing without it: AccessDenied on memory-state/)
  })
})

describe('telemetry', () => {
  const spans = new InMemorySpanExporter()
  const cm = new AsyncLocalStorageContextManager()
  beforeAll(() => {
    context.setGlobalContextManager(cm.enable())
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }))
  })
  afterAll(() => { trace.disable(); context.disable() })

  it('counts the inactive records left out on the span, and never names them', async () => {
    const s = state()
    for (const id of ['mem-f0', 'mem-f1', 'mem-p0']) await s.deactivate({ recordId: id, namespace: id.startsWith('mem-p') ? PREFS : FACTS, reason: 'r', by: 'h' })
    const m = new AgentMemory(MEMORY_ID, fake(), Date.now, () => s)
    await span('test.recall', {}, async () => m.longTerm.recall(worker, 'q', { strategies: ['facts', 'preferences'], topK: 2 }))
    const got = spans.getFinishedSpans().find((x) => x.name === 'test.recall')
    expect(got?.attributes['trace.memory.inactive_filtered']).toBe(3)
    expect(JSON.stringify(got?.attributes)).not.toMatch(/mem-/)
  })
})

describe('the memory_recall tool', () => {
  const env = { ...process.env }
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...env } })

  it('leaves inactive records out, and no tool lets an agent change what is inactive', async () => {
    process.env.TRACE_MEMORY_STATE_HOME = freshHome()
    process.env.TRACE_MEMORY_ID = MEMORY_ID
    process.env.AWS_REGION = 'us-east-1'
    process.env.TRACE_MEMORY_ACTOR = worker.id
    await new MemoryState(REPO).deactivate({ recordId: 'mem-f0', namespace: FACTS, reason: 'wrong', by: 'h' })
    const f = fake()
    vi.spyOn(BedrockAgentCoreClient.prototype, 'send').mockImplementation(((c: Parameters<SendClient['send']>[0]) => f.send(c)) as never)
    const reg = new Registry(memoryTools)
    const out = await reg.call('memory.recall', { query: 'rails', strategies: ['facts'], top_k: 2 }, { hardware: false, via: 'test' }) as { records: { text: string }[] }
    expect(out.records.map((r) => r.text)).toEqual(['fact 1', 'fact 2'])
    expect(reg.list().map((t) => t.name).sort()).toEqual(['memory.recall', 'memory.remember'])
  })
})
