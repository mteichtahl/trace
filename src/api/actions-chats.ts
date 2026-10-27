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
 * People are matched by the hash of their Cognito sub (and, for threads written before, of their email): never by
 * their email, which can change. Stored in the central bucket under projects/<slug>/chats/ (the API role needs Get,
 * List and conditional Put there).
 */
import { z } from 'zod'
import { type Author, ChatStore, MAX_MESSAGE_CHARS, MAX_USER_CHARS, ThreadId } from '../core/chats.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { ActionError, type Context, Repo, def, hashOf, hashesOf, label, plainly, storeAt } from './action-kit.js'

const store = (ctx: Context, repo: string): ChatStore => new ChatStore(storeAt(ctx, PROJECTS_PREFIX), repo)
const author = (ctx: Context): Author => ({ label: label(ctx.principal), hash: hashOf(ctx.principal), also: hashesOf(ctx.principal) })

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
const limited = (ctx: Context): void => {
  if (!takeChatWrite(ctx.principal.sub)) throw new ActionError('Too many messages at once: wait a moment and try again.')
}

const Parts = z.unknown().optional()
/** A person's message: text only (any `role` sent is ignored: it is theirs). */
const NewMessage = z.object({ text: z.string().max(MAX_USER_CHARS), parts: Parts })
const Reply = z.object({ role: z.enum(['assistant', 'tool']), text: z.string().max(MAX_MESSAGE_CHARS), parts: Parts })

export const CHAT_ACTIONS = {
  'chats.list': def('read', Repo.extend({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).default(100) }), async (a, ctx) =>
    ({ repo: a.repo, threads: await store(ctx, a.repo).list({ query: a.query, limit: a.limit }) })),

  'chats.get': def('read', Repo.extend({ thread: ThreadId, before: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).default(50) }), async (a, ctx) => {
    const t = await store(ctx, a.repo).get(a.thread, { before: a.before, limit: a.limit })
    if (!t) throw new ActionError(`There is no conversation ${a.thread} on this project.`)
    return { repo: a.repo, ...t }
  }),

  'chats.append': def('read', Repo.extend({ thread: ThreadId.optional(), title: z.string().max(120).optional(), messages: z.array(NewMessage).min(1).max(20) }), async (a, ctx) => {
    limited(ctx)
    return { repo: a.repo, ...(await plainly(() => store(ctx, a.repo).append(author(ctx), { thread: a.thread, title: a.title, messages: a.messages }))) }
  }),

  'chats.reply': def('read', Repo.extend({ thread: ThreadId, after: z.string().min(1).max(40), messages: z.array(Reply).min(1).max(50) }), async (a, ctx) => {
    limited(ctx)
    return { repo: a.repo, ...(await plainly(() => store(ctx, a.repo).reply(author(ctx), { thread: a.thread, after: a.after, messages: a.messages }))) }
  }),

  'chats.rename': def('read', Repo.extend({ thread: ThreadId, title: z.string().trim().min(1).max(120) }), async (a, ctx) =>
    ({ repo: a.repo, thread: await plainly(() => store(ctx, a.repo).rename(a.thread, a.title)) })),

  'chats.recall': def('read', Repo.extend({ limit: z.number().int().min(1).max(200).default(50) }), async (a, ctx) =>
    ({ repo: a.repo, messages: await store(ctx, a.repo).recall(author(ctx), a.limit) })),
}
