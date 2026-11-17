/** The three states a person sorts changes by (docs/ui-simplify.md, "Changes"). */
import { describe, expect, it } from 'vitest'
import { countStates, summaryLine } from '@/routes/_app/p/$id/changes/index'
import type { ChangeSummary } from './types'
import { changeState } from './guided'

const c = (o: Partial<ChangeSummary>): ChangeSummary => ({ verdict: 'ready', ...o }) as ChangeSummary

describe('changeState', () => {
  it('is yours when it waits for a person: to review, or to ask for a fix', () => {
    expect(changeState(c({ verdict: 'ready' }))).toBe('yours')
    expect(changeState(c({ verdict: 'failing' }))).toBe('yours')
    expect(changeState(c({ verdict: 'unfinished' }))).toBe('yours')
  })

  it("is trace's while trace makes, checks, updates or applies it", () => {
    for (const verdict of ['checking', 'applying', 'conflict'] as const) expect(changeState(c({ verdict }))).toBe('trace')
    // its job is still at it, whatever its checks say
    expect(changeState(c({ verdict: 'ready', working: true }))).toBe('trace')
    expect(changeState(c({ verdict: 'failing', working: true }))).toBe('trace')
    // an answer trace is applying; one trace will not apply on its own is the person's
    expect(changeState(c({ verdict: 'unfinished', answers: [{}] as ChangeSummary['answers'] }))).toBe('trace')
    expect(changeState(c({ verdict: 'unfinished', answers: [{ stopped: 'the job was cancelled' }] as ChangeSummary['answers'] }))).toBe('yours')
  })

  it('is blocked when it waits on something else: the change it builds on, or checks that cannot start', () => {
    expect(changeState(c({ verdict: 'blocked' }))).toBe('blocked')
    expect(changeState(c({ verdict: 'checking', stuck: { why: 'no runner' } as ChangeSummary['stuck'] }))).toBe('blocked')
  })

  it('counts each state and says them in one line', () => {
    const xs = [c({}), c({}), c({ verdict: 'checking' }), c({ verdict: 'blocked' })]
    expect(countStates(xs)).toEqual({ yours: 2, trace: 1, blocked: 1 })
    expect(summaryLine(countStates(xs), xs.length)).toBe('4 open changes: 2 for you, 1 with trace, 1 blocked.')
    expect(summaryLine(countStates([]), 0)).toBe('No open changes.')
  })
})
