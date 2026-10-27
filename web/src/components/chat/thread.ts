/**
 * A stored thread as a conversation for this viewer (docs/ui-design.md "Conversations are part of the record", and
 * the rule that only a person's own words are ever their request):
 *
 *   - the viewer's own turns, and trace's replies to them, become the AG-UI conversation, with their cards (tool
 *     calls and results)
 *   - other people's turns, and trace's replies to them, are shown in the thread but go to trace only as quoted data
 *     (`foreign`: id → "who: text", or "" for a row that is not quoted at all, a tool result); a thread with any of
 *     them is read-only for trace (no start_task)
 *
 * What the person sends is kept with chats.append (their own words only); trace's replies are kept by the chat agent
 * itself (src/web/agui.ts, chats.reply).
 */
import type { Message } from '@ag-ui/client'
import type { ChatMessage } from '@/lib/types'

export interface Replay {
  messages: Message[]
  /** id → the quoted line for trace ("" for a row not quoted) */
  foreign: Map<string, string>
  /** the stored id of the viewer's own latest turn, when it is the thread's latest person turn */
  after?: string
}

const MAX_QUOTE = 2000

export function toReplay(ms: readonly ChatMessage[]): Replay {
  const messages: Message[] = []
  const foreign = new Map<string, string>()
  let after: string | undefined
  for (const m of ms) {
    if (m.role === 'system') continue
    const mine = m.yours !== false
    if (m.role === 'user') after = mine ? m.id : undefined
    if (!mine) foreign.set(m.id, m.role === 'tool' ? '' : `${m.role === 'user' ? (m.author ?? 'someone on the project') : 'trace (to them)'}: ${m.content.slice(0, MAX_QUOTE)}`)
    if (m.role === 'tool') messages.push({ id: m.id, role: 'tool', content: m.content, toolCallId: m.toolCallId ?? '' } as Message)
    else if (m.role === 'assistant')
      messages.push({ id: m.id, role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) } : {}) } as Message)
    else messages.push({ id: m.id, role: 'user', content: m.content } as Message)
  }
  return { messages, foreign, ...(after ? { after } : {}) }
}

/** Kept for compatibility: stored messages → AG-UI messages. */
export const toAgui = (ms: readonly ChatMessage[]): Message[] => toReplay(ms).messages
