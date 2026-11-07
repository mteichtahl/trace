import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QualityBar } from './quality-bar'

const wide = (on: boolean) => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
    ({ matches: on, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as MediaQueryList)
}

afterEach(() => { vi.restoreAllMocks() })

const checks = [{ id: 'a', text: 'The answer resolves what it blocks', status: 'met' as const }]

describe('the quality bar: one Submit in the page (#198)', () => {
  for (const on of [true, false]) {
    it(`${on ? 'on a wide screen' : 'on a phone'}: one button, and pressing it submits`, () => {
      wide(on)
      const onSubmit = vi.fn()
      render(<TooltipProvider><QualityBar checks={checks} onSubmit={onSubmit} submitLabel="Send the answer" /></TooltipProvider>)
      // the hidden copy for the other width is not in the page at all
      const buttons = screen.getAllByRole('button', { name: 'Send the answer', hidden: true })
      expect(buttons).toHaveLength(1)
      fireEvent.click(buttons[0]!)
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })
  }
})

// #227: Order submit's "order recorded" showed "Waived" before the order gate was signed. It is not a risk accepted,
// just not asked for yet: it says so, and holds Submit back no more than a waiver
describe('a check not due yet', () => {
  it('is said as not due, not as waived, and does not hold Submit', () => {
    wide(true)
    const onSubmit = vi.fn()
    render(<TooltipProvider><QualityBar checks={[...checks, { id: 'recorded', text: 'Order number, cost and ship date recorded', status: 'not_due' }]} onSubmit={onSubmit} submitLabel="Submit" /></TooltipProvider>)
    expect(screen.getByRole('button', { name: /Order number, cost and ship date recorded/ })).toHaveTextContent('Not due yet: Order number')
    expect(screen.queryByText(/Waived:/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('the count', () => {
  it('leaves a check not due yet out of "n of m met"', () => {
    wide(true)
    render(<TooltipProvider><QualityBar checks={[...checks, { id: 'b', text: 'Two', status: 'not_met' }, { id: 'c', text: 'Later', status: 'not_due' }]} onSubmit={() => {}} /></TooltipProvider>)
    expect(screen.getByText('1 of 2 met')).toBeInTheDocument()
  })
})
