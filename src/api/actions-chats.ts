/**
 * Ask trace's conversations through the API (src/core/chats.ts keeps them). Every thread on a project is visible to
 * everyone on it, so each action needs read on the project; adding to one needs read too, because a reviewer may
 * ask trace questions (what trace then does on their behalf is checked again as them, action by action).
 *
 *   chats.list    read   the project's threads, newest first; `query` searches their names and last lines
 *   chats.get     read   one thread's messages, oldest first, a page at a time backwards (`before`, `limit`)
 *   chats.append  read   the caller's own messages (always role user, named by them), in a thread or a new one
 *   chats.reply   read   trace's reply to the caller's own latest message in a thread (roles assistant and tool, named
 *                        "trace"): the web backend (src/web/agui.ts) records each run's output with it, as the person.
 *                        Refused unless `after` is the thread's last person turn and it is the caller's. The web
 *                        backend's /api/call never passes this action on (src/web/call.ts), so the app cannot write
 *                        trace's words itself
 *   chats.rename  read   give a thread a name
 *   chats.recall  read   the person's own sent messages on this project, newest first (Up and Down in the box)
 *
 * Memory: the person's own words, and only those, are also recorded, best-effort, as short-term events of the
 * project's memory (recordTurns), so AgentCore extracts their preferences and session summaries from conversations.
 * Each user turn of chats.append goes under the caller's own person actor (the hash of their sub, never the email), one
 * session per thread (`chat-<thread>`), and only for people who may write to the project (a read-only guest's words
 * are not recorded at all). trace's replies and tool rows (chats.reply) are never recorded: model output, or anything a
 * tool result, a document or another person's message planted in it, must not shape memory. Nothing here writes the
 * project's `chat` actor: what the whole project remembers is only what a person confirmed (memory.remember, scope
 * project, after the Confirm of the `remember` card), so typing the words that mark a confirmed fact only ever
 * reaches the person's own records. A memory failure is logged and never fails the action.
 *
 * People are matched by the hash of their Cognito sub (and, for threads written before, of their email): never by
 * their email, which can change. Stored in the central bucket under projects/<slug>/chats/ (the API role needs Get,
 * List and conditional Put there).
 */
import { z } from 'zod'
import { type Author, type ChatMessage, ChatStore, MAX_MESSAGE_CHARS, MAX_USER_CHARS, ThreadId, isAuthor } from '../core/chats.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { type Actor, chatSession, personActor } from '../agents/runtime/memory.js'
import { isAdmin, require_ } from '../core/access.js'
import { ActionError, type Context, Repo, def, hashOf, hashesOf, label, plainly, projectMemory, storeAt } from './action-kit.js'

export const store = (ctx: Context, repo: string): ChatStore => new ChatStore(storeAt(ctx, PROJECTS_PREFIX), repo)
export const author = (ctx: Context): Author => ({ label: label(ctx.principal), hash: hashOf(ctx.principal), also: hashesOf(ctx.principal) })

/**
 * A soft limit on writes per person (per API runtime instance; AgentCore keeps one per session, and the web backend
 * uses one session per person, so in practice per person): a burst of BURST, refilled at RATE per second.
 */
export const CHAT_WRITES = { burst: 30, perSecond: 0.5 }
const buckets = new Map<string, { tokens: number; at: number }>()
export function takeChatWrite(sub: string, now: number = Date.now()): boolean {
  const b = buckets.get(sub) ?? { tokens: CHAT_WRITES.burst, at: now }
  b.tokens = Math.min(CHAT_WRITES.burst, b.tokens + ((now - b.at) / 1000) * CHAT_WRITES.perSecond)
  b.at = now
  buckets.set(sub, b)
  if (buckets.size > 10_000) for (const k of [...buckets.keys()].slice(0, 5000)) buckets.delete(k)
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}
/** Refuse the caller's write when they are over CHAT_WRITES (chats.append, chats.reply, memory.remember). */
export const limited = (ctx: Context): void => {
  if (!takeChatWrite(ctx.principal.sub)) throw new ActionError('Too many messages at once: wait a moment and try again.')
}

/** Each message with `yours`: a person's turn by its author; a reply by whom it answers (`for_hash`, else the turn
 * before it). */
export function markYours(messages: readonly ChatMessage[], who: Author): (ChatMessage & { yours: boolean })[] {
  let turn = false
  return messages.map((m) => {
    if (m.role === 'user') { turn = isAuthor(who, m.by_hash); return { ...m, yours: turn } }
    return { ...m, yours: m.for_hash ? isAuthor(who, m.for_hash) : turn }
  })
}

// ------------------------------------------------------------------ the conversation into memory

/** How long recording a turn may hold the answer (the turn is kept already; memory is best-effort). */
export const RECORD_MS = 4000
/** The most turns one call records (chats.append takes at most 20 messages). */
const MAX_RECORDED = 20

/** The one actor chat recording writes: the caller's own person actor. Never the project's chat actor (or any agent's),
 * whatever happens upstream: that is memory.remember's alone, on a person's Confirm. */
export function recordingActor(repo: string, sub: string): Actor {
  const a = personActor(repo, sub)
  if (a.kind !== 'person') throw new Error('chat recording writes only the person\'s own actor')
  return a
}

/**
 * Record the caller's own user turns in the project's memory, under their own person actor, best-effort: never throws,
 * and holds the answer at most RECORD_MS. Nothing for a read-only guest; never trace's words or tool rows (there is no
 * way to pass them here: only texts, recorded as role user).
 */
async function recordTurns(ctx: Context, repo: string, thread: string, texts: readonly string[]): Promise<void> {
  const log = ctx.deps.log ?? ((l: Record<string, unknown>) => { console.log(JSON.stringify(l)) })
  const work = (async () => {
    const turns = texts.filter((t) => t.trim()).slice(0, MAX_RECORDED)
    if (!turns.length) return
    const mem = projectMemory(ctx, repo)
    if (!mem) return
    // only people who may write to the project: a read-only guest's words are not recorded
    const writer = isAdmin(ctx.principal) || (await require_(ctx.principal, repo, 'read')) === 'write'
    if (!writer) return
    const actor = recordingActor(repo, ctx.principal.sub)
    const session = chatSession(thread)
    for (const t of turns) await mem.shortTerm.record(actor, session, 'user', t)
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((ok) => { timer = setTimeout(() => ok('late'), RECORD_MS) })
  try {
    if ((await Promise.race([work, late])) === 'late') log({ warning: 'chat memory: still recording, answered without waiting', repo })
  } catch (e) {
    log({ warning: 'chat memory: not recorded', repo, error: e instanceof Error ? e.name : 'Error', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
  } finally {
    clearTimeout(timer)
  }
  work.catch(() => undefined)
}

const Parts = z.unknown().optional()
/** A person's message: text only (any `role` sent is ignored: it is theirs). */
const NewMessage = z.object({ text: z.string().max(MAX_USER_CHARS), parts: Parts })
const Reply = z.object({ role: z.enum(['assistant', 'tool']), text: z.string().max(MAX_MESSAGE_CHARS), parts: Parts })

export const CHAT_ACTIONS = {
  'chats.list': def('read', Repo.extend({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).default(100) }), async (a, ctx) =>
    ({ repo: a.repo, threads: await store(ctx, a.repo).list({ query: a.query, limit: a.limit }) })),

  // each message says whether it is `yours`: your own turn, or trace's reply (and tool rows) to one of yours. The app
  // replays only those as the conversation; the rest are other people's, quoted as data (src/web/agui.ts)
  'chats.get': def('read', Repo.extend({ thread: ThreadId, before: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).default(50) }), async (a, ctx) => {
    const t = await store(ctx, a.repo).get(a.thread, { before: a.before, limit: a.limit })
    if (!t) throw new ActionError(`There is no conversation ${a.thread} on this project.`)
    return { repo: a.repo, ...t, messages: markYours(t.messages, author(ctx)) }
  }),

  'chats.append': def('read', Repo.extend({ thread: ThreadId.optional(), title: z.string().max(120).optional(), messages: z.array(NewMessage).min(1).max(20) }), async (a, ctx) => {
    limited(ctx)
    const out = await plainly(() => store(ctx, a.repo).append(author(ctx), { thread: a.thread, title: a.title, messages: a.messages }))
    await recordTurns(ctx, a.repo, out.thread.id, a.messages.map((m) => m.text))
    return { repo: a.repo, ...out }
  }),

  'chats.reply': def('read', Repo.extend({ thread: ThreadId, after: z.string().min(1).max(40), messages: z.array(Reply).min(1).max(50) }), async (a, ctx) => {
    limited(ctx)
    const out = await plainly(() => store(ctx, a.repo).reply(author(ctx), { thread: a.thread, after: a.after, messages: a.messages }))
    return { repo: a.repo, ...out }
  }),

  'chats.rename': def('read', Repo.extend({ thread: ThreadId, title: z.string().trim().min(1).max(120) }), async (a, ctx) =>
    ({ repo: a.repo, thread: await plainly(() => store(ctx, a.repo).rename(a.thread, a.title)) })),

  'chats.recall': def('read', Repo.extend({ limit: z.number().int().min(1).max(200).default(50) }), async (a, ctx) =>
    ({ repo: a.repo, messages: await store(ctx, a.repo).recall(author(ctx), a.limit) })),
}
