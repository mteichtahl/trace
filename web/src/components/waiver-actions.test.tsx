import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { draftFrom } from '@/components/skills/form-skills'
import { DecisionTimeline } from '@/components/project/decision-timeline'
import { readJourney } from '@/lib/readers'
import type { Waiver } from '@/lib/types'
import type { JourneyMore } from '@/lib/types-s1'
import { decisionRows } from '@/routes/_app/p/$id/decisions'
import { WaiverActions, withdrawReason } from './waiver-actions'

async function inRouter(ui: ReactNode): Promise<void> {
  const root = createRootRoute()
  const page = createRoute({ getParentRoute: () => root, path: '/', component: () => ui })
  const skill = createRoute({ getParentRoute: () => root, path: '/p/$id/do/$skill', component: () => <p>skill page</p> })
  const router = createRouter({ routeTree: root.addChildren([page, skill]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await act(async () => { render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router as never} /></QueryClientProvider>) })
}

const W: Waiver = {
  id: 'w1', title: 'finding layout.drc@J1', reason: 'The footprint is the vendor\'s own. Risk: none', risk: 'major', caught: 'On the bench: plug it in', severity: 'safety',
  riskText: 'The plug may not seat.', scope: 'this revision only', by: 'marc@example.com', at: '2026-11-05T06:38:00Z', target: { kind: 'finding', id: 'layout.drc@J1' }, closed: false, mayWithdraw: true,
}

// journey.get as the API answers it (src/core/journey.ts journeyView): a waiver, and the log's entry for it
const raw = {
  repo: 'acme/board', current_stage: 'layout', revision: 'A', template: 'board', stages: [], gates: [], next: {}, questions: [],
  waivers: [{
    id: 'w1', stage: 'layout', gate: null, target: { kind: 'finding', id: 'layout.drc@J1' }, reason: W.reason, risk: 'The plug may not seat.', severity: 'safety',
    caught_where: 'On the bench: plug it in', scope: 'this revision only', by: 'marc@example.com', at: '2026-11-05T06:38:00.000Z', acknowledged: null, closed: false, opened_by_you: false,
    withdrawn: null, may_withdraw: true, withdraw_blocked: null,
  }],
  decisions: [{ id: 'd1', at: '2026-11-05T06:38:00.000Z', kind: 'waiver.added', stage: 'layout', ref: 'w1', summary: 'A waiver was taken on finding layout.drc@J1 (rated safety): The footprint is the vendor\'s own.', by: 'marc@example.com' }],
}

describe('the Decisions page', () => {
  // test-esp32 #150: each waiver showed twice, at its time and again under "In force, no date recorded"
  it('shows a waiver once, at the time it was taken, with the waiver as it stands', () => {
    const rows = decisionRows(readJourney(raw) as JourneyMore)
    const waivers = rows.filter((r) => r.kind === 'waiver')
    expect(waivers).toHaveLength(1)
    expect(waivers[0]).toMatchObject({ id: 'd1', at: '2026-11-05T06:38:00.000Z', state: 'active', waiver: { id: 'w1', mayWithdraw: true } })
    expect(rows.some((r) => r.undated)).toBe(false)
  })

  it('a waiver the log does not name is listed at its own time, not as undated', () => {
    const rows = decisionRows(readJourney({ ...raw, decisions: [] }) as JourneyMore)
    expect(rows).toEqual([expect.objectContaining({ kind: 'waiver', at: '2026-11-05T06:38:00.000Z', by: 'marc@example.com', state: 'active' })])
    expect(rows[0]?.undated).toBeUndefined()
  })

  it('a withdrawn waiver reads as withdrawn, with who and why, and offers nothing', async () => {
    const gone = { ...raw.waivers[0], closed: true, may_withdraw: false, withdrawn: { by: 'marc@example.com', at: '2026-11-05T07:00:00.000Z', reason: 'Rated safety by mistake.', replaced_by: null } }
    const withdrawn = { id: 'd2', at: '2026-11-05T07:00:00.000Z', kind: 'waiver.withdrawn', stage: 'layout', ref: 'w1', summary: 'The waiver on finding layout.drc@J1 was withdrawn by marc@example.com: Rated safety by mistake.', by: 'marc@example.com' }
    const rows = decisionRows(readJourney({ ...raw, waivers: [gone], decisions: [withdrawn, ...raw.decisions] }) as JourneyMore)
    expect(rows.map((r) => [r.id, r.state])).toEqual([['d2', 'withdrawn'], ['d1', 'withdrawn']])
    await inRouter(<DecisionTimeline rows={rows} onOpen={() => {}} repo="acme/board" />)
    expect(screen.getByText('Withdrawn by marc@example.com: Rated safety by mistake.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).not.toBeInTheDocument()
  })

  it('a waiver in force has Withdraw and Take it again on its moment', async () => {
    await inRouter(<DecisionTimeline rows={decisionRows(readJourney(raw) as JourneyMore)} onOpen={() => {}} repo="acme/board" />)
    expect(screen.getByRole('button', { name: 'Withdraw…' })).toBeInTheDocument()
    const href = new URL(screen.getByRole('link', { name: 'Take it again' }).getAttribute('href')!, 'http://x')
    expect(href.pathname).toBe('/p/acme~board/do/waiver')
    expect(href.searchParams.get('replaces')).toBe('w1')
  })
})

describe('withdrawing a waiver', () => {
  it('needs a reason in a sentence before it sends, and says what withdrawing does', async () => {
    expect(withdrawReason(' no ')).toBeNull()
    expect(withdrawReason('Rated safety by mistake.')).toBe('Rated safety by mistake.')
    const onWithdraw = vi.fn(async () => 'Withdrawn.')
    await inRouter(<WaiverActions repo="acme/board" waiver={W} onWithdraw={onWithdraw} />)
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw…' }))
    expect(screen.getByText(/The reason is kept in the record\. Finding layout\.drc@J1 counts again/)).toBeInTheDocument()
    const send = screen.getByRole('button', { name: 'Withdraw the waiver' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Why withdraw it'), 'Rated safety by mistake; I meant failure.')
    await userEvent.click(send)
    expect(onWithdraw).toHaveBeenCalledWith('w1', 'Rated safety by mistake; I meant failure.')
  })

  it('someone who may not reads why, and a closed waiver offers nothing', async () => {
    await inRouter(<>
      <WaiverActions repo="acme/board" waiver={{ ...W, mayWithdraw: false, withdrawBlocked: 'Only marc@example.com, who took it, or an admin can withdraw this waiver.' }} />
      <WaiverActions repo="acme/board" waiver={{ ...W, id: 'w2', closed: true, mayWithdraw: false }} />
    </>)
    expect(screen.getByText('Only marc@example.com, who took it, or an admin can withdraw this waiver.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Take it again' })).not.toBeInTheDocument()
  })
})

describe('taking a waiver again', () => {
  it('fills the Waiver skill in from the waiver as it was taken', () => {
    expect(draftFrom(W)).toEqual({
      replaces: 'w1', what: 'finding:layout.drc@J1', reason: W.reason, risk: 'The plug may not seat.', severity: 'safety',
      caught: 'bench', where: 'plug it in', scope: 'revision', condition: '',
    })
    // one recorded from an answer keeps the agent's words for where it is caught, read as a later stage
    expect(draftFrom({ ...W, caught: 'Bring up: fit the lid', scope: 'until the case changes' })).toMatchObject({ caught: 'later', where: 'Bring up: fit the lid', scope: 'condition', condition: 'the case changes' })
    expect(draftFrom({ ...W, caught: 'Nowhere: accepted for good', severity: 'cosmetic' })).toMatchObject({ caught: 'nowhere', where: '' })
  })
})
