/**
 * Ask trace's conversations, kept with the project (docs/ui-design.md "Conversations are part of the record" and
 * "History is kept"): visible to everyone on the project, on any device, after signing out.
 *
 * Not in the repository (a chat is not design data, and committing every message would bury the history): in the
 * central bucket under the project's own prefix, as JSON objects, written with conditional puts like the central store
 * (If-Match on the ETag read, If-None-Match for a new object; a lost race is re-run on a fresh read):
 *
 *   projects/<slug>/chats/index.json            every thread: id, title, who started it, when, message count, the
 *                                                last message's first line; newest first
 *   projects/<slug>/chats/threads/<id>.json     one thread: its title and messages, oldest first
 *   projects/<slug>/chats/recall/<hash>.json    one person's own sent messages on this project, newest first, at
 *                                                most 200, without repeats in a row: what Up and Down recall
 *
 * A message is { id, role (user | assistant | tool), text (markdown), by and by_hash for a person's, at, parts? }.
 * `parts` carries a renderer's data (a decision card, a run card) as JSON, bounded like the text. People are named by
 * their email for others on the project to read, and matched by their 16-character hash.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { type Backend, Conflict } from './central.js'
import { projectSlug } from './project.js'

export const MAX_MESSAGE_CHARS = 100_000
export const MAX_PARTS_BYTES = 200_000
export const MAX_THREAD_BYTES = 4 * 1024 * 1024
export const MAX_RECALL = 200

export class ChatError extends Error {
  override name = 'ChatError'
}

export const ROLES = ['user', 'assistant', 'tool'] as const
export const ThreadId = z.string().regex(/^[a-z0-9]{8,40}$/, 'a thread id')

const Message = z.object({
  id: z.string(), role: z.enum(ROLES), text: z.string(), by: z.string().nullable(), by_hash: z.string().nullable(), at: z.string(),
  parts: z.unknown().optional(),
})
export type ChatMessage = z.output<typeof Message>
const Thread = z.object({ id: z.string(), title: z.string(), created: z.string(), updated: z.string(), by: z.string().nullable(), messages: z.array(Message) })
export type ChatThread = z.output<typeof Thread>
const Summary = z.object({ id: z.string(), title: z.string(), created: z.string(), updated: z.string(), by: z.string().nullable(), count: z.number(), last: z.string() })
export type ThreadSummary = z.output<typeof Summary>
const Index = z.object({ threads: z.array(Summary) })
const Recall = z.object({ messages: z.array(z.object({ text: z.string(), thread: z.string(), at: z.string() })) })
export type RecallEntry = z.output<typeof Recall>['messages'][number]

export interface Author { label: string; hash: string }
export interface NewMessage { role: (typeof ROLES)[number]; text: string; parts?: unknown }

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v))
const dec = (b: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(b))
const firstLine = (t: string): string => (t.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 160)
const titleFrom = (t: string): string => {
  const line = firstLine(t).replace(/[#*_`>]/g, '').trim()
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New conversation'
}

/** One project's chats, in `store` (the central bucket at its `projects` prefix). */
export class ChatStore {
  readonly slug: string

  constructor(private readonly store: Backend, repo: string, private readonly now: () => Date = () => new Date()) {
    this.slug = projectSlug(repo)
  }

  private key(...parts: string[]): string { return [this.slug, 'chats', ...parts].join('/') }

  private async read<T>(key: string, schema: z.ZodType<T>, empty: T): Promise<{ value: T; etag: string | null }> {
    const got = await this.store.get(key)
    if (!got) return { value: empty, etag: null }
    return { value: schema.parse(dec(got.body)), etag: got.etag }
  }

  /** Read, change, write back with a condition; re-run on a lost race. */
  private async change<T, R>(key: string, schema: z.ZodType<T>, empty: T, fn: (v: T) => { value: T; result: R }, maxBytes = MAX_THREAD_BYTES): Promise<R> {
    for (let i = 0; i < 6; i++) {
      const cur = await this.read(key, schema, empty)
      const { value, result } = fn(cur.value)
      const body = enc(value)
      if (body.length > maxBytes) throw new ChatError('This conversation is too long to add to. Start a new one; this one stays in the history.')
      try {
        await this.store.put(key, body, { ...(cur.etag === null ? { ifNoneMatch: true } : { ifMatch: cur.etag }), contentType: 'application/json' })
        return result
      } catch (e) {
        if (!(e instanceof Conflict)) throw e
        await new Promise((r) => setTimeout(r, 20 * 2 ** i * Math.random()))
      }
    }
    throw new ChatError('The conversation kept changing while this was being saved; try again.')
  }

  async list(o: { query?: string | undefined; limit?: number | undefined } = {}): Promise<ThreadSummary[]> {
    const { value } = await this.read(this.key('index.json'), Index, { threads: [] })
    const q = o.query?.trim().toLowerCase()
    const all = [...value.threads].sort((a, b) => b.updated.localeCompare(a.updated))
    const hit = q ? all.filter((t) => t.title.toLowerCase().includes(q) || t.last.toLowerCase().includes(q)) : all
    return hit.slice(0, o.limit ?? 100)
  }

  /** One thread, its messages oldest first; `before` (a message id) and `limit` page backwards from the newest. */
  async get(id: string, o: { before?: string | undefined; limit?: number | undefined } = {}): Promise<{ thread: Omit<ChatThread, 'messages'>; messages: ChatMessage[]; more: boolean } | null> {
    const { value, etag } = await this.read(this.key('threads', `${ThreadId.parse(id)}.json`), Thread.nullable(), null)
    if (!value || etag === null) return null
    const end = o.before ? value.messages.findIndex((m) => m.id === o.before) : value.messages.length
    const stop = end < 0 ? value.messages.length : end
    const limit = o.limit ?? 50
    const start = Math.max(0, stop - limit)
    const { messages, ...thread } = value
    return { thread, messages: messages.slice(start, stop), more: start > 0 }
  }

  /** Add messages to a thread (a new one when `thread` is absent): returns the thread's summary and the new ids. */
  async append(who: Author, o: { thread?: string | undefined; title?: string | undefined; messages: readonly NewMessage[] }): Promise<{ thread: ThreadSummary; ids: string[]; created: boolean }> {
    if (!o.messages.length) throw new ChatError('Nothing to add.')
    for (const m of o.messages) {
      if (m.text.length > MAX_MESSAGE_CHARS) throw new ChatError(`A message can be at most ${MAX_MESSAGE_CHARS.toLocaleString('en')} characters.`)
      if (m.parts !== undefined && enc(m.parts).length > MAX_PARTS_BYTES) throw new ChatError('A message\'s cards are too large to keep.')
    }
    const created = !o.thread
    const id = o.thread ? ThreadId.parse(o.thread) : randomUUID().replaceAll('-', '').slice(0, 20)
    const at = this.now().toISOString()
    const added: ChatMessage[] = o.messages.map((m) => ({
      id: randomUUID().replaceAll('-', '').slice(0, 16), role: m.role, text: m.text, at,
      by: m.role === 'user' ? who.label : null, by_hash: m.role === 'user' ? who.hash : null, ...(m.parts !== undefined ? { parts: m.parts } : {}),
    }))
    const thread = await this.change(this.key('threads', `${id}.json`), Thread.nullable(), null, (t) => {
      if (!t && !created) throw new ChatError(`There is no conversation ${id} on this project.`)
      const firstUser = o.messages.find((m) => m.role === 'user')?.text ?? o.messages[0]?.text ?? ''
      const next: ChatThread = t
        ? { ...t, updated: at, messages: [...t.messages, ...added] }
        : { id, title: o.title?.trim() || titleFrom(firstUser), created: at, updated: at, by: who.label, messages: added }
      return { value: next, result: next }
    })
    const summary: ThreadSummary = {
      id, title: thread.title, created: thread.created, updated: thread.updated, by: thread.by, count: thread.messages.length,
      last: firstLine(thread.messages.at(-1)?.text ?? ''),
    }
    await this.change(this.key('index.json'), Index, { threads: [] }, (ix) => ({ value: { threads: [summary, ...ix.threads.filter((x) => x.id !== id)] }, result: null }))
    const sent = added.filter((m) => m.role === 'user')
    if (sent.length) {
      await this.change(this.key('recall', `${who.hash}.json`), Recall, { messages: [] }, (r) => {
        let list = r.messages
        for (const m of sent) if (list[0]?.text !== m.text) list = [{ text: m.text, thread: id, at: m.at }, ...list]
        return { value: { messages: list.slice(0, MAX_RECALL) }, result: null }
      })
    }
    return { thread: summary, ids: added.map((m) => m.id), created }
  }

  async rename(id: string, title: string): Promise<ThreadSummary> {
    const name = title.trim()
    if (!name) throw new ChatError('Give the conversation a name.')
    const t = await this.change(this.key('threads', `${ThreadId.parse(id)}.json`), Thread.nullable(), null, (cur) => {
      if (!cur) throw new ChatError(`There is no conversation ${id} on this project.`)
      const next = { ...cur, title: name.slice(0, 120) }
      return { value: next, result: next }
    })
    const summary: ThreadSummary = { id, title: t.title, created: t.created, updated: t.updated, by: t.by, count: t.messages.length, last: firstLine(t.messages.at(-1)?.text ?? '') }
    await this.change(this.key('index.json'), Index, { threads: [] }, (ix) => ({ value: { threads: ix.threads.map((x) => (x.id === id ? summary : x)) }, result: null }))
    return summary
  }

  /** The person's own sent messages on this project, newest first. */
  async recall(who: Author, limit = 50): Promise<RecallEntry[]> {
    const { value } = await this.read(this.key('recall', `${who.hash}.json`), Recall, { messages: [] })
    return value.messages.slice(0, limit)
  }
}
