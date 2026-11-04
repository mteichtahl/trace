import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatThread, LiveCall, RememberCard } from './renderers'

afterEach(() => { vi.restoreAllMocks() })

const args = { repo: 'acme/board', text: 'The case is printed in PETG.', scope: 'project' as const }
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('remember: trace asks, the person confirms', () => {
  it('shows the exact words and whose they are; only Confirm calls memory.remember, as the person, in this thread', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ repo: 'acme/board', recorded: true, scope: 'project', actor: 'chat', session: 'chat-abcdefgh12', note: 'Recorded.' }))
    const respond = vi.fn()
    render(<ChatThread.Provider value="abcdefgh12"><RememberCard args={args} status="executing" respond={respond} /></ChatThread.Provider>)
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
    render(<RememberCard args={{ ...args, scope: 'personal' }} status="executing" respond={vi.fn()} />)
    expect(screen.getByText(/Your own preference/)).toBeInTheDocument()
  })

  it('Cancel remembers nothing and tells trace', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const respond = vi.fn()
    render(<RememberCard args={args} status="executing" respond={respond} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(respond).toHaveBeenCalledWith({ confirmed: false, reason: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a kept offer the conversation went on from shows as not remembered, with no buttons', () => {
    render(<LiveCall.Provider value={false}><RememberCard args={args} status="inProgress" /></LiveCall.Provider>)
    expect(screen.getByText(/Not remembered: the conversation went on/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remember this/ })).toBeNull()
  })

  it('done: says it shows in Memory after extraction, or why not', () => {
    const { rerender } = render(<RememberCard args={args} status="complete" result={JSON.stringify({ confirmed: true, recorded: true })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/shows in Memory in a few minutes/)
    rerender(<RememberCard args={args} status="complete" result={JSON.stringify({ confirmed: true, recorded: false, reason: 'no write access to acme/board' })} />)
    expect(screen.getByRole('status')).toHaveTextContent('Not remembered: no write access to acme/board.')
  })
})
