/**
 * A job that ended without finishing is never a dead end (test-esp32 log #46): its card under "Ended without finishing"
 * and the next step offer Start again (job.control restart) and Dismiss (job.control dismiss, with an optional reason);
 * once settled it leaves the overview; trace's step it was doing reads "stopped", never as if trace were working on it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextStepCard } from '@/components/next-step-card'
import { splitRuns } from '@/components/run-line'
import { stepLabel } from '@/lib/guided'
import { readJob } from '@/lib/readers'
import type { NextStep, RunSummary, StageStep } from '@/lib/types'
import { LostJobActions, START_AGAIN, lostReason, useLostJob } from './lost-job'

const calls: [string, unknown][] = []
let answer: Record<string, unknown> = { ok: true, kept: 'It starts again on claude/task-sch, from what the lost attempt left there.' }
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  call: async (action: string, args: unknown) => { calls.push([action, args]); return answer },
}))
const toasts: string[] = []
vi.mock('sonner', () => ({ toast: Object.assign((t: string) => { toasts.push(t) }, { error: (t: string) => { toasts.push(`error: ${t}`) } }) }))

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>)
const lost: RunSummary = { id: 'h.job-sch', title: 'Draw the schematic', state: 'lost', controls: ['restart', 'dismiss'], startedAt: new Date().toISOString() }

function Actions({ run, size }: { run: RunSummary; size?: 'sm' | 'lg' }) {
  const act = useLostJob('acme/x')
  return <LostJobActions run={run} onAct={act} size={size} />
}

beforeEach(() => { calls.length = 0; toasts.length = 0; answer = { ok: true, kept: 'It starts again on claude/task-sch, from what the lost attempt left there.' } })

describe('a lost job\'s actions', () => {
  it('Start again asks job.control restart and says where it starts', async () => {
    wrap(<Actions run={lost} />)
    await userEvent.click(screen.getByRole('button', { name: START_AGAIN }))
    await waitFor(() => expect(toasts).toEqual(['Started again: Draw the schematic']))
    expect(calls).toEqual([['job.control', { id: 'h.job-sch', op: 'restart', repo: 'acme/x' }]])
  })

  it('Dismiss takes an optional reason, and sends none when none is given', async () => {
    answer = { ok: true, dismissed: true, kept: 'Dismissed.' }
    wrap(<Actions run={lost} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await userEvent.type(screen.getByPlaceholderText('Why it is no longer needed (optional)'), 'Drawn by hand instead')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(toasts).toEqual(['Dismissed: Draw the schematic']))
    expect(calls).toEqual([['job.control', { id: 'h.job-sch', op: 'dismiss', repo: 'acme/x', reason: 'Drawn by hand instead' }]])
    expect(lostReason('  ')).toBeNull()
  })

  it('says why when it is refused, and draws only what the job view offers (nothing for a reviewer)', async () => {
    answer = { ok: false, reason: 'It was started again already: follow the new job.' }
    wrap(<Actions run={lost} />)
    await userEvent.click(screen.getByRole('button', { name: START_AGAIN }))
    await waitFor(() => expect(toasts).toEqual(['error: Could not start draw the schematic again']))
    const { container } = wrap(<Actions run={{ ...lost, controls: [] }} />)
    expect(container).toBeEmptyDOMElement()
    wrap(<Actions run={{ ...lost, id: 'h.wi', controls: ['dismiss'] }} />)
    expect(screen.getAllByRole('button', { name: START_AGAIN })).toHaveLength(1)
  })

  it('is the next step\'s button when the next step is a lost job\'s', () => {
    const step: NextStep = { kind: 'task', owner: 'you', summary: 'The Implementation job "Draw the schematic" ended without finishing.', action: { label: 'Start it again', call: 'job.restart' }, jobId: 'h.job-sch' }
    wrap(<NextStepCard step={step} part="contributor" callButton={<Actions run={lost} size="lg" />} />)
    expect(screen.getByRole('button', { name: START_AGAIN })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })
})

describe('settled and stopped', () => {
  it('a dismissed or restarted lost job leaves "Ended without finishing"', () => {
    const now = Date.now()
    expect(splitRuns([lost], now).ended.map((r) => r.id)).toEqual(['h.job-sch'])
    expect(splitRuns([{ ...lost, settled: { how: 'dismissed', by: 'm@example.com', at: new Date().toISOString() } }], now).ended).toEqual([])
    expect(readJob({ id: 'h.j', workerJobId: 'j', title: 'x', state: 'lost', controls: ['restart', 'dismiss'], settled: { how: 'restarted', by: 'trace', at: '2026-11-05T00:00:00.000Z', reason: null } }))
      .toMatchObject({ state: 'lost', controls: ['restart', 'dismiss'], settled: { how: 'restarted', by: 'trace' } })
  })

  it('trace\'s step now reads "stopped" while the job doing it ended without finishing', () => {
    const steps: StageStep[] = [
      { id: 'a', text: 'Draw the schematic', owner: 'trace', state: 'now', ref: null, stopped: true },
      { id: 'b', text: 'Agree the pin plan', owner: 'you', state: 'next', ref: null },
    ]
    expect(steps.map((_, i) => stepLabel(steps, i))).toEqual(['trace · stopped', 'You · after trace'])
  })
})
