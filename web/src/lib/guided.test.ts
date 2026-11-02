/**
 * The guided flow's reading: the new journey fields (stage guide, steps, the next step's place and after line), the
 * change actions' answers (tolerant of an older or partial API), and the step and "now" logic the screens draw.
 */
import { describe, expect, it } from 'vitest'
import { READERS, changeWords, readChange, readChangeDiff, readChanges, readGuide, readJourney, readSteps, splitRecommendation, verdictOf } from './readers'
import { changeLine, changeOf, checksWords, currentStage, decisionMode, gateMeter, nextPlace, ownerWord, stageSteps, stepLabel, stepPlace, stepWords } from './guided'
import type { Gate, Journey, Stage, StageStep } from './types'

const stage = (id: string, state: Stage['state'], extra: Partial<Stage> = {}): Stage => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), state, criteria: { met: 0, total: 0 }, ...extra })
const gate = (after: string, statuses: ('met' | 'not_met' | 'waived')[], state: Gate['state'] = 'open'): Gate => ({
  id: after, name: `the ${after} gate`, after, state, waivers: [], criteria: statuses.map((s, i) => ({ id: `c${i + 1}`, text: `Criterion ${i + 1}`, status: s })),
})

describe('reading the guided flow from journey.get', () => {
  const raw = {
    repo: 'acme/x', name: 'X', template: 'board', revision: 'A', current_stage: 'capture',
    stages: [
      { id: 'define', name: 'Define', state: 'done', met: 2, total: 2 },
      {
        id: 'capture', name: 'Capture', state: 'current', met: 1, total: 2,
        guide: { purpose: 'Draw the schematic.', you_do: 'Review sheets.', trace_does: 'Drafts sheets.', you_get: 'A schematic.', typical_time: '2 to 4 days', next: 'Prove: simulate.' },
        steps: [
          { id: 's1', text: 'trace drafts the sheets', owner: 'trace', state: 'done', ref: null },
          { id: 's2', text: 'Review the power sheet', owner: 'you', state: 'now', ref: { kind: 'change', id: '12' } },
          { id: 's3', text: 'Stock check', owner: 'robot', state: 'soon', ref: { kind: 'nonsense', id: 'x' } },
          { id: 's4', text: 'Sign the schematic gate', owner: 'admins', state: 'later', ref: { kind: 'gate', id: 'capture' } },
        ],
      },
    ],
    gates: [{ id: 'capture', name: 'schematic', title: 'the schematic gate', stage: 'capture', state: 'open', criteria: [] }],
    next: {
      kind: 'review', belongs_to: 'you', yours: true, summary: 'trace finished the power sheet. Review it and accept it into the design.', why: '',
      recommendation: 'trace recommends accepting it. All 7 checks passed.', button: 'Review the change', stage: 'capture', ref: { kind: 'change', id: '12' },
      step: { index: 2, total: 4 }, after: 'After you accept: trace checks stock.',
    },
    questions: [], waivers: [], decisions: [],
  }

  it('gives each stage its guide and steps, with addresses for changes and gates', () => {
    const j = readJourney(raw)
    const cap = j.stages[1]!
    expect(cap.guide).toMatchObject({ purpose: 'Draw the schematic.', typical_time: '2 to 4 days', next: 'Prove: simulate.' })
    expect(cap.steps!.map((s) => [s.owner, s.state])).toEqual([['trace', 'done'], ['you', 'now'], ['contributors', 'later'], ['admins', 'later']])
    expect(cap.steps![1]!.to).toBe('/p/acme~x/changes/12')
    expect(cap.steps![2]!.ref).toBeNull()
    expect(cap.steps![3]!.to).toBe('/p/acme~x/gates/capture')
    // a stage the API gives nothing for has neither
    expect(j.stages[0]!.guide).toBeUndefined()
    expect(j.stages[0]!.steps).toBeUndefined()
  })

  it('reads the review next step: its place, the recommendation split from its reason, the after line and the change it opens', () => {
    const n = readJourney(raw).next
    expect(n).toMatchObject({ kind: 'review', owner: 'you', step: { index: 2, total: 4 }, after: 'After you accept: trace checks stock.', ref: { kind: 'change', id: '12' } })
    expect(n.action).toEqual({ label: 'Review the change', to: '/p/acme~x/changes/12' })
    expect(n.recommend).toEqual({ text: 'trace recommends accepting it.', why: 'All 7 checks passed.' })
    expect(n.lead).toBe('trace finished the power sheet. Review it and accept it into the design.')
    expect(changeOf(n)).toBe(12)
  })

  it('an older answer (no step, after, guide or steps) still reads', () => {
    const old = readJourney({ ...raw, stages: [{ id: 'capture', name: 'Capture', state: 'current', met: 1, total: 2 }], next: { kind: 'task', belongs_to: 'you', yours: true, summary: 'Do it.', button: 'Go' } })
    expect(old.next.step).toBeNull()
    expect(old.next.after).toBeNull()
    expect(old.next.recommend).toBeUndefined()
    expect(old.stages[0]!.steps).toBeUndefined()
  })

  it('says when GitHub could not be reached', () => {
    expect(readJourney({ ...raw, changes_unavailable: 'GitHub did not answer' }).changesUnavailable).toBe('GitHub did not answer')
    expect(readJourney(raw).changesUnavailable).toBeUndefined()
  })

  it('a guide needs its purpose; steps need their text', () => {
    expect(readGuide({ you_do: 'x' })).toBeUndefined()
    expect(readGuide({ purpose: 'P' })).toEqual({ purpose: 'P', you_do: '', trace_does: '', you_get: '', typical_time: '', next: null })
    expect(readSteps('nope')).toBeUndefined()
    expect(readSteps([{ owner: 'you' }, { text: 'T' }])).toEqual([{ id: 'step-1', text: 'T', owner: 'contributors', state: 'later', ref: null }])
  })

  it('splits a recommendation only when it starts with trace recommends', () => {
    expect(splitRecommendation('trace recommends signing. All met.')).toEqual({ text: 'trace recommends signing.', why: 'All met.' })
    expect(splitRecommendation('Use 4.2 A', 'From the datasheet.')).toEqual({ text: 'Use 4.2 A', why: 'From the datasheet.' })
  })
})

describe('reading the change actions', () => {
  const summary = {
    number: 12, title: 'Power and USB-C input sheet', url: 'https://github.com/acme/x/pull/12', draft: false, held: true, from: 'the schematic specialist',
    job_id: 'j', stage: 'capture', opened_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:05:00Z', state: 'open', mergeable: 'clean',
    checks: { total: 7, passed: 7, failed: 0, running: 0, skipped: 0, failing: [] }, verdict: 'ready',
  }

  it('changes.list: the changes, oldest first', () => {
    const r = readChanges({ repo: 'acme/x', changes: [{ ...summary, number: 13, opened_at: '2026-11-01T11:00:00Z' }, summary] })
    expect(r.changes.map((c) => c.number)).toEqual([12, 13])
    expect(READERS['changes.list']!({ changes: [] }, { repo: 'acme/x' })).toEqual({ repo: 'acme/x', changes: [] })
  })

  it('change.get: a full answer, and a partial one with may_accept false and empty lists', () => {
    const full = readChange({
      ...summary, summary: ['Added a USB-C input.'], requirements: ['R4'], may_accept: true, blockers: [],
      files: [{ path: 'power.kicad_sch', status: 'modified', additions: 14, deletions: 0, kind: 'schematic' }, { path: 'x.bin', status: 'weird', kind: 'weird' }],
      checks_list: [{ name: 'ERC', state: 'passed', summary: 'clean' }], recommendation: { verdict: 'accept', why: 'All passed.' },
      base: { ref: 'main', sha: 'a' }, head: { ref: 'claude/x', sha: 'b' },
    })
    expect(full).toMatchObject({ number: 12, may_accept: true, requirements: ['R4'], recommendation: { verdict: 'accept', why: 'All passed.' } })
    expect(full.files[1]).toEqual({ path: 'x.bin', status: 'modified', additions: 0, deletions: 0, kind: 'binary' })
    const partial = readChange({ number: 5, title: 'T' })
    expect(partial).toMatchObject({ number: 5, state: 'open', may_accept: false, files: [], checks_list: [], blockers: [], summary: [], recommendation: { verdict: 'none', why: '' }, checks: null, from: 'a trace job' })
    // only a GitHub link is kept for View on GitHub
    expect(readChange({ ...summary, url: 'https://evil.example/x' }).url).toBe('')
  })

  it('the pill is the API\'s word, else worked out from the checks and mergeable state', () => {
    expect(verdictOf({ checks: null, mergeable: 'clean', verdict: 'conflict' })).toBe('conflict')
    expect(verdictOf({ checks: { total: 2, passed: 1, failed: 1, running: 0, skipped: 0, failing: ['ERC'] }, mergeable: 'clean' })).toBe('failing')
    expect(verdictOf({ checks: { total: 2, passed: 1, failed: 0, running: 1, skipped: 0, failing: [] }, mergeable: 'unknown' })).toBe('checking')
    expect(verdictOf({ checks: null, mergeable: 'dirty' })).toBe('conflict')
    expect(verdictOf({ checks: null, mergeable: 'clean' })).toBe('ready')
    expect(verdictOf({ checks: null, mergeable: 'blocked' })).toBe('blocked')
  })

  it('change.diff: both sides, a renamed file\'s old path, and an added file', () => {
    expect(readChangeDiff({ path: 'b.md', kind: 'text', patch: '@@', before: { ref: 'a1', path: 'a.md' }, after: { ref: 'b2' }, binary: false }))
      .toEqual({ path: 'b.md', kind: 'text', patch: '@@', before: { ref: 'a1', path: 'a.md' }, after: { ref: 'b2' }, binary: false })
    expect(readChangeDiff({ path: 'n.md', kind: 'text', before: null, after: { ref: 'b2' } })).toMatchObject({ before: null, patch: null, binary: false })
  })
})

describe('the steps and the now-step', () => {
  it('works steps out from the gate when the API gives none: met done, first open now, the next next, then the signature', () => {
    const s = stageSteps(stage('capture', 'current'), gate('capture', ['met', 'waived', 'not_met', 'not_met']))
    expect(s.map((x) => [x.text, x.state])).toEqual([['Criterion 1', 'done'], ['Criterion 2', 'waived'], ['Criterion 3', 'now'], ['Criterion 4', 'next'], ['Sign the capture gate', 'later']])
    expect(s[4]!.owner).toBe('admins')
    expect(stageSteps(stage('capture', 'current'), gate('capture', ['met']), { admin: true })[1]).toMatchObject({ owner: 'you', state: 'now' })
    expect(stepPlace(s)).toEqual({ index: 3, total: 5 })
  })

  it('a done stage has every step done; a queued one has none now', () => {
    expect(stageSteps(stage('define', 'done'), gate('define', ['not_met'], 'signed')).every((x) => x.state === 'done')).toBe(true)
    expect(stageSteps(stage('prove', 'queued'), gate('prove', ['not_met'])).some((x) => x.state === 'now')).toBe(false)
  })

  it('uses the API\'s steps as they are', () => {
    const steps: StageStep[] = [{ id: 'a', text: 'A', owner: 'trace', state: 'done', ref: null }, { id: 'b', text: 'B', owner: 'you', state: 'now', ref: null }]
    expect(stageSteps(stage('capture', 'current', { steps }), gate('capture', ['not_met']))).toBe(steps)
  })

  it('"Step 3 of 5 in Capture": the API\'s place first, else the worked-out one', () => {
    const j = { stages: [stage('define', 'done'), stage('capture', 'current')], gates: [gate('capture', ['met', 'not_met'])], next: { kind: 'task', owner: 'you', summary: '' } } as unknown as Journey
    expect(nextPlace(j)).toEqual({ index: 2, total: 3, stage: 'Capture' })
    expect(stepWords(nextPlace({ ...j, next: { ...j.next, step: { index: 3, total: 5 } } }))).toBe('Step 3 of 5 in Capture')
    expect(nextPlace({ ...j, stages: [stage('define', 'done')] })).toBeNull()
    expect(currentStage(j)).toMatchObject({ index: 1, total: 2 })
  })

  it('labels each step with who and when', () => {
    const steps: StageStep[] = [
      { id: '1', text: '', owner: 'trace', state: 'done', ref: null }, { id: '2', text: '', owner: 'person', who: 'Priya', state: 'done', ref: null },
      { id: '3', text: '', owner: 'you', state: 'now', ref: null }, { id: '4', text: '', owner: 'trace', state: 'next', ref: null },
      { id: '5', text: '', owner: 'admins', state: 'later', ref: null },
    ]
    expect(steps.map((_, i) => stepLabel(steps, i))).toEqual(['trace · done', 'Priya · done', 'You · now', 'trace · after you', 'An admin'])
    expect(ownerWord({ owner: 'contributors' })).toBe('A contributor')
  })

  it('the gate meter counts waived criteria as met', () => {
    expect(gateMeter(gate('capture', ['met', 'waived', 'not_met', 'not_met']), stage('capture', 'current'))).toEqual({ met: 2, total: 4, frac: 0.5 })
    expect(gateMeter(undefined, stage('capture', 'current', { criteria: { met: 1, total: 3 } }))).toMatchObject({ met: 1, total: 3 })
  })
})

describe('changes in words, and what the decision bar may do', () => {
  const c = { total: 7, passed: 4, failed: 0, running: 3, skipped: 0, failing: [] }
  it('says the checks plainly', () => {
    expect(checksWords({ ...c, passed: 7, running: 0 })).toBe('7 checks passed')
    expect(checksWords(c)).toBe('Checks running, 4 of 7 done')
    expect(checksWords({ ...c, failed: 1, running: 0, failing: ['ERC'] })).toBe('1 check failing: ERC')
    expect(checksWords(null)).toBe('No checks yet')
    expect(changeLine({ verdict: 'conflict', checks: null } as never)).toMatch(/trace will bring it up to date/)
  })

  it('decisionMode: reviewers read only; a closed change is closed; may_accept decides the rest', () => {
    expect(decisionMode({ state: 'open', may_accept: true }, 'reviewer')).toBe('read-only')
    expect(decisionMode({ state: 'merged', may_accept: true }, 'contributor')).toBe('closed')
    expect(decisionMode({ state: 'open', may_accept: false }, 'contributor')).toBe('blocked')
    expect(decisionMode({ state: 'open', may_accept: true }, undefined)).toBe('ready')
  })
})

describe('"pull request" becomes "change" where people read', () => {
  it('rewrites an older API\'s review summary', () => {
    expect(changeWords('Soil: The Schematic agent opened pull request #12, "Power sheet" (a draft). Its work counts once it is merged.'))
      .toBe('Soil: The Schematic agent finished "Power sheet" (a draft). Review it and accept it into the design.')
    expect(changeWords('Two pull requests wait')).toBe('Two changes wait')
    expect(changeWords('Nothing to rename')).toBe('Nothing to rename')
  })
})
