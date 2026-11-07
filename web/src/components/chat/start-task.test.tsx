import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { keys } from '@/lib/queries'
import { toast } from 'sonner'
import { ChatRepo, LiveCall, StartTaskCard } from './renderers'
import { resetTaskConfirms } from './task-confirm'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() }) }))

afterEach(() => { vi.restoreAllMocks(); vi.mocked(toast).mockClear(); vi.mocked(toast.error).mockClear(); qc.clear(); resetTaskConfirms() })
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
    // (a look an earlier card began and the test's end cancelled may still reach fetch, aborted: it asks nothing)
    expect(fetch.mock.calls.filter(([, i]) => !(i as RequestInit).signal?.aborted)).toEqual([])
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

    // nothing waits on a disabled button: the work is queued until the agent is there (test-esp32 log #2, #80)
    it('the conversation\'s own project: Confirm goes ahead and says the work is queued, from what the screen\'s notice knows', () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      qc.setQueryData(keys.action('project.agent', { repo: 'acme/board' }), settingUp('acme/board'))
      render(<ChatRepo.Provider value="acme/board"><StartTaskCard args={args} status="executing" respond={vi.fn()} /></ChatRepo.Provider>, { wrapper })
      expect(screen.getByRole('button', { name: /Confirm and start/ })).toBeEnabled()
      expect(screen.getByText(/the work is queued, and starts by itself once the agent is ready/)).toBeInTheDocument()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('a conversation on no project: asks for the named project\'s agent, and says its work is queued', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(settingUp('acme/board')))
      render(<StartTaskCard args={args} status="executing" respond={vi.fn()} />, { wrapper })
      await waitFor(() => expect(screen.getByText(/trace is still setting up this project's agent: the work is queued/)).toBeInTheDocument())
      expect(screen.getByRole('button', { name: /Confirm and start/ })).toBeEnabled()
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown)).toContainEqual({ action: 'project.agent', repo: 'acme/board' })
    })
  })

  describe('locked to the conversation\'s project', () => {
    it('another project than the conversation\'s is refused on the card: no Confirm, nothing started or asked, Dismiss tells trace why', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      const respond = vi.fn()
      render(<ChatRepo.Provider value="acme/other"><StartTaskCard args={args} status="executing" respond={respond} /></ChatRepo.Provider>, { wrapper })
      expect(screen.getByRole('alert')).toHaveTextContent('trace named acme/board, but this conversation is on acme/other: nothing can be started on another project from here.')
      expect(screen.queryByRole('button', { name: /Confirm and start/ })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      expect(respond).toHaveBeenCalledWith({ confirmed: false, reason: expect.stringMatching(/^trace named acme\/board/) as unknown as string })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('starts the work on the conversation\'s project, whatever spelling trace gave it', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { accepted: true, jobId: 'j1' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      render(<ChatRepo.Provider value="acme/board"><StartTaskCard args={{ ...args, repo: 'Acme/Board' }} status="executing" respond={vi.fn()} /></ChatRepo.Provider>, { wrapper })
      await userEvent.click(screen.getByRole('button', { name: /Confirm and start/ }))
      await waitFor(() => expect(fetch).toHaveBeenCalled())
      const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { action: string; repo: string })
      expect(bodies.find((b) => b.action === 'task')?.repo).toBe('acme/board')
    })
  })

  describe('the confirm does not depend on the card staying on screen (test log R25)', () => {
    const answer = (body: unknown) => new Response(JSON.stringify({ ok: true, result: body }), { status: 200, headers: { 'content-type': 'application/json' } })

    it('a card that unmounts while its Confirm is on its way still starts the job, says so, and shows it when drawn again', async () => {
      let release: (r: Response) => void = () => undefined
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
        const b = JSON.parse(String((init as RequestInit).body)) as { action: string }
        if (b.action === 'task') return new Promise<Response>((r) => { release = r })
        return answer({ repo: 'acme/board', jobs: [{ id: 'acme--board--j7', repo: 'acme/board', title: 'Run ERC on the power sheet', state: 'running' }], agents: [], handoffs: [], batch: [], updatedAt: '' })
      })
      const respond = vi.fn()
      const { unmount } = render(<ChatRepo.Provider value="acme/board"><StartTaskCard args={args} status="executing" respond={respond} toolCallId="tc1" /></ChatRepo.Provider>, { wrapper })
      await userEvent.click(screen.getByRole('button', { name: /Confirm and start/ }))
      // the person opens another step: the card goes, the call is on its way
      unmount()
      release(answer({ accepted: true, jobId: 'acme--board--j7' }))
      await waitFor(() => expect(toast).toHaveBeenCalledWith('trace started the work.', expect.anything()))
      expect(fetch.mock.calls.filter(([, i]) => String((i as RequestInit).body).includes('"action":"task"'))).toHaveLength(1)
      // trace is still answered, when the conversation can take it
      expect(respond).toHaveBeenCalledWith({ confirmed: true, accepted: true, jobId: 'acme--board--j7' })
      // drawn again (back on the step, or the kept conversation reloaded, with no result in it): the job, not the offer
      render(<ChatRepo.Provider value="acme/board"><LiveCall.Provider value={false}><StartTaskCard args={args} status="inProgress" toolCallId="tc1" /></LiveCall.Provider></ChatRepo.Provider>, { wrapper })
      expect(screen.queryByRole('button', { name: /Confirm and start/ })).toBeNull()
      expect(screen.queryByText(/the conversation went on without it being confirmed/)).toBeNull()
      expect(await screen.findByText('Run ERC on the power sheet')).toBeInTheDocument()
    })

    it('a failure is never silent: the card and a toast say why, and a second click starts nothing more', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: 'the project is paused' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      render(<ChatRepo.Provider value="acme/board"><StartTaskCard args={args} status="executing" respond={vi.fn()} toolCallId="tc2" /></ChatRepo.Provider>, { wrapper })
      await userEvent.click(screen.getByRole('button', { name: /Confirm and start/ }))
      expect(await screen.findByText('Not started: the project is paused.')).toBeInTheDocument()
      expect(toast.error).toHaveBeenCalledWith('trace could not start the work.', { description: 'the project is paused' })
      expect(screen.queryByRole('button', { name: /Confirm and start/ })).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('the job the list does not know yet is asked for itself: one that failed at once says so, not queued for ever', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
        const b = JSON.parse(String((init as RequestInit).body)) as { action: string }
        if (b.action === 'jobs.list') return answer({ repo: 'acme/board', jobs: [], agents: [], handoffs: [], batch: [], updatedAt: '' })
        return answer({ id: 'j9', kind: 'task', state: 'failed', error: 'the agent could not clone the repository' })
      })
      render(<StartTaskCard args={args} status="complete" result={JSON.stringify({ confirmed: true, accepted: true, jobId: 'j9' })} />, { wrapper })
      expect(await screen.findByText(/the agent could not clone the repository/)).toBeInTheDocument()
    })
  })
})

