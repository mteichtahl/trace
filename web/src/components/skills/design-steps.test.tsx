import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
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

describe('Architecture choice: Accept the key parts (test-esp32 #38, #96)', () => {
  const check = { run: 'r1', at: '2026-11-05T00:00:00Z', boards: 10, order_code: 'C2838502', need: 10, status: 'ok', flags: [], stock: 2140, unit_price: 2.71, currency: 'USD', note: null }
  const parts = {
    ...view,
    key_parts: {
      option: 'A', quantity: 10, parts: [
        { block: 'tmr', block_name: 'Timer', mpn: 'NE555DR', role: 'astable', off_board: false, check, standing: 'ok', why: null, exception: null },
        { block: 'tmr', block_name: 'Timer', mpn: 'SSD1306-MODULE', role: null, off_board: true, check: { ...check, order_code: null, status: 'short', stock: 6, unit_price: 0.5 }, standing: 'problem', why: 'Short: 10 needed, 6 in stock.', exception: { reason: 'Four from the last build.', by: 'Priya', scope: 'part' } },
        { block: 'tmr', block_name: 'Timer', mpn: 'LED-RED', role: null, off_board: false, check: null, standing: 'unchecked', why: 'Not checked for stock yet: trace runs the parts check at the build quantity.', exception: null },
      ],
    },
  } as unknown as SkillView
  it('lists each key part with its part number, supplier code, stock against the need, price and exception', () => {
    render(<DesignSteps repo="acme/x" skill="architecture-choice" step="parts" view={parts} draft={{}} setDraft={() => undefined} />)
    expect(screen.getByText('Key parts of option A: Classic astable')).toBeInTheDocument()
    expect(screen.getByText(/for the 10 boards the project builds/)).toBeInTheDocument()
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('NE555DR')
    expect(rows[1]).toHaveTextContent('C2838502')
    expect(rows[1]).toHaveTextContent('2,140')
    expect(rows[1]).toHaveTextContent('US$2.71')
    expect(rows[1]).toHaveTextContent('In stock')
    expect(rows[2]).toHaveTextContent('Excepted')
    expect(rows[2]).toHaveTextContent('Short: 10 needed, 6 in stock.')
    expect(rows[2]).toHaveTextContent('Exception, by Priya: Four from the last build.')
    expect(rows[2]).toHaveTextContent('(off the board)')
    expect(rows[3]).toHaveTextContent('Not checked')
  })
})

describe('Architecture choice: fixed criteria follow the requirements they quote (test-esp32 run 2, #173)', () => {
  const withCriteria = (criteria: unknown[]) => ({ ...view, architecture: { ...view.architecture, criteria } }) as unknown as SkillView
  const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>

  it('says a criterion may quote old numbers, and offers to reword it', () => {
    render(wrap(<DesignSteps repo="acme/x" skill="architecture-choice" step="criteria" view={withCriteria([{ id: 'cost', name: 'Cost against 8 USD/board and 100 USD project', weight: 3, description: 'REQ-f3f79d and REQ-4ce9e8.', stale: { requirements: ['REQ-f3f79d', 'REQ-4ce9e8'], since: '2026-11-06T10:00:00Z' } }])} draft={{}} setDraft={() => undefined} />))
    expect(screen.getByText('May quote old numbers')).toBeInTheDocument()
    expect(screen.getByText(/names REQ-f3f79d, REQ-4ce9e8, changed on 2026-11-06 after these words were written/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask trace to reword it' })).toBeInTheDocument()
  })

  it('reads a criterion reworded after the fix by its new words, with the ones it was fixed with', () => {
    render(wrap(<DesignSteps repo="acme/x" skill="architecture-choice" step="criteria" view={withCriteria([{ id: 'cost', name: 'Cost against 9 USD/board and 275 USD project', weight: 3, description: null, was: 'Cost against 8 USD/board and 100 USD project' }])} draft={{}} setDraft={() => undefined} />))
    expect(screen.getByText('Cost against 9 USD/board and 275 USD project')).toBeInTheDocument()
    expect(screen.getByText(/was fixed as "Cost against 8 USD\/board and 100 USD project" and reworded since/)).toBeInTheDocument()
    expect(screen.queryByText('May quote old numbers')).toBeNull()
  })
})
