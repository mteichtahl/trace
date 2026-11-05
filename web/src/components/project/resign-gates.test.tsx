/**
 * The gates to sign again after a change of requirements (journey.get `resign`; test-esp32 log #62, #71): which gates,
 * and for each whether its evidence stands.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { readJourney } from '@/lib/readers'
import type { Journey } from '@/lib/types'

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: React.ReactNode; className?: string }) => <a href={Object.entries(params ?? {}).reduce((h, [k, v]) => h.replace(`$${k}`, v), to)} className={className}>{children}</a> }))
const { ResignGates, resignText } = await import('./resign-gates')

const resign: NonNullable<Journey['resign']> = {
  requirements: ['REQ-39855b'], edits: 'REQ-39855b changed only its acceptance criterion',
  gates: [
    { gate: 'define', name: 'requirements baseline', stage: 'define', state: 'signed', why: 'Agree REQ-39855b again in Requirements review, then sign it.' },
    { gate: 'architect', name: 'architecture review', stage: 'architect', state: 'kept', why: 'The chosen architecture stands. Sign it again; nothing is redone.' },
    { gate: 'capture', name: 'schematic review', stage: 'capture', state: 'kept', why: 'The schematic stands. Sign it again; nothing is redone.' },
    { gate: 'prove', name: 'design proven', stage: 'prove', state: 'redo', why: 'Done again: TST-008, TST-009 are run again.' },
  ],
}

describe('ResignGates', () => {
  it('lists each gate with whether its evidence stands, linking to the gate', () => {
    render(<ResignGates resign={resign} id="acme~x" />)
    const card = screen.getByRole('region', { name: 'Gates to sign again' })
    expect(within(card).getByText('3 gates to sign again')).toBeInTheDocument()
    const rows = within(card).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Requirements baseline.*Signed again$/),
      expect.stringMatching(/^Architecture review.*Evidence unchanged$/),
      expect.stringMatching(/^Schematic review.*Evidence unchanged$/),
      expect.stringMatching(/^Design proven.*TST-008, TST-009 are run again\.Part redone$/),
    ])
    expect(within(rows[1]!).getByRole('link')).toHaveAttribute('href', '/p/acme~x/gates/architect')
  })

  it('says what changed, and that the gates keeping their evidence are signed again with nothing redone', () => {
    expect(resignText(resign)).toEqual({
      title: '3 gates to sign again',
      body: 'REQ-39855b changed only its acceptance criterion after the requirements baseline, so the project went back to Define. 2 gates keep their evidence: open and sign again, nothing is redone there.',
    })
    const all = { ...resign, gates: resign.gates.filter((g) => g.state === 'kept') }
    expect(resignText(all).body).toMatch(/Each keeps its evidence: open it and sign again, nothing is redone\.$/)
  })

  it('is read from journey.get, and left out when the answer has none', () => {
    const raw = { repo: 'acme/x', name: 'X', template: 'board', revision: 'A', current_stage: 'define', stages: [], gates: [], next: { kind: 'task', summary: '' }, questions: [], waivers: [], decisions: [] }
    expect(readJourney(raw).resign).toBeUndefined()
    const j = readJourney({ ...raw, resign: { requirements: ['REQ-39855b'], edits: 'REQ-39855b changed only its acceptance criterion', gates: [{ gate: 'architect', name: 'architecture review', stage: 'architect', state: 'kept', why: 'x' }, { gate: 'prove', name: 'design proven', stage: 'prove', state: 'odd', why: 'y' }] } })
    expect(j.resign?.gates.map((g) => g.state)).toEqual(['kept', 'redo'])
  })
})
