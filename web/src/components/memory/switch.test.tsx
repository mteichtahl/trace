import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SwitchOffForm } from './switch'

describe('SwitchOffForm', () => {
  it('keeps Switch off disabled until a reason is given, then sends it', async () => {
    const onSubmit = vi.fn(async () => undefined)
    render(<SwitchOffForm onSubmit={onSubmit} />)
    const button = screen.getByRole('button', { name: /Switch off/ })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Why should the agents stop using this/), 'datasheet minimum is 2.2 µF')
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onSubmit).toHaveBeenCalledWith('datasheet minimum is 2.2 µF')
  })

  it('words the question for several memories', () => {
    render(<SwitchOffForm count={3} onSubmit={async () => undefined} />)
    expect(screen.getByLabelText(/stop using these 3/)).toBeInTheDocument()
  })
})
