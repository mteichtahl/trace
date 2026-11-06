import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SKILLS } from './definitions'
import { Unavailable } from './parts'

const def = SKILLS.find((s) => s.id === 'schematic-finish')!

describe('checks no tool can make yet', () => {
  it('asks the person to confirm the confirmable ones, and lists the rest as waiting', async () => {
    let data: { confirmed?: Record<string, boolean> } = {}
    const draft = { data, setData: (fn: (d: typeof data) => typeof data) => { data = fn(data) } }
    render(<Unavailable def={def} draft={draft} checks={[
      { id: 'notes', unavailable: "trace's draft notes", confirmable: true },
      { id: 'serves', unavailable: 'the list of schematic files' },
    ]} />)
    expect(screen.getByText(/One check of the bar cannot be checked from the record yet/)).toBeInTheDocument()
    expect(screen.getByText('Every sheet names its requirements')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /I checked it: no draft notes open/ }))
    expect(data.confirmed).toEqual({ notes: true })
  })
})

describe('on a step', () => {
  it('shows only the boxes of that step and of no step', () => {
    const rr = SKILLS.find((s) => s.id === 'release-review')!
    const checks = [{ id: 'single', unavailable: 'sellers and lifecycle', confirmable: true }]
    const draft = { data: {}, setData: () => {} }
    const { rerender } = render(<Unavailable def={rr} draft={draft} checks={checks} step="emc" />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    rerender(<Unavailable def={rr} draft={draft} checks={checks} step="bom" />)
    expect(screen.getByRole('checkbox', { name: /I checked it: single-source/ })).toBeInTheDocument()
  })
})
