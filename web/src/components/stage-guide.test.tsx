import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StepList, stepWords } from './stage-guide'
import type { StageStep } from '@/lib/types'

const steps: StageStep[] = [
  { id: 'a', text: 'Draft the schematic', owner: 'trace', state: 'done', ref: null },
  { id: 'b', text: 'Sign the schematic gate', owner: 'you', state: 'now', ref: null },
  { id: 'c', text: 'Check stock', owner: 'trace', state: 'later', ref: null },
]

describe('stage steps while a project is paused', () => {
  it('steps not done read "On hold"; done ones keep their words', () => {
    expect(stepWords(steps, 0, true)).toBe(stepWords(steps, 0, false))
    expect(stepWords(steps, 1, true)).toBe('On hold')
    expect(stepWords(steps, 2, true)).toBe('On hold')
    expect(stepWords(steps, 1, false)).not.toBe('On hold')
  })
  it('the step that was yours is no longer highlighted, and says why', () => {
    render(<StepList steps={steps} held />)
    const mine = screen.getByLabelText(/Sign the schematic gate/)
    expect(mine.className).not.toMatch(/bg-primary-soft/)
    expect(mine.getAttribute('aria-label')).toBe('Sign the schematic gate: on hold while the project is paused')
  })
})
