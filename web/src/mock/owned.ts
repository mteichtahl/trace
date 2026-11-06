/**
 * The overview when trace's criterion has nothing working on it (src/api/owned-work.ts; test-esp32 log #161, #33, #92),
 * as journey.get answers it. Off unless asked for, so the other screens stay as they are:
 *
 *   sessionStorage.setItem('trace.mock.owned', 'started')   trace started the work on its own
 *   sessionStorage.setItem('trace.mock.owned', 'stopped')   that work ended without meeting it: Start it
 *   sessionStorage.setItem('trace.mock.owned', 'review')    a person's review while trace still prepares it
 *   location.reload()
 *
 * Start it (journey.start_work) moves 'stopped' to 'started'.
 */
import type { Journey } from '@/lib/types'

type Owned = 'started' | 'stopped' | 'review'
let pressed = false
export const ownedOn = (): Owned | null => {
  const v = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('trace.mock.owned') : null
  if (v === 'stopped' && pressed) return 'started'
  return v === 'started' || v === 'stopped' || v === 'review' ? v : null
}

const STARTED = 'The Implementation agent works on "Every part is in stock for the build quantity, or its exception is signed".'

export function ownedStepOf(next: Journey['next']): Journey['next'] {
  const o = ownedOn()
  if (o === 'started') {
    return {
      kind: 'working', owner: 'trace', short: 'trace checks every part is in stock',
      summary: 'trace started work on Capture: every part is in stock for the build quantity, or its exception is signed.',
      why: `Nothing was working on it, so trace started it: the${STARTED.slice(3).replace(/\.$/, '')}. The schematic review needs it (4 of 7 criteria met).`,
      action: { label: 'Watch' }, jobId: 'job-owned-1',
      reviewer: { summary: 'trace started work on Capture: every part is in stock for the build quantity, or its exception is signed.' },
      step: { index: 3, total: 5 }, after: 'When trace has done this, the pin plan is yours to review.',
    }
  }
  if (o === 'stopped') {
    const lead = 'trace is not working on Capture: every part is in stock for the build quantity, or its exception is signed. trace started its work once, and that work ended without meeting it.'
    const rec = 'trace recommends starting it: its agent picks up from what the record and the default branch hold.'
    return {
      kind: 'task', owner: 'you', short: 'you start trace\'s stock check',
      summary: `${lead} **${rec}**`, lead, recommend: { text: rec },
      why: 'Nothing is working on it now, and the schematic review needs it (4 of 7 criteria met).',
      action: { label: 'Start it', call: 'journey.start_work' },
      reviewer: { summary: lead, action: { label: 'Read the stage' } },
      step: { index: 3, total: 5 }, after: 'Once it is started, trace works on it, and the next step says so.',
    }
  }
  if (o === 'review') {
    return {
      kind: 'working', owner: 'trace', short: 'trace draws the power and USB sheet',
      summary: 'trace is working on Capture: the Implementation agent draws the power and USB sheet.',
      why: 'There is nothing for you to review yet: "The power sheet is reviewed by a person" is yours once trace\'s work is ready.',
      action: { label: 'Watch' }, jobId: 'job-owned-2',
      reviewer: { summary: 'trace is working on Capture: the Implementation agent draws the power and USB sheet.' },
      step: { index: 4, total: 5 }, after: 'Then it is your move: the power sheet is reviewed by a person.',
    }
  }
  return next
}

/** The stage's steps while the work is stopped: trace's step "now" reads as stopped, not as trace at work. */
export function ownedStagesOf(stages: Journey['stages']): Journey['stages'] {
  if (ownedOn() !== 'stopped') return stages
  return stages.map((s) => (s.steps ? { ...s, steps: s.steps.map((x) => (x.state === 'now' && x.owner === 'trace' ? { ...x, stopped: true } : x)) } : s))
}

/** journey.start_work: the work starts, and the step says so. */
export function ownedAction(name: string): Response | undefined {
  if (name !== 'journey.start_work') return undefined
  pressed = true
  return new Response(JSON.stringify({ ok: true, result: { repo: 'acme/soil-sensor', criterion: 'capture.stock', jobId: 'job-owned-1', started: [STARTED] } }), { headers: { 'content-type': 'application/json' } })
}
