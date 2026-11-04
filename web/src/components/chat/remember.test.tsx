import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ChatRepo, ChatThread, LiveCall, RememberCard } from './renderers'

afterEach(() => { vi.restoreAllMocks() })

const args = { repo: 'acme/board', text: 'The case is printed in PETG.', scope: 'project' as const }
/** In a conversation on acme/board, as the chat screen sets it. */
const wrapper = ({ children }: { children: ReactNode }) => <ChatRepo.Provider value="acme/board">{children}</ChatRepo.Provider>
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('remember: trace asks, the person confirms', () => {
  it('shows the exact words and whose they are; only Confirm calls memory.remember, as the person, in this thread', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ repo: 'acme/board', recorded: true, scope: 'project', actor: 'chat', session: 'chat-abcdefgh12', note: 'Recorded.' }))
    const respond = vi.fn()
    render(<ChatThread.Provider value="abcdefgh12"><RememberCard args={args} status="executing" respond={respond} /></ChatThread.Provider>, { wrapper })
    expect(screen.getByLabelText('What trace will remember')).toHaveTextContent('The case is printed in PETG.')
    expect(screen.getByText(/A fact about the project/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Remember this/ }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ confirmed: true, recorded: true, note: 'Recorded.' }))
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    // no author in the request: the API takes it from the person's sign-in
    expect(bodies).toEqual([{ action: 'memory.remember', repo: 'acme/board', text: 'The case is printed in PETG.', scope: 'project', thread: 'abcdefgh12' }])
  })

  it('a personal preference says it is the person\'s own', () => {
    render(<RememberCard args={{ ...args, scope: 'personal' }} status="executing" respond={vi.fn()} />, { wrapper })
    expect(screen.getByText(/Your own preference/)).toBeInTheDocument()
  })

  it('Cancel remembers nothing and tells trace', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const respond = vi.fn()
    render(<RememberCard args={args} status="executing" respond={respond} />, { wrapper })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(respond).toHaveBeenCalledWith({ confirmed: false, reason: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a kept offer the conversation went on from shows as not remembered, with no buttons', () => {
    render(<LiveCall.Provider value={false}><RememberCard args={args} status="inProgress" /></LiveCall.Provider>, { wrapper })
    expect(screen.getByText(/Not remembered: the conversation went on/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remember this/ })).toBeNull()
  })

  it('done: says it shows in Memory after extraction, or why not', () => {
    const { rerender } = render(<RememberCard args={args} status="complete" result={JSON.stringify({ confirmed: true, recorded: true })} />, { wrapper })
    expect(screen.getByRole('status')).toHaveTextContent(/shows in Memory in a few minutes/)
    rerender(<RememberCard args={args} status="complete" result={JSON.stringify({ confirmed: true, recorded: false, reason: 'no write access to acme/board' })} />)
    expect(screen.getByRole('status')).toHaveTextContent('Not remembered: no write access to acme/board.')
  })

  describe('locked to the conversation\'s project', () => {
    it('writes to the conversation\'s project, whatever spelling trace gave it', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ repo: 'acme/board', recorded: true, note: 'Recorded.' }))
      render(<RememberCard args={{ ...args, repo: 'Acme/Board' }} status="executing" respond={vi.fn()} />, { wrapper })
      await userEvent.click(screen.getByRole('button', { name: /Remember this/ }))
      await waitFor(() => expect(fetch).toHaveBeenCalled())
      expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ action: 'memory.remember', repo: 'acme/board' })
    })

    it('another project than the conversation\'s is refused on the card: no Remember, nothing written, Dismiss tells trace why', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      const respond = vi.fn()
      render(<RememberCard args={{ ...args, repo: 'acme/secret' }} status="executing" respond={respond} />, { wrapper })
      expect(screen.getByRole('alert')).toHaveTextContent('trace named acme/secret, but this conversation is on acme/board: nothing can be remembered on another project from here.')
      expect(screen.queryByRole('button', { name: /Remember this/ })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      expect(respond).toHaveBeenCalledWith({ confirmed: false, reason: expect.stringMatching(/^trace named acme\/secret/) as unknown as string })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('a conversation on no project remembers nothing', () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      render(<RememberCard args={args} status="executing" respond={vi.fn()} />)
      expect(screen.getByRole('alert')).toHaveTextContent(/not on a project/)
      expect(screen.queryByRole('button', { name: /Remember this/ })).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })
  })
})
