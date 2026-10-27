import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StartTaskCard } from './renderers'

afterEach(() => vi.restoreAllMocks())

const args = { repo: 'acme/board', request: 'Run ERC on the power sheet', agent: 'verify' }

describe('start_task: trace asks, the person confirms', () => {
  it('shows the exact request and agent; Confirm calls task as the person and answers trace with the job', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { accepted: true, jobId: 'acme--board--j1' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const respond = vi.fn()
    render(<StartTaskCard args={args} status="executing" respond={respond} />)
    expect(screen.getByLabelText('The exact request')).toHaveTextContent('Run ERC on the power sheet')
    expect(screen.getByText(/Agent: Verification/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Confirm and start/ }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ confirmed: true, accepted: true, jobId: 'acme--board--j1' }))
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/call')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ action: 'task', repo: 'acme/board', request: 'Run ERC on the power sheet', agent: 'verify' })
  })

  it('Cancel starts nothing and tells trace', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const respond = vi.fn()
    render(<StartTaskCard args={args} status="executing" respond={respond} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(respond).toHaveBeenCalledWith({ confirmed: false, reason: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('done: the run card for a started job, words for one that was not', () => {
    const { rerender } = render(<StartTaskCard args={args} status="complete" result={JSON.stringify({ confirmed: true, accepted: true, jobId: 'j1' })} />)
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull()
    rerender(<StartTaskCard args={args} status="complete" result={JSON.stringify({ confirmed: false, reason: 'cancelled' })} />)
    expect(screen.getByText('You cancelled this.')).toBeInTheDocument()
  })
})
