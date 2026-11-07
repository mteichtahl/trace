import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CoverageRow } from '@/lib/types-s1'
import { layoutTrace } from '@/components/project/traceability'
import { recommendGlyph } from '@/components/project/project-icon'
import { readoutState } from './checklist-skill'
import { IntentQualityList, answerChecks, arrivingChoice, changedFields, decidedNote, draftCount, intentDraftContext, intentSubmitLabel, statementBadge, undecidedStatements, withIntentDecision } from './conversation-skills'
import { SKILLS, checksOf, pictureOf } from './definitions'
import { continueText, draftKey } from './draft'
import { changeChecks, waivableShown, waiverChecks, whereExample, type WaiverDraft } from './form-skills'
import { changesExplained } from './kicad-skill'
import { qualityChecks } from './use-skill'

describe('the skill table', () => {
  it('holds all twenty skills, each with steps and a quality bar', () => {
    expect(SKILLS).toHaveLength(20)
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(20)
    for (const s of SKILLS) {
      expect(s.steps.length).toBeGreaterThan(1)
      expect(s.checks.length).toBeGreaterThan(1)
      for (const c of s.checks) if (c.step) expect(s.steps.map((x) => x.id)).toContain(c.step)
    }
  })
  it('puts each skill in its variant', () => {
    const v = (id: string) => SKILLS.find((s) => s.id === id)!.variant
    expect(['intent-builder', 'question-answer'].map(v)).toEqual(['conversational', 'conversational'])
    expect(['bench-setup', 'bring-up-run', 'incoming-inspection'].map(v)).toEqual(['checklist', 'checklist', 'checklist'])
    expect(SKILLS.filter((s) => s.variant === 'stepped')).toHaveLength(15)
  })
  it('adds the shared reason rule to every bar but the intent', () => {
    expect(checksOf(SKILLS.find((s) => s.id === 'waiver')!).at(-1)!.id).toBe('reasons')
    expect(checksOf(SKILLS.find((s) => s.id === 'intent-builder')!).some((c) => c.id === 'reasons')).toBe(false)
  })
  it('opens each step with its picture', () => {
    const cr = SKILLS.find((s) => s.id === 'change-request')!
    expect(pictureOf(cr, 'impact')).toBe('traceability')
    expect(pictureOf(cr, 'state')).toBe('none')
  })
})

describe('the quality bar', () => {
  const sf = SKILLS.find((s) => s.id === 'schematic-finish')!
  it('keeps Submit off until the checker says met: an unreported check is not met', () => {
    const bar = qualityChecks(sf, { checks: [{ id: 'notes', status: 'met' }] })
    expect(bar.find((c) => c.id === 'notes')!.status).toBe('met')
    expect(bar.find((c) => c.id === 'erc')!.status).toBe('not_met')
  })
  it('lets the screen override what it knows itself', () => {
    expect(qualityChecks(sf, { checks: [{ id: 'changes', status: 'met' }] }, { changes: 'not_met' }).find((c) => c.id === 'changes')!.status).toBe('not_met')
  })
  it('every change from the draft needs a reason', () => {
    const ch = [{ id: 'a', what: 'C3 changed', guess: 'g' }, { id: 'b', what: 'R7', confirmed: true, reason: 'r7' }]
    expect(changesExplained(ch, {})).toBe(false)
    expect(changesExplained(ch, { a: 'radio bulk cap' })).toBe(true)
  })
})

describe('Waiver', () => {
  const d: WaiverDraft = { done: [], what: 'F2', reason: '', risk: '', caught: '', where: '', scope: '', condition: '' }
  it('refuses "not needed" as a reason', () => {
    expect(waiverChecks({ ...d, reason: 'not needed' }).reason).toBe('not_met')
    expect(waiverChecks({ ...d, reason: 'Driven by the battery through J1' }).reason).toBe('met')
  })
  it('a safety waiver must name where it is verified, never accepted for good', () => {
    expect(waiverChecks({ ...d, severity: 'safety', caught: 'nowhere' }).safety).toBe('not_met')
    expect(waiverChecks({ ...d, severity: 'safety', caught: 'bench', where: 'Bring-up step 3' }).safety).toBe('met')
    expect(waiverChecks({ ...d, severity: 'degraded', caught: 'nowhere' }).safety).toBe('met')
  })
  it('names its scope', () => {
    expect(waiverChecks({ ...d, scope: 'condition', condition: '' }).scope).toBe('not_met')
    expect(waiverChecks({ ...d, scope: 'revision' }).scope).toBe('met')
  })
  // test-esp32 #148: opened from a DRC finding's "Waive this one…", the finding was 28th of 28, below the fold
  it('shows what it was opened with first, and alone until the person asks for the rest', () => {
    const list = [...Array.from({ length: 27 }, (_, i) => ({ id: `requirement:R-${i + 1}` })), { id: 'finding:drc@3' }]
    expect(waivableShown(list, 'finding:drc@3', false).map((w) => w.id)).toEqual(['finding:drc@3'])
    const all = waivableShown(list, 'finding:drc@3', true)
    expect(all[0]?.id).toBe('finding:drc@3')
    expect(all).toHaveLength(28)
    // nothing chosen, or something not in the list: every one, in order
    expect(waivableShown(list, undefined, false)).toEqual(list)
    expect(waivableShown(list, 'other', false)).toEqual(list)
  })
  it('gives a "Where exactly" example that fits what is waived', () => {
    expect(whereExample('later', 'finding', 'DRC: J2 courtyard overlaps U1')).toBe('Sign-off: the rule checks on the release files')
    expect(whereExample('later', 'finding', 'U3 (TLV75533) has 6 in stock: 10 boards need 10.')).toBe('Fabricate: the stock check when the order is placed')
    expect(whereExample('later', 'finding')).not.toMatch(/SPICE/)
    expect(whereExample('bench', 'finding')).toMatch(/^Bring-up step/)
    expect(whereExample('later', 'requirement')).toBe('Prove: SPICE stability run on the LDO')
    expect(whereExample('bench', 'requirement')).toBe('Bring-up step 3 (unpowered rail check)')
  })
})

describe('Change request', () => {
  it('never edits a released revision', () => {
    const d = { done: [], what: 'part' as const, change: 'Use a 2,000 mAh cell', why: 'Two years of battery', acknowledged: true, revision: 'this' as const, covers: 'both' as const }
    expect(changeChecks(d, true).released).toBe('not_met')
    expect(changeChecks({ ...d, revision: 'next' }, true).released).toBe('met')
    expect(changeChecks({ ...d, acknowledged: false }, false).impact).toBe('not_met')
  })
})

describe('Question answer', () => {
  it('arrives with the option "Use <option>" named, only when it is one of this question\'s options (#198)', () => {
    const options = [{ id: 'a' }, { id: 'b' }]
    expect(arrivingChoice(options, 'b')).toBe('b')
    expect(arrivingChoice(options, 'c')).toBeNull()
    expect(arrivingChoice(options, 'other')).toBeNull()
    expect(arrivingChoice(options, undefined)).toBeNull()
  })
  it('refuses "it depends" and wants a number for a quantity', () => {
    const d = { done: [], answer: 'it depends', value: '', source: '', lasts: '' as const }
    expect(answerChecks({ ...d, option: 'other' }, { unit: 'A' }).resolves).toBe('not_met')
    expect(answerChecks({ ...d, option: 'other', answer: 'Stall current', value: '' }, { unit: 'A' }).units).toBe('not_met')
    expect(answerChecks({ ...d, option: '4.2', lasts: 'once' }, { recommended: '4.2', unit: 'A' })).toMatchObject({ resolves: 'met', units: 'met', requirement: 'met', reasons: 'met' })
    expect(answerChecks({ ...d, option: '3.5' }, { recommended: '4.2' }).reasons).toBe('not_met')
  })
  it('lets an open question be answered in words, digits and all', () => {
    // no options and no quantity: a decision naming "2 errors at J1" needs no source, and every check can be met
    const d = { done: [], answer: 'Allow a silkscreen-only edit to clear the 2 errors at J1.', value: '', source: '', lasts: 'rule' as const }
    expect(Object.values(answerChecks(d, { options: [] })).every((x) => x === 'met')).toBe(true)
    // a number given for a quantity still says where it comes from
    expect(answerChecks({ ...d, answer: 'about 4 A' }, { unit: 'A', options: [] }).source).toBe('not_met')
  })
  it('does not resolve with an option that needs a detail until it is given (test-esp32 log #137)', () => {
    const d = { done: [], option: 'm', answer: '', value: '', source: '', lasts: 'once' as const }
    const o = { recommended: 'm', options: ['m', 'bare'], needs: { m: "the module's part number" } }
    expect(answerChecks(d, o).resolves).toBe('not_met')
    expect(answerChecks({ ...d, detail: 'tbd' }, o).resolves).toBe('not_met')
    expect(answerChecks({ ...d, detail: 'ER-OLEDM0.96-1' }, o).resolves).toBe('met')
    expect(answerChecks({ ...d, option: 'bare', reason: 'no module' }, o).resolves).toBe('met')
  })
  it('does not count a choice kept from an earlier question', () => {
    const d = { done: [], option: 'park', answer: '', value: '', source: '', lasts: 'once' as const }
    expect(answerChecks(d, { options: ['a', 'b'] }).resolves).toBe('not_met')
    expect(answerChecks({ ...d, option: 'a' }, { options: ['a', 'b'] }).resolves).toBe('met')
  })
  // test-esp32 #143: two near-identical questions share option ids; the second showed the first one's choice
  it('does not count a draft written for another question, even with the same option ids', () => {
    const d = { done: [], question: 'aq1967542f437743', option: 'a', answer: '', value: '', source: '', lasts: 'once' as const }
    expect(answerChecks(d, { options: ['a', 'b'], question: 'aq1967542f437743' })).toMatchObject({ resolves: 'met', requirement: 'met' })
    expect(answerChecks(d, { options: ['a', 'b'], question: 'aq00000000000002' })).toMatchObject({ resolves: 'not_met', requirement: 'not_met' })
  })
})

describe('bench readouts', () => {
  it('says out of limits at once', () => {
    expect(readoutState({ id: 'i', label: 'I', value: 0.2, unit: 'A', max: 0.15 })).toBe('out')
    expect(readoutState({ id: 'v', label: 'V', value: 3.3, unit: 'V', min: 3.25, max: 3.35 })).toBe('ok')
    expect(readoutState({ id: 'v', label: 'V', value: null, unit: 'V' })).toBe('none')
  })
})

describe('drafts', () => {
  it('say where to continue (New project keeps its own under drafts.<key>.<skill>)', () => {
    expect(draftKey('acme/soil-sensor', 'schematic-finish')).toBe('drafts.acme~soil-sensor.schematic-finish')
    expect(continueText({ name: 'Schematic finish', step: 3, steps: 6, savedAt: 0 })).toBe('Continue: Schematic finish, step 4 of 6')
  })
})

describe('traceability', () => {
  const row = (id: string, verdict: CoverageRow['verdict']): CoverageRow => ({ id, verdict, kind: 'functional', text: id, acceptance: null, status: 'accepted', tests: [] })
  it('colours a failing chain back to its intent line', () => {
    const l = layoutTrace([row('R-1', 'verified'), row('R-2', 'failing')], { intent: [{ id: 'I-1', topic: 'Purpose', text: 'p' }, { id: 'I-2', topic: 'Interfaces', text: 'i' }], links: [{ requirement: 'R-1', intent: 'I-1' }, { requirement: 'R-2', intent: 'I-2' }] })
    expect(l.intents.find((i) => i.id === 'I-2')!.failing).toBe(true)
    expect(l.intents.find((i) => i.id === 'I-1')!.failing).toBe(false)
  })
  it('counts every link of a requirement from several intent lines: none is "not covered" while it has one', () => {
    const t = { intent: [{ id: 'I-1', topic: 'Power', text: 'p' }, { id: 'I-2', topic: 'Interfaces', text: 'i' }, { id: 'I-3', topic: 'Build', text: 'b' }], links: [{ requirement: 'R-1', intent: 'I-1' }, { requirement: 'R-1', intent: 'I-2' }, { requirement: 'R-2', intent: 'I-2' }] }
    const l = layoutTrace([row('R-1', 'verified'), row('R-2', 'failing')], t)
    expect(l.intents.map((i) => [i.id, i.uncovered])).toEqual([['I-1', false], ['I-2', false], ['I-3', true]])
    expect(l.reqs.find((r) => r.row.id === 'R-1')).toMatchObject({ intent: 'I-1', intents: ['I-1', 'I-2'] })
    expect(l.intents.find((i) => i.id === 'I-2')!.failing).toBe(true)
  })
})

describe('project icon', () => {
  it('recommends the glyph its description names first', () => expect(recommendGlyph('A soil moisture sensor that reports over LoRa')).toBe('sensor'))
})

describe('Intent builder decisions', () => {
  it('an edit saved in the draft reads "Not submitted", not "Accepted", though the view lays it over the record (test-esp32 #22)', () => {
    // skill.get lays the draft's edit over the record, so the statement comes back accepted
    expect(statementBadge({ state: 'accepted' }, { choice: 'edit' })).toEqual({ status: 'yours', label: 'Not submitted' })
    expect(statementBadge({ state: 'accepted' }, { choice: 'accept' })).toEqual({ status: 'yours', label: 'Not submitted' })
    expect(statementBadge({ state: 'draft' }, { choice: 'edit' })).toEqual({ status: 'yours', label: 'Not submitted' })
    // a flag the new words still raise is shown over it
    expect(statementBadge({ state: 'needs_number', flag: 'Needs a number' }, { choice: 'edit' })).toEqual({ status: 'warning', label: 'Needs a number' })
    // accepted in the record, nothing in the draft
    expect(statementBadge({ state: 'accepted' })).toEqual({ status: 'met', label: 'Accepted' })
    expect(decidedNote('edit')).toBe('Rewording in your draft. Submit intent records it.')
  })

  it('Submit intent says it accepts the statements still in draft (test-esp32 #26)', () => {
    const statements = [{ id: 's1', state: 'accepted' as const }, { id: 's2', state: 'draft' as const }, { id: 's3', state: 'needs_number' as const }, { id: 's4', state: 'accepted' as const }, { id: 's5', state: 'draft' as const }]
    // s4 is accepted only in the draft (the view lays it over the record); s5 is reworded there
    const left = undecidedStatements(statements, [{ statement: 's4' }, { statement: 's5' }])
    expect(left).toEqual(['s2', 's3'])
    expect(intentSubmitLabel('Submit intent', left.length)).toBe('Submit intent (accepts 2 still in draft)')
    expect(intentSubmitLabel('Submit intent', 0)).toBe('Submit intent')
  })

  it('tells trace\'s chat the draft\'s decisions are not in the record yet (test-esp32 #22)', () => {
    const c = intentDraftContext([{ statement: 's5', choice: 'edit', text: 'Sleeps under 20 µA.' }], ['s2'])
    expect(c).toMatchObject({ submitted: false, decisions: [{ statement: 's5', choice: 'edit', words: 'Sleeps under 20 µA.' }], acceptedAtSubmit: ['s2'] })
    expect(c.note).toMatch(/not in the record/)
    expect(c).not.toHaveProperty('notedInDraft')
    // what trace noted in the draft, so it rewords one by its id rather than noting it twice (test log R5)
    expect(intentDraftContext([], [], [{ id: 'INT-000001', topic: 'power', text: 'USB 5 V.' }]).notedInDraft).toEqual([{ id: 'INT-000001', topic: 'power', words: 'USB 5 V.' }])
  })

  it('counts the panel\'s statements and the ones trace noted in the draft (test log R5: "0 statements · from the record")', () => {
    expect(draftCount(0, 0)).toBe('0 statements')
    expect(draftCount(3, 2)).toBe('3 statements · 2 noted in your draft')
    expect(draftCount(1, 1)).toBe('1 statement · 1 noted in your draft')
  })

  it('keeps one decision per statement in the draft, replaced or removed', () => {
    let d: { done: string[]; decisions?: Parameters<typeof withIntentDecision>[0]['decisions'] } = { done: ['purpose'] }
    d = withIntentDecision(d, 'INT-R4', { choice: 'reject', reason: 'superseded by the full USB-C power input statement' })
    d = withIntentDecision(d, 'INT-R4-interface', { choice: 'accept' })
    expect(d.decisions).toEqual([
      { statement: 'INT-R4', choice: 'reject', reason: 'superseded by the full USB-C power input statement' },
      { statement: 'INT-R4-interface', choice: 'accept' },
    ])
    d = withIntentDecision(d, 'INT-R4', { choice: 'edit', text: 'Works with USB-C chargers.' })
    expect(d.decisions?.find((x) => x.statement === 'INT-R4')).toEqual({ statement: 'INT-R4', choice: 'edit', text: 'Works with USB-C chargers.' })
    d = withIntentDecision(d, 'INT-R4', null)
    expect(d.decisions?.map((x) => x.statement)).toEqual(['INT-R4-interface'])
    expect(d.done).toEqual(['purpose'])
  })

  it('an interface edit sends only the fields the person changed, so the rest are read from the new words (test-esp32 #20)', () => {
    const shown = { type: 'I2C', connector: '4-pin header', rate: '400 kHz' }
    expect(changedFields(shown, { ...shown })).toBeUndefined()
    expect(changedFields(shown, { ...shown, rate: '400 kHz ', direction: ' out ', protocol: '' })).toEqual({ direction: 'out' })
    expect(changedFields(shown, { ...shown, connector: 'Qwiic' })).toEqual({ connector: 'Qwiic' })
  })
})

// #31: an intent line marked "don't care" showed as "not covered" in the diagram, and no check or item said why
describe('traceability: a line left out on purpose', () => {
  const row = (id: string): CoverageRow => ({ id, verdict: 'untested', kind: 'functional', text: id, acceptance: null, status: 'accepted', tests: [] })
  it('says "left out: don\'t care", or the reason it was left out with, not "not covered"', () => {
    const t = {
      intent: [
        { id: 'I-1', topic: 'Power', text: 'p', kind: 'statement' as const },
        { id: 'I-2', topic: 'Compliance', text: 'c', kind: 'dont_care' as const },
        { id: 'I-3', topic: 'Physical', text: 'b', kind: 'statement' as const, uncovered: 'Checked by Board setup against the outline.' },
        { id: 'I-4', topic: 'Build', text: 'x', kind: 'statement' as const },
      ],
      links: [{ requirement: 'R-1', intent: 'I-1' }],
    }
    const l = layoutTrace([row('R-1')], t)
    expect(l.intents.map((i) => [i.id, i.uncovered, i.left])).toEqual([
      ['I-1', false, undefined], ['I-2', false, "don't care"], ['I-3', false, 'Checked by Board setup against the outline.'], ['I-4', true, undefined],
    ])
  })
})

// #10: with no intent statement recorded, the panel drew each check's reason in a column beside its name, so the name
// wrapped a word a line, and all seven said the same reason. The name has its own line; a shared reason is said once
describe('the Draft intent panel\'s quality bar', () => {
  const def = SKILLS.find((d) => d.id === 'intent-builder')!
  const NONE = 'No intent statements are recorded yet: answer the topics and trace drafts them.'

  it('gives each check its name and reason apart', () => {
    const c = qualityChecks(def, { checks: [{ id: 'vague', status: 'not_met', detail: '1 left' }, { id: 'conflicts', status: 'met' }] })
    expect(c.find((x) => x.id === 'vague')).toMatchObject({ name: 'No vague words', detail: '1 left', text: 'No vague words (1 left)' })
    expect(c.find((x) => x.id === 'conflicts')!.detail).toBeUndefined()
  })

  it('says a reason every check shares once, under the list, each name on its own line', () => {
    const checks = qualityChecks(def, { checks: checksOf(def).map((x) => ({ id: x.id, status: 'not_met' as const, detail: NONE })) })
    render(<IntentQualityList checks={checks} topic={0} />)
    expect(screen.getAllByText(NONE)).toHaveLength(1)
    const name = screen.getByText('Every topic answered or marked')
    expect(name.tagName).toBe('P')
    expect(name.textContent).toBe('Every topic answered or marked')
  })

  it('puts a check\'s own reason under its name', () => {
    const checks = qualityChecks(def, { checks: [{ id: 'vague', status: 'not_met', detail: '1 left' }, { id: 'interfaces', status: 'not_met', detail: 's6 lacks protocol' }] })
    render(<IntentQualityList checks={checks} topic={0} />)
    const name = screen.getByText('No vague words')
    expect(name.nextElementSibling).toHaveTextContent('1 left')
  })
})
