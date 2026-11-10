/**
 * The decisions log shows the waivers one answer took as one entry (core/journey.ts oneEntryPerWaiverAnswer): six
 * waivers from the case question were six entries each repeating a 700-character reason (test-esp32-run3 S15).
 */
import { describe, expect, it } from 'vitest'
import { oneEntryPerWaiverAnswer } from '../../src/core/journey.js'

const w = (id: string, on: string, rest = 'the stack is 24.3 mm (in answer to question q1)', by = 'Marc', rated = 'minor') =>
  ({ id, kind: 'waiver.added', by, summary: `A waiver was taken on ${on} (rated ${rated}): ${rest}` })

describe('oneEntryPerWaiverAnswer', () => {
  it('folds the waivers one answer took into one entry, oldest first, keeping the newest id', () => {
    const got = oneEntryPerWaiverAnswer([w('c', 'REQ-023'), w('b', 'REQ-022'), w('a', 'TST-034'), { id: 'x', kind: 'change.accepted', by: 'Marc', summary: 'accepted' }])
    expect(got).toEqual([
      { id: 'c', kind: 'waiver.added', by: 'Marc', summary: '3 waivers were taken on TST-034; REQ-022; and REQ-023 (rated minor): the stack is 24.3 mm (in answer to question q1)' },
      { id: 'x', kind: 'change.accepted', by: 'Marc', summary: 'accepted' },
    ])
  })

  it('keeps apart waivers with another reason, rating or person, and leaves a single one as it was', () => {
    const one = w('a', 'REQ-001')
    const got = oneEntryPerWaiverAnswer([w('d', 'REQ-004', 'other'), w('c', 'REQ-003', undefined, 'Ann'), w('b', 'REQ-002', undefined, 'Marc', 'major'), one])
    expect(got).toHaveLength(4)
    expect(got[3]).toBe(one)
  })
})
