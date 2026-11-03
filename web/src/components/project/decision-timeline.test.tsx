import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DecisionEntry } from '@/lib/types-s1'
import { DecisionTimeline, matches, timelineGroups } from './decision-timeline'

const now = new Date('2026-11-03T10:00:00Z').getTime()
const rows: DecisionEntry[] = [
  { id: 'a', kind: 'decision', title: 'Use the TPS54331 regulator', by: 'Marc', at: '2026-11-03T08:00:00Z', choice: 'TPS54331', recommended: true, state: 'closed' },
  { id: 'b', kind: 'gate', title: 'Define gate signed', by: 'Marc', at: '2026-11-02T09:00:00Z', state: 'signed', to: '/p/x/gates/define' },
  { id: 'c', kind: 'question', title: 'Supply voltage?', by: 'Marc', at: '2026-11-03T09:30:00Z', choice: '12 V', recommended: false, reason: 'The bench supply is 12 V', state: 'answered' },
  { id: 'd', kind: 'waiver', title: 'W-1: No EMC test', by: '—', at: '2026-11-03T09:59:00Z', state: 'active', undated: true },
]

describe('timelineGroups', () => {
  it('groups by day, newest first, with undated records last', () => {
    const g = timelineGroups(rows, now)
    expect(g.map((x) => x.label)).toEqual(['Today', 'Yesterday', 'In force, no date recorded'])
    expect(g[0]!.items.map((x) => x.id)).toEqual(['c', 'a'])
    expect(g[2]!.items.map((x) => x.id)).toEqual(['d'])
  })
})

describe('matches', () => {
  it('searches title, choice, reason and who', () => {
    expect(matches(rows[2]!, 'bench')).toBe(true)
    expect(matches(rows[0]!, 'tps')).toBe(true)
    expect(matches(rows[0]!, 'emc')).toBe(false)
  })
})

describe('DecisionTimeline', () => {
  it('shows each decision with its recommendation, filters by kind and opens a gate', () => {
    const onOpen = vi.fn()
    render(<DecisionTimeline rows={rows} onOpen={onOpen} />)
    expect(screen.getByText('Not the recommendation')).toBeInTheDocument()
    expect(screen.getByText(/The bench supply is 12 V/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Gates/ }))
    expect(screen.queryByText('Supply voltage?')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Define gate signed'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('says so when nothing matches the search', () => {
    render(<DecisionTimeline rows={rows} onOpen={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Search decisions'), { target: { value: 'nothing like this' } })
    expect(screen.getByText(/No decisions match/)).toBeInTheDocument()
  })
})
