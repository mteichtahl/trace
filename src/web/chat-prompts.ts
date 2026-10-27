/**
 * The installation's changes to the chat agent's instructions (an admin's prompts.set of chat.role at installation
 * scope), as the web backend applies them: asked of the API (`prompts.chat`, src/api/actions-prompts.ts) with the
 * person's own token, and kept for a short while in this container.
 *
 *   why the API   the backend has no read of the prompts store, and gets none: the store is one database with every
 *                 prompt's override and its history, which S3 cannot grant in part. The API answers the editable
 *                 chat entries only
 *   cache         CACHE_MS (60 s) per container, the same for everyone (the answer depends on no person). A change made
 *                 through this backend (prompts.set / reset / revert, src/web/call.ts) clears this container's copy at
 *                 once; other containers pick it up within 60 s. The live event `record.changed { what: 'prompts' }`
 *                 cannot reach a Lambda (it is a browser subscription), so 60 s is the bound, and it is said here
 *   failure       the API not answering: the code defaults, logged, and asked again after FAILED_MS (15 s)
 *   locked        only editable ids are ever taken from the answer; the locked chat entries (chat.data, the fences)
 *                 are composed from the code whatever the API says (src/prompts/resolve.ts effective ignores an override
 *                 of a locked id too)
 */
import { z } from 'zod'
import { CATALOG } from '../prompts/catalog.js'
import type { Layers, Override } from '../prompts/resolve.js'
import { NO_LAYERS } from '../prompts/resolve.js'
import { type Caller, callApi } from './call.js'
import type { WebDeps } from './deps.js'

export const CACHE_MS = 60_000
export const FAILED_MS = 15_000

const Answer = z.object({
  ok: z.literal(true),
  result: z.object({
    entries: z.array(z.object({ id: z.string(), text: z.string().nullable(), version: z.number().nullable() }).loose()),
    unavailable: z.string().optional(),
  }).loose(),
}).loose()

/** The layers an answer of prompts.chat makes: its editable chat entries with a text, nothing else. */
export function layersOf(entries: readonly { id: string; text: string | null; version: number | null }[]): Layers {
  const installation = new Map<string, Override>()
  for (const e of entries) {
    const c = CATALOG.get(e.id)
    if (!c || c.prompt !== 'chat' || c.mode !== 'editable' || e.text === null) continue
    installation.set(e.id, { id: e.id, text: e.text, version: e.version ?? 0, updated: 0, by: null })
  }
  return installation.size ? { installation } : NO_LAYERS
}

export class ChatPrompts {
  private held: { layers: Layers; until: number } | null = null
  private pending: Promise<Layers> | null = null

  constructor(private readonly deps: WebDeps) {}

  /** The installation's chat layers: cached, else asked of the API as this person. Never throws. */
  async layers(who: Caller): Promise<Layers> {
    const now = this.deps.now()
    if (this.held && now < this.held.until) return this.held.layers
    this.pending ??= this.fetch(who).finally(() => { this.pending = null })
    return this.pending
  }

  /** A prompts change went through this container: ask again next time. */
  invalidate(): void { this.held = null }

  private async fetch(who: Caller): Promise<Layers> {
    try {
      const a = await callApi(this.deps, who, 'prompts.chat', {})
      const parsed = Answer.safeParse(a.json)
      if (a.status !== 200 || !parsed.success) throw new Error(`prompts.chat answered ${a.status}`)
      if (parsed.data.result.unavailable) this.deps.log({ warning: 'chat prompts: the installation\'s overrides could not be read; the defaults are used', reason: parsed.data.result.unavailable })
      const layers = layersOf(parsed.data.result.entries)
      this.held = { layers, until: this.deps.now() + CACHE_MS }
      return layers
    } catch (e) {
      this.deps.log({ warning: 'chat prompts: the API did not answer; the defaults are used', error: e instanceof Error ? e.message.slice(0, 200) : String(e) })
      this.held = { layers: NO_LAYERS, until: this.deps.now() + FAILED_MS }
      return NO_LAYERS
    }
  }
}

/** The actions after which this container's copy is cleared (installation scope only changes it, but any is cheap). */
export const PROMPT_WRITES: ReadonlySet<string> = new Set(['prompts.set', 'prompts.reset', 'prompts.revert'])

const perContainer = new WeakMap<WebDeps, ChatPrompts>()

/** This container's cache (one per deps: the tests' worlds are kept apart). */
export function chatPrompts(deps: WebDeps): ChatPrompts {
  let c = perContainer.get(deps)
  if (!c) { c = new ChatPrompts(deps); perContainer.set(deps, c) }
  return c
}
