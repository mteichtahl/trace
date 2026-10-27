/**
 * One question to trace's chat agent outside the chat panel (POST /api/agui, AG-UI events over SSE), for a screen
 * that wants an answer in place: "Ask trace to improve it" on an agent instruction. Streams the reply's text as it is
 * written and resolves with the whole reply. Same token, body hash and refresh as the chat (components/chat/agent.ts).
 */
import { signedFetch } from '@/components/chat/agent'

export interface AskOnce {
  prompt: string
  /** what is on screen, as AG-UI context entries */
  context?: { description: string; value: string }[]
  onText?: (soFar: string) => void
  signal?: AbortSignal
}

export async function askOnce(o: AskOnce): Promise<string> {
  const id = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2))
  const body = JSON.stringify({
    threadId: `once-${id()}`,
    runId: id(),
    state: {},
    messages: [{ id: id(), role: 'user', content: o.prompt }],
    tools: [],
    context: o.context ?? [],
    forwardedProps: {},
  })
  const res = await signedFetch('/api/agui', { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, signal: o.signal })
  if (!res.ok || !res.body) throw new Error(`trace could not answer (${res.status})`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const e = JSON.parse(line.slice(5).trim()) as { type: string; delta?: string; message?: string }
          if (e.type === 'TEXT_MESSAGE_CONTENT' && e.delta) {
            text += e.delta
            o.onText?.(text)
          } else if (e.type === 'RUN_ERROR') throw new Error(e.message ?? 'trace stopped')
        } catch (err) {
          if (err instanceof Error && err.message !== 'Unexpected end of JSON input' && !(err instanceof SyntaxError)) throw err
        }
      }
    }
  }
  return text
}
