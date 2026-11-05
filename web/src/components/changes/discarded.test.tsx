import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DecisionBar, barWords, discardedWords } from './decision-bar'

// test-esp32 log #75: a discarded change came back as a new one when a job pushed to its branch
describe('a discarded change', () => {
  const discarded = { by: 'marc@example.com', at: '2026-11-05T10:18:00Z', reason: 'We chose the other regulator.\nUse the LDO.', jobs: ['The Verification job that was working on it was stopped.'] }
  const change = { state: 'closed' as const, may_accept: false, blockers: [], title: 'Power sheet', from: 'the Implementation specialist', discarded }

  it('says who discarded it and why, the job it stopped, and that trace will not bring it back', () => {
    expect(barWords('closed', change)).toBe('marc@example.com discarded this change: "We chose the other regulator. Use the LDO." The Verification job that was working on it was stopped. Nothing in the design changed, and trace will not open its branch as a change again: work that is still wanted comes as a new change that links this one.')
    render(<DecisionBar change={change} part="contributor" note="" onAccept={() => undefined} onAsk={() => undefined} onDiscard={() => undefined} />)
    expect(screen.getByText(/The Verification job that was working on it was stopped/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Accept into the design/ })).toBeNull()
  })

  it('reads as before from an older API, and without a reason', () => {
    expect(discardedWords(undefined)).toBe('This change was discarded. Nothing in the design changed.')
    expect(discardedWords({ ...discarded, reason: '', jobs: [] })).toMatch(/^marc@example\.com discarded this change\. Nothing in the design changed/)
  })
})
