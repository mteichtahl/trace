/**
 * The next step when a requirement changed after the baseline: signing the next gate waits for the person to decide
 * the change in Requirements review (src/api/actions-journey.ts changedStep).
 */
import { describe, expect, it } from 'vitest'
import { changedStep } from '../../src/api/actions-journey.js'
import type { NextStep } from '../../src/core/journey.js'

const gate: NextStep = {
  kind: 'gate', belongs_to: 'you', yours: true, summary: 'The schematic review gate is ready. All 4 criteria met. trace recommends signing.',
  why: 'Work on the next stage starts only when the schematic review gate is signed.', recommendation: 'trace recommends signing.',
  button: 'Review and sign', stage: 'capture', ref: { kind: 'gate', id: 'capture' },
}

describe('changedStep', () => {
  it('sends the person to Requirements review before a gate while a changed requirement is unaccepted', () => {
    expect(changedStep(gate, 'capture', ['R5'])).toEqual({
      kind: 'task', belongs_to: 'you', yours: true,
      summary: 'R5 was changed after the requirements baseline and is not accepted yet: accept, edit or strike it in Requirements review. The schematic review gate is ready. All 4 criteria met.',
      why: expect.stringMatching(/accepted requirements/), recommendation: null, button: 'Open Requirements review', stage: 'capture', ref: { kind: 'skill', id: 'requirements-review' },
    })
    expect(changedStep(gate, 'capture', ['R5', 'R7', 'R13']).summary).toMatch(/^R5, R7 and R13 were changed .* accept, edit or strike them/)
  })
  it('leaves the step alone with nothing open, in Define, or when the step is not the person signing a gate', () => {
    expect(changedStep(gate, 'capture', [])).toBe(gate)
    expect(changedStep({ ...gate, stage: 'define' }, 'define', ['R5'])).toEqual({ ...gate, stage: 'define' })
    const theirs = { ...gate, belongs_to: 'admins' as const, yours: false }
    expect(changedStep(theirs, 'capture', ['R5'])).toBe(theirs)
    const working: NextStep = { ...gate, kind: 'working', belongs_to: 'trace', yours: false }
    expect(changedStep(working, 'capture', ['R5'])).toBe(working)
  })
})
