/**
 * Who the next step waits on (src/api/waits-on.ts, test-esp32 log #146, #147). In run 2 the Overview said "trace is
 * working on Layout" while nothing of trace's was: the design rule check's criterion waited on two waivers, a
 * person's, and two changes waited on checks no runner would start. The step now says who it waits on.
 */
import { describe, expect, it } from 'vitest'
import type { GateView, NextStep, StageView } from '../../src/core/journey.js'
import type { JobRow } from '../../src/core/job-index.js'
import { stuckView } from '../../src/api/stuck-checks.js'
import { findingsOf, waitsOn, waitsOnSteps, workingNow } from '../../src/api/waits-on.js'

const AT = Date.parse('2026-11-05T07:00:00Z') / 1000
const iso = (s: number): string => new Date(s * 1000).toISOString()
const REFUSED = 'GitHub rejected the runner credential because it lacks the required permission (administration=write). Re-authorize the CodeConnections connection'

// the step journey.get had in run 2: trace's criterion, as if trace were working on it
const working: NextStep = {
  kind: 'working', belongs_to: 'trace', yours: false, summary: 'trace is working on Layout: the design rule check is clean, or each finding is waived.',
  why: 'The layout gate needs it (3 of 5 criteria met).', recommendation: null, button: 'Watch', stage: 'layout',
  ref: { kind: 'criterion', id: 'layout.drc' }, step: { index: 2, total: 6 }, after: 'When trace has done this, trace works on the next criterion: the board fits its enclosure.',
}
const criterion = (o: Partial<GateView['criteria'][number]> = {}): GateView['criteria'][number] => ({
  id: 'layout.drc', text: 'The design rule check is clean, or each finding is waived.', owner: 'trace', status: 'not_met', evidence_label: null, waiver: null, opened_by_you: false, checked_at: null,
  evidence: [{ kind: 'run', ref: 'run-7a99' }, { kind: 'finding', ref: 'drc:J1', label: 'lib_footprint_mismatch J1' }, { kind: 'finding', ref: 'drc:U1', label: 'lib_footprint_mismatch U1' }], ...o,
})
const gates = [{ criteria: [criterion()] }]
const stuck = stuckView({ runs: 1, since: iso(AT - 20 * 3600) }, { project: 'trace-ci-213dfa1f', builds: [{ at: iso(AT - 60), status: 'FAILED', phase: 'DOWNLOAD_SOURCE', message: REFUSED }] }, AT)
const changes = [
  { number: 20, title: 'Docs record', state: 'open' as const, checks: { total: 2, passed: 0, failed: 0, running: 2, skipped: 0, failing: [] }, stuck },
  { number: 22, title: 'Case', state: 'open' as const, checks: { total: 2, passed: 0, failed: 0, running: 2, skipped: 0, failing: [] }, stuck: { ...stuck, since: iso(AT - 13 * 3600) } },
]
const admin = { admin: true, part: null }
const contributor = { admin: false, part: 'contributor' as const }

describe('who the next step waits on', () => {
  it('nothing of trace\'s working, and the check found things: the person waives them or asks for a fix (#147)', () => {
    const w = waitsOn(working, { changes: [], working: 0, gates, viewer: contributor, at: AT })
    expect(w.owner).toBe('you')
    expect(w.step).toMatchObject({
      kind: 'task', belongs_to: 'you', yours: true, ref: { kind: 'criterion', id: 'layout.drc' }, button: 'See the findings',
      summary: 'Layout: waive the 2 findings on "The design rule check is clean, or each finding is waived", or ask trace to fix them.',
    })
    expect(w.step.why).toMatch(/^trace is not working on it now/)
    // and the checks that cannot start are said too, for the admin to fix
    expect(waitsOn(working, { changes, working: 0, gates, viewer: contributor, at: AT }).step.why).toMatch(/Separately, the checks of changes #20 and #22 cannot start: the CodeBuild runner cannot get a GitHub runner token/)
  })

  it('checks that cannot start: an admin\'s step, with what to do and "Run the checks again" (#146)', () => {
    const none = [{ criteria: [criterion({ evidence: [] })] }]
    const a = waitsOn(working, { changes, working: 0, gates: none, viewer: admin, at: AT })
    expect(a.owner).toBe('you')
    expect(a.step).toMatchObject({ kind: 'task', belongs_to: 'you', yours: true, button: 'Run the checks again', ref: { kind: 'action', id: 'changes.rerun_stuck' } })
    expect(a.step.summary).toBe(`Checks cannot start: ${stuck.why}. ${stuck.fix}`)
    expect(a.step.why).toBe('Changes #20 and #22 have waited 20 hours for their checks. Nothing checks them until the runner is fixed, so Layout waits.')
    // anyone else is told it is an admin's, and reads the change
    const c = waitsOn(working, { changes, working: 0, gates: none, viewer: contributor, at: AT })
    expect(c.owner).toBe('admins')
    expect(c.step).toMatchObject({ belongs_to: 'admins', yours: false, button: 'Read the change', ref: { kind: 'change', id: '20' } })
    // even while a job of trace's runs elsewhere: nothing but an admin fixes the runner
    expect(waitsOn(working, { changes, working: 1, gates, viewer: admin, at: AT }).step.ref).toEqual({ kind: 'action', id: 'changes.rerun_stuck' })
  })

  it('nothing working and checks running: it waits on those checks, not on trace', () => {
    const running = changes.map(({ stuck: _s, ...c }) => c)
    const w = waitsOn(working, { changes: running, working: 0, gates: [{ criteria: [criterion({ evidence: [] })] }], viewer: admin, at: AT })
    expect(w.step.summary).toBe('Waiting for the checks of changes #20 and #22 to finish: no job of trace\'s is working on Layout now.')
    expect(w.owner).toBeNull()
  })

  it('a job of trace\'s working on it, or a step that is not trace\'s, stays as it is', () => {
    expect(waitsOn(working, { changes: [], working: 1, gates, viewer: admin, at: AT }).step).toBe(working)
    const review: NextStep = { ...working, kind: 'review', belongs_to: 'you', yours: true, ref: { kind: 'change', id: '18' } }
    expect(waitsOn(review, { changes, working: 0, gates, viewer: admin, at: AT }).step).toBe(review)
    const lost: NextStep = { ...working, kind: 'task', ref: { kind: 'action', id: 'job.restart' } }
    expect(waitsOn(lost, { changes, working: 0, gates, viewer: admin, at: AT }).step).toBe(lost)
  })

  it('a met or waived criterion has no findings to waive', () => {
    expect(findingsOf(gates, 'layout.drc')).toEqual({ text: criterion().text, findings: 2 })
    expect(findingsOf([{ criteria: [criterion({ status: 'waived' })] }], 'layout.drc')).toBeNull()
    expect(findingsOf(gates, 'layout.fit')).toBeNull()
  })

  it('the stage\'s step "now" is shown as the person\'s, not "trace · now"', () => {
    const stages = [{ steps: [{ id: 'layout.drc', text: 'DRC', owner: 'trace', state: 'now', ref: null }, { id: 'sign', text: 'Sign', owner: 'admins', state: 'next', ref: null }] }] as Pick<StageView, 'steps'>[]
    expect(waitsOnSteps(stages, 'you')[0]!.steps.map((s) => `${s.owner}:${s.state}`)).toEqual(['you:now', 'admins:next'])
    expect(waitsOnSteps(stages, null)).toEqual(stages)
  })

  it('counts queued and live jobs only: a paused or lost one is not working', () => {
    const row = (state: string, beatAt: number | null): JobRow => ({ id: state, state, kind: 'task', parentJob: null, beatAt, startedAt: AT - 600, updatedAt: AT - 600 } as unknown as JobRow)
    expect(workingNow([row('queued', null), row('running', AT - 10), row('running', AT - 3 * 3600), row('paused', null), row('succeeded', null)], AT)).toBe(2)
  })
})
