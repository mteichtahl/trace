/**
 * The gate page's waivers and evidence, from the test-esp32 run:
 *   #156  "Every connection is routed. Met (4 waived)": the stage's four waivers put on the first criterion
 *   #157  ratings shown as "Major" and "Degraded", safety and failure alike, not in the Waiver form's words
 *   #155  a waiver titled by its raw, URL-escaped finding id
 *   #129  an evidence chip whose sheet said only "Evidence cited here."
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Gate, Waiver } from '@/lib/types'
import { READERS } from '@/lib/readers'
import { chipSummary, runOfChip } from './evidence-chip'
import { criterionStatusLabel, criterionWaivers, waiverCriterion } from './skills/gate-rules'
import { RATINGS, WaiverRating } from './waiver-rating'

const w = (id: string, target: Waiver['target'], risk: Waiver['risk'] = 'degraded', more: Partial<Waiver> = {}): Waiver => ({ id, title: id, reason: 'r', risk, caught: 'bench', target, ...more })

// the Layout gate of the run: two waivers on the design rule check, two on the case fit, none on routing
const layout: Pick<Gate, 'criteria' | 'waivers'> = {
  criteria: [
    { id: 'layout.route', text: 'Every connection is routed.', status: 'met' },
    { id: 'layout.drc', text: 'The design rule check is clean, or each finding is waived.', status: 'met' },
    { id: 'layout.fit', text: 'The board fits its enclosure.', status: 'met' },
  ],
  waivers: [
    w('J1', { kind: 'finding', id: 'drc:lib_footprint_mismatch:J1' }, 'safety'),
    w('U1', { kind: 'finding', id: 'drc:lib_footprint_mismatch:U1' }, 'failure'),
    w('F1', { kind: 'finding', id: 'layout.fit@urn:trace:trace:mteichtahl%2Ftest-esp32-e2e:requirement:REQ-8fc402' }),
    w('F2', { kind: 'finding', id: 'layout.fit@urn:trace:trace:mteichtahl%2Ftest-esp32-e2e:case-finding:Q1' }),
  ],
}

describe('each criterion counts its own waivers (#156)', () => {
  it('routing has none; the rule check and the case fit two each', () => {
    expect(layout.criteria.map((c) => criterionStatusLabel(c, layout))).toEqual(['Met', 'Met (2 waived)', 'Met (2 waived)'])
  })
  it('a requirement waiver counts for no criterion, a withdrawn one for none, and journey.get\'s word wins', () => {
    expect(waiverCriterion(w('R', { kind: 'requirement', id: 'REQ-1' }))).toBeNull()
    expect(criterionWaivers({ waivers: [w('X', { kind: 'criterion', id: 'layout.route' }, 'degraded', { closed: true })] }, 'layout.route')).toEqual([])
    expect(waiverCriterion(w('M', { kind: 'finding', id: 'erc:x:U2' }, 'degraded', { criterion: 'c1' }))).toBe('c1')
    expect(criterionStatusLabel({ id: 'c', status: 'waived' }, layout)).toBe('Met (waived)')
    expect(criterionStatusLabel({ id: 'layout.drc', status: 'not_met' }, layout)).toBe('Not met')
  })
})

describe('a waiver\'s rating, in the form\'s words (#157)', () => {
  it('shows the rating the person chose, each of the four in its own style', () => {
    const { container } = render(<>{RATINGS.map((r) => <WaiverRating key={r.id} rating={r.id} />)}</>)
    expect(RATINGS.map((r) => screen.getByText(r.label).textContent)).toEqual(['Cosmetic', 'Degraded', 'Failure', 'Safety'])
    const looks = [...container.querySelectorAll('[data-rating]')].map((e) => e.className)
    expect(new Set(looks).size).toBe(4)
    expect(screen.queryByText(/Major|Minor/)).toBeNull()
  })
  it('journey.get\'s severity is read as given, not folded into another scale', () => {
    const read = (severity: string) => (READERS['journey.get']!({ repo: 'a/b', current_stage: 'layout', gates: [], stages: [], waivers: [{ id: 'w', severity, target: { kind: 'finding', id: 'drc:x:J1' } }] }, { repo: 'a/b' }) as { waivers: Waiver[] }).waivers[0]!.risk
    expect(['cosmetic', 'degraded', 'failure', 'safety'].map(read)).toEqual(['cosmetic', 'degraded', 'failure', 'safety'])
  })
})

describe('a waiver is titled in plain words (#155)', () => {
  it('takes journey.get\'s words, with the criterion it counts for', () => {
    const j = READERS['journey.get']!({ repo: 'a/b', current_stage: 'layout', gates: [], stages: [], waivers: [{ id: 'w', severity: 'cosmetic', about: 'the finding of “The board fits its enclosure” on requirement REQ-8fc402', criterion: 'layout.fit', target: { kind: 'finding', id: 'layout.fit@urn:trace:x:a%2Fb:requirement:REQ-8fc402' } }] }, { repo: 'a/b' }) as { waivers: Waiver[] }
    expect(j.waivers[0]).toMatchObject({ title: 'The finding of “The board fits its enclosure” on requirement REQ-8fc402', criterion: 'layout.fit' })
    expect(j.waivers[0]!.title).not.toMatch(/%2F|urn:/)
  })
})

describe('an evidence chip opens on what it cites (#129)', () => {
  it('a run chip opens the run itself, in its project', () => {
    expect(runOfChip({ kind: 'run', id: 'run-r1', to: '/p/mteichtahl~test-esp32-e2e/runs/run-r1' })).toEqual({ repo: 'mteichtahl/test-esp32-e2e', id: 'run-r1' })
    expect(runOfChip({ kind: 'datasheet', id: 'U1' })).toBeNull()
  })
  it('anything else says what it is, never "Evidence cited here." alone', () => {
    expect(chipSummary({ kind: 'datasheet', label: 'U1 datasheet', id: 'AMS1117' })).toBe('trace cited a datasheet (AMS1117) without saying what it shows.')
    expect(chipSummary({ kind: 'record', label: 'x', summary: 'Intent coverage: 10 of 10.' })).toBe('Intent coverage: 10 of 10.')
  })
})
