/**
 * The change screens' parts: the decision bar's states (ready, blocked with its reasons, reviewer read-only, closed;
 * Discard and Ask each confirm with a required reason or note), the next-step card's step, recommendation box, After
 * line and Accept now, the renamed words people read, and the mock change actions that every screen draws from.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NextStepCard } from '@/components/next-step-card'
import { KIND } from '@/components/needs-you-card'
import { KIND_WORDS } from '@/routes/_app/inbox'
import { handle } from '@/mock/handlers'
import type { ChangeDetail, ChangeSummary, Journey, NextStep } from '@/lib/types'
import { DecisionBar } from './decision-bar'
import { finishedStage } from './celebration'
import { acceptedWords } from './use-change-actions'

const change = { state: 'open' as const, may_accept: true, blockers: [] as string[], title: 'Power sheet', from: 'the schematic specialist' }
const bar = (o: Partial<typeof change> = {}, part?: 'contributor' | 'reviewer', note = '') => {
  const fns = { onAccept: vi.fn(), onAsk: vi.fn(), onDiscard: vi.fn() }
  render(<DecisionBar change={{ ...change, ...o }} part={part} note={note} acceptSays="Accepting adds it to the design and moves Capture to step 4." {...fns} />)
  return fns
}

describe('the decision bar', () => {
  it('ready: says what accepting does and accepts with the note', async () => {
    const f = bar({}, 'contributor', 'Looks good')
    expect(screen.getByText('Accepting adds it to the design and moves Capture to step 4.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Accept into the design' }))
    expect(f.onAccept).toHaveBeenCalledWith('Looks good')
  })

  it('may_accept false: Accept is disabled and the blockers are said', () => {
    bar({ may_accept: false, blockers: ['3 checks are still running.'] }, 'contributor')
    expect(screen.getByRole('button', { name: 'Accept into the design' })).toBeDisabled()
    expect(screen.getByText(/Not ready to accept: 3 checks are still running\./)).toBeInTheDocument()
    // asking and discarding stay open
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toBeEnabled()
  })

  it('a reviewer reads it: no buttons, and a sentence saying why', () => {
    bar({}, 'reviewer')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/You are a reviewer on this project, so you can read this change but not decide on it/)).toBeInTheDocument()
  })

  it('a change already accepted says so', () => {
    bar({ state: 'merged' as never }, 'contributor')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('This change was accepted into the design.')).toBeInTheDocument()
  })

  it('Discard confirms in the bar and needs a reason', async () => {
    const f = bar({}, 'contributor')
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const go = screen.getByRole('button', { name: 'Discard this change' })
    expect(go).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Why discard it?'), 'Dropping USB-C')
    await userEvent.click(go)
    expect(f.onDiscard).toHaveBeenCalledWith('Dropping USB-C')
  })

  it('Ask for changes starts from the note box, needs a note, and can be backed out of', async () => {
    const f = bar({}, 'contributor', 'Use a 1 A part')
    await userEvent.click(screen.getByRole('button', { name: 'Ask for changes' }))
    const box = screen.getByLabelText('What should the schematic specialist change?')
    expect(box).toHaveValue('Use a 1 A part')
    await userEvent.clear(box)
    expect(screen.getByRole('button', { name: 'Send it back with this note' })).toBeDisabled()
    await userEvent.type(box, '  ')
    expect(screen.getByRole('button', { name: 'Send it back with this note' })).toBeDisabled()
    await userEvent.type(box, 'Use 1 A')
    await userEvent.click(screen.getByRole('button', { name: 'Send it back with this note' }))
    expect(f.onAsk).toHaveBeenCalledWith('Use 1 A')
    await userEvent.click(screen.getByRole('button', { name: 'Keep reviewing' }))
    expect(screen.getByRole('button', { name: 'Accept into the design' })).toBeInTheDocument()
  })
})

describe('the next-step card', () => {
  const step: NextStep = {
    kind: 'review', owner: 'you', summary: 'x **y**', lead: 'trace finished the **power sheet**. Review it.',
    recommend: { text: 'trace recommends accepting.', why: 'All 7 checks passed.' }, after: 'After you accept: trace checks stock.',
    action: { label: 'Review the change' }, reviewer: { summary: 'It waits for a contributor.', action: { label: 'Read the change' } },
  }

  it('shows the place, the recommendation with its reason, Accept now and the After line', async () => {
    const onAccept = vi.fn()
    render(<NextStepCard step={step} place={{ index: 3, total: 5, stage: 'Capture' }} onAccept={onAccept} />)
    expect(screen.getByText('Step 3 of 5 in Capture')).toBeInTheDocument()
    expect(screen.getByText('trace recommends accepting.')).toBeInTheDocument()
    expect(screen.getByText('All 7 checks passed.', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('After you accept: trace checks stock.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Accept now' }))
    expect(onAccept).toHaveBeenCalled()
  })

  it('a reviewer sees the reading form, without Accept now or the After line', () => {
    render(<NextStepCard step={step} part="reviewer" onAccept={() => undefined} />)
    expect(screen.getByText('It waits for a contributor.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept now' })).toBeNull()
    expect(screen.queryByText('After you accept: trace checks stock.')).toBeNull()
  })
})

describe('words people read', () => {
  it('say change, not pull request', () => {
    expect(KIND.review).toBe('Change to review')
    expect(KIND_WORDS.review).toBe('Changes to review')
    expect(acceptedWords('Power sheet', { next: 'trace is checking stock.', stage: 'capture' }, { index: 3, total: 5, stage: 'Capture' }))
      .toEqual({ title: 'Accepted into the design', description: 'Capture is now on step 4 of 5. trace is checking stock.' })
  })
})

describe('the stage celebration', () => {
  const st = (states: string[]) => ({ stages: states.map((s, i) => ({ id: `s${i}`, name: `S${i}`, state: s, criteria: { met: 0, total: 0 } })) }) as unknown as Journey
  it('fires only when the current stage moves forward', () => {
    expect(finishedStage(undefined, st(['current']))).toBeNull()
    expect(finishedStage(st(['done', 'current', 'queued']), st(['done', 'current', 'queued']))).toBeNull()
    expect(finishedStage(st(['done', 'current', 'queued']), st(['done', 'done', 'current']))).toEqual({ done: 'S1', next: 'S2' })
    expect(finishedStage(st(['done', 'current']), st(['done', 'done']))).toEqual({ done: 'S1', next: null })
  })
})

describe('the mock change actions (dev:mock)', () => {
  const call = async <T,>(action: string, args: Record<string, unknown>) => (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()) as { ok: boolean; result: T; error?: string }

  it('lists, reads, diffs, refuses an early accept, and accepting moves Capture on', async () => {
    const list = await call<{ changes: ChangeSummary[] }>('changes.list', { repo: 'acme/soil-sensor' })
    expect(list.result.changes.map((c) => [c.number, c.verdict])).toEqual([[12, 'ready'], [13, 'checking']])
    const twelve = await call<ChangeDetail>('change.get', { repo: 'acme/soil-sensor', number: 12 })
    expect(twelve.result).toMatchObject({ may_accept: true, recommendation: { verdict: 'accept' } })
    const diff = await call<{ before: unknown; after: unknown }>('change.diff', { repo: 'acme/soil-sensor', number: 12, path: 'hardware/power.kicad_sch' })
    expect(diff.result).toMatchObject({ before: { ref: 'a91c04b' }, after: { ref: twelve.result.head.sha } })
    const thirteen = await call<ChangeDetail>('change.get', { repo: 'acme/soil-sensor', number: 13 })
    const early = await call('change.accept', { repo: 'acme/soil-sensor', number: 13, head_sha: thirteen.result.head.sha })
    expect(early).toMatchObject({ ok: false, error: expect.stringMatching(/still running/) })
    // a head other than the one shown is refused, as the API refuses it
    const moved = await call('change.accept', { repo: 'acme/soil-sensor', number: 12, head_sha: 'f'.repeat(40) })
    expect(moved).toMatchObject({ ok: false, error: 'It changed since you looked at it. Look again before accepting.' })
    const done = await call<{ merged: boolean }>('change.accept', { repo: 'acme/soil-sensor', number: 12, head_sha: twelve.result.head.sha })
    expect(done.result.merged).toBe(true)
    const j = await call<Journey>('journey.get', { repo: 'acme/soil-sensor' })
    expect(j.result.next).toMatchObject({ kind: 'working', step: { index: 4, total: 5 } })
    expect((await call<{ changes: ChangeSummary[] }>('changes.list', { repo: 'acme/soil-sensor' })).result.changes.map((c) => c.number)).toEqual([13])
    expect((await call<{ id: string }[]>('inbox', {})).result.some((i) => i.id.includes(':12'))).toBe(false)
  })
})
