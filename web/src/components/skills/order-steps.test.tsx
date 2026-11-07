import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SKILL_VIEWS } from '@/mock/fixtures-s1'
import { OrderStep, type OrderDraft, orderChecks } from './order-steps'

const view = SKILL_VIEWS['order-submit']!.order!

function step(id: string, start: OrderDraft = {}) {
  let d = start
  const r = render(<OrderStep repo="acme/desk-gadget" step={id} view={view} draft={d} setDraft={(fn) => { d = fn(d) }} loading={false} />)
  return { ...r, draft: () => d }
}

describe('Order submit steps (#225)', () => {
  it('Re-check stock shows today\'s lines and what changed since sign-off', () => {
    step('stock')
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText(/2 lines changed since the parts check/)).toBeInTheDocument()
    expect(screen.getByText('Was 0.1121')).toBeInTheDocument()
    expect(screen.queryByText(/nothing open/)).toBeNull()
  })

  it('Download the package lists the files to upload, each opening in the app', () => {
    step('package')
    const zip = screen.getByRole('link', { name: 'desk-gadget-gerbers.zip' })
    expect(zip.getAttribute('href')).toBe('/p/acme~desk-gadget/files/hardware/desk-gadget/release/revA/desk-gadget-gerbers.zip')
    expect(screen.getByText('Upload to JLCPCB')).toBeInTheDocument()
  })

  it('Enter the options ticks each option as entered', async () => {
    const s = step('options')
    expect(screen.getByText('Surface finish:')).toBeInTheDocument()
    expect(screen.getAllByText("JLCPCB's default: no record decides it")).toHaveLength(4)
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Entered' })[0]!)
    expect(s.draft().entered).toEqual(['layers'])
  })

  it('the part matching marks each line matched or not placed', async () => {
    const s = step('matching')
    expect(screen.getByText('C701341')).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('radio', { name: 'Not placed' })[4]!)
    expect(s.draft()).toMatchObject({ matched: [], unplaced: ['J2'] })
  })

  it('the bar follows the ticks', () => {
    expect(orderChecks(view, {})).toEqual({ options: 'not_met', matching: 'not_met' })
    const all = { entered: view.options.map((o) => o.id), matched: view.lines.slice(1).map((l) => l.key), unplaced: [view.lines[0]!.key] }
    expect(orderChecks(view, all)).toEqual({ options: 'met', matching: 'met' })
  })
})
