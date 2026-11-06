/**
 * The Intent builder's conversation (test-esp32 #8, #21): trace asks the topic's question when the builder opens, and
 * the conversation is kept, so coming back opens it again with trace's question after what was said, at the topic left.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@/lib/api'
import { ChatView } from '@/components/chat/chat-view'
import { SKILL_BY_ID } from './definitions'
import { IntentOpening, TOPIC_QUESTIONS, openingWords, threadKey, useSkillThread } from './intent-chat'

type Msg = { id: string; role: string; content: string }
const agent = {
  messages: [] as Msg[], isRunning: false, threadId: undefined as string | undefined,
  setMessages(m: Msg[]) { this.messages = m; bump() },
  addMessage(m: Msg) { this.messages = [...this.messages, m]; bump() },
}
let bump = () => {}
vi.mock('@copilotkit/react-core/v2', () => ({
  useAgent: () => { const [, set] = useState(0); bump = () => set((x) => x + 1); return { agent } },
  useCopilotKit: () => ({ copilotkit: { runAgent: async () => undefined, stopAgent: () => undefined } }),
  useRenderToolCall: () => () => null,
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
const mockCall = vi.mocked(call)
const def = SKILL_BY_ID['intent-builder']!
const REPO = 'acme/soil-sensor'
let qc: QueryClient
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
const opening = <IntentOpening words={openingWords(def, 0, [])} />

let stored: Record<string, { id: string; role: string; content: string }[]>
let prefs: Record<string, unknown>
beforeEach(() => {
  // jsdom plays no audio: the chat unlocks it on the first key press
  HTMLMediaElement.prototype.play = () => Promise.resolve()
  HTMLMediaElement.prototype.pause = () => undefined
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  agent.messages = []
  stored = { t1: [{ id: 'm1', role: 'user', content: 'It measures soil moisture for a farm manager.' }, { id: 'm2', role: 'assistant', content: 'Noted as the purpose.' }] }
  prefs = { prefs: {}, views: {} }
  mockCall.mockReset()
  mockCall.mockImplementation((async (action: string, a: Record<string, unknown>) => {
    if (action === 'chats.get') { const m = stored[String(a.thread)]; if (!m) throw new Error('There is no such conversation.'); return { messages: m } }
    if (action === 'chats.append') return { id: a.thread ?? 't9', messageId: 'u1' }
    if (action === 'chats.recall') return []
    if (action === 'me.get') return prefs
    if (action === 'me.set') return { ok: true }
    return {}
  }) as unknown as typeof call)
})

describe('trace opens the Intent builder', () => {
  it('asks the first topic\'s question, not the bar\'s count', () => {
    const w = openingWords(def, 0, [])
    expect(w).toContain('First, **purpose**. What does the product do, in one sentence, and who uses it?')
    expect(w).not.toMatch(/checks met/)
    // coming back: the topic the person left
    expect(openingWords(def, 2, ['purpose', 'environment'])).toBe(`We're on **power** (topic 3 of 10). ${TOPIC_QUESTIONS.power}`)
    // a question for every topic
    for (const s of def.steps) expect(TOPIC_QUESTIONS[s.id]).toContain('?')
  })

  it('the question stays first in a new conversation once the person answers', async () => {
    const onThread = vi.fn()
    wrap(<ChatView agentId="trace-focus" repo={REPO} intro={opening} pinIntro onThread={onThread} />)
    expect(screen.getByLabelText('trace asks')).toHaveTextContent('What does the product do')
    await userEvent.type(screen.getByRole('textbox'), 'A soil moisture probe{Enter}')
    expect(await screen.findByText('A soil moisture probe')).toBeInTheDocument()
    expect(screen.getByLabelText('trace asks')).toBeInTheDocument()
    expect(screen.getByLabelText('trace asks').compareDocumentPosition(screen.getByText('A soil moisture probe')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the new conversation's thread is handed back to keep
    await waitFor(() => expect(onThread).toHaveBeenCalledWith('t9'))
  })
})

describe('the conversation is kept', () => {
  it('opens the kept thread, with trace\'s question after what was said', async () => {
    wrap(<ChatView agentId="trace-focus" repo={REPO} threadId="t1" intro={<IntentOpening words={openingWords(def, 1, ['purpose'])} />} pinIntro />)
    const earlier = await screen.findByText('Noted as the purpose.')
    const ask = screen.getByLabelText('trace asks')
    expect(ask).toHaveTextContent("We're on environment")
    expect(earlier.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a kept thread that is gone does not leave the chat stuck opening: the next message starts a new one', async () => {
    const onThread = vi.fn()
    wrap(<ChatView agentId="trace-focus" repo={REPO} threadId="gone" intro={opening} pinIntro onThread={onThread} />)
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    await userEvent.type(screen.getByRole('textbox'), 'A soil moisture probe{Enter}')
    await waitFor(() => expect(onThread).toHaveBeenCalledWith('t9'))
    expect(mockCall.mock.calls.filter(([a]) => a === 'chats.append')[0]![1]).not.toHaveProperty('thread')
  })

  it('the skill\'s thread is kept with the person\'s preferences, per project', async () => {
    prefs = { prefs: {}, views: {}, threads: { 'acme_soil-sensor': { 'intent-builder': 't1' } } }
    expect(threadKey(REPO, 'intent-builder')).toBe('threads.acme_soil-sensor.intent-builder')
    const { result } = renderHook(() => useSkillThread(REPO, 'intent-builder'), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.thread).toBe('t1')
    result.current.keep('t2')
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('me.set', { key: 'threads.acme_soil-sensor.intent-builder', value: 't2' }))
    await waitFor(() => expect(result.current.thread).toBe('t2'))
  })
})
