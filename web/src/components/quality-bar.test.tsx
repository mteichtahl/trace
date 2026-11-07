import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { QualityBar } from './quality-bar'
import { contextStore } from '@/components/chat/context'
import { SKILLS } from '@/components/skills/definitions'

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

describe('the quality bar in trace\'s assistant\'s context (test-esp32 #53)', () => {
  it('gives the assistant each check in the words on screen, with its status, while the bar is shown', () => {
    wide(true)
    const bar = [
      { id: 'match', text: SKILLS.find((s) => s.id === 'pin-plan-review')!.checks.find((c) => c.id === 'match')!.text, status: 'met' as const },
      { id: 'boot', text: 'Boot, reset and debug pins keep their roles', status: 'not_met' as const },
    ]
    const { unmount } = render(<TooltipProvider><QualityBar checks={bar} onSubmit={() => {}} /></TooltipProvider>)
    const entry = contextStore.get().entries.find((e) => e.id === 'quality-bar')
    expect(entry).toMatchObject({ label: 'Quality bar · 1 of 2 met', value: { checks: [{ text: 'The schematic matches the pin plan', status: 'met' }, { text: 'Boot, reset and debug pins keep their roles', status: 'not_met' }] } })
    unmount()
    expect(contextStore.get().entries.some((e) => e.id === 'quality-bar')).toBe(false)
  })

  it('names what the pin plan check compares: the schematic, not firmware the project may not have', () => {
    const pins = SKILLS.find((s) => s.id === 'pin-plan-review')!
    expect(pins.checks.map((c) => c.text).join(' ')).not.toMatch(/firmware/i)
  })
})

// #239: a long check (the checker's reason after it) ran on one line under Submit and "2 checks left", so the end of
// the sentence was hidden. Every item wraps within the bar
describe('a long check on a wide screen', () => {
  it('wraps within the bar instead of running on under Submit', () => {
    wide(true)
    const text = 'Boot, reset and debug pins keep their roles (GPIO12 is a boot strap: pulled high at reset it sets the flash voltage to 1.8 V, and the off-board pins are not in the connector order)'
    render(<TooltipProvider><QualityBar checks={[...checks, { id: 'boot', text, status: 'not_met' }]} onSubmit={() => {}} /></TooltipProvider>)
    const item = screen.getByRole('button', { name: /GPIO12 is a boot strap/ })
    expect(item.className).not.toMatch(/whitespace-nowrap/)
    expect(item.className).toMatch(/max-w-full/)
    expect(item).toHaveTextContent(text)
  })
})
