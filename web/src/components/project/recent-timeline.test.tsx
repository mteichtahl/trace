import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RecentItem } from '@/lib/types'

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => <a href={to} className={className}>{children}</a> }))
const { RecentTimeline } = await import('./recent-timeline')

const now = new Date('2026-11-03T10:00:00Z').getTime()
const items: RecentItem[] = [
  { id: '1', who: 'trace', text: 'Drafted the schematic', at: '2026-11-03T08:00:00Z' },
  { id: '2', who: 'Marc Teichtahl', text: 'Signed the Architecture gate', at: '2026-11-02T09:00:00Z', to: '/p/x/gates/architect' },
  { id: '3', who: 'Priya Shah', text: 'Answered a question', at: '2026-11-03T09:00:00Z', ref: 'Q-4' },
]

describe('RecentTimeline', () => {
  it('lists newest first under day labels, with who and a link where there is one', () => {
    render(<RecentTimeline items={items} now={now} />)
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Today', 'Yesterday'])
    const texts = screen.getAllByText(/Drafted|Signed|Answered/).map((e) => e.textContent)
    expect(texts[0]).toContain('Answered')
    expect(screen.getByText('Signed the Architecture gate').closest('a')).toHaveAttribute('href', '/p/x/gates/architect')
    expect(screen.getByLabelText('Priya Shah')).toHaveTextContent('PS')
  })

  it('keeps only the latest few', () => {
    render(<RecentTimeline items={items} limit={2} now={now} />)
    expect(screen.queryByText('Signed the Architecture gate')).not.toBeInTheDocument()
  })
})
