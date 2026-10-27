import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type Decision, DecisionCard, canSubmit } from './decision-card'

const decision: Decision = {
  question: 'C2 on the regulator output',
  recommended: 'c22',
  options: [
    { id: 'waive', label: 'Waive and test stability on the bench' },
    { id: 'c22', label: 'Change C2 to 2.2 µF', detail: '(0603, X5R, 10 V, LCSC C23630, in stock)' },
  ],
  why: 'The regulator asks for at least 2.2 µF.',
  evidence: [{ kind: 'datasheet', label: 'TLV755 datasheet p.12' }],
  givesUp: 'About US$0.002 more per board.',
}

describe('DecisionCard', () => {
  it('puts the recommendation first and marked', () => {
    render(<DecisionCard decision={decision} onChoose={() => undefined} />)
    expect(screen.getByText('trace recommends')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button')
    expect(buttons.find((b) => b.textContent === 'Change C2 to 2.2 µF')).toBeTruthy()
    expect(screen.getByText('What it gives up')).toBeInTheDocument()
    expect(screen.getByText('TLV755 datasheet p.12')).toBeInTheDocument()
  })

  it('sends the recommendation without a reason', async () => {
    const onChoose = vi.fn()
    render(<DecisionCard decision={decision} onChoose={onChoose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Change C2 to 2.2 µF' }))
    expect(onChoose).toHaveBeenCalledWith({ option: 'c22', recommended: true })
  })

  it('requires "Your reason" when not the recommendation', async () => {
    const onChoose = vi.fn()
    render(<DecisionCard decision={decision} onChoose={onChoose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose another' }))
    await userEvent.click(screen.getByRole('radio'))
    const send = screen.getByRole('button', { name: /^Choose Waive/ })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Your reason'), 'The bench run catches it')
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(onChoose).toHaveBeenCalledWith({ option: 'waive', recommended: false, reason: 'The bench run catches it' })
  })

  it('canSubmit: the rule on its own', () => {
    expect(canSubmit(decision, null, '')).toBe(false)
    expect(canSubmit(decision, 'c22', '')).toBe(true)
    expect(canSubmit(decision, 'waive', '  ')).toBe(false)
    expect(canSubmit(decision, 'waive', 'cheaper')).toBe(true)
  })
})
