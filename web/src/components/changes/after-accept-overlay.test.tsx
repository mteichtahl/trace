/**
 * The three additions: Overlay's availability, legend and compositing; the "What happens next" screen's words from
 * an accept answer and the journey after it; and the step-to-skill map the stage sheet links with.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CRITERION_SKILLS, jobOf, skillOf, stepLink } from '@/lib/step-skills'
import { SKILLS } from '@/components/skills/definitions'
import type { Journey, RunSummary, StageStep } from '@/lib/types'
import { nextView } from './after-accept'
import { OVERLAY_LEGEND, OverlayLegend, overlayAvailable, overlayPixels } from './overlay'

describe('Overlay', () => {
  it('is offered only when the file has both sides, and says why not', () => {
    expect(overlayAvailable({ ref: 'a' }, { ref: 'b' })).toEqual({ ok: true })
    expect(overlayAvailable(null, { ref: 'b' })).toEqual({ ok: false, why: 'Overlay needs a before: this file is new in this change.' })
    expect(overlayAvailable({ ref: 'a' }, null)).toMatchObject({ ok: false, why: expect.stringMatching(/removes the file/) })
  })

  it('has a legend of added, removed and unchanged in the theme tokens', () => {
    expect(OVERLAY_LEGEND.map((l) => [l.word, l.token])).toEqual([['Added', '--verified'], ['Removed', '--destructive'], ['Unchanged', '--muted-foreground']])
    render(<OverlayLegend />)
    expect(screen.getByRole('list', { name: 'Overlay colours' })).toHaveTextContent('AddedRemovedUnchanged')
  })

  it('colours after-only ink as added, before-only as removed, both as unchanged', () => {
    // four pixels; a white background in both, black ink: [both, before only, after only, neither]
    const W = [255, 255, 255, 255]
    const K = [0, 0, 0, 255]
    const before = new Uint8ClampedArray([...W, ...K, ...K, ...W, ...W])
    const after = new Uint8ClampedArray([...W, ...K, ...W, ...K, ...W])
    const out = new Uint8ClampedArray(before.length)
    const c = { added: [0, 200, 0] as [number, number, number], removed: [200, 0, 0] as [number, number, number], same: [120, 120, 120] as [number, number, number], bg: [250, 250, 250] as [number, number, number] }
    const n = overlayPixels(before, after, out, c)
    expect(n).toEqual({ added: 1, removed: 1, same: 1 })
    const px = (i: number) => [...out.slice(i * 4, i * 4 + 3)]
    expect([px(0), px(1), px(2), px(3), px(4)]).toEqual([c.bg, c.same, c.removed, c.added, c.bg])
  })
})

describe('What happens next, after accepting', () => {
  const steps: StageStep[] = [
    { id: 'a', text: 'trace drafts the sheets', owner: 'trace', state: 'done', ref: null },
    { id: 'b', text: "Review trace's power sheet", owner: 'you', state: 'done', ref: { kind: 'change', id: '12' } },
    { id: 'c', text: 'Check every part is in stock for 10 boards', owner: 'trace', state: 'now', ref: null },
    { id: 'd', text: 'Sign the schematic gate', owner: 'admins', state: 'next', ref: { kind: 'gate', id: 'capture' } },
  ]
  const j = {
    stages: [
      { id: 'define', name: 'Define', state: 'done', criteria: { met: 2, total: 2 } },
      { id: 'capture', name: 'Capture', state: 'current', criteria: { met: 5, total: 6 }, steps: [...steps, { id: 'e', text: 'x', owner: 'trace', state: 'done', ref: null }] },
      { id: 'prove', name: 'Prove', state: 'queued', criteria: { met: 0, total: 0 } },
    ],
    gates: [],
    next: { kind: 'working', owner: 'trace', summary: '', step: { index: 4, total: 5 } },
  } as unknown as Journey
  const answer = { title: 'Power and USB-C input sheet', result: { stage: 'capture', next: 'trace is checking stock for 10 boards, about 4 minutes.' } }

  it('says what moved, what trace does now, the next three steps with owners, and how many are left', () => {
    const v = nextView(answer, j, 2)
    expect(v.title).toBe('Accepted into the design')
    expect(v.moved).toBe('Capture is now on step 4 of 5.')
    expect(v.doing).toBe('trace is checking stock for 10 boards, about 4 minutes.')
    expect(v.steps).toEqual([
      { text: 'Check every part is in stock for 10 boards', who: 'trace', when: 'now', owner: 'trace' },
      { text: 'Sign the schematic gate', who: 'An admin', when: 'next', owner: 'admins' },
      { text: 'Prove starts', who: 'trace', when: 'later', owner: 'trace' },
    ])
    expect(v.notice).toBe("We'll tell you the moment the gate is ready. No need to keep this open.")
    expect(v.back).toBe('Back to Needs you · 2 left')
  })

  it('still reads before the journey has refreshed, and with nothing left', () => {
    const v = nextView(answer, undefined, 0)
    expect(v.moved).toBe('"Power and USB-C input sheet" is part of the design now.')
    expect(v.steps).toEqual([])
    expect(v.back).toBe('Back to Home')
    expect(nextView({ ...answer, result: { stage: 'capture', next: '' } }, j, 1).doing).toBe('trace carries on with the next step.')
  })
})

describe('the step-to-skill map', () => {
  const step = (o: Partial<StageStep>): StageStep => ({ id: 's', text: '', owner: 'you', state: 'later', ref: null, ...o })
  const skillIds = new Set(SKILLS.map((s) => s.id))

  it('names only skills that exist', () => {
    for (const s of Object.values(CRITERION_SKILLS)) expect(skillIds.has(s), s).toBe(true)
  })

  it('maps criteria, gates and questions; trace checks and unknown words get nothing', () => {
    expect(skillOf(step({ ref: { kind: 'criterion', id: 'capture.pins' } }))).toBe('pin-plan-review')
    expect(skillOf(step({ ref: { kind: 'criterion', id: 'define.measurable' } }))).toBe('requirements-review')
    expect(skillOf(step({ ref: { kind: 'criterion', id: 'signoff.report' } }))).toBe('release-review')
    expect(skillOf(step({ ref: { kind: 'criterion', id: 'fabricate.order.sheet' } }))).toBe('order-submit')
    expect(skillOf(step({ ref: { kind: 'criterion', id: 'fabricate.received.bench' } }))).toBe('bench-setup')
    expect(skillOf(step({ ref: { kind: 'gate', id: 'capture' } }))).toBe('gate-signing')
    expect(skillOf(step({ ref: { kind: 'question', id: 'q1' } }))).toBe('question-answer')
    expect(skillOf(step({ owner: 'trace', ref: { kind: 'criterion', id: 'capture.pins' } }))).toBeNull()
    expect(skillOf(step({ ref: { kind: 'criterion', id: 'capture.erc' }, text: 'The electrical rule check is clean' }))).toBeNull()
    expect(skillOf(step({ text: 'Water the plants' }))).toBeNull()
    // by words, when the id is not known
    expect(skillOf(step({ text: 'Finish the schematic notes on the sensor sheet' }))).toBe('schematic-finish')
    expect(skillOf(step({ text: 'Run the bring-up tests on board 1' }))).toBe('bring-up-run')
  })

  it('links trace steps to their running or queued job, and nothing else', () => {
    const jobs = [
      { id: 'job_s1', title: 'Check stock for 10 boards', state: 'queued' },
      { id: 'job_v1', title: 'Check the ERC', state: 'running' },
      { id: 'job_old', title: 'Route the board', state: 'done' },
    ] as RunSummary[]
    expect(jobOf(step({ owner: 'trace', text: 'Check every part is in stock for 10 boards', state: 'next' }), jobs)?.id).toBe('job_s1')
    expect(jobOf(step({ owner: 'trace', text: 'Every connection is routed', state: 'next' }), jobs)).toBeNull()
    expect(jobOf(step({ owner: 'trace', text: 'trace drafts the sheets', state: 'done' }), jobs)).toBeNull()
    expect(stepLink(step({ owner: 'trace', text: 'Check every part is in stock for 10 boards' }), { projectId: 'a~b', jobs })).toEqual({ label: 'Queued job', to: '/p/a~b/runs/job_s1' })
    expect(stepLink(step({ ref: { kind: 'criterion', id: 'capture.pins' } }), { projectId: 'a~b' })).toEqual({ label: 'Pin plan review', to: '/p/a~b/do/pin-plan-review' })
    expect(stepLink(step({ ref: { kind: 'change', id: '12' }, to: '/p/a~b/changes/12' }), { projectId: 'a~b' })).toEqual({ label: 'Review the change', to: '/p/a~b/changes/12' })
    expect(stepLink(step({ state: 'done', ref: { kind: 'gate', id: 'x' } }), { projectId: 'a~b' })).toBeNull()
  })
})
