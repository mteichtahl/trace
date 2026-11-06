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
