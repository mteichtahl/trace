import { describe, expect, it } from 'vitest'
import { githubWaits, pullTitle } from './github-waits'
import type { InboxItem } from '@/lib/types'

const item = (id: string, o: Partial<InboxItem> = {}): InboxItem => ({
  id, kind: 'review', repo: 'mteichtahl/testyyyu', project: 'Test', summary: `Test: The Verification agent opened pull request #1, "Project purpose and requirements R1-R10". Its work counts once it is merged.`,
  createdAt: '2026-10-31T07:40:00.000Z', action: { label: 'Review on GitHub', href: 'https://github.com/mteichtahl/testyyyu/pull/1' }, pull: { repo: 'mteichtahl/testyyyu', number: 1 }, ...o,
})

describe('what a project waits for on GitHub', () => {
  it('this project\'s pull requests only, oldest first; not questions, gates or other projects', () => {
    const items = [
      item('review:2', { createdAt: '2026-10-31T09:00:00.000Z', pull: { repo: 'mteichtahl/testyyyu', number: 2 } }), item('review:1'),
      item('question:q', { kind: 'question', pull: undefined }), item('review:9', { repo: 'mteichtahl/trace-sample', pull: { repo: 'mteichtahl/trace-sample', number: 9 } }),
    ]
    expect(githubWaits(items, 'mteichtahl/testyyyu').map((i) => i.id)).toEqual(['review:1', 'review:2'])
    expect(githubWaits(undefined, 'mteichtahl/testyyyu')).toEqual([])
  })

  it('names a pull request by its own title', () => {
    expect(pullTitle(item('review:1'))).toBe('Project purpose and requirements R1-R10')
    expect(pullTitle(item('x', { summary: 'something else' }))).toBe('something else')
  })
})
