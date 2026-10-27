import { describe, expect, it } from 'vitest'
import { S3Backend } from '../../src/core/central.js'
import { ChatStore } from '../../src/core/chats.js'
import { FakeS3 } from './fake-s3.js'

const me = { label: 'me@example.com', hash: 'm'.repeat(16) }
const you = { label: 'you@example.com', hash: 'y'.repeat(16) }

describe('chats in the central bucket', () => {
  it('keeps threads, an index, and each person\'s sent messages for recall', async () => {
    const s3 = new FakeS3()
    const store = new ChatStore(new S3Backend('bucket', 'projects', s3), 'Acme/Board')
    const a = await store.append(me, { messages: [{ role: 'user', text: '## Why this regulator?\nIt seems large.' }, { role: 'assistant', text: 'It carries 1 A.' }] })
    expect(a.created).toBe(true)
    expect(a.thread).toMatchObject({ title: 'Why this regulator?', count: 2, by: 'me@example.com', last: 'It carries 1 A.' })
    expect([...s3.objects.keys()].sort()).toEqual([
      `bucket/projects/acme/board/chats/index.json`, `bucket/projects/acme/board/chats/recall/${me.hash}.json`, `bucket/projects/acme/board/chats/threads/${a.thread.id}.json`,
    ])
    await store.append(you, { thread: a.thread.id, messages: [{ role: 'user', text: 'And the heat?' }] })
    await store.append(me, { messages: [{ role: 'user', text: 'Show me the power sheet' }] })
    await store.append(me, { messages: [{ role: 'user', text: 'Show me the power sheet' }] })
    const list = await store.list()
    expect(list).toHaveLength(3)
    expect((await store.list({ query: 'regulator' })).map((t) => t.id)).toEqual([a.thread.id])
    const g = await store.get(a.thread.id, { limit: 2 })
    expect(g?.messages.map((m) => m.text)).toEqual(['It carries 1 A.', 'And the heat?'])
    expect(g?.more).toBe(true)
    expect(g?.messages[1]).toMatchObject({ by: 'you@example.com', role: 'user' })
    const older = await store.get(a.thread.id, { before: g?.messages[0]?.id, limit: 5 })
    expect(older?.messages.map((m) => m.role)).toEqual(['user'])
    // recall: own messages only, newest first, no repeats in a row
    expect((await store.recall(me)).map((r) => r.text)).toEqual(['Show me the power sheet', '## Why this regulator?\nIt seems large.'])
    expect((await store.recall(you)).map((r) => r.text)).toEqual(['And the heat?'])
    expect((await store.rename(a.thread.id, 'Regulator choice')).title).toBe('Regulator choice')
    expect((await store.list()).find((t) => t.id === a.thread.id)?.title).toBe('Regulator choice')
    await expect(store.append(me, { thread: 'abcdefgh123', messages: [{ role: 'user', text: 'x' }] })).rejects.toThrow(/no conversation/)
    expect(await store.get('abcdefgh123')).toBeNull()
  })

  it('re-runs a write that lost a race, without losing the other writer\'s message', async () => {
    const s3 = new FakeS3()
    const store = new ChatStore(new S3Backend('bucket', 'projects', s3), 'acme/board')
    const a = await store.append(me, { messages: [{ role: 'user', text: 'first' }] })
    s3.interleave = () => store.append(you, { thread: a.thread.id, messages: [{ role: 'user', text: 'meanwhile' }] })
    await store.append(me, { thread: a.thread.id, messages: [{ role: 'user', text: 'second' }] })
    expect(s3.conflicts).toBeGreaterThan(0)
    expect((await store.get(a.thread.id))?.messages.map((m) => m.text)).toEqual(['first', 'meanwhile', 'second'])
  })
})
