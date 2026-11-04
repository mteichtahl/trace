/**
 * The Documents tab (components/docs/documents.tsx, routes/_app/p/$id/docs.tsx): why a document is behind in a
 * sentence, a printed copy as a file the viewer opens by its hash, the tab from Architect on, and each card's state.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { behindWhy, DocumentCard, printedFile } from '@/components/docs/documents'
import type { ProjectDocument } from '@/lib/types-docs'

const stage = (s: string) => ({ capture: 'Capture', layout: 'Layout', architect: 'Architect' })[s] ?? s
const doc = (o: Partial<ProjectDocument> = {}): ProjectDocument => ({
  kind: 'lld', title: 'Low level design', file: 'docs/design/low-level-design.md', exists: true, due: true, from: 'capture', state: 'current',
  revision: 'B', commit: '7f3c21b08e44', updated: '2026-11-03', behind: [],
  sections: [{ id: 'modules', title: 'Modules', due: 'capture', written: true, overdue: false }, { id: 'pin-plan', title: 'Pin plan', due: 'capture', written: false, overdue: false }],
  printed: null, ...o,
})

describe('the Documents tab', () => {
  it('says why a document is behind: the records that changed and the sections still to write', () => {
    expect(behindWhy(doc(), stage)).toBeNull()
    expect(behindWhy(doc({ state: 'behind', behind: ['schematic', 'pin-plan'] }), stage)).toBe('The schematic and the pin plan changed since it was written.')
    const overdue = doc({ state: 'behind', sections: [{ id: 'pin-plan', title: 'Pin plan', due: 'capture', written: false, overdue: true }] })
    expect(behindWhy(overdue, stage)).toBe('Pin plan is still to write for Capture.')
    expect(behindWhy({ ...overdue, behind: ['board'] }, stage)).toBe('The board changed since it was written; Pin plan is still to write for Capture.')
  })

  it('opens a printed copy by its hash, named for the project, document and revision', () => {
    const p = { kind: 'hld' as const, sha256: 'f'.repeat(64), bytes: 1200, commit: 'a41e9d0c2b17', run: 'r-1', at: 0 }
    expect(printedFile('acme/soil-sensor', 'High level design', p, { revision: 'B' })).toMatchObject({ path: 'soil-sensor_high-level-design_rev-B.pdf', printed: { sha256: p.sha256 }, revision: 'Rev B' })
    expect(printedFile('acme/soil-sensor', 'High level design', p).path).toBe('soil-sensor_high-level-design_a41e9d0.pdf')
  })

  it('shows each document\'s state in words, and its print and text once written', () => {
    const { rerender } = render(<DocumentCard repo="acme/x" d={doc({ state: 'behind', behind: ['schematic'] })} stage={stage} writing={false} onOpen={() => {}} />)
    expect(screen.getByText('Behind')).toBeTruthy()
    expect(screen.getByText('Not printed yet')).toBeTruthy()
    expect(screen.getByText('Read the text')).toBeTruthy()
    rerender(<DocumentCard repo="acme/x" d={doc({ state: 'behind', behind: ['schematic'] })} stage={stage} writing onOpen={() => {}} />)
    expect(screen.getByText('Updating')).toBeTruthy()
    rerender(<DocumentCard repo="acme/x" d={doc({ kind: 'guide', title: 'User guide', exists: false, due: false, from: 'layout', state: 'later', sections: [] })} stage={stage} writing={false} onOpen={() => {}} />)
    expect(screen.getByText('From Layout')).toBeTruthy()
    expect(screen.queryByText('Read the text')).toBeNull()
  })
})
