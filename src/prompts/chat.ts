/**
 * The web app's chat agent's system prompt (Ask trace, src/web/agui.ts): chat.role (editable), chat.data, and the
 * screen's context and shared state, each fenced (locked); in a shared conversation, the other people's messages
 * (chat.others) and, when work may not be started, chat.read_only. Every fenced value is cleaned of its closing tag,
 * so nothing inside can end the fence early. Tool results reach the model fenced too (chat.tool_result, fenceResult).
 */
import { type Composed, Composer, type Layers, NO_LAYERS, resolvePrompt } from './resolve.js'

export interface ChatContext { description: string; value: string }

const MAX_STATE = 8000
const MAX_OTHERS = 40_000

/** Remove every closing tag of a fence (and its look-alikes with spaces or case changes) from a value. */
export const unfence = (value: string, tag: string): string => value.replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'gi'), '')

export interface ChatOptions {
  /** earlier messages by other people (and trace's replies to them), "who: text" each */
  others?: readonly string[] | undefined
  /** work may not be started here */
  readOnly?: boolean | undefined
}

export function composeChat(context: readonly ChatContext[], state: unknown, layers: Layers = NO_LAYERS, o: ChatOptions = {}): Composed {
  const p = new Composer(layers).add('chat.role').add('chat.data')
  const lines = context.map((c) => unfence(`- ${c.description}: ${c.value}`, 'app-context'))
  if (lines.length) p.add('chat.context', { context: lines })
  const empty = state === undefined || state === null || (typeof state === 'object' && Object.keys(state).length === 0)
  if (!empty) p.add('chat.state', { state: unfence(JSON.stringify(state).slice(0, MAX_STATE), 'app-state') })
  if (o.others?.length) {
    let left = MAX_OTHERS
    const kept: string[] = []
    for (const m of [...o.others].reverse()) {
      const line = unfence(`- ${m}`, 'other-people').replace(/\n/g, ' ')
      if (line.length > left) break
      kept.unshift(line)
      left -= line.length
    }
    p.add('chat.others', { messages: kept })
  }
  if (o.readOnly) p.add('chat.read_only')
  return p.done()
}

/** One tool's result as the model reads it: fenced as data (chat.tool_result). */
export const fenceResult = (tool: string, result: string, layers: Layers = NO_LAYERS): string =>
  resolvePrompt('chat.tool_result', { tool: tool.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'a tool', result: unfence(result, 'tool-result') }, layers).text
