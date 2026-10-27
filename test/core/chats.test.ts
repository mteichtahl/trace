import { describe, expect, it } from 'vitest'
import { S3Backend } from '../../src/core/central.js'
import { ChatStore, MAX_THREADS_PER_PERSON, MAX_USER_CHARS } from '../../src/core/chats.js'
import { FakeS3 } from './fake-s3.js'

const me = { label: 'me@example.com', hash: 'm'.repeat(16), also: ['m'.repeat(16), 'e'.repeat(16)] }
const you = { label: 'you@example.com', hash: 'y'.repeat(16) }

describe('chats in the central bucket', () => {
  it('keeps threads, an index, and each person\'s sent messages for recall', async () => {
    const s3 = new FakeS3()
    const store = new ChatStore(new S3Backend('bucket', 'projects', s3), 'Acme/Board')
    const a = await store.append(me, { messages: [{ text: '## Why this regulator?\nIt seems large.' }] })
    expect(a.created).toBe(true)
    await store.reply(me, { thread: a.thread.id, after: a.ids[0]!, messages: [{ role: 'assistant', text: 'It carries 1 A.' }] })
    expect((await store.list())[0]).toMatchObject({ title: 'Why this regulator?', count: 2, by: 'me@example.com', by_hash: me.hash, last: 'It carries 1 A.' })
    expect([...s3.objects.keys()].sort()).toEqual([
      `bucket/projects/acme/board/chats/index.json`, `bucket/projects/acme/board/chats/recall/${me.hash}.json`, `bucket/projects/acme/board/chats/threads/${a.thread.id}.json`,
    ])
    await store.append(you, { thread: a.thread.id, messages: [{ text: 'And the heat?' }] })
    await store.append(me, { messages: [{ text: 'Show me the power sheet' }] })
    await store.append(me, { messages: [{ text: 'Show me the power sheet' }] })
    expect(await store.list()).toHaveLength(3)
    expect((await store.list({ query: 'regulator' })).map((t) => t.id)).toEqual([a.thread.id])
    const g = await store.get(a.thread.id, { limit: 2 })
    expect(g?.messages.map((m) => m.text)).toEqual(['It carries 1 A.', 'And the heat?'])
    expect(g?.more).toBe(true)
    expect(g?.messages[0]).toMatchObject({ role: 'assistant', by: 'trace', by_hash: null, for_hash: me.hash })
    expect(g?.messages[1]).toMatchObject({ by: 'you@example.com', by_hash: you.hash, role: 'user' })
    const older = await store.get(a.thread.id, { before: g?.messages[0]?.id, limit: 5 })
    expect(older?.messages.map((m) => m.role)).toEqual(['user'])
    // recall: own messages only, newest first, no repeats in a row
    expect((await store.recall(me)).map((r) => r.text)).toEqual(['Show me the power sheet', '## Why this regulator?\nIt seems large.'])
    expect((await store.recall(you)).map((r) => r.text)).toEqual(['And the heat?'])
    expect((await store.rename(a.thread.id, 'Regulator choice')).title).toBe('Regulator choice')
    expect((await store.list()).find((t) => t.id === a.thread.id)?.title).toBe('Regulator choice')
    await expect(store.append(me, { thread: 'abcdefgh123', messages: [{ text: 'x' }] })).rejects.toThrow(/no conversation/)
    expect(await store.get('abcdefgh123')).toBeNull()
  })

  it('keeps trace\'s replies only for the caller\'s own latest turn', async () => {
    const store = new ChatStore(new S3Backend('bucket', 'projects', new FakeS3()), 'acme/board')
    const a = await store.append(me, { messages: [{ text: 'Start the layout' }] })
    // someone else cannot put trace's words under my question
    await expect(store.reply(you, { thread: a.thread.id, after: a.ids[0]!, messages: [{ role: 'assistant', text: 'Done: started.' }] })).rejects.toThrow(/your own latest/)
    const b = await store.append(you, { thread: a.thread.id, messages: [{ text: 'What about thermal?' }] })
    // nor can I, once someone else has spoken since
    await expect(store.reply(me, { thread: a.thread.id, after: a.ids[0]!, messages: [{ role: 'assistant', text: 'x' }] })).rejects.toThrow(/your own latest/)
    await store.reply(you, { thread: a.thread.id, after: b.ids[0]!, messages: [{ role: 'tool', text: '{"ok":true}' }, { role: 'assistant', text: 'It runs cool.' }] })
    expect((await store.get(a.thread.id))?.messages.map((m) => [m.role, m.by])).toEqual([['user', 'me@example.com'], ['user', 'you@example.com'], ['tool', 'trace'], ['assistant', 'trace']])
  })

  it('accepts the email\'s hash of earlier records as the same person (recall), and caps threads and sizes', async () => {
    const s3 = new FakeS3()
    const store = new ChatStore(new S3Backend('bucket', 'projects', s3), 'acme/board')
    // a recall list written before identity was keyed on the sub
    await s3.putObject({ Bucket: 'bucket', Key: `projects/acme/board/chats/recall/${'e'.repeat(16)}.json`, Body: new TextEncoder().encode(JSON.stringify({ messages: [{ text: 'old one', thread: 'x', at: '2020-01-01T00:00:00.000Z' }] })) })
    await store.append(me, { messages: [{ text: 'new one' }] })
    const r = (await store.recall(me)).map((x) => x.text)
    expect(r).toEqual(['new one', 'old one'])
    await expect(store.append(me, { messages: [{ text: 'x'.repeat(MAX_USER_CHARS + 1) }] })).rejects.toThrow(/at most/)
    expect(MAX_THREADS_PER_PERSON).toBe(500)
  })

  it('re-runs a write that lost a race, without losing the other writer\'s message', async () => {
    const s3 = new FakeS3()
    const store = new ChatStore(new S3Backend('bucket', 'projects', s3), 'acme/board')
    const a = await store.append(me, { messages: [{ text: 'first' }] })
    s3.interleave = () => store.append(you, { thread: a.thread.id, messages: [{ text: 'meanwhile' }] })
    await store.append(me, { thread: a.thread.id, messages: [{ text: 'second' }] })
    expect(s3.conflicts).toBeGreaterThan(0)
    expect((await store.get(a.thread.id))?.messages.map((m) => m.text)).toEqual(['first', 'meanwhile', 'second'])
  })
})
