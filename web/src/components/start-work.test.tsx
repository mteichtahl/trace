/**
 * trace's criterion with nothing working on it (test-esp32 log #161): the Overview never says "trace is working" over
 * nothing. When trace's own start of the work ended without meeting it, the next step says so and its "Start it" calls
 * journey.start_work, in the card as in the mock (dev:mock, sessionStorage trace.mock.owned).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextStepCard } from '@/components/next-step-card'
import { handle } from '@/mock/handlers'
import type { Journey, NextStep } from '@/lib/types'
import { START_WORK, StartWork } from './start-work'

const calls: [string, unknown][] = []
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  call: async (action: string, args: unknown) => { calls.push([action, args]); return { repo: 'acme/x', criterion: 'signoff.coverage', jobId: 'h.job-2', started: ['The Verification agent works on "Every requirement is verified or waived".'] } },
}))
const toasts: string[] = []
vi.mock('sonner', () => ({ toast: Object.assign((t: string) => { toasts.push(t) }, { success: (t: string) => { toasts.push(t) }, error: (t: string) => { toasts.push(`error: ${t}`) } }) }))

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>)
beforeEach(() => { calls.length = 0; toasts.length = 0 })

describe('Start it', () => {
  it('the next step card puts it in place of a link, and it starts the work', async () => {
    const step: NextStep = { kind: 'task', owner: 'you', summary: 'trace is not working on Sign-off: every requirement is verified or waived.', action: { label: START_WORK, call: 'journey.start_work' } }
    wrap(<NextStepCard step={step} callButton={<StartWork repo="acme/x" size="lg" />} />)
    await userEvent.click(screen.getByRole('button', { name: START_WORK }))
    await waitFor(() => expect(calls).toEqual([['journey.start_work', { repo: 'acme/x' }]]))
    expect(toasts).toEqual(['trace started the work'])
  })
})

describe('the mock (dev:mock): the overview\'s owned-work states', () => {
  const call = async <T,>(action: string, args: Record<string, unknown>) => (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()) as { ok: boolean; result: T }
  afterEach(() => sessionStorage.removeItem('trace.mock.owned'))

  it('stopped offers Start it, and starting it says trace started the work', async () => {
    sessionStorage.setItem('trace.mock.owned', 'stopped')
    const j = await call<Journey>('journey.get', { repo: 'acme/soil-sensor' })
    expect(j.result.next).toMatchObject({ kind: 'task', owner: 'you', action: { label: 'Start it', call: 'journey.start_work' } })
    expect(j.result.next.summary).not.toMatch(/trace is working/)
    await call('journey.start_work', { repo: 'acme/soil-sensor' })
    expect((await call<Journey>('journey.get', { repo: 'acme/soil-sensor' })).result.next).toMatchObject({ kind: 'working', summary: expect.stringMatching(/^trace started work on Capture/) })
  })
})
