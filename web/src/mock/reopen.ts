/**
 * Mock: the motor driver taken back to Define by a change of requirements after Prove (journey.get `resign`,
 * src/api/reopen-scope.ts; test-esp32 log #62, #71). Off unless asked for, so the other screens stay as they are:
 *
 *   sessionStorage.setItem('trace.mock.reopen', 'on'); location.reload()
 *
 * Define's gate waits for the changed requirement to be agreed again; Architect and Capture keep their evidence;
 * Prove runs again only that requirement's tests.
 */
import type { Journey } from '@/lib/types'

export const reopenOn = (): boolean => typeof sessionStorage !== 'undefined' && sessionStorage.getItem('trace.mock.reopen') === 'on'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

export const REOPEN_REPO = 'acme/motor-driver'

/** The journey as journey.get answers it just after the reopen. */
export function reopened(j: Journey): Journey {
  const stages = j.stages.map((s, i) => ({
    ...s, state: i === 0 ? 'reopened' as const : 'queued' as const,
    ...(i === 0 ? { reopened: { at: ago(4 * 60_000), reason: 'requirement REQ-39855b was changed after the requirements baseline' }, criteria: { met: 1, total: 2 } } : {}),
  }))
  return {
    ...j, stages, current: 'define',
    gates: j.gates.map((g, i) => ({ ...g, state: i === 0 ? 'open' as const : 'locked' as const, signature: undefined })),
    next: {
      kind: 'task', owner: 'you', short: 'you agree one changed requirement',
      summary: 'Back in Define: requirement REQ-39855b was changed after the requirements baseline. Agree the change in Requirements review.',
      action: { label: 'Open Requirements review', to: '/p/acme~motor-driver/do/requirements-review' },
    },
    recent: [{ id: 'r1', who: 'trace', text: 'Define was reopened: requirement REQ-39855b was changed after the requirements baseline', at: ago(4 * 60_000) }, ...j.recent],
    resign: {
      requirements: ['REQ-39855b'], edits: 'REQ-39855b changed only its acceptance criterion',
      gates: [
        { gate: 'define', name: 'requirements baseline', stage: 'define', state: 'agree', why: 'Agree REQ-39855b again in Requirements review, then sign it.' },
        { gate: 'architect', name: 'architecture review', stage: 'architect', state: 'kept', why: 'The chosen architecture stands: only the acceptance criterion of REQ-39855b changed, and Prove checks the design against it. Sign it again; nothing is redone.' },
        { gate: 'capture', name: 'schematic review', stage: 'capture', state: 'kept', why: 'The schematic stands: only the acceptance criterion of REQ-39855b changed, and Prove checks the design against it. Sign it again; nothing is redone.' },
        { gate: 'prove', name: 'design proven', stage: 'prove', state: 'redo', why: 'Done again: REQ-39855b changed only its acceptance criterion: TST-008, TST-009 are run again.' },
      ],
    },
  }
}
