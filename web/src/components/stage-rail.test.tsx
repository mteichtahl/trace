import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { JOURNEYS } from '@/mock/fixtures'
import type { Stage } from '@/lib/types'
import { StageRail, stageRailLabel } from './stage-rail'

const st = (name: string, state: Stage['state'], met = 0, total = 0, extra: Partial<Stage> = {}): Stage => ({ id: name.toLowerCase(), name, state, criteria: { met, total }, ...extra })

describe('StageRail', () => {
  it('reads as "Stage 3 of 9, Capture, 4 of 6 criteria met"', () => {
    const stages = ['Define', 'Architect', 'Capture', 'Prove', 'Layout', 'Sign-off', 'Release', 'Fabricate', 'Bring up'].map((n, i) =>
      st(n, i < 2 ? 'done' : i === 2 ? 'current' : 'queued', i === 2 ? 4 : 0, i === 2 ? 6 : 0),
    )
    expect(stageRailLabel(stages)).toBe('Stage 3 of 9, Capture, 4 of 6 criteria met')
  })

  it('names a reopened stage and why', () => {
    const stages = [st('Define', 'done'), st('Capture', 'reopened', 2, 6, { reopened: { reason: 'datasheet conflict found in Prove' } }), st('Prove', 'queued')]
    expect(stageRailLabel(stages)).toBe('Stage 2 of 3, Capture, 2 of 6 criteria met, reopened: datasheet conflict found in Prove')
  })

  it('every form carries the label for screen readers', () => {
    const j = JOURNEYS['acme/soil-sensor']!
    const label = 'Stage 3 of 9, Capture, 4 of 6 criteria met'
    for (const variant of ['full', 'compact', 'bar'] as const) {
      const { unmount } = render(
        <TooltipProvider>
          <StageRail stages={j.stages} gates={j.gates} variant={variant} />
        </TooltipProvider>,
      )
      expect(screen.getByLabelText(label)).toBeInTheDocument()
      unmount()
    }
  })

  it('marks the current stage and labels queued ones', () => {
    const j = JOURNEYS['acme/soil-sensor']!
    render(
      <TooltipProvider>
        <StageRail stages={j.stages} gates={j.gates} />
      </TooltipProvider>,
    )
    const current = screen.getByRole('button', { current: 'step' })
    expect(current).toHaveAccessibleName('Capture: 4 of 6 criteria met')
    expect(screen.getAllByText('Queued')).toHaveLength(6)
    expect(screen.getByText('Firmware track')).toBeInTheDocument()
  })
})
