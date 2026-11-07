/**
 * A skill's chat is kept (test log R25): Requirements review's (and every stepped skill's) conversation opens again
 * after a reload or on the next visit, as the Intent builder's does.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@/lib/api'
import { SkillChat } from './skill-chat'

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
const REPO = 'acme/soil-sensor'
let qc: QueryClient
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
let prefs: Record<string, unknown>

beforeEach(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve()
  HTMLMediaElement.prototype.pause = () => undefined
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  agent.messages = []
  prefs = { prefs: {}, views: {} }
  mockCall.mockReset()
  mockCall.mockImplementation((async (action: string, a: Record<string, unknown>) => {
    if (action === 'chats.get') return { messages: a.thread === 't1' ? [{ id: 'm1', role: 'user', content: 'Start the power sheet.' }, { id: 'm2', role: 'assistant', content: 'I offered to start it.' }] : [] }
    if (action === 'chats.append') return { id: a.thread ?? 't9', messageId: 'u1' }
    if (action === 'chats.recall') return []
    if (action === 'me.get') return prefs
    if (action === 'me.set') return { ok: true }
    return {}
  }) as unknown as typeof call)
})

describe('a skill\'s chat is kept', () => {
  it('opens the conversation kept for the skill on the project', async () => {
    prefs = { prefs: {}, views: {}, threads: { 'acme_soil-sensor': { 'requirements-review': 't1' } } }
    wrap(<SkillChat repo={REPO} skill="requirements-review" intro={<p>Step intro</p>} />)
    expect(await screen.findByText('I offered to start it.')).toBeInTheDocument()
    expect(mockCall).toHaveBeenCalledWith('chats.get', { repo: REPO, thread: 't1', limit: 500 })
  })

  it('a new conversation\'s thread is kept for the next visit', async () => {
    wrap(<SkillChat repo={REPO} skill="requirements-review" intro={<p>Step intro</p>} />)
    await userEvent.type(await screen.findByRole('textbox'), 'Why is REQ-3 inferred?{Enter}')
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('me.set', { key: 'threads.acme_soil-sensor.requirements-review', value: 't9' }))
  })
})
