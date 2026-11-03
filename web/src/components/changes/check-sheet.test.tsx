/**
 * A change's checks on a phone: the one line's words, failing first in the list, and a check opened in its sheet
 * (the result first, findings, the log tab, previous and next) from the mock change.check.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ChangeCheck } from '@/lib/types'
import { CheckSheet, checksLine, checksState, order } from './check-sheet'

// the mock handlers import the api module themselves: load them when a call is made, not while it is mocked
vi.mock('@/lib/api', async (orig) => {
  return {
    ...(await orig<typeof import('@/lib/api')>()),
    call: vi.fn(async (action: string, args: Record<string, unknown>) => {
      const { handle } = await import('@/mock/handlers')
      const env = (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()) as { ok: boolean; result: unknown; error?: string }
      if (!env.ok) throw new Error(env.error)
      return env.result
    }),
  }
})

const k = (state: ChangeCheck['state'], name: string = state): ChangeCheck => ({ name, state, summary: null, id: null })

describe('the checks in one line', () => {
  it('says how they went in plain words', () => {
    expect(checksLine(Array.from({ length: 7 }, () => k('passed')))).toBe('7 of 7 checks passed')
    expect(checksLine([k('passed'), k('failed'), k('passed')])).toBe('1 failing')
    expect(checksLine([k('passed'), k('running'), k('running'), k('running')])).toBe('3 still running')
    expect(checksLine([k('failed'), k('running'), k('running')])).toBe('1 failing, 2 still running')
    expect(checksLine([k('passed'), k('skipped')])).toBe('1 of 1 check passed, 1 skipped')
    expect(checksLine([], { total: 0, passed: 0, failed: 0, running: 0, skipped: 0, failing: [] })).toBe('No checks yet')
    expect(checksLine([], null)).toBe('trace could not read the checks')
    expect(checksLine([], { total: 4, passed: 4, failed: 0, running: 0, skipped: 0, failing: [] })).toBe('4 of 4 checks passed')
  })

  it('shows the worst state, and lists failing first', () => {
    expect(checksState([k('passed'), k('running'), k('failed')])).toBe('failed')
    expect(checksState([k('passed'), k('running')])).toBe('running')
    expect(checksState([])).toBeNull()
    expect(order([k('passed', 'a'), k('running', 'b'), k('failed', 'c'), k('passed', 'd')])).toEqual([2, 1, 0, 3])
  })
})

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('a check, opened', () => {
  const checks: ChangeCheck[] = [
    { name: 'Electrical rules check', state: 'passed', summary: 'No errors', id: 'job:9201' },
    { name: 'Enclosure clearance', state: 'failed', summary: 'J3 is 0.6 mm from the wall; 1 mm needed', id: 'job:9207' },
    { name: 'A status', state: 'passed', summary: 'ok', id: null },
  ]

  it('shows the result first, its findings, the log, and walks to the next check', async () => {
    const onIndex = vi.fn()
    wrap(<CheckSheet repo="acme/soil-sensor" number={13} checks={checks} index={1} onIndex={onIndex} />)
    expect(screen.getByRole('dialog', { name: /Enclosure clearance/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Failed. J3 is 0.6 mm from the wall')
    await waitFor(() => expect(screen.getByText('J3 too close to the wall')).toBeInTheDocument())
    expect(screen.getByText(/What it found \(2\)/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Log' }))
    expect(await screen.findByText(/Process completed with exit code 1/)).toBeInTheDocument()
    // failing comes first: this is check 1 of 3, so Previous is off
    expect(screen.getByText('Check 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Previous check/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /Next check/ }))
    expect(onIndex).toHaveBeenCalledWith(0)
  })

  it('a status with nothing more to open says so', () => {
    wrap(<CheckSheet repo="acme/soil-sensor" number={13} checks={checks} index={2} onIndex={() => {}} />)
    expect(screen.getByText(/only reports a result/)).toBeInTheDocument()
  })
})
