/**
 * Ask trace's conversations through the API (src/core/chats.ts keeps them). Every thread on a project is visible to
 * everyone on it, so each action needs read on the project; adding to one needs read too, because a reviewer may
 * ask trace questions (what trace then does on their behalf is checked again as them, action by action).
 *
 *   chats.list    read   the project's threads, newest first; `query` searches their names and last lines
 *   chats.get     read   one thread's messages, oldest first, a page at a time backwards (`before`, `limit`)
 *   chats.append  read   add messages to a thread, or start one (no `thread`): the person's own messages are named
 *                        by them; trace's replies and tool rows by no one
 *   chats.rename  read   give a thread a name
 *   chats.recall  read   the person's own sent messages on this project, newest first (Up and Down in the box)
 *
 * Stored in the central bucket under projects/<slug>/chats/ (the API role needs Get, List and conditional Put there).
 */
import { z } from 'zod'
import { ChatStore, MAX_MESSAGE_CHARS, ROLES, ThreadId } from '../core/chats.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { ActionError, type Context, Repo, def, hashOf, label, plainly, storeAt } from './action-kit.js'

const store = (ctx: Context, repo: string): ChatStore => new ChatStore(storeAt(ctx, PROJECTS_PREFIX), repo)
const author = (ctx: Context): { label: string; hash: string } => ({ label: label(ctx.principal), hash: hashOf(ctx.principal) })

const NewMessage = z.object({ role: z.enum(ROLES).default('user'), text: z.string().max(MAX_MESSAGE_CHARS), parts: z.unknown().optional() })

export const CHAT_ACTIONS = {
  'chats.list': def('read', Repo.extend({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).default(100) }), async (a, ctx) =>
    ({ repo: a.repo, threads: await store(ctx, a.repo).list({ query: a.query, limit: a.limit }) })),

  'chats.get': def('read', Repo.extend({ thread: ThreadId, before: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).default(50) }), async (a, ctx) => {
    const t = await store(ctx, a.repo).get(a.thread, { before: a.before, limit: a.limit })
    if (!t) throw new ActionError(`There is no conversation ${a.thread} on this project.`)
    return { repo: a.repo, ...t }
  }),

  'chats.append': def('read', Repo.extend({ thread: ThreadId.optional(), title: z.string().max(120).optional(), messages: z.array(NewMessage).min(1).max(50) }), async (a, ctx) =>
    ({ repo: a.repo, ...(await plainly(() => store(ctx, a.repo).append(author(ctx), { thread: a.thread, title: a.title, messages: a.messages }))) })),

  'chats.rename': def('read', Repo.extend({ thread: ThreadId, title: z.string().trim().min(1).max(120) }), async (a, ctx) =>
    ({ repo: a.repo, thread: await plainly(() => store(ctx, a.repo).rename(a.thread, a.title)) })),

  'chats.recall': def('read', Repo.extend({ limit: z.number().int().min(1).max(200).default(50) }), async (a, ctx) =>
    ({ repo: a.repo, messages: await store(ctx, a.repo).recall(author(ctx), a.limit) })),
}
