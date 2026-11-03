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

  it('says when a named requirement is not in the project, and when there are none', () => {
    const { rerender } = render(<ChangeRequirements ids={['REQ-077']} rows={[]} link={link} />)
    expect(screen.getByText(/could not find REQ-077/)).toBeInTheDocument()
    rerender(<ChangeRequirements ids={[]} rows={[]} link={link} />)
    expect(screen.getByText('This change does not name a requirement.')).toBeInTheDocument()
  })
})
