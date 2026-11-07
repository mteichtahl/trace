/**
 * Requirements review's edits and trace's decide_requirement (test log R23): an edit over an earlier one keeps its
 * fields, accepted rows can be edited, and the chat's decisions are the rows' own.
 */
import { describe, expect, it } from 'vitest'
import { type RequirementDecision, type ShownRequirement, changedRequirementFields, decideRequirements, recordRequirement, requirementBadge, reviewDraftContext, shownRequirement, withRequirementEdit } from './requirement-edit'

const r7: ShownRequirement = { id: 'REQ-7ec888', text: 'Reads soil moisture accurately', criterion: 'Readings are accurate', method: null, kind: 'electrical', accepted: true }
const r2: ShownRequirement = { id: 'R-2', text: 'Has a two-line display', criterion: null, method: null, kind: 'functional', accepted: false }
const shown = new Map([[r7.id, r7], [r2.id, r2]])

describe('an edit in the draft', () => {
  it('lays its fields over an earlier edit\'s, and accepts the requirement', () => {
    const none: { decisions?: RequirementDecision[] } = {}
    const one = withRequirementEdit(none, 'R-2', { text: 'Has a two-line display readable at 1 m' })
    const two = withRequirementEdit(one, 'R-2', { criterion: '16 characters by 2 lines, read at 1 m in 500 lx' })
    expect(two.decisions).toEqual([{ requirement: 'R-2', choice: 'edit', text: 'Has a two-line display readable at 1 m', criterion: '16 characters by 2 lines, read at 1 m in 500 lx' }])
    // over an accept or a strike, it replaces it
    expect(withRequirementEdit({ decisions: [{ requirement: 'R-2', choice: 'strike', reason: 'Not needed' }] }, 'R-2', { method: 'Inspection' }).decisions).toEqual([{ requirement: 'R-2', choice: 'edit', method: 'Inspection' }])
  })

  it('shows the edit over the record, and only the fields changed count', () => {
    expect(shownRequirement(r7, { choice: 'edit', criterion: '±3 % VWC' })).toMatchObject({ text: r7.text, criterion: '±3 % VWC', kind: 'electrical' })
    expect(shownRequirement(r7, { choice: 'accept' })).toBe(r7)
    expect(changedRequirementFields(r7, { text: ` ${r7.text} `, criterion: '±3 % VWC', method: '', class: 'electrical' })).toEqual({ criterion: '±3 % VWC' })
  })

  it('reads an item the review lists, and badges it', () => {
    expect(recordRequirement({ id: 'requirement:R-9', title: 'R-9: Sleeps under 20 µA', status: 'open', criterion: '20 µA at 25 °C' })).toEqual({ id: 'R-9', text: 'Sleeps under 20 µA', criterion: '20 µA at 25 °C', method: null, kind: null, accepted: false })
    expect(recordRequirement({ id: 'intent:I-6', title: 'Not covered', status: 'open' })).toBeNull()
    expect(requirementBadge({ choice: 'edit' }, true)).toEqual({ status: 'met', label: 'Accepted, edited' })
    expect(requirementBadge(undefined, true)).toEqual({ status: 'met', label: 'Accepted' })
    expect(requirementBadge(undefined, false)).toEqual({ status: 'yours', label: 'Undecided' })
  })
})

describe('decide_requirement', () => {
  it('edits an accepted requirement\'s criterion, then its method, keeping the criterion', () => {
    let d: RequirementDecision[] = []
    let r = decideRequirements(d, { decisions: [{ requirement: 'REQ-7ec888', choice: 'edit', criterion: 'Within ±3 % VWC from 0 to 50 % VWC at 25 °C' }] }, shown)
    expect(r.refused).toEqual([])
    d = r.decisions
    r = decideRequirements(d, { decisions: [{ requirement: 'REQ-7ec888', choice: 'edit', method: 'Bench test', kind: 'functional' }] }, shown)
    expect(r.decisions).toEqual([{ requirement: 'REQ-7ec888', choice: 'edit', criterion: 'Within ±3 % VWC from 0 to 50 % VWC at 25 °C', method: 'Bench test', class: 'functional' }])
    expect(r.decided).toEqual([{ requirement: 'REQ-7ec888', choice: 'edit', method: 'Bench test', class: 'functional' }])
    // accepting it again keeps the edit
    expect(decideRequirements(r.decisions, { decisions: [{ requirement: 'REQ-7ec888', choice: 'accept' }] }, shown).decisions).toEqual(r.decisions)
  })

  it('refuses a requirement not listed, an edit that changes nothing, a strike without a reason; undoes one', () => {
    const r = decideRequirements([], { decisions: [
      { requirement: 'REQ-nope', choice: 'accept' },
      { requirement: 'R-2', choice: 'edit', text: 'Has a two-line display' },
      { requirement: 'R-2', choice: 'strike' },
      { requirement: 'R-2', choice: 'strike', reason: 'The phone app shows it' },
    ] }, shown)
    expect(r.refused).toEqual([expect.stringMatching(/REQ-nope is not listed/), expect.stringMatching(/nothing to change/), expect.stringMatching(/needs a reason/)])
    expect(r.decisions).toEqual([{ requirement: 'R-2', choice: 'strike', reason: 'The phone app shows it' }])
    expect(decideRequirements(r.decisions, { decisions: [{ requirement: 'R-2', choice: 'undo' }] }, shown).decisions).toEqual([])
    expect(decideRequirements([], { nope: 1 }, shown).refused[0]).toMatch(/could not be read/)
  })

  it('tells the chat each row as shown, with its state', () => {
    const c = reviewDraftContext([r7, r2], [{ requirement: 'REQ-7ec888', choice: 'edit', criterion: '±3 % VWC' }])
    expect(c.requirements).toEqual([
      { id: 'REQ-7ec888', words: r7.text, criterion: '±3 % VWC', kind: 'electrical', state: 'edited in the draft (accepted)' },
      { id: 'R-2', words: r2.text, criterion: null, kind: 'functional', state: 'undecided' },
    ])
    expect(c.note).toMatch(/decide_requirement, never with a task/)
  })
})
