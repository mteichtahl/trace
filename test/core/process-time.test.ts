/**
 * Where a project's time went (src/core/process-time.ts): when a gate became ready (never after its signature, so a
 * criterion re-checked after signing does not make a negative wait), the spans trace waited on a person, each stage's
 * length and wait (two waits at once counted once), and when a question asks again what was answered.
 */
import { describe, expect, it } from 'vitest'
import type { JourneyRecord } from '../../src/core/journey.js'
import { asksAgain, gateReadyAt, personWaits, stageTimes, unionSeconds } from '../../src/core/process-time.js'

const T = 1_800_000_000
const H = 3600

/** A record with only what process-time reads; the rest left out. */
function record(o: Partial<Record<keyof JourneyRecord, unknown>> = {}): JourneyRecord {
  return {
    journey: { revision: 'A', currentStage: 'capture', name: 'Board' },
    stages: [
      { id: 'define', ord: 0, started: T, finished: T + 2 * H },
      { id: 'architect', ord: 1, started: T + 2 * H, finished: T + 5 * H },
      { id: 'capture', ord: 2, started: T + 5 * H, finished: null },
      { id: 'prove', ord: 3, started: null, finished: null },
    ],
    gates: [{ id: 'define.gate', stage: 'define' }, { id: 'architect.gate', stage: 'architect' }],
    criteria: [
      { id: 'define.intent', gate: 'define.gate', status: 'met', checkedAt: T + H },
      { id: 'define.reqs', gate: 'define.gate', status: 'met', checkedAt: T + 1.5 * H },
      { id: 'architect.blocks', gate: 'architect.gate', status: 'met', checkedAt: T + 4 * H },
    ],
    waivers: [],
    signatures: [
      { gate: 'define.gate', at: T + 2 * H, supersededAt: null, revision: 'A' },
      { gate: 'architect.gate', at: T + 5 * H, supersededAt: null, revision: 'A' },
    ],
    questions: [],
    decisions: [],
    dismissals: [],
    ...o,
  } as unknown as JourneyRecord
}

describe('when a gate became ready to sign', () => {
  it('is its last criterion met or waived up to the signature, never before its stage started', () => {
    const r = record()
    expect(gateReadyAt(r, 'define.gate', T + 2 * H)).toBe(T + 1.5 * H)
    // a criterion re-checked after the signature (real records have them) is not "ready" for that signature
    const later = record({ criteria: [...(r.criteria as object[]), { id: 'define.late', gate: 'define.gate', status: 'met', checkedAt: T + 9 * H }] })
    expect(gateReadyAt(later, 'define.gate', T + 2 * H)).toBe(T + 1.5 * H)
    // a waiver counts as the criterion being met
    const waived = record({ waivers: [{ targetKind: 'criterion', target: 'define.reqs', at: T + 1.8 * H, closedAt: null }] })
    expect(gateReadyAt(waived, 'define.gate', T + 2 * H)).toBe(T + 1.8 * H)
    // criteria all checked before the stage started: ready when it started
    const early = record({ criteria: [{ id: 'architect.blocks', gate: 'architect.gate', status: 'met', checkedAt: T }] })
    expect(gateReadyAt(early, 'architect.gate', T + 5 * H)).toBe(T + 2 * H)
    expect(gateReadyAt(r, 'no.gate', T)).toBeNull()
  })
})

describe('the waits on people', () => {
  it('a blocking question until answered, a gate from ready to signed, a change from ready to accepted', () => {
    const r = record({
      questions: [
        { id: 'q1', kind: 'question', stage: 'define', blocks: 'R4', askedAt: T + 0.25 * H, answeredAt: T + 0.75 * H },
        // a question that blocks nothing waits on no one
        { id: 'q2', kind: 'question', stage: 'define', blocks: '', askedAt: T, answeredAt: T + H },
      ],
      decisions: [
        { id: 'd1', kind: 'change.accepted', stage: 'architect', ref: '12', at: T + 3 * H, detail: { ready_since: new Date((T + 2.5 * H) * 1000).toISOString() } },
        // an older decision without ready_since counts no wait
        { id: 'd2', kind: 'change.accepted', stage: 'architect', ref: '13', at: T + 3 * H, detail: {} },
      ],
    })
    const w = personWaits(r, T + 6 * H)
    expect(w).toEqual([
      { kind: 'question', stage: 'define', ref: 'q1', from: T + 0.25 * H, to: T + 0.75 * H },
      { kind: 'gate', stage: 'define', ref: 'define.gate', from: T + 1.5 * H, to: T + 2 * H },
      { kind: 'gate', stage: 'architect', ref: 'architect.gate', from: T + 4 * H, to: T + 5 * H },
      { kind: 'change', stage: 'architect', ref: '12', from: T + 2.5 * H, to: T + 3 * H },
    ])
  })

  it('a gate of the current stage ready and unsigned waits until now', () => {
    const r = record({
      gates: [{ id: 'capture.gate', stage: 'capture' }],
      criteria: [{ id: 'capture.erc', gate: 'capture.gate', status: 'met', checkedAt: T + 6 * H }],
      signatures: [],
    })
    expect(personWaits(r, T + 8 * H)).toEqual([{ kind: 'gate', stage: 'capture', ref: 'capture.gate', from: T + 6 * H, to: T + 8 * H }])
  })
})

describe('each stage\'s time', () => {
  it('its length (to now while it runs) and the union of its waits, clipped to it', () => {
    const r = record({
      // two waits at once in Architect count once: 3.5 h to 4.5 h and the gate's 4 h to 5 h make 1.5 h
      questions: [{ id: 'q1', kind: 'stuck', stage: 'architect', blocks: null, askedAt: T + 3.5 * H, answeredAt: T + 4.5 * H }],
    })
    const s = stageTimes(r, T + 6 * H)
    expect(s.map((x) => [x.id, x.seconds / H, x.waiting / H])).toEqual([['define', 2, 0.5], ['architect', 3, 1.5], ['capture', 1, 0]])
    expect(s[0]?.name).toBe('Define')
  })

  it('unionSeconds merges overlaps and clips', () => {
    expect(unionSeconds([{ from: 0, to: 10 }, { from: 5, to: 15 }, { from: 20, to: 30 }], 0, 25)).toBe(20)
    expect(unionSeconds([{ from: 5, to: 1 }], 0, 10)).toBe(0)
  })
})

describe('a question asked again', () => {
  it('blocks what an answered question blocked, or names the same criterion; never when it blocks nothing', () => {
    const r = record({ questions: [{ id: 'q1', kind: 'question', stage: 'layout', blocks: 'Layout: define.intent renders.', askedAt: T, answeredAt: T + H }] }) as JourneyRecord
    expect(asksAgain(r, 'layout: define.intent  renders')).toBe(true)
    expect(asksAgain(r, 'the board outline (define.intent)')).toBe(true)
    expect(asksAgain(r, 'the connector choice')).toBe(false)
    expect(asksAgain(r, '')).toBe(false)
    expect(asksAgain(null, 'anything')).toBe(false)
  })
})
