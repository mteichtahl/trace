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
 * A message is { id, role (user | assistant | tool), text (markdown), by and by_hash, at, for_hash?, parts? }.
 * `parts` carries a renderer's data (a decision card, a run card, the tool calls of a reply) as JSON, bounded like the
 * text. Who wrote what is never taken from the caller's word:
 *
 *   append   the person's own turns only: role user, `by` their email (display only) and `by_hash` the hash of their
 *            Cognito sub (what every match uses; records made before carry their email's hash, `also`)
 *   reply    trace's replies and tool rows (role assistant | tool), `by` "trace", `by_hash` null, and `for_hash` the
 *            person whose turn they answer. Accepted only while the thread's last person turn is the caller's own (the
 *            id it answers is named), so nobody can write trace's words under someone else's question. The web
 *            backend (src/web/agui.ts) records each run's output this way, with the person's token
 *
 * Limits: a person starts at most MAX_THREADS_PER_PERSON threads on a project; a person's message is at most
 * MAX_USER_CHARS characters, a reply's at most MAX_MESSAGE_CHARS.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { type Backend, Conflict } from './central.js'
import { projectSlug } from './project.js'

export const MAX_MESSAGE_CHARS = 100_000
export const MAX_USER_CHARS = 20_000
export const MAX_THREADS_PER_PERSON = 500
export const TRACE_AUTHOR = 'trace'
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
  /** a reply's: the person whose turn it answers */
  for_hash: z.string().nullable().optional(),
  parts: z.unknown().optional(),
})
export type ChatMessage = z.output<typeof Message>
const Thread = z.object({ id: z.string(), title: z.string(), created: z.string(), updated: z.string(), by: z.string().nullable(), by_hash: z.string().nullable().optional(), messages: z.array(Message) })
export type ChatThread = z.output<typeof Thread>
const Summary = z.object({ id: z.string(), title: z.string(), created: z.string(), updated: z.string(), by: z.string().nullable(), by_hash: z.string().nullable().optional(), count: z.number(), last: z.string() })
export type ThreadSummary = z.output<typeof Summary>
const Index = z.object({ threads: z.array(Summary) })
const Recall = z.object({ messages: z.array(z.object({ text: z.string(), thread: z.string(), at: z.string() })) })
export type RecallEntry = z.output<typeof Recall>['messages'][number]

/** A person: `label` to read (their email), `hash` to match (their sub's), `also` the hashes earlier records may carry. */
export interface Author { label: string; hash: string; also?: readonly string[] | undefined }
export interface NewMessage { text: string; parts?: unknown }
export interface ReplyMessage { role: 'assistant' | 'tool'; text: string; parts?: unknown }

/** Is the recorded hash this person? */
export const isAuthor = (who: Author, hash: string | null | undefined): boolean => !!hash && (hash === who.hash || (who.also?.includes(hash) ?? false))

/** The last person turn of a thread, or null. */
export const lastTurn = (messages: readonly ChatMessage[]): ChatMessage | null => [...messages].reverse().find((m) => m.role === 'user') ?? null

const newMessageId = (): string => randomUUID().replaceAll('-', '').slice(0, 16)
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

  private checkSizes(ms: readonly { text: string; parts?: unknown }[], max: number): void {
    if (!ms.length) throw new ChatError('Nothing to add.')
    for (const m of ms) {
      if (m.text.length > max) throw new ChatError(`A message can be at most ${max.toLocaleString('en')} characters.`)
      if (m.parts !== undefined && enc(m.parts).length > MAX_PARTS_BYTES) throw new ChatError('A message\'s cards are too large to keep.')
    }
  }

  private summaryOf(t: ChatThread): ThreadSummary {
    return { id: t.id, title: t.title, created: t.created, updated: t.updated, by: t.by, by_hash: t.by_hash ?? null, count: t.messages.length, last: firstLine(t.messages.at(-1)?.text ?? '') }
  }

  private async index(summary: ThreadSummary): Promise<void> {
    await this.change(this.key('index.json'), Index, { threads: [] }, (ix) => ({ value: { threads: [summary, ...ix.threads.filter((x) => x.id !== summary.id)] }, result: null }))
  }

  /** The person's own turns, in a thread (a new one when `thread` is absent): the thread's summary and the new ids. */
  async append(who: Author, o: { thread?: string | undefined; title?: string | undefined; messages: readonly NewMessage[] }): Promise<{ thread: ThreadSummary; ids: string[]; created: boolean }> {
    this.checkSizes(o.messages, MAX_USER_CHARS)
    const created = !o.thread
    if (created) {
      const { value } = await this.read(this.key('index.json'), Index, { threads: [] })
      const mine = value.threads.filter((t) => isAuthor(who, t.by_hash) || (!t.by_hash && t.by === who.label)).length
      if (mine >= MAX_THREADS_PER_PERSON) throw new ChatError(`You have ${MAX_THREADS_PER_PERSON} conversations on this project, the most one person can start. Carry on in one of them.`)
    }
    const id = o.thread ? ThreadId.parse(o.thread) : randomUUID().replaceAll('-', '').slice(0, 20)
    const at = this.now().toISOString()
    const added: ChatMessage[] = o.messages.map((m) => ({
      id: newMessageId(), role: 'user', text: m.text, at, by: who.label, by_hash: who.hash, ...(m.parts !== undefined ? { parts: m.parts } : {}),
    }))
    const thread = await this.change(this.key('threads', `${id}.json`), Thread.nullable(), null, (t) => {
      if (!t && !created) throw new ChatError(`There is no conversation ${id} on this project.`)
      const next: ChatThread = t
        ? { ...t, updated: at, messages: [...t.messages, ...added] }
        : { id, title: o.title?.trim() || titleFrom(o.messages[0]?.text ?? ''), created: at, updated: at, by: who.label, by_hash: who.hash, messages: added }
      return { value: next, result: next }
    })
    const summary = this.summaryOf(thread)
    await this.index(summary)
    await this.change(this.key('recall', `${who.hash}.json`), Recall, { messages: [] }, (r) => {
      let list = r.messages
      for (const m of added) if (list[0]?.text !== m.text) list = [{ text: m.text, thread: id, at: m.at }, ...list]
      return { value: { messages: list.slice(0, MAX_RECALL) }, result: null }
    })
    return { thread: summary, ids: added.map((m) => m.id), created }
  }

  /**
   * trace's reply to the caller's turn `after` (and the tool rows of it): refused unless `after` is the thread's last
   * person turn and it is the caller's own.
   */
  async reply(who: Author, o: { thread: string; after: string; messages: readonly ReplyMessage[] }): Promise<{ thread: ThreadSummary; ids: string[] }> {
    this.checkSizes(o.messages, MAX_MESSAGE_CHARS)
    const id = ThreadId.parse(o.thread)
    const at = this.now().toISOString()
    const added: ChatMessage[] = o.messages.map((m) => ({
      id: newMessageId(), role: m.role, text: m.text, at, by: TRACE_AUTHOR, by_hash: null, for_hash: who.hash, ...(m.parts !== undefined ? { parts: m.parts } : {}),
    }))
    const thread = await this.change(this.key('threads', `${id}.json`), Thread.nullable(), null, (t) => {
      if (!t) throw new ChatError(`There is no conversation ${id} on this project.`)
      const turn = lastTurn(t.messages)
      if (!turn || turn.id !== o.after || !isAuthor(who, turn.by_hash)) throw new ChatError('Only a reply to your own latest message in this conversation can be kept.')
      const next: ChatThread = { ...t, updated: at, messages: [...t.messages, ...added] }
      return { value: next, result: next }
    })
    const summary = this.summaryOf(thread)
    await this.index(summary)
    return { thread: summary, ids: added.map((m) => m.id) }
  }

  async rename(id: string, title: string): Promise<ThreadSummary> {
    const name = title.trim()
    if (!name) throw new ChatError('Give the conversation a name.')
    const t = await this.change(this.key('threads', `${ThreadId.parse(id)}.json`), Thread.nullable(), null, (cur) => {
      if (!cur) throw new ChatError(`There is no conversation ${id} on this project.`)
      const next = { ...cur, title: name.slice(0, 120) }
      return { value: next, result: next }
    })
    const summary = this.summaryOf(t)
    await this.change(this.key('index.json'), Index, { threads: [] }, (ix) => ({ value: { threads: ix.threads.map((x) => (x.id === id ? summary : x)) }, result: null }))
    return summary
  }

  /** The person's own sent messages on this project, newest first. */
  async recall(who: Author, limit = 50): Promise<RecallEntry[]> {
    const hashes = [...new Set([who.hash, ...(who.also ?? [])])]
    const lists = await Promise.all(hashes.map(async (h) => (await this.read(this.key('recall', `${h}.json`), Recall, { messages: [] })).value.messages))
    return lists.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
  }
}
