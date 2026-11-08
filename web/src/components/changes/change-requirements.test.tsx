import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ChangeRequirements, findRequirement } from './change-requirements'
import type { CoverageRow } from '@/lib/types-s1'

const row = (id: string, extra: Partial<CoverageRow> = {}): CoverageRow => ({
  id, kind: 'functional', text: `${id} words`, acceptance: `${id} criterion`, status: 'approved', verdict: 'verified',
  tests: [{ id: `TST-${id}`, method: 'test', status: 'pass', last_run: null }], ...extra,
})
const link = (rid: string, children: React.ReactNode, className?: string) => <a href={`/req/${rid}`} className={className}>{children}</a>

describe('ChangeRequirements', () => {
  it('shows each requirement expanded, with its criterion, tests and a link to it', () => {
    render(<ChangeRequirements ids={['REQ-001', 'REQ-002']} rows={[row('REQ-001'), row('REQ-002', { verdict: 'failing' })]} link={link} />)
    expect(screen.getByText('REQ-001 criterion')).toBeInTheDocument()
    expect(screen.getByText('TST-REQ-002')).toBeInTheDocument()
    expect(screen.getByText('Failing')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open REQ-002' })).toHaveAttribute('href', '/req/REQ-002')
  })

  it('links to the project\'s own id when the change uses a short form', () => {
    render(<ChangeRequirements ids={['REQ-9']} rows={[row('REQ-009')]} link={link} />)
    expect(screen.getByRole('link', { name: 'Open REQ-009' })).toHaveAttribute('href', '/req/REQ-009')
    expect(findRequirement([row('REQ-010')], 'REQ-10')?.id).toBe('REQ-010')
  })

  it('starts folded when there are many, and opens them all on request', async () => {
    const ids = ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004']
    render(<ChangeRequirements ids={ids} rows={ids.map((i) => row(i))} link={link} />)
    expect(screen.queryByText('REQ-001 criterion')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open all 4' }))
    expect(screen.getByText('REQ-004 criterion')).toBeInTheDocument()
  })

  it('says when a named requirement is not in the design yet, and when there are none', () => {
    const { rerender } = render(<ChangeRequirements ids={['REQ-077']} rows={[]} link={link} />)
    expect(screen.getByText(/REQ-077 is not among the design's requirements yet/)).toBeInTheDocument()
    rerender(<ChangeRequirements ids={[]} rows={[]} link={link} />)
    expect(screen.getByText('This change does not name a requirement.')).toBeInTheDocument()
  })

  it('says once, plainly, which ids it cites that the project does not have, and lists none of them (log #47, #105)', () => {
    // run 1: the schematic change named R3
    const { rerender } = render(<ChangeRequirements ids={[]} unknown={['R3']} rows={[]} link={link} />)
    expect(screen.getByText('The change names R3, which is not a requirement of this project.')).toBeInTheDocument()
    expect(screen.queryByText('This change does not name a requirement.')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    // run 2: R1 to R7 beside a requirement it does name
    const r = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']
    rerender(<ChangeRequirements ids={['REQ-9b1b96']} unknown={r} rows={[row('REQ-9b1b96')]} link={link} />)
    expect(screen.getAllByText(/which are not requirements of this project/)).toHaveLength(1)
    expect(screen.getByText('The change names R1, R2, R3, R4, R5, R6 and R7, which are not requirements of this project.')).toBeInTheDocument()
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/req/REQ-9b1b96'])
  })

  // test-esp32-run2 R47: a change adding 33 tests showed "No test yet" on every requirement it covers
  it('says a requirement is tested in this change when the accepted design has no test for it', () => {
    render(<ChangeRequirements ids={['REQ-001', 'REQ-002']} tested={['REQ-001']} rows={[row('REQ-001', { verdict: 'no_test' }), row('REQ-002', { verdict: 'no_test' })]} link={link} />)
    expect(screen.getAllByText('Tested in this change')).toHaveLength(1)
    expect(screen.getAllByText('No test yet')).toHaveLength(1)
  })
})
