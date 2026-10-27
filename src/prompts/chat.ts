/**
 * The web app's chat agent's system prompt (Ask trace, src/web/agui.ts): chat.role (editable), chat.data, and the
 * screen's context and shared state, each fenced (locked). The context and state are cleaned of their closing fence
 * tags, so nothing inside can end the fence early.
 */
import { type Composed, Composer, type Layers, NO_LAYERS } from './resolve.js'

export interface ChatContext { description: string; value: string }

const MAX_STATE = 8000

export function composeChat(context: readonly ChatContext[], state: unknown, layers: Layers = NO_LAYERS): Composed {
  const p = new Composer(layers).add('chat.role').add('chat.data')
  const lines = context.map((c) => `- ${c.description}: ${c.value}`.replaceAll('</app-context>', ''))
  if (lines.length) p.add('chat.context', { context: lines })
  const empty = state === undefined || state === null || (typeof state === 'object' && Object.keys(state).length === 0)
  if (!empty) p.add('chat.state', { state: JSON.stringify(state).slice(0, MAX_STATE).replaceAll('</app-state>', '') })
  return p.done()
}
