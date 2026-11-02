/**
 * The recovery when drafting the requirements from the submitted intent stopped (test-2: the job was lost, and the
 * Requirements page offered only "Open the Intent builder"): the page and the next step offer "Draft the requirements
 * again", which calls requirements.draft and says it started; while trace drafts them the page shows the running job.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextStepCard } from '@/components/next-step-card'
import type { NextStep, RunSummary } from '@/lib/types'
import { NoRequirements } from '@/routes/_app/p/$id/requirements'
import { DRAFT_AGAIN, DraftAgain } from './draft-again'

const calls: [string, unknown][] = []
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  call: async (action: string, args: unknown) => { calls.push([action, args]); return { repo: 'acme/x', jobId: 'h.job-2', attempt: 2, started: ['The Verification agent drafts the candidate requirements again, from your submitted intent.'] } },
}))
const toasts: string[] = []
vi.mock('sonner', () => ({ toast: Object.assign((t: string) => { toasts.push(t) }, { error: (t: string) => { toasts.push(`error: ${t}`) } }) }))

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>)

beforeEach(() => { calls.length = 0; toasts.length = 0 })

describe('drafting the requirements again', () => {
  it('the Requirements page says why nothing is drafting them and offers to start again', async () => {
    wrap(<NoRequirements id="acme~x" repo="acme/x" drafting={{ state: 'stopped', jobId: 'h.job-1', jobState: 'lost', why: 'The Verification specialist stopped answering, so it is lost.' }} jobs={[]} write />)
    expect(screen.getByText(/The Verification specialist stopped answering, so it is lost\. Your intent is submitted/)).toBeInTheDocument()
    expect(screen.queryByText(/Open the Intent builder/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: DRAFT_AGAIN }))
    await waitFor(() => expect(toasts).toEqual(['Drafting the requirements again']))
    expect(calls).toEqual([['requirements.draft', { repo: 'acme/x' }]])
  })

  it('a reviewer is told, and not offered the button', () => {
    wrap(<NoRequirements id="acme~x" repo="acme/x" drafting={{ state: 'stopped', why: 'It is lost.' }} jobs={[]} write={false} />)
    expect(screen.queryByRole('button', { name: DRAFT_AGAIN })).toBeNull()
  })

  it('while trace drafts them, the page shows the running job, not the Intent builder', () => {
    const run: RunSummary = { id: 'h.job-2', title: 'The intent was submitted in the Intent builder.', state: 'running', startedAt: new Date().toISOString() }
    wrap(<NoRequirements id="acme~x" repo="acme/x" drafting={{ state: 'drafting', jobId: 'h.job-2', jobState: 'running' }} jobs={[run]} write />)
    expect(screen.getByText(/trace is drafting them from your intent/)).toBeInTheDocument()
    expect(screen.getByText(run.title)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: DRAFT_AGAIN })).toBeNull()
  })

  it('the next step card puts the call button in place of a link', async () => {
    const step: NextStep = { kind: 'task', owner: 'you', summary: 'It is lost. Draft the requirements again to start it once more.', action: { label: DRAFT_AGAIN, call: 'requirements.draft' } }
    wrap(<NextStepCard step={step} callButton={<DraftAgain repo="acme/x" size="lg" />} />)
    await userEvent.click(screen.getByRole('button', { name: DRAFT_AGAIN }))
    await waitFor(() => expect(calls).toEqual([['requirements.draft', { repo: 'acme/x' }]]))
  })
})
