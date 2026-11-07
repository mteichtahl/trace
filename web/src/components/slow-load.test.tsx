import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLOW_LOAD_MS, SlowLoad, slowLoadWords } from './states'
import { ApiError } from '@/lib/api'
import { UPDATING } from '@/lib/http'

describe('a slow first load says so (test-esp32 #171: the Overview on grey placeholders 15 s and more after a deploy)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('says nothing while the load is quick, then what is happening, with Try again', () => {
    const retry = vi.fn()
    render(<SlowLoad loading what="this project" onRetry={retry} />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { vi.advanceTimersByTime(SLOW_LOAD_MS) })
    expect(screen.getByRole('status').textContent).toMatch(/This project is taking longer than usual to load\./)
    act(() => { screen.getByRole('button', { name: /Try again/ }).click() })
    expect(retry).toHaveBeenCalledOnce()
  })

  it('says trace is updating at once when a try failed for that and another is on its way', () => {
    render(<SlowLoad loading failureReason={new ApiError(UPDATING, 424, 'updating')} what="this project" />)
    expect(screen.getByRole('status').textContent).toMatch(/trace is updating, so this project is taking a moment to load\. It tries again by itself\./)
  })

  it('is gone once the load has finished', () => {
    const { rerender } = render(<SlowLoad loading failureReason={new Error('boom')} what="this project" />)
    expect(screen.getByRole('status')).toBeTruthy()
    rerender(<SlowLoad loading={false} failureReason={new Error('boom')} what="this project" />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('words for each case', () => {
    expect(slowLoadWords('this project', new Error('500'))).toBe('This project did not load on the first try. trace is trying again.')
    expect(slowLoadWords('this project', null)).toBe('This project is taking longer than usual to load. trace is still waiting for an answer.')
  })
})
