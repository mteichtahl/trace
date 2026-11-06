/**
 * Checks no runner picks up (test-esp32 log #146, #147): the change card, the review page's bar and the overview's next
 * step say the checks cannot start, why, and what an admin does, never "Checks running" or "trace is working"; "Run the
 * checks again" cancels and runs them again (change.rerun, changes.rerun_stuck), in the mock as in the API.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { handle } from '@/mock/handlers'
import { changeLine } from '@/lib/guided'
import { readChanges } from '@/lib/readers'
import type { ChangeDetail, ChangeSummary, Journey, StuckChecks } from '@/lib/types'
import { ChecksBadge, changeMeta } from './changes-list'
import { DecisionBar, offersRerun } from './decision-bar'

const stuck: StuckChecks = {
  runs: 2, since: '2026-11-04T10:42:00Z', runner: 'trace-ci-213dfa1f', connection: true,
  why: 'the CodeBuild runner cannot get a GitHub runner token, because its GitHub connection lacks administration access',
  fix: 'An admin re-authorizes the GitHub connection with administration access. trace then runs the stuck checks again itself.',
}
const card = {
  number: 20, title: 'Docs record', url: 'u', draft: false, held: false, from: 'the docs specialist', job_id: null, stage: 'layout', opened_at: '2026-11-04T10:40:00Z', updated_at: '2026-11-04T10:42:00Z',
  state: 'open', mergeable: 'blocked', checks: { total: 2, passed: 0, failed: 0, running: 2, skipped: 0, failing: [] }, verdict: 'blocked', stuck,
} satisfies ChangeSummary

describe('a change whose checks cannot start', () => {
  it('the card says why and who fixes it, never "Checks running, 0 of 2 done"', () => {
    const line = `Checks cannot start: ${stuck.why}. An admin re-authorizes the GitHub connection; the change says how.`
    expect(changeLine(card)).toBe(line)
    expect(changeMeta(card)).toBe(line)
    // without it, as before
    expect(changeLine({ ...card, stuck: undefined, verdict: 'checking' })).toBe('Checks running, 0 of 2 done. Ready to review when the last one finishes.')
  })

  it('changes.list keeps it, so the card can say it; an answer without its words says nothing', () => {
    expect(readChanges({ repo: 'acme/board', changes: [card] }).changes[0]?.stuck).toEqual(stuck)
    expect(readChanges({ repo: 'acme/board', changes: [{ ...card, stuck: { runs: 1 } }] }).changes[0]?.stuck).toBeUndefined()
  })

  it('its badge reads "Cannot start", not a spinner', () => {
    const { container } = render(<ChecksBadge c={card.checks} stuck={stuck} />)
    expect(screen.getByText('Cannot start')).toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('the bar offers "Run the checks again" in place of Accept', () => {
    expect(offersRerun('blocked', { state: 'open', stuck })).toBe(true)
    expect(offersRerun('read-only', { state: 'open', stuck })).toBe(false)
    render(<DecisionBar change={{ state: 'open', may_accept: false, blockers: [`Its checks cannot start: ${stuck.why}.`], title: 'Docs record', from: 'the docs specialist', verdict: 'blocked', stuck }} part="contributor" note="" onAccept={() => undefined} onAsk={() => undefined} onDiscard={() => undefined} onRerun={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Run the checks again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Accept into the design/ })).toBeNull()
  })
})

describe('the mock (dev:mock): change 42 and the overview', () => {
  const call = async <T,>(action: string, args: Record<string, unknown>) => (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()) as { ok: boolean; result: T; error?: string }
  afterEach(() => sessionStorage.removeItem('trace.mock.stuck'))

  it('the overview\'s next step is the admin\'s while checks cannot start, and running them again clears it', async () => {
    sessionStorage.setItem('trace.mock.stuck', 'on')
    const j = await call<Journey>('journey.get', { repo: 'acme/soil-sensor' })
    expect(j.result.next).toMatchObject({ owner: 'you', action: { label: 'Run the checks again', call: 'changes.rerun_stuck' } })
    expect(j.result.next.summary).toMatch(/^Checks cannot start: the CodeBuild runner cannot get a GitHub runner token/)
    const d = await call<ChangeDetail>('change.get', { repo: 'acme/soil-sensor', number: 42 })
    expect(d.result).toMatchObject({ verdict: 'blocked', may_accept: false, stuck: { connection: true }, recommendation: { verdict: 'wait', why: expect.stringMatching(/^Its checks cannot start/) } })
    const r = await call<{ changes: number[]; summary: string }>('changes.rerun_stuck', { repo: 'acme/soil-sensor' })
    expect(r.result).toMatchObject({ changes: [42], summary: expect.stringMatching(/runs again/) })
    expect((await call<ChangeDetail>('change.get', { repo: 'acme/soil-sensor', number: 42 })).result).toMatchObject({ verdict: 'checking' })
    expect((await call<Journey>('journey.get', { repo: 'acme/soil-sensor' })).result.next.action?.call).not.toBe('changes.rerun_stuck')
  })
})
