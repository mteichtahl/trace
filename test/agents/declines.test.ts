import { describe, expect, it } from 'vitest'
import { declineIn, declinedOf, declinedSummary } from '../../src/agents/declines.js'

describe('a specialist declining a job as another\'s work (test log R26)', () => {
  it('reads the NOT MINE line, by kind or by title, never for itself', () => {
    expect(declineIn('NOT MINE: verify: criteria are Verification\'s.\nNothing changed.', 'impl')).toEqual({ to: 'verify', why: 'criteria are Verification\'s.' })
    expect(declineIn('\n  not mine: Verification - its record', 'impl')).toMatchObject({ to: 'verify' })
    expect(declineIn('NOT MINE: impl: x', 'impl')).toBeNull()
    expect(declineIn('NOT MINE: nobody: x', 'impl')).toBeNull()
  })

  it('reads the report\'s own words only when it also says it changed nothing', () => {
    // the report job R26 ended with
    const r26 = 'I didn\'t change REQ-7ec888. Editing a requirement\'s acceptance criterion belongs to the Verification specialist, not to Implementation, so this job should go to them. Only the Verification specialist adds or updates requirements.'
    expect(declineIn(r26, 'impl')).toMatchObject({ to: 'verify' })
    // part of the work done, the rest named for another: not a decline
    expect(declineIn('Routed the board. The thermal check belongs to the Thermal specialist.', 'impl')).toBeNull()
    expect(declineIn('Pushed abc.', 'impl')).toBeNull()
  })

  it('writes the summary so it reads back as a decline, and nothing else does', () => {
    const s = declinedSummary('impl', { to: 'verify', why: 'w' }, 'NOT MINE: verify: w\nI changed nothing.')
    expect(s).toBe('impl: declined, for verify: I changed nothing.')
    expect(declinedOf(s)).toEqual({ from: 'impl', to: 'verify', why: 'I changed nothing.' })
    expect(declinedOf('impl: done in 2 turns: belongs to the Verification specialist')).toBeNull()
    expect(declinedOf('impl: declined, for nobody: x')).toBeNull()
    expect(declinedOf(null)).toBeNull()
  })
})
