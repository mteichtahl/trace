import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Heartbeat, WORKING_S, agoShort, beatWords, quietState } from './heartbeat'

const T = Date.parse('2026-11-03T10:47:33Z')
const iso = (msAgo: number) => new Date(T - msAgo).toISOString()

describe('quietState: quiet is not stopped', () => {
  it('working: a line in the last few seconds', () => {
    expect(quietState({ heardAt: iso(2_000), usualQuietS: 60 }, T)).toBe('working')
    expect(quietState({ heardAt: iso(WORKING_S * 1000), usualQuietS: 60 }, T)).toBe('working')
  })
  it('quiet: no lines, but no longer than this step usually goes quiet', () => {
    expect(quietState({ heardAt: iso(40_000), usualQuietS: 60 }, T)).toBe('quiet')
    expect(quietState({ heardAt: iso(60_000), usualQuietS: 60 }, T)).toBe('quiet')
  })
  it('late: past the step\'s usual quiet, when there is no overdue time', () => {
    expect(quietState({ heardAt: iso(61_000), usualQuietS: 60 }, T)).toBe('late')
  })
  it('a job\'s own overdue and lost times decide for it', () => {
    const job = { heardAt: iso(5 * 60_000), usualQuietS: 60, overdueAt: iso(-60_000), lostAt: iso(-10 * 60_000) }
    expect(quietState(job, T)).toBe('quiet')
    expect(quietState({ ...job, overdueAt: iso(1_000) }, T)).toBe('late')
    expect(quietState({ ...job, overdueAt: iso(60_000), lostAt: iso(1_000) }, T)).toBe('lost')
  })
  it('nothing said yet counts from the start, and is quiet until the usual is past', () => {
    expect(quietState({ heardAt: null, usualQuietS: 60 }, T)).toBe('quiet')
    expect(quietState({ heardAt: null, usualQuietS: 60, startedAt: iso(30_000) }, T)).toBe('quiet')
    expect(quietState({ heardAt: null, usualQuietS: 60, startedAt: iso(90_000) }, T)).toBe('late')
  })
})

describe('the words', () => {
  it('says how recently it spoke, in short words', () => {
    expect(agoShort(iso(500), T)).toBe('just now')
    expect(beatWords({ heardAt: iso(2_000), usualQuietS: 60 }, T)).toBe('newest line 2 s ago')
    expect(beatWords({ heardAt: iso(60_000), usualQuietS: 120 }, T)).toBe('quiet for 1 min · normal for this step')
  })
  it('later than usual says when it will be declared lost', () => {
    expect(beatWords({ heardAt: iso(4 * 60_000), usualQuietS: 60, overdueAt: iso(1_000), lostAt: '2026-11-03T11:20:00Z' }, T)).toMatch(/^later than usual: no word for 4 min · declared lost at \d\d:\d\d if still silent$/)
  })
  it('draws the dot with its state', () => {
    render(<Heartbeat beat={{ heardAt: new Date().toISOString(), usualQuietS: 60 }} />)
    expect(screen.getByText(/newest line/).closest('[data-quiet]')).toHaveAttribute('data-quiet', 'working')
  })
})
