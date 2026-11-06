/**
 * A guided skill's quality bar and Submit (#210, seen in Release review):
 *   - an "I checked it" confirmation counts in the bar at once, from the draft on screen, not seconds later once the
 *     record has checked it again; unticking one the record said was confirmed takes it back at once
 *   - Submit never ignores a click: pressed with checks left, it says which, and submits nothing
 *   - once submitted, the person lands on the project page the skill was opened from, else the project's overview;
 *     never browser history, which may be a page outside the project
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QualityBar, type QualityCheck } from '@/components/quality-bar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { call } from '@/lib/api'
import { rememberPage, returnTo } from '@/lib/return-to'
import type { SkillView } from '@/lib/types-s1'
import { SKILL_BY_ID } from './definitions'
import { draftChecks, qualityChecks, useSkill } from './use-skill'

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
const def = SKILL_BY_ID['release-review']!
type Check = NonNullable<SkillView['checks']>[number]
const yours = (id: string): Check => ({ id, status: 'not_met', unavailable: 'a checker for this check', confirmable: true })
const confirmed = (id: string): Check => ({ id, status: 'met', confirmed: true, detail: 'You confirmed it.' })
const [first, second] = def.checks.map((c) => c.id) as [string, string]

describe('an "I checked it" confirmation', () => {
  it('counts in the bar at once, from the draft on screen', () => {
    const view = { checks: [yours(first), yours(second)] }
    const bar = qualityChecks(def, view, draftChecks(view, { confirmed: { [first]: true } }))
    expect(bar.find((c) => c.id === first)).toMatchObject({ status: 'met', text: def.checks[0]!.text })
    // not ticked: still not met, saying why
    expect(bar.find((c) => c.id === second)).toMatchObject({ status: 'not_met', text: `${def.checks[1]!.text} (cannot be checked yet: needs a checker for this check)` })
  })

  it('unticked after the record said confirmed: not met at once', () => {
    const view = { checks: [confirmed(first)] }
    expect(qualityChecks(def, view, draftChecks(view, { confirmed: { [first]: false } })).find((c) => c.id === first)).toMatchObject({ status: 'not_met', text: def.checks[0]!.text })
  })

  it('cannot meet a check that is not the person\'s to confirm', () => {
    const view = { checks: [{ id: first, status: 'not_met', unavailable: 'a release run' } as Check] }
    expect(draftChecks(view, { confirmed: { [first]: true } })).toEqual({})
    expect(qualityChecks(def, view, draftChecks(view, { confirmed: { [first]: true } }))[0]!.status).toBe('not_met')
  })
})

describe('Submit', () => {
  const checks: QualityCheck[] = [
    { id: 'a', text: 'Each area acknowledged', status: 'met' },
    { id: 'b', text: 'Cost stated', status: 'not_met' },
    { id: 'c', text: 'Parts acknowledged', status: 'not_met' },
  ]
  const bar = (ui: ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>)

  for (const wide of [true, false]) it(`pressed with checks left ${wide ? 'on a wide screen' : 'on a phone'}: says which, and submits nothing`, async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
      ({ matches: wide, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as MediaQueryList)
    const onSubmit = vi.fn()
    bar(<QualityBar checks={checks} onSubmit={onSubmit} />)
    expect(screen.queryByRole('alert')).toBeNull()
    await userEvent.click(screen.getAllByRole('button', { name: 'Submit' })[0]!)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Not submitted.')
    expect(alert).toHaveTextContent('2 checks are left:')
    expect(alert).toHaveTextContent('Cost stated')
    expect(alert).toHaveTextContent('Parts acknowledged')
    expect(onSubmit).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('pressed while held for the agent: says why', async () => {
    const onSubmit = vi.fn()
    bar(<QualityBar checks={[checks[0]!]} onSubmit={onSubmit} blocked="The project's agent is not set up yet." />)
    await userEvent.click(screen.getAllByRole('button', { name: 'Submit' })[0]!)
    expect(screen.getByRole('alert')).toHaveTextContent(/Not submitted\.\s*The project's agent is not set up yet\./)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('the message goes once every check is met, and Submit then submits', async () => {
    const onSubmit = vi.fn()
    const { rerender } = bar(<QualityBar checks={checks} onSubmit={onSubmit} />)
    await userEvent.click(screen.getAllByRole('button', { name: 'Submit' })[0]!)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    rerender(<TooltipProvider><QualityBar checks={checks.map((c) => ({ ...c, status: 'met' as const }))} onSubmit={onSubmit} /></TooltipProvider>)
    expect(screen.queryByRole('alert')).toBeNull()
    await userEvent.click(screen.getAllByRole('button', { name: 'Submit' })[0]!)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('where a submitted skill returns to', () => {
  it('the project page it was opened from, else the overview', () => {
    rememberPage('/p/acme~soil-sensor/design?tab=pins')
    expect(returnTo(REPO)).toBe('/p/acme~soil-sensor/design?tab=pins')
    rememberPage('/p/acme~soil-sensor')
    expect(returnTo(REPO)).toBe('/p/acme~soil-sensor')
    // a page outside the project, or another project's
    rememberPage('/inbox')
    expect(returnTo(REPO)).toBe('/p/acme~soil-sensor')
    rememberPage('/p/acme~soil-sensor-two/design')
    expect(returnTo(REPO)).toBe('/p/acme~soil-sensor')
  })

  function Screen() {
    const s = useSkill(REPO, def, { done: [] })
    return <button type="button" onClick={() => void s.submit()}>Submit review</button>
  }
  const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

  beforeEach(() => {
    navigate.mockReset(); back.mockReset()
    mockCall.mockReset()
    mockCall.mockImplementation((async (action: string) => {
      if (action === 'skill.submit') return { ok: true, recorded: 'the release report' }
      if (action === 'skill.get') return { skill: def.id, checks: [] }
      if (action === 'journey.get') return { repo: REPO, name: 'Soil sensor', stages: [], gates: [] }
      return {}
    }) as unknown as typeof call)
  })

  it('goes to the project page, not back in history', async () => {
    rememberPage('/p/acme~soil-sensor/build')
    wrap(<Screen />)
    await userEvent.click(screen.getByRole('button', { name: 'Submit review' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ href: '/p/acme~soil-sensor/build' }))
    expect(back).not.toHaveBeenCalled()
  })

  it('opened from outside the project: goes to its overview', async () => {
    rememberPage('/inbox')
    wrap(<Screen />)
    await userEvent.click(screen.getByRole('button', { name: 'Submit review' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ href: '/p/acme~soil-sensor' }))
    expect(back).not.toHaveBeenCalled()
  })
})
