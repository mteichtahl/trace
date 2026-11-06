/**
 * What a guided skill's Submit came to (test-esp32 #89): refused, the skill's page says what blocked it and which step
 * fixes it, stays, and keeps the draft; recorded with a criterion it sets still not met, it says which, why and what to
 * do, and stays with the draft kept; met in full, it says what it recorded, the criteria change on screen at once, and
 * the person returns. All of it in use-skill, so every skill's Submit does the same.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ApiError, call } from '@/lib/api'
import type { Journey } from '@/lib/types'
import { SKILL_BY_ID } from './definitions'
import { applyCriteria, doneWords, partlyOutcome, refusedOutcome } from './submit-outcome'
import { useSkill } from './use-skill'

const navigate = vi.fn()
const back = vi.fn()
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
  useRouter: () => ({ history: { back } }),
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() }) }))
const mockCall = vi.mocked(call)
const REPO = 'acme/soil-sensor'
const def = SKILL_BY_ID['requirements-review']!
const REFUSED = 'Requirements review cannot be submitted yet. Not met: No conflicts or duplicates (Duplicates: R-017 and R-022.).'
const why = 'R-017 waits on an open question: answer it, then accept or strike it here.'
const PARTLY = {
  ok: true, recorded: '1 requirement accepted, 1 intent line left out', draft_kept: true,
  criteria: [
    { id: 'define.accepted', text: 'Every requirement is accepted or struck.', status: 'not_met', why, step: 'decide' },
    { id: 'define.firmware', text: 'The firmware requirements are accepted with the rest.', status: 'not_met', why, step: 'decide' },
    { id: 'define.sources', text: 'Every requirement cites its source.', status: 'met' },
  ],
}
const DONE = { ok: true, recorded: '2 requirements accepted', criteria: [{ id: 'define.accepted', text: 'Every requirement is accepted or struck.', status: 'met' }] }

function Screen() {
  const s = useSkill(REPO, def, { done: [], no_conflicts: true })
  return (
    <div>
      <p>Step {s.stepIndex + 1}</p>
      <button type="button" onClick={() => void s.submit()}>Submit review</button>
      {s.outcome}
    </div>
  )
}

let submit: () => Promise<unknown>
const drafts: unknown[] = []
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

beforeEach(() => {
  navigate.mockReset(); back.mockReset(); vi.mocked(toast).mockReset(); drafts.length = 0
  mockCall.mockReset()
  mockCall.mockImplementation((async (action: string, args: Record<string, unknown>) => {
    if (action === 'skill.submit') return submit()
    if (action === 'skill.draft') { drafts.push(args.data); return { kept: args.data !== null } }
    if (action === 'skill.get') return { skill: def.id, checks: [] }
    if (action === 'journey.get') return { repo: REPO, name: 'Soil sensor', stages: [], gates: [] }
    return {}
  }) as unknown as typeof call)
})

describe("a skill's Submit says what it came to", () => {
  it('refused: stays on the skill, says what blocked it and which step fixes it, and keeps the draft', async () => {
    submit = () => Promise.reject(new ApiError(REFUSED, 200))
    wrap(<Screen />)
    await userEvent.click(screen.getByRole('button', { name: 'Submit review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Requirements review was not submitted')
    expect(screen.getByText(REFUSED)).toBeInTheDocument()
    expect(screen.getByText('Your draft is kept. Fix what is named above, then submit again.')).toBeInTheDocument()
    // the step that fixes it, one click away
    await userEvent.click(screen.getByRole('button', { name: /Go to resolve conflicts/ }))
    expect(screen.getByText('Step 5')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
    await waitFor(() => expect(drafts).toContainEqual(expect.objectContaining({ no_conflicts: true })))
    expect(drafts).not.toContain(null)
  })

  it('partly refused: recorded, but says which criterion is not met, why and what to do; stays with the draft kept', async () => {
    submit = async () => PARTLY
    wrap(<Screen />)
    await userEvent.click(screen.getByRole('button', { name: 'Submit review' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Requirements review was submitted, but not everything is met yet')
    expect(screen.getByText('Recorded: 1 requirement accepted, 1 intent line left out.')).toBeInTheDocument()
    // two criteria not met for the same reason are said once
    expect(screen.getByText('Every requirement is accepted or struck; the firmware requirements are accepted with the rest: not met.')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Go to decide/ })).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
    await waitFor(() => expect(drafts.length).toBeGreaterThan(0))
    expect(drafts).not.toContain(null)
  })

  it('met in full: says what it recorded and what it met, discards the draft and returns', async () => {
    submit = async () => DONE
    wrap(<Screen />)
    await userEvent.click(screen.getByRole('button', { name: 'Submit review' }))
    // the project's overview (nothing remembered here), never back in history (#210)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ href: '/p/acme~soil-sensor' }))
    expect(back).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Requirements review submitted. Recorded: 2 requirements accepted. Met: Every requirement is accepted or struck.')
    expect(screen.queryByTestId('submit-outcome')).toBeNull()
    await waitFor(() => expect(drafts).toContain(null))
  })
})

describe('the outcome, worked out', () => {
  it('names the checks a refusal is about, each with its step', () => {
    expect(refusedOutcome(def, REFUSED)).toEqual({ kind: 'refused', message: REFUSED, fix: [{ text: 'No conflicts or duplicates', step: 'conflicts' }] })
    expect(refusedOutcome(def, 'Answer the open question first.')).toMatchObject({ fix: [] })
  })
  it('is partly refused only when a criterion it set is not met', () => {
    expect(partlyOutcome(PARTLY)).toMatchObject({ kind: 'partly', left: [{ id: 'define.accepted' }, { id: 'define.firmware' }], met: [{ id: 'define.sources' }] })
    expect(partlyOutcome(DONE)).toBeNull()
    expect(partlyOutcome(undefined)).toBeNull()
    expect(doneWords('Waiver taken.', undefined)).toBe('Waiver taken.')
  })
  it('writes the criteria it set into the journey on screen at once', () => {
    const qc = new QueryClient()
    const j = { repo: REPO, gates: [{ id: 'define', criteria: [{ id: 'define.accepted', text: 'x', status: 'not_met' }, { id: 'define.other', text: 'y', status: 'not_met' }] }] } as unknown as Journey
    qc.setQueryData(['journey.get', REPO, {}], j)
    applyCriteria(qc, REPO, DONE)
    const after = qc.getQueryData<Journey>(['journey.get', REPO, {}])!
    expect(after.gates[0]!.criteria.map((c) => c.status)).toEqual(['met', 'not_met'])
  })
})
