import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { QualityCheck } from '@/components/quality-bar'
import { FocusLayout, type FocusStep, railStates } from './focus-layout'

const steps: FocusStep[] = [
  { id: 'stock', title: 'Check stock', state: 'done' },
  { id: 'options', title: 'Check options', state: 'done' },
  { id: 'matching', title: 'Match lines', state: 'current' },
  { id: 'pay', title: 'Pay', state: 'todo' },
]
const checks: QualityCheck[] = [
  { id: 'stock', text: 'Stock re-checked today', status: 'met', step: 'stock' },
  { id: 'options', text: 'Every option matches the order sheet', status: 'not_met', step: 'options' },
  { id: 'reasons', text: 'Every choice against the recommendation has a reason', status: 'met' },
]

function draw(o: { anyStep?: boolean; onStep?: (id: string) => void } = {}) {
  return render(
    <TooltipProvider>
      <FocusLayout title="Order submit" steps={steps} checks={checks} onSubmit={() => {}} onClose={() => {}} onStep={o.onStep ?? (() => {})} anyStep={o.anyStep}>
        <p>work</p>
      </FocusLayout>
    </TooltipProvider>,
  )
}

// #232: Order submit's rail said "Done" for every step passed with Continue, while its checks were still Not met
describe('a step passed with a check still not met', () => {
  it('is Visited, not Done; one whose checks are met is Done', () => {
    expect(railStates(steps, checks)).toEqual(['done', 'visited', 'current', 'todo'])
  })
  it('says Visited on the rail', () => {
    draw()
    const rail = screen.getByRole('navigation', { name: 'Steps' })
    expect(within(rail).getByRole('button', { name: /Check options/ })).toHaveTextContent('Visited, a check still not met: Check optionsVisited')
    expect(within(rail).getByRole('button', { name: /Check stock/ })).toHaveTextContent('Done: Check stock')
  })
})

// #30: Requirements review's rail steps could not be clicked (Decide did nothing): only Continue moved on
describe('the rail', () => {
  it('opens a later step with a click where the screen allows any step', () => {
    const onStep = vi.fn()
    draw({ anyStep: true, onStep })
    const pay = within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: /Pay/ })
    expect(pay).toBeEnabled()
    fireEvent.click(pay)
    expect(onStep).toHaveBeenCalledWith('pay')
  })
  it('keeps later steps shut where it does not (a checklist on the bench, the new project form)', () => {
    draw()
    expect(within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: /Pay/ })).toBeDisabled()
  })
})

// R16: the Intent builder let the whole document scroll (4562 px in an 873 px window): screen-reader text, absolutely
// positioned inside a panel's scroller with no positioned ancestor, grew the page, and the header scrolled away
describe('the Focus shell', () => {
  it('is the viewport, clips what is inside it, and each scroller is positioned', () => {
    const { container } = render(
      <TooltipProvider>
        <FocusLayout title="Intent builder" variant="conversational" centre="fill" steps={steps} checks={checks} onSubmit={() => {}} onClose={() => {}} aside={<p>draft</p>}>
          <p>chat</p>
        </FocusLayout>
      </TooltipProvider>,
    )
    const shell = container.querySelector('[data-focus-shell]')!
    expect(shell).toHaveClass('h-dvh', 'overflow-clip', 'relative')
    // every scroller or clipped panel in it is the containing block of what is absolute inside it
    const panels = Array.from(shell.querySelectorAll('.overflow-y-auto, .overflow-clip'))
    expect(panels.length).toBeGreaterThanOrEqual(3)
    for (const el of panels) expect(el).toHaveClass('relative')
    expect(screen.getByText('chat').parentElement).toHaveClass('min-h-0', 'overflow-clip')
  })
})

// R24: a click on the rail kept the centre pane's scroll, so the new step's heading was far above the view
describe('a new step', () => {
  it('opens with the centre pane at the top; the same step keeps its place', () => {
    const at = (current: string) => steps.map((s) => ({ ...s, state: s.id === current ? 'current' as const : s.state === 'current' ? 'done' as const : s.state }))
    const shell = (current: string, words = 'work') => (
      <TooltipProvider>
        <FocusLayout title="Requirements review" steps={at(current)} checks={checks} onSubmit={() => {}} onClose={() => {}} onStep={() => {}} anyStep>
          <p>{words}</p>
        </FocusLayout>
      </TooltipProvider>
    )
    const { container, rerender } = render(shell('matching'))
    const pane = container.querySelector<HTMLElement>('[data-focus-centre]')!
    pane.scrollTop = 900
    rerender(shell('matching', 'more work'))
    expect(pane.scrollTop).toBe(900)
    rerender(shell('pay'))
    expect(pane.scrollTop).toBe(0)
  })
})
