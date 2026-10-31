import { describe, expect, it } from 'vitest'
import type { CoverageRow } from '@/lib/types-s1'
import { layoutTrace } from '@/components/project/traceability'
import { recommendGlyph } from '@/components/project/project-icon'
import { readoutState } from './checklist-skill'
import { answerChecks, withIntentDecision } from './conversation-skills'
import { SKILLS, checksOf, pictureOf } from './definitions'
import { continueText, draftKey } from './draft'
import { changeChecks, waiverChecks, type WaiverDraft } from './form-skills'
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
  it('refuses "it depends" and wants a number for a quantity', () => {
    const d = { done: [], answer: 'it depends', value: '', source: '', lasts: '' as const }
    expect(answerChecks({ ...d, option: 'other' }, { unit: 'A' }).resolves).toBe('not_met')
    expect(answerChecks({ ...d, option: 'other', answer: 'Stall current', value: '' }, { unit: 'A' }).units).toBe('not_met')
    expect(answerChecks({ ...d, option: '4.2', lasts: 'once' }, { recommended: '4.2', unit: 'A' })).toMatchObject({ resolves: 'met', units: 'met', requirement: 'met', reasons: 'met' })
    expect(answerChecks({ ...d, option: '3.5' }, { recommended: '4.2' }).reasons).toBe('not_met')
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
})

describe('project icon', () => {
  it('recommends the glyph its description names first', () => expect(recommendGlyph('A soil moisture sensor that reports over LoRa')).toBe('sensor'))
})

describe('Intent builder decisions', () => {
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
})
