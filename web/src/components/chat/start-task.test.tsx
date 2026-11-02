import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { keys } from '@/lib/queries'
import { ChatRepo, LiveCall, StartTaskCard } from './renderers'

afterEach(() => { vi.restoreAllMocks(); qc.clear() })
beforeEach(() => { qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }) })

const args = { repo: 'acme/board', request: 'Run ERC on the power sheet', agent: 'verify' }
let qc = new QueryClient()
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>

describe('start_task: trace asks, the person confirms', () => {
  it('the run card follows the job: what the project\'s job list says of it now, not the moment it was started', () => {
    qc.setQueryData(keys.action('jobs.list', { repo: 'acme/board' }), { repo: 'acme/board', jobs: [{ id: 'j1', repo: 'acme/board', title: 'Run ERC on the power sheet', state: 'done', summary: 'ERC clean.' }], agents: [], handoffs: [], batch: [], updatedAt: '' })
    render(<StartTaskCard args={args} status="complete" result={JSON.stringify({ confirmed: true, accepted: true, jobId: 'j1' })} />, { wrapper })
    expect(screen.queryByText(/Queued/)).toBeNull()
  })

  it('shows the exact request and agent; Confirm calls task as the person and answers trace with the job', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { accepted: true, jobId: 'acme--board--j1' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const respond = vi.fn()
    render(<StartTaskCard args={args} status="executing" respond={respond} />, { wrapper })
    expect(screen.getByLabelText('The exact request')).toHaveTextContent('Run ERC on the power sheet')
    expect(screen.getByText(/Agent: Verification/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Confirm and start/ }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ confirmed: true, accepted: true, jobId: 'acme--board--j1' }))
    // the task call (the card then follows the job through the project's job list)
    const bodies = fetch.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as { action: string } }))
    expect(bodies.filter((b) => b.body.action === 'task')).toEqual([{ url: '/api/call', body: { action: 'task', repo: 'acme/board', request: 'Run ERC on the power sheet', agent: 'verify' } }])
  })

  it('a kept offer the conversation went on from shows as not started, with no buttons and no spinner', () => {
    render(<LiveCall.Provider value={false}><StartTaskCard args={args} status="inProgress" /></LiveCall.Provider>, { wrapper })
    expect(screen.getByText('Not started: the conversation went on without it being confirmed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm and start/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
  })

  it('Cancel starts nothing and tells trace', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const respond = vi.fn()
    // in the conversation on its own project (the screen's notice asks for its agent, not the card)
    render(<ChatRepo.Provider value="acme/board"><StartTaskCard args={args} status="executing" respond={respond} /></ChatRepo.Provider>, { wrapper })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(respond).toHaveBeenCalledWith({ confirmed: false, reason: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('done: the run card for a started job, words for one that was not', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { repo: 'acme/board', jobs: [], agents: [], handoffs: [], batch: [], updatedAt: '' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { rerender } = render(<StartTaskCard args={args} status="complete" result={JSON.stringify({ confirmed: true, accepted: true, jobId: 'j1' })} />, { wrapper })
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull()
    rerender(<StartTaskCard args={args} status="complete" result={JSON.stringify({ confirmed: false, reason: 'cancelled' })} />)
    expect(screen.getByText('You cancelled this.')).toBeInTheDocument()
  })

  describe('while a project\'s agent is being set up', () => {
    const settingUp = (repo: string) => ({ repo, ready: false, state: 'setting_up', text: 'The installation update is running.', requested_at: null, update: null, expected_by: null, next_check_s: 60 })
    const answer = (body: unknown) => new Response(JSON.stringify({ ok: true, result: body }), { status: 200, headers: { 'content-type': 'application/json' } })

    it('the conversation\'s own project: Confirm waits on what the screen\'s notice knows, and asks nothing itself', () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      qc.setQueryData(keys.action('project.agent', { repo: 'acme/board' }), settingUp('acme/board'))
      render(<ChatRepo.Provider value="acme/board"><StartTaskCard args={args} status="executing" respond={vi.fn()} /></ChatRepo.Provider>, { wrapper })
      expect(screen.getByRole('button', { name: /Confirm and start/ })).toBeDisabled()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('another project than the conversation\'s: asks for that project\'s agent, and Confirm waits for it', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(settingUp('acme/board')))
      render(<ChatRepo.Provider value="acme/other"><StartTaskCard args={args} status="executing" respond={vi.fn()} /></ChatRepo.Provider>, { wrapper })
      await waitFor(() => expect(screen.getByRole('button', { name: /Confirm and start/ })).toBeDisabled())
      expect(screen.getByText(/trace is still setting up this project's agent/)).toBeInTheDocument()
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown)).toContainEqual({ action: 'project.agent', repo: 'acme/board' })
    })
  })
})
