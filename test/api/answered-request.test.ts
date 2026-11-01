/**
 * The brief a specialist gets when its ended job's question is answered: the answer, and what the person said it
 * lasts as (Question answer's last step) — a requirement change goes for review, a rule is remembered.
 */
import { describe, expect, it } from 'vitest'
import { answeredRequest } from '../../src/api/actions-journey.js'

const base = { id: 'aq1', text: 'How should R5 be handled?', jobId: 'job-1', branch: 'claude/handoff-ho1', answer: 'Widen R5 to ±25 %', reason: 'a visual target', by: 'marc@example.com' }

describe('answeredRequest', () => {
  it('a requirement change is proposed for Requirements review, never taken as made', () => {
    const r = answeredRequest({ ...base, lasts: 'requirement' })
    expect(r).toMatch(/Widen R5 to ±25 %/)
    expect(r).toMatch(/changes a requirement[\s\S]*Requirements review/)
    expect(r).toMatch(/Until it is accepted, treat the requirement as it stands/)
  })
  it('a rule is remembered; a one-off adds nothing', () => {
    expect(answeredRequest({ ...base, lasts: 'rule' })).toMatch(/memory\.remember/)
    const once = answeredRequest({ ...base, lasts: 'once' })
    expect(once).not.toMatch(/Requirements review|memory\.remember/)
  })
})
