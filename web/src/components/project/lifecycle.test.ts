import { describe, expect, it } from 'vitest'
import { bannerWords, markWords, mayPause } from './lifecycle'
import { invalidationsFor } from '@/lib/live'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const at = (msAgo: number) => (NOW - msAgo) / 1000

describe('the paused and retired banner', () => {
  it('says nothing for an active project', () => {
    expect(bannerWords({ paused: null, retired: null }, NOW)).toBeNull()
    expect(bannerWords(undefined, NOW)).toBeNull()
  })
  it('says who paused it, when and why, and what that means', () => {
    const w = bannerWords({ paused: { at: at(2 * 3600_000), by: 'ana@example.com', reason: 'Waiting on parts' }, retired: null }, NOW)
    expect(w).toMatchObject({ title: 'This project is paused', retired: false, line: 'Paused by ana@example.com 2 hours ago: Waiting on parts.' })
    expect(w?.body).toMatch(/nothing can be changed and trace starts no work here until it is resumed/)
  })
  it('retired wins over paused, and says nothing was deleted', () => {
    const w = bannerWords({ paused: { at: at(60_000), by: 'a', reason: null }, retired: { at: at(60_000), by: 'marc@example.com', reason: null } }, NOW)
    expect(w).toMatchObject({ title: 'This project is retired', retired: true })
    expect(w?.body).toMatch(/Nothing has been deleted/)
  })
  it('a mark without a reason ends plainly', () => {
    expect(markWords('Paused', { at: at(10_000), by: 'x@example.com', reason: null }, NOW)).toBe('Paused by x@example.com just now.')
  })
})

describe('who may pause', () => {
  it('contributors and admins; reviewers not', () => {
    expect(mayPause({ admin: true })).toBe(true)
    expect(mayPause({ admin: false, part: 'contributor' })).toBe(true)
    expect(mayPause({ admin: false, part: 'reviewer' })).toBe(false)
    expect(mayPause({ admin: false })).toBe(false)
  })
})

describe('live events', () => {
  it('a lifecycle change refreshes the lists, the banner and Next', () => {
    const keys = invalidationsFor({ type: 'record.changed', repo: 'a/b', what: 'projects', at: '' })
    expect(keys).toEqual(expect.arrayContaining([['projects'], ['project.lifecycle', 'a/b'], ['projects.retired'], ['inbox']]))
  })
})
