/** A run's steps: from its session (the API) when there is one, else from its own steps (older answers, mocks). */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { RunRecordView } from '@/lib/types-s1'
import { RunSteps, pretty, stepsOf } from './run-steps'

const base = { id: 'run_2', kind: 'kicad.route', subject: null, started: 1000, finished: 1100, status: 'fail', summary: null } as RunRecordView

describe('a run\'s steps', () => {
  it('reads the session\'s tool calls, marks this run, and opens a failed step to what went in and came out', async () => {
    const r: RunRecordView = {
      ...base,
      steps: [{ id: 'old', title: 'ignored', state: 'done' }],
      session: {
        job: 'job_1', agent: 'Layout specialist',
        steps: [
          { id: 'run_1', kind: 'kicad.netclasses', summary: 'Set the net classes', status: 'pass', started: 900, finished: 960 },
          { id: 'run_2', kind: 'kicad.route', summary: 'Ran the autorouter', status: 'fail', started: 1000, finished: 1100, args: { passes: 12 }, result: { routed: 209, total: 212 } },
          { id: 'run_3', kind: 'agent.report', summary: null, status: 'running', started: 1100, finished: null },
        ],
      },
    }
    const steps = stepsOf(r, 1130)
    expect(steps.map((s) => [s.title, s.state, s.here ?? false])).toEqual([['Set the net classes', 'done', false], ['Ran the autorouter', 'failed', true], ['agent.report', 'running', false]])
    expect(steps[2]!.durationS).toBe(30)
    render(<RunSteps steps={steps} />)
    expect(screen.getByText('This run')).toBeInTheDocument()
    // a failed step with its args starts open
    expect(screen.getByText('What went in')).toBeInTheDocument()
    expect(screen.getByText(/"routed": 209/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Ran the autorouter/ }))
    expect(screen.queryByText('What went in')).toBeNull()
  })

  it('falls back to the run\'s own steps when there is no session', () => {
    const steps = stepsOf({ ...base, session: null, steps: [{ id: 's1', title: 'Build the power model', state: 'done', durationS: 50 }, { id: 's2', title: 'Sweep', state: 'queued' }] })
    expect(steps.map((s) => s.title)).toEqual(['Build the power model', 'Sweep'])
    render(<RunSteps steps={steps} />)
    expect(screen.getByText('Build the power model')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(stepsOf({ ...base })).toEqual([])
  })

  it('cuts long JSON short and pretty-prints text that parses', () => {
    expect(pretty('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(pretty('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}\n…`)
  })
})
