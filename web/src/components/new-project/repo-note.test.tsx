/** New project's Repository step: what it says of the repository it would use (test-esp32 log #78). */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { NewProjectDraft } from '@/lib/types-s1'
import { RepoNote } from './repo-note'
import type { RepoCheck } from './rules'

const d: NewProjectDraft = {
  name: 'test-esp32', description: '', icon: { glyph: 'board', colour: 'green' }, start: 'idea', template: 'board',
  repository: { mode: 'new', owner: 'mteichtahl', name: 'test-esp32', branch: 'main' },
  advanced: { ownToken: false, memoryDays: 30, onboardingPr: true, applySettings: true }, people: [],
  build: { quantity: 10, later: { certify: false, produce: false, sustain: false }, fab: 'JLCPCB' },
}
const retired: RepoCheck = {
  repo: 'mteichtahl/test-esp32', exists: true, project: { name: 'test-esp32', retired: true }, suggestion: 'mteichtahl/test-esp32-2',
  text: 'mteichtahl/test-esp32 already exists: it holds the retired project test-esp32. mteichtahl/test-esp32-2 is free.',
}

describe('RepoNote', () => {
  it('names the retired project that holds the repository, and offers the free name', () => {
    const onUse = vi.fn()
    render(<RepoNote d={d} check={retired} onUse={onUse} />)
    expect(screen.getByRole('status').textContent).toMatch(/already exists: it holds the retired project test-esp32\. mteichtahl\/test-esp32-2 is free\. Restore it from Admin, Retired projects/)
    fireEvent.click(screen.getByRole('button', { name: 'Use test-esp32-2' }))
    expect(onUse).toHaveBeenCalledWith('test-esp32-2')
  })

  it('a repository only GitHub has: says it exists, and how to use it on purpose', () => {
    render(<RepoNote d={d} check={{ ...retired, project: null, text: 'mteichtahl/test-esp32 already exists on GitHub. mteichtahl/test-esp32-2 is free.' }} onUse={() => undefined} />)
    expect(screen.getByRole('status').textContent).toMatch(/already exists on GitHub\..*choose An existing repository/)
  })

  it('a free name, and while it is being asked', () => {
    const { rerender } = render(<RepoNote d={d} check={undefined} onUse={() => undefined} />)
    expect(screen.getByText('Checking mteichtahl/test-esp32 on GitHub…')).toBeTruthy()
    rerender(<RepoNote d={d} check={{ ...retired, exists: false, project: null, suggestion: null, text: null }} onUse={() => undefined} />)
    expect(screen.getByText('✓ mteichtahl/test-esp32 is free on GitHub')).toBeTruthy()
  })
})
