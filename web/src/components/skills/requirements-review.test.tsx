/**
 * Requirements review on its own screen (test-esp32 #28, #29, #63, #64):
 *   - every requirement still undecided can be accepted at once, the ones struck first kept as they are; a decided row
 *     shows Undo, not its Accept again
 *   - an intent line no requirement covers is resolved only with a reason, on every step it shows: no bare Resolve
 *   - a requirement changed since a person decided it shows what changed, before and after
 *   - the "no two requirements contradict" tick counts in the bar at once, and a Submit pressed while the draft is
 *     saved waits for the save, then submits
 *   - every row, accepted ones too, can be edited (words, criterion, method, kind) into the draft, and trace's chat
 *     does the same with decide_requirement (test log R23)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { call } from '@/lib/api'
import type { SkillView } from '@/lib/types-s1'
import { SKILL_BY_ID } from './definitions'
import { DesignSteps, RequirementLine, acceptRest, decidedByReview, withDecision, withLeftOut, type DesignDraft } from './design-steps'
import { withRequirementEdit } from './requirement-edit'
import { SteppedSkill } from './stepped-skill'
import { draftChecks, qualityChecks } from './use-skill'

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/chat/embedded-chat', () => ({ EmbeddedChat: () => null }))
// the chat's decide_requirement, as the app registers it: kept so a test can call it as the model would
const tools = vi.hoisted(() => new Map<string, { handler: (args: unknown) => Promise<unknown> }>())
vi.mock('@copilotkit/react-core/v2', () => ({ useFrontendTool: (t: { name: string; handler: (args: unknown) => Promise<unknown> }) => { tools.set(t.name, t) } }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
const mockCall = vi.mocked(call)

const REPO = 'acme/soil-sensor'
const def = SKILL_BY_ID['requirements-review']!
const items: SkillView['items'] = [
  { id: 'requirement:R-1', title: 'R-1: Reads moisture every 15 minutes', detail: 'From the brief.', status: 'open', criterion: '15 min ± 10 s' },
  { id: 'requirement:R-2', title: 'R-2: Has a two-line display', detail: 'From the brief.', status: 'open', criterion: null },
  {
    id: 'requirement:R-3', title: 'R-3: The 3.3 V rail is rated for at least 600 mA', detail: 'From Power.', status: 'open', criterion: '3.1-3.6 V at the loads',
    was: { choice: 'accepted', by: 'marc@example.com', at: '2026-11-05T10:00:00Z', changes: [{ field: 'criterion', before: '3.3 V ± 3 %', after: '3.1-3.6 V at the loads' }] },
  },
  { id: 'intent:I-6', title: 'Not covered: Fits a 50 × 30 mm board.', detail: 'No requirement is derived from this intent line.', status: 'open' },
]
// accepted in the record, its criterion without a number: the bar names it (test log R23)
const accepted: NonNullable<SkillView['items']>[number] = { id: 'requirement:REQ-7ec888', title: 'REQ-7ec888: Reads soil moisture accurately', words: 'Reads soil moisture accurately', kind: 'electrical', detail: 'From the brief.', status: 'open', criterion: 'Readings are accurate', accepted: true }
const conflictsCheck = (d?: DesignDraft) => ({ id: 'conflicts', status: d?.no_conflicts ? 'met' : 'not_met', detail: d?.no_conflicts ? 'You confirmed it.' : 'Confirm in Resolve conflicts that no two requirements contradict each other.', by_draft: 'no_conflicts' }) as NonNullable<SkillView['checks']>[number]

describe('Accept or strike', () => {
  it('accepts every requirement still undecided at once, keeping a strike made first', () => {
    const struck = withDecision({}, 'R-2', 'strike', 'Not needed on the probe')
    const all = acceptRest(struck, ['R-1', 'R-2', 'R-3'])
    expect(all.decisions).toEqual([{ requirement: 'R-2', choice: 'strike', reason: 'Not needed on the probe' }, { requirement: 'R-1', choice: 'accept' }, { requirement: 'R-3', choice: 'accept' }])
  })

  it('a decided row shows its decision and Undo, not Accept again; Accept all takes only the undecided', async () => {
    let draft: DesignDraft = withDecision({}, 'R-1', 'accept')
    const set = (fn: (d: DesignDraft) => DesignDraft) => { draft = fn(draft) }
    const { rerender } = render(<DesignSteps repo={REPO} skill="requirements-review" step="decide" view={{ skill: def.id, items }} draft={draft} setDraft={set} />)
    const r1 = screen.getByText(/R-1: Reads moisture/).closest('li')!
    expect(within(r1).getByText('Accepted')).toBeInTheDocument()
    expect(within(r1).queryByRole('button', { name: 'Accept R-1' })).toBeNull()
    expect(within(r1).getByRole('button', { name: 'Undo R-1' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Accept the 2 still undecided/ }))
    expect(draft.decisions?.map((d) => `${d.requirement}:${d.choice}`)).toEqual(['R-1:accept', 'R-2:accept', 'R-3:accept'])
    rerender(<DesignSteps repo={REPO} skill="requirements-review" step="decide" view={{ skill: def.id, items }} draft={draft} setDraft={set} />)
    expect(screen.queryByRole('button', { name: /still undecided/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Undo R-2' }))
    expect(draft.decisions?.map((d) => d.requirement)).toEqual(['R-1', 'R-3'])
  })

  it('shows each requirement\'s criterion, and what changed since it was accepted, before and after', () => {
    render(<DesignSteps repo={REPO} skill="requirements-review" step="decide" view={{ skill: def.id, items }} draft={{}} setDraft={() => undefined} />)
    expect(screen.getByText('Criterion: 15 min ± 10 s')).toBeInTheDocument()
    const changed = screen.getByLabelText('What changed')
    expect(changed).toHaveTextContent('Changed since marc@example.com accepted it')
    expect(within(changed).getByLabelText('Before: 3.3 V ± 3 %')).toBeInTheDocument()
    expect(within(changed).getByLabelText('Now: 3.1-3.6 V at the loads')).toBeInTheDocument()
  })
})

describe('Editing a requirement (test log R23)', () => {
  it('an accepted row on Make it testable has Edit; saving the criterion keeps it accepted, in the draft', async () => {
    let draft: DesignDraft = {}
    const set = (fn: (d: DesignDraft) => DesignDraft) => { draft = fn(draft) }
    const ui = () => <ul><RequirementLine it={accepted} decision={draft.decisions?.find((d) => d.requirement === 'REQ-7ec888')} onDecide={() => undefined} onEdit={(id, f) => set((d) => withRequirementEdit(d, id, f))} /></ul>
    const { rerender } = render(ui())
    expect(screen.getByText('Accepted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Decide/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Edit REQ-7ec888' }))
    const box = screen.getByLabelText('Acceptance criterion')
    // a long criterion on several lines; not a login field
    expect(box.tagName).toBe('TEXTAREA')
    expect(box).toHaveAttribute('autocomplete', 'off')
    expect(box).toHaveAttribute('data-1p-ignore')
    await userEvent.clear(box)
    await userEvent.type(box, 'Within ±3 % VWC from 0 to 50 % VWC at 25 °C')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(draft.decisions).toEqual([{ requirement: 'REQ-7ec888', choice: 'edit', criterion: 'Within ±3 % VWC from 0 to 50 % VWC at 25 °C' }])
    rerender(ui())
    expect(screen.getByText('Accepted, edited')).toBeInTheDocument()
    expect(screen.getByText('Criterion: Within ±3 % VWC from 0 to 50 % VWC at 25 °C')).toBeInTheDocument()
    // a second edit, of the method and kind only, keeps the criterion set before
    await userEvent.click(screen.getByRole('button', { name: 'Edit REQ-7ec888' }))
    await userEvent.type(screen.getByLabelText('Method'), 'Bench test against dried samples')
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'functional')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(draft.decisions).toEqual([{ requirement: 'REQ-7ec888', choice: 'edit', criterion: 'Within ±3 % VWC from 0 to 50 % VWC at 25 °C', method: 'Bench test against dried samples', class: 'functional' }])
  })

  it('on Decide, an undecided row and an accepted one can be edited; Accept all leaves the accepted one', async () => {
    let draft: DesignDraft = {}
    const set = (fn: (d: DesignDraft) => DesignDraft) => { draft = fn(draft) }
    render(<DesignSteps repo={REPO} skill="requirements-review" step="decide" view={{ skill: def.id, items: [...items, accepted] }} draft={draft} setDraft={set} />)
    expect(screen.getByRole('button', { name: /Accept the 3 still undecided/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit R-2' }))
    const words = screen.getByLabelText('Requirement')
    await userEvent.clear(words)
    await userEvent.type(words, 'Has a two-line display readable at 1 m')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(draft.decisions).toEqual([{ requirement: 'R-2', choice: 'edit', text: 'Has a two-line display readable at 1 m' }])
    expect(screen.getByRole('button', { name: 'Edit REQ-7ec888' })).toBeInTheDocument()
  })

  it('trace\'s chat edits the criterion in the draft with decide_requirement, and the row shows it', async () => {
    mockCall.mockReset()
    let saved: DesignDraft | undefined
    mockCall.mockImplementation((async (action: string, args: Record<string, unknown>) => {
      if (action === 'skill.draft') { saved = args.data as DesignDraft; return { kept: true } }
      if (action === 'skill.get') return { skill: def.id, items: [...items, accepted], checks: [{ id: 'criterion', status: 'not_met', detail: '1 accepted requirement without a criterion with a number: REQ-7ec888.' }], draft: { done: ['source', 'decide'] }, step: 2, saved: '2026-11-06T00:00:00Z' }
      if (action === 'journey.get') return { repo: REPO, name: 'Soil sensor', stages: [], gates: [] }
      return {}
    }) as unknown as typeof call)
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><SteppedSkill repo={REPO} def={def} /></TooltipProvider></QueryClientProvider>)
    expect((await screen.findAllByRole('button', { name: 'Edit REQ-7ec888' })).length).toBeGreaterThan(0)
    const tool = tools.get('decide_requirement')!
    await waitFor(async () => expect(await tool.handler({ decisions: [{ requirement: 'REQ-7ec888', choice: 'edit', criterion: 'Within ±3 % VWC from 0 to 50 % VWC at 25 °C' }] })).toMatchObject({ decided: [{ requirement: 'REQ-7ec888', choice: 'edit' }] }))
    expect(await screen.findByText('Criterion: Within ±3 % VWC from 0 to 50 % VWC at 25 °C')).toBeInTheDocument()
    await waitFor(() => expect(saved?.decisions).toEqual([{ requirement: 'REQ-7ec888', choice: 'edit', criterion: 'Within ±3 % VWC from 0 to 50 % VWC at 25 °C' }]), { timeout: 3000 })
  })
})

describe('An intent line no requirement covers', () => {
  it('is left out only with a reason, on every step, and can be undone', async () => {
    for (const step of def.steps.map((s) => s.id)) {
      let draft: DesignDraft = {}
      const { unmount } = render(<DesignSteps repo={REPO} skill="requirements-review" step={step} view={{ skill: def.id, items }} draft={draft} setDraft={(fn) => { draft = fn(draft) }} />)
      const leave = screen.getByRole('button', { name: 'Leave out I-6' })
      expect(leave).toBeDisabled()
      await userEvent.type(screen.getByPlaceholderText('Why no requirement covers it'), 'The housing is chosen in Layout')
      await userEvent.click(leave)
      expect(draft.uncovered).toEqual([{ statement: 'I-6', reason: 'The housing is chosen in Layout' }])
      unmount()
    }
    expect(withLeftOut({ uncovered: [{ statement: 'I-6', reason: 'x' }] }, 'I-6', null).uncovered).toEqual([])
  })

  it('is decided by the review\'s own steps, never by a bare Resolve', () => {
    expect(decidedByReview('requirements-review', { id: 'intent:I-6' })).toBe(true)
    expect(decidedByReview('requirements-review', { id: 'requirement:R-1' })).toBe(true)
    expect(decidedByReview('pin-plan-review', { id: 'finding:x' })).toBe(false)
  })
})

describe('the "no two requirements contradict" tick', () => {
  it('counts in the bar from the draft on screen, before the record has checked it again', () => {
    const view = { checks: [conflictsCheck()] }
    expect(qualityChecks(def, view, draftChecks(view, { no_conflicts: true })).find((c) => c.id === 'conflicts')).toMatchObject({ status: 'met', text: 'No conflicts or duplicates' })
    // untick after the record said met: not met, without the record's words about its own verdict
    const met = { checks: [conflictsCheck({ no_conflicts: true })] }
    expect(qualityChecks(def, met, draftChecks(met, {})).find((c) => c.id === 'conflicts')).toMatchObject({ status: 'not_met', text: 'No conflicts or duplicates' })
    // a duplicate the record found is not the tick's to clear
    expect(draftChecks({ checks: [{ id: 'conflicts', status: 'not_met', detail: 'Duplicates: R-1 and R-4.' }] }, { no_conflicts: true })).toEqual({})
  })
})

describe('Requirements review, the whole screen', () => {
  let saves: { data: unknown; resolve: () => void }[]
  let lastDraft: DesignDraft | undefined
  const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider>{ui}</TooltipProvider></QueryClientProvider>)

  beforeEach(() => {
    saves = []
    lastDraft = undefined
    mockCall.mockReset()
    mockCall.mockImplementation((async (action: string, args: Record<string, unknown>) => {
      // each save answers only when the test says so: the network
      if (action === 'skill.draft') return new Promise((resolve) => { saves.push({ data: args.data, resolve: () => { lastDraft = args.data as DesignDraft; resolve({ kept: true }) } }) })
      if (action === 'skill.get') {
        const others = [{ id: 'criterion', status: 'met' }, { id: 'sources', status: 'met' }, { id: 'covered', status: 'met' }, { id: 'struck', status: 'met' }]
        return { skill: def.id, items, checks: [...others, conflictsCheck(lastDraft)], draft: { done: ['source', 'decide', 'testable', 'classify'] }, step: 4, saved: '2026-11-06T00:00:00Z' }
      }
      if (action === 'journey.get') return { repo: REPO, name: 'Soil sensor', stages: [], gates: [] }
      return {}
    }) as unknown as typeof call)
  })

  it('no bare Resolve on any step: requirements point to Decide, the intent line has its reason box', async () => {
    wrap(<SteppedSkill repo={REPO} def={def} />)
    expect(await screen.findByText('Do any two requirements contradict each other?')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Leave out I-6' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Decide/ })).toHaveLength(3)
  })

  it('the tick counts at once; Submit pressed while the draft is saved waits for it, then submits the ticked draft', async () => {
    wrap(<SteppedSkill repo={REPO} def={def} />)
    const tick = await screen.findByRole('checkbox', { name: /no two requirements contradict/ })
    const submit = () => screen.getAllByRole('button', { name: 'Submit' })[0]!
    expect(submit()).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(tick)
    // counted at once: every check met, though the record has not seen the tick yet
    expect(screen.getAllByText('6 of 6 met').length).toBeGreaterThan(0)
    expect(submit()).not.toHaveAttribute('aria-disabled')
    // but the tick is still being saved: Submit pressed now waits for it
    expect(screen.getAllByText('Saving your draft…').length).toBeGreaterThan(0)
    await userEvent.click(submit())
    expect(screen.getAllByText('Saving your draft, then submitting…').length).toBeGreaterThan(0)
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 })
    expect(saves[0]!.data).toMatchObject({ no_conflicts: true })
    expect(mockCall.mock.calls.some(([a]) => a === 'skill.submit')).toBe(false)
    act(() => saves[0]!.resolve())
    await waitFor(() => expect(mockCall.mock.calls.find(([a]) => a === 'skill.submit')?.[1]).toMatchObject({ draft: { no_conflicts: true } }))
  })

  // #30: the rail's steps could not be clicked (Decide did nothing); only each step's Continue moved on
  it('a step on the rail opens with a click, a later one too', async () => {
    wrap(<SteppedSkill repo={REPO} def={def} />)
    await screen.findByText('Do any two requirements contradict each other?')
    const rail = screen.getAllByRole('navigation', { name: 'Steps' })[0]!
    await userEvent.click(within(rail).getByRole('button', { name: /Cover the intent/ }))
    expect((await screen.findAllByText('Step 6 of 6')).length).toBeGreaterThan(0)
    await userEvent.click(within(rail).getByRole('button', { name: /Decide/ }))
    expect((await screen.findAllByText('Step 2 of 6')).length).toBeGreaterThan(0)
  })

  it('saves go one after another, so an older one never lands last', async () => {
    wrap(<SteppedSkill repo={REPO} def={def} />)
    const tick = await screen.findByRole('checkbox', { name: /no two requirements contradict/ })
    await userEvent.click(tick)
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2000 })
    // Continue straight away: a second save while the first is still on its way
    await userEvent.click(screen.getByRole('button', { name: /Continue to cover the intent/ }))
    await new Promise((r) => setTimeout(r, 1000))
    expect(saves).toHaveLength(1)
    act(() => saves[0]!.resolve())
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]!.data).toMatchObject({ no_conflicts: true })
    act(() => saves[1]!.resolve())
  })
})
