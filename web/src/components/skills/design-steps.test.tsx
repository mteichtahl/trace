import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SkillView } from '@/lib/types-s1'
import { DesignSteps } from './design-steps'

const block = (id: string, serves: string[]) => ({ id, name: `Block ${id}`, role: null, parts: [{ mpn: `MPN-${id}`, key: true }], serves, x: 0.5, y: 0.5 })
const view = {
  checks: [],
  architecture: {
    options: [
      { id: 'A', name: 'Classic astable', summary: 'RA much smaller than RB.', recommended: true, why: 'The datasheet circuit.', gives_up: 'One more resistor.', risks: [], total: 42, blocks: [block('tmr', ['R5', 'R6'])], connections: [] },
      { id: 'B', name: 'Output-fed astable', summary: 'One timing resistor.', recommended: false, why: 'Fewest parts.', gives_up: null, risks: ['Duty depends on the output swing'], total: 37, blocks: [block('osc', ['R5'])], connections: [] },
    ],
    criteria: [{ id: 'acc', name: 'Flash rate accuracy', weight: 3, description: null }],
    fixed: { by: 'p', at: '2026-10-31T00:00:00Z' },
    scores: [
      { option: 'A', criterion: 'acc', score: 5, reason: 'Timing set by RA and RB only.', by: 'trace' },
      { option: 'B', criterion: 'acc', score: 3, reason: 'Depends on VOH.', by: 'trace' },
    ],
    recommended: 'A', chosen: null, current: 'A',
  },
} as unknown as SkillView

describe('Architecture choice: compare the options', () => {
  it('Read each option: switches between the options, each with its summary, why and what none of its blocks serve', async () => {
    render(<DesignSteps repo="acme/x" skill="architecture-choice" step="read" view={view} draft={{}} setDraft={() => undefined} />)
    expect(screen.getByText('2 options: option A, Classic astable')).toBeInTheDocument()
    expect(screen.getByText('RA much smaller than RB.')).toBeInTheDocument()
    expect(screen.queryByText('Flash rate accuracy')).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: /Option B/ }))
    expect(screen.getByText('2 options: option B, Output-fed astable')).toBeInTheDocument()
    expect(screen.getByText('One timing resistor.')).toBeInTheDocument()
    expect(screen.getByText(/No block of option B serves R6/)).toBeInTheDocument()
  })

  it('Score: the options side by side on the criteria, each score with its reason', () => {
    render(<DesignSteps repo="acme/x" skill="architecture-choice" step="score" view={view} draft={{}} setDraft={() => undefined} />)
    expect(screen.getByText('Flash rate accuracy')).toBeInTheDocument()
    expect(screen.getByText('Timing set by RA and RB only.')).toBeInTheDocument()
    expect(screen.getByText('Depends on VOH.')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })
})
