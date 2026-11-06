import { describe, expect, it } from 'vitest'
import { needsReason } from './stepped-skill'

describe('needsReason (the bar\'s reasons check, before the server answers)', () => {
  const rec = { recommended: 'A', reasonNeeded: { A: 'Option C scores higher (44 against 42.5)' } }
  it('the recommendation outscored needs a reason; the top score against the recommendation does too', () => {
    expect(needsReason({ option: 'A' }, rec)).toBe(true)
    expect(needsReason({ option: 'A', reason: 'Certified module.' }, rec)).toBe(false)
    expect(needsReason({ option: 'C' }, rec)).toBe(true)
    expect(needsReason({ option: 'A' }, { recommended: 'A' })).toBe(false)
    expect(needsReason(undefined, rec)).toBe(false)
  })
})
