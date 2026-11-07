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
