import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RunLine, runDetail } from './run-line'
import type { RunSummary } from '@/lib/types'

const run: RunSummary = { id: 'job-1', title: 'Routing the board', state: 'running' }
const noop = () => undefined

describe('RunLine', () => {
  it('offers only what the job\'s view says job.control can do', async () => {
    render(<RunLine run={{ ...run, controls: ['cancel'] }} onPause={noop} onCancel={noop} onMoveUp={noop} />)
    await userEvent.click(screen.getByRole('button', { name: 'Controls for Routing the board' }))
    expect(screen.getByRole('menuitem', { name: 'Cancel…' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Pause' })).toBeNull()
  })

  it('has no menu when the job can do nothing', () => {
    render(<RunLine run={{ ...run, controls: [] }} onPause={noop} onCancel={noop} />)
    expect(screen.queryByRole('button', { name: 'Controls for Routing the board' })).toBeNull()
  })

  it('without controls in the view, shows what the screen offers', async () => {
    render(<RunLine run={run} onPause={noop} />)
    await userEvent.click(screen.getByRole('button', { name: 'Controls for Routing the board' }))
    expect(screen.getByRole('menuitem', { name: 'Pause' })).toBeInTheDocument()
  })

  it('pauses a running job and says what happens next; holds a queued one, resumes a held one, moves it up', async () => {
    const said: string[] = []
    const ok = (what: string) => async () => { said.push(what); return what }
    const { rerender } = render(<RunLine run={{ ...run, controls: ['pause', 'cancel'] }} onPause={ok('pause')} onResume={ok('resume')} onCancel={noop} />)
    await userEvent.click(screen.getByRole('button', { name: 'Controls for Routing the board' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pause' }))
    rerender(<RunLine run={{ ...run, state: 'queued', position: 2, controls: ['pause', 'move_up', 'cancel'] }} onPause={ok('hold')} onMoveUp={ok('up')} onCancel={noop} />)
    await userEvent.click(screen.getByRole('button', { name: 'Controls for Routing the board' }))
    expect(screen.getByRole('menuitem', { name: 'Hold in the queue' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move up the queue' }))
    rerender(<RunLine run={{ ...run, state: 'queued', held: true, controls: ['resume', 'cancel'] }} onResume={ok('release')} onCancel={noop} />)
    await userEvent.click(screen.getByRole('button', { name: 'Controls for Routing the board' }))
    expect(screen.queryByRole('menuitem', { name: 'Hold in the queue' })).toBeNull()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Resume' }))
    expect(said).toEqual(['pause', 'up', 'release'])
  })

  it('says where a queued, paused or lost job stands', () => {
    expect(runDetail({ ...run, state: 'queued', position: 1, startsWhen: 'the Verification agent is busy' }, 0)).toBe('Next in the queue: the Verification agent is busy')
    expect(runDetail({ ...run, state: 'queued', position: 3 }, 0)).toBe('Number 3 in the queue')
    expect(runDetail({ ...run, state: 'paused', pausedBy: 'priya@example.com', branch: 'claude/task-x' }, 0)).toBe('Paused by priya@example.com: its work so far is kept on claude/task-x. Resume carries on from there.')
    expect(runDetail({ ...run, state: 'lost', step: 'trace lost contact with it' }, 0)).toBe('trace lost contact with it')
  })
})
