import { describe, expect, it } from 'vitest'
import { pullWords } from './pull-status'
import type { PullStatus } from '@/lib/types'

const base: PullStatus = {
  repo: 'mteichtahl/testyyyu', number: 1, title: 'Project purpose and requirements R1-R10', url: 'https://github.com/mteichtahl/testyyyu/pull/1', state: 'open', draft: false,
  mergeable: 'blocked', head: 'claude/task-x', sha: 'abc', updated_at: '2026-10-31T07:40:00Z', checks: { total: 5, passed: 3, failed: 0, running: 2, skipped: 0, failing: [] },
}

describe('a pull request\'s status in words', () => {
  it('says what is happening first: failing checks by name, then running, then whether it can merge', () => {
    expect(pullWords(base)).toEqual({ text: 'Checks running: 3 of 5 passed', tone: 'running' })
    expect(pullWords({ ...base, checks: { total: 5, passed: 3, failed: 2, running: 0, skipped: 0, failing: ['build', 'lint'] } })).toEqual({ text: '2 checks failing: build, lint', tone: 'bad' })
    expect(pullWords({ ...base, mergeable: 'clean', checks: { total: 5, passed: 4, failed: 0, running: 0, skipped: 1, failing: [] } })).toEqual({ text: 'All checks passed · ready to merge', tone: 'good' })
    expect(pullWords({ ...base, mergeable: 'dirty', checks: null })).toEqual({ text: 'Conflicts with its base branch', tone: 'bad' })
    expect(pullWords({ ...base, draft: true, mergeable: 'clean', checks: { total: 0, passed: 0, failed: 0, running: 0, skipped: 0, failing: [] } })).toEqual({ text: 'Draft · ready to merge', tone: 'good' })
  })

  it('merged and closed end it', () => {
    expect(pullWords({ ...base, state: 'merged' })).toEqual({ text: 'Merged', tone: 'done' })
    expect(pullWords({ ...base, state: 'closed' })).toEqual({ text: 'Closed without merging', tone: 'muted' })
  })
})
