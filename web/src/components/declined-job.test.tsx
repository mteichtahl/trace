/**
 * A task its specialist declined as another's work is not shown done (test log R26: "succeeded: impl: done in 2 turns:
 * I didn't change REQ-7ec888…" and nothing else happened): its line says it was declined and for whom, and Send it to
 * <specialist> asks job.control send. Only when its view offers it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunLine, splitRuns } from '@/components/run-line'
import { readJob } from '@/lib/readers'
import { sendWords } from './declined-job'

const calls: [string, unknown][] = []
let answer: Record<string, unknown> = { ok: true, kept: 'The Verification specialist takes it on a new branch.' }
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  call: async (action: string, args: unknown) => { calls.push([action, args]); return answer },
}))
const toasts: string[] = []
vi.mock('sonner', () => ({ toast: Object.assign((t: string) => { toasts.push(t) }, { error: (t: string) => { toasts.push(`error: ${t}`) } }) }))

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>)
// the API's job view (src/api/actions-jobs.ts), as jobs.list answers it
const view = (over: Record<string, unknown> = {}) => readJob({
  id: 'h.job-r26', workerJobId: 'job-r26', kind: 'task', repository: 'acme/x', title: 'Change the criterion', state: 'succeeded', agent: 'impl', agentName: 'Implementation',
  step: 'Declined: the Implementation specialist changed nothing; it says this is the Verification specialist\'s work.',
  declined: { from: 'impl', to: 'verify', toName: 'Verification', why: 'I didn\'t change REQ-7ec888.', sent: null }, controls: ['send'], ...over,
})

beforeEach(() => { calls.length = 0; toasts.length = 0; answer = { ok: true, kept: 'The Verification specialist takes it on a new branch.' } })

describe('a declined job\'s line', () => {
  it('says it was declined and for whom, and Send it to Verification asks job.control send', async () => {
    wrap(<RunLine run={view()} />)
    expect(screen.getByText(/Declined: the Implementation specialist changed nothing/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: sendWords('Verification') }))
    await waitFor(() => expect(toasts).toEqual(['Sent to the Verification specialist: Change the criterion']))
    expect(calls).toEqual([['job.control', { id: 'h.job-r26', op: 'send', repo: 'acme/x' }]])
  })

  it('says why when it is refused, and draws no button once sent or for a reviewer', async () => {
    answer = { ok: false, reason: 'd-user sent it to the Verification specialist already: follow the new job.' }
    const { unmount } = wrap(<RunLine run={view()} />)
    await userEvent.click(screen.getByRole('button', { name: sendWords('Verification') }))
    await waitFor(() => expect(toasts).toEqual(['error: Could not send change the criterion to the Verification specialist']))
    unmount()
    wrap(<RunLine run={view({ controls: [], declined: { from: 'impl', to: 'verify', toName: 'Verification', why: 'x', sent: { by: 'd-user', at: '2026-11-07T10:00:00Z' } } })} />)
    expect(screen.queryByRole('button', { name: sendWords('Verification') })).toBeNull()
    expect(view().declined).toEqual({ from: 'impl', to: 'verify', toName: 'Verification', why: 'I didn\'t change REQ-7ec888.' })
  })

  it('stays on the overview under Ended without finishing until it is sent on, for a day', () => {
    const now = Date.now()
    const ended = { endedAt: new Date(now - 60_000).toISOString() }
    expect(splitRuns([view(ended)], now).ended.map((r) => r.id)).toEqual(['h.job-r26'])
    expect(splitRuns([view({ ...ended, declined: { from: 'impl', to: 'verify', toName: 'Verification', why: 'x', sent: { by: 'you', at: '' } } })], now).ended).toEqual([])
    expect(splitRuns([view({ endedAt: new Date(now - 25 * 3600_000).toISOString() })], now).ended).toEqual([])
    expect(splitRuns([view({ ...ended, declined: null })], now)).toEqual({ doing: [], ended: [] })
  })
})
