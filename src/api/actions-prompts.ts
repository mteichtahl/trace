/**
 * The chat agent's instructions as the installation has them: what the web backend (src/web/agui.ts) needs to apply an
 * admin's change to Ask trace, without reading the prompts store itself.
 *
 *   prompts.chat   any class   the installation's text of each EDITABLE `chat.*` entry of the catalog (today chat.role):
 *                              the override when there is one that still validates, else null (the code default
 *                              applies), with its version and the sha of the text. Locked `chat.*` entries are never
 *                              answered: whatever the store holds for them, the backend composes them from the code,
 *                              so they stay locked
 *
 * Why an action and not read access for the backend: the installation's overrides are one SQLite database
 * (prompts/…/central.db, src/prompts/store.ts) holding every prompt's override, the specialists' and the workflows'
 * among them, and their history with who changed what. S3 cannot grant a part of one object, so read access would give
 * the backend all of it. The API already reads the store for prompts.list and prompts.get; this answers the chat
 * entries only, after the same "in an account class" check every prompts read makes.
 */
import { z } from 'zod'
import { AccessDenied, classOf } from '../core/access.js'
import { CATALOG } from '../prompts/catalog.js'
import { effective, type Override } from '../prompts/resolve.js'
import { InstallationPrompts } from '../prompts/store.js'
import { type Context, NO_ACCESS, def } from './action-kit.js'

/** The editable entries of the chat prompt: the only ones prompts.chat answers. */
export const CHAT_EDITABLE: readonly string[] = [...CATALOG.values()].filter((e) => e.prompt === 'chat' && e.mode === 'editable').map((e) => e.id)

export interface ChatPromptEntry { id: string; text: string | null; version: number | null; sha: string; skipped?: string[] }

/** The installation layer's text of each editable chat entry (null: the code default). Pure: the overrides are given. */
export function chatEntries(installation: ReadonlyMap<string, Override>): ChatPromptEntry[] {
  return CHAT_EDITABLE.map((id) => {
    const { template, provenance: p } = effective(id, { installation })
    const skipped = (p.skipped ?? []).map((s) => `v${s.version}: ${s.reason}`)
    return { id, text: p.layer === 'installation' ? template : null, version: p.version, sha: p.sha, ...(skipped.length ? { skipped } : {}) }
  })
}

export const PROMPT_ACTIONS = {
  'prompts.chat': def('signed-in', z.object({}), async (_a, ctx: Context) => {
    if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
    const store = ctx.deps.prompts?.() ?? new InstallationPrompts()
    try {
      return { entries: chatEntries(await store.overrides()) }
    } catch (e) {
      // the store could not be read: the backend uses the code defaults, and says why in its log
      return { entries: chatEntries(new Map()), unavailable: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
    }
  }),
}
