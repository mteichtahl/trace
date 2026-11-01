// The inbox's review kind (src/api/inbox-review.ts): a pull request a trace job opened, still open, needs a person.
// Seen in the browser: testyyyu's Verification job opened PR #1 and Home still said "Nothing needs you".
import { describe, expect, it } from 'vitest'
import { reviewItems } from '../../src/api/inbox-review.js'
import type { JobRow } from '../../src/core/job-index.js'
import type { PullSummary } from '../../src/api/github.js'

const job = (id: string, branch: string | null, agent: string | null, endedAt: number | null): JobRow => ({
  id, handle: null, session: null, kind: 'task', agent, title: id, number: null, requestedBySub: null, requestedBy: null, state: 'succeeded', step: null,
  queuedAt: null, startedAt: null, endedAt, beatAt: null, where: null, branch, parentJob: null, handoff: null, resumeOf: null, resumedBy: null,
  summary: null, error: null, payload: null, claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null, updatedAt: endedAt ?? 0,
})
const pull = (number: number, head: string, o: Partial<PullSummary> = {}): PullSummary => ({
  number, title: `PR ${number}`, head, draft: false, labels: [], url: `https://github.com/mteichtahl/testyyyu/pull/${number}`, updated_at: '2026-10-31T07:40:00Z', ...o,
})
const WORDS = { verify: 'Verification', impl: 'Implementation' }

describe('the inbox: pull requests trace\'s jobs opened', () => {
  it('lists an open pull request whose branch a job worked on, with the agent, and a link to it', () => {
    const at = Date.parse('2026-10-31T08:00:00Z') / 1000
    const items = reviewItems({
      repo: 'mteichtahl/testyyyu', project: 'Test', stage: 'define', at,
      pulls: [pull(1, 'claude/task-write-the-project-purpose', { title: 'Project purpose and requirements R1-R10' }), pull(2, 'marc/my-own-change')],
      jobs: [job('job-a', 'claude/task-write-the-project-purpose', 'verify', at - 1200), job('job-b', null, 'impl', at - 600)],
      agentWords: WORDS,
    })
    expect(items).toEqual([{
      id: 'review:1', kind: 'review', repo: 'mteichtahl/testyyyu', project: 'Test', stage: 'define',
      // a change, reviewed in the app (docs/guided-flow.md): the words never say "pull request", GitHub's link stays in url
      summary: 'Test: The Verification agent made a change, "Project purpose and requirements R1-R10". Its work counts once you accept it.',
      since: new Date((at - 1200) * 1000).toISOString(), waited: expect.any(String), blocking: false, action: 'Review the change',
      ref: { kind: 'pull', id: '1', url: 'https://github.com/mteichtahl/testyyyu/pull/1', to: '/p/mteichtahl~testyyyu/changes/1' },
    }])
  })

  it('a person\'s own pull request, or none open, is not listed; a resumed task\'s branch names its newest job', () => {
    expect(reviewItems({ repo: 'r/r', project: 'P', stage: 'define', pulls: [pull(3, 'feature/x')], jobs: [job('j', 'claude/x', 'verify', 1)], agentWords: WORDS })).toEqual([])
    const both = reviewItems({ repo: 'r/r', project: 'P', stage: 'define', pulls: [pull(4, 'claude/x', { draft: true })], jobs: [job('old', 'claude/x', 'verify', 1), job('new', 'claude/x', 'impl', 2)], agentWords: WORDS })
    expect(both[0]?.summary).toBe('P: The Implementation agent made a change, "PR 4" (a draft). Its work counts once you accept it.')
  })
})
