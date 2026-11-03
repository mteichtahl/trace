import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { ChangeDetail, CheckJob } from '@/lib/types'
import { ChangeChecks, checksWithoutJob, jobsWords } from './change-checks'

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const job = (o: Partial<CheckJob>): CheckJob => ({
  id: 1, run: 'check:1', name: 'Board checks', workflow: 'trace checks', state: 'running', startedAt: ago(175), completedAt: null,
  steps: [], step: "Checking the routed board against JLCPCB's design rules", stepIndex: 4, stepCount: 9, typicalS: 360, queuedS: null,
  heardAt: ago(2), newest: 'drc: 1,204 of 2,480 items checked', usualQuietS: 60, runner: 'aws', ...o,
})
const d = {
  checks: { total: 5, passed: 1, failed: 0, running: 2, skipped: 0, failing: [] },
  checks_list: [
    { name: 'Board checks', state: 'running', summary: null },
    { name: 'Schematic checks', state: 'passed', summary: null },
    { name: 'Datasheet limits', state: 'passed', summary: '0 conflicts' },
  ],
} as unknown as ChangeDetail

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>)

describe('a change\'s checks say which step they are on', () => {
  const jobs = [
    job({}),
    job({ id: 2, run: 'check:2', name: 'Simulation', state: 'queued', startedAt: null, step: null, stepIndex: null, stepCount: 0, queuedS: 40, heardAt: null, newest: null }),
    job({ id: 3, run: 'check:3', name: 'Schematic checks', state: 'passed', startedAt: ago(400), completedAt: ago(352), step: null, stepIndex: null }),
  ]

  it('says what runs, waits and passed', () => {
    expect(jobsWords(jobs)).toBe('1 running · 1 waiting for a build machine · 1 passed')
    expect(checksWithoutJob(d.checks_list, jobs).map((k) => k.name)).toEqual(['Datasheet limits'])
  })

  it('a running check: its step, its time against the usual, its newest line and Watch', () => {
    wrap(<ChangeChecks d={d} jobs={jobs} repo="acme/soil-sensor" />)
    expect(screen.getByText('Step 4 of 9')).toBeInTheDocument()
    expect(screen.getByText("Checking the routed board against JLCPCB's design rules")).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Board checks progress' })).toHaveAttribute('aria-valuenow', '33')
    expect(screen.getByText('3 min so far, usually 6 min')).toBeInTheDocument()
    expect(screen.getByText(/Newest line 2 s ago/)).toBeInTheDocument()
    expect(screen.getByText('· drc: 1,204 of 2,480 items checked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Watch Board checks' })).toBeInTheDocument()
  })

  it('one waiting for a machine says so; a finished one keeps its log one tap away; a check with no job keeps its line', () => {
    wrap(<ChangeChecks d={d} jobs={jobs} repo="acme/soil-sensor" />)
    expect(screen.getByText(/Usually under a minute; waiting 40 s\./)).toBeInTheDocument()
    const done = screen.getByText('Schematic checks').closest('li')!
    expect(within(done).getByText(/passed in 48 s/)).toBeInTheDocument()
    expect(within(done).getByRole('button', { name: 'Log of Schematic checks' })).toBeInTheDocument()
    expect(screen.getByText('Datasheet limits')).toBeInTheDocument()
  })

  it('with no jobs, the check lines as before', () => {
    wrap(<ChangeChecks d={d} jobs={[]} repo="acme/soil-sensor" />)
    expect(screen.getByText(/Checks running, 1 of 5 done/)).toBeInTheDocument()
    expect(screen.getByText('Board checks')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Watch/ })).toBeNull()
  })
})
