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
  it('marks an option that records a waiver, before and after it is chosen', () => {
    const d: Decision = { ...decision, options: [decision.options[0]!, { ...decision.options[1]!, waiver: 'Records a waiver in your name: 1 finding, rated cosmetic, this revision only. Risk: Ringing.' }] }
    const { rerender } = render(<DecisionCard decision={d} onChoose={() => undefined} />)
    expect(screen.getByText('Records a waiver')).toBeInTheDocument()
    expect(screen.getByText(/In your name: 1 finding, rated cosmetic/)).toBeInTheDocument()
    rerender(<DecisionCard decision={d} onChoose={() => undefined} chosen={{ option: 'c22', recommended: true }} />)
    expect(screen.getByText('Records a waiver')).toBeInTheDocument()
  })

  it('puts the recommendation first and marked', () => {
    render(<DecisionCard decision={decision} onChoose={() => undefined} />)
    expect(screen.getByText('trace recommends')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button')
    expect(buttons.find((b) => b.textContent === 'Change C2 to 2.2 µF')).toBeTruthy()
    expect(screen.getByText('What it gives up')).toBeInTheDocument()
    expect(screen.getByText('TLV755 datasheet p.12')).toBeInTheDocument()
  })

  it('asks for the detail a recommended answer needs before sending it (test-esp32 log #137)', async () => {
    const onChoose = vi.fn()
    const module: Decision = {
      question: 'Which OLED module should the case be shaped around?', recommended: 'm',
      options: [{ id: 'm', label: 'A 0.96 inch SSD1306 I2C module', needs: "the module's part number, or a link to its dimensioned drawing" }, { id: 'bare', label: 'A bare panel' }],
    }
    render(<DecisionCard decision={module} onChoose={onChoose} />)
    const send = screen.getByRole('button', { name: 'A 0.96 inch SSD1306 I2C module' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText("The module's part number, or a link to its dimensioned drawing"), 'ER-OLEDM0.96-1')
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(onChoose).toHaveBeenCalledWith({ option: 'm', recommended: true, answer: 'ER-OLEDM0.96-1' })
    expect(canSubmit(module, 'm', '', '')).toBe(false)
    expect(canSubmit(module, 'bare', 'a reason', '')).toBe(true)
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
