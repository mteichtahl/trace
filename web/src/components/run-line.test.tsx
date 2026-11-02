import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RunLine, runDetail, runState, splitRuns } from './run-line'
import { time } from '@/lib/format'
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

  describe('a running job the runtime no longer reports (test-2: "15 min so far, usually 3.5 min" for a lost job)', () => {
    const t0 = Date.parse('2026-11-02T10:00:00Z')
    const heard = { at: new Date(t0).toISOString(), overdueAt: new Date(t0 + 6 * 60_000).toISOString(), lostAt: new Date(t0 + 15 * 60_000).toISOString() }
    const r: RunSummary = { ...run, startedAt: new Date(t0 - 60_000).toISOString(), typicalS: 210, heard, controls: ['pause', 'cancel'] }

    it('is running while trace hears from it, then says it has not heard from it and when it is declared lost', () => {
      expect(runState(r, t0 + 60_000)).toBe('running')
      expect(runDetail(r, t0 + 60_000)).toMatch(/so far, usually/)
      expect(runState(r, t0 + 10 * 60_000)).toBe('silent')
      expect(runDetail(r, t0 + 10 * 60_000)).toBe(`trace has not heard from it since ${time(heard.at)} (10 min ago). If it stays silent, it is declared lost at ${time(heard.lostAt)}.`)
      expect(runDetail(r, t0 + 10 * 60_000)).not.toMatch(/so far/)
      expect(runState(r, t0 + 16 * 60_000)).toBe('lost')
    })

    it('the Overview lists it under trace is doing only while it is not lost; once lost it is over, with no controls', () => {
      const queued: RunSummary = { ...run, id: 'q', state: 'queued' }
      const lost: RunSummary = { ...run, id: 'l', state: 'lost', startedAt: new Date(t0).toISOString() }
      expect(splitRuns([r, queued, lost], t0 + 60_000)).toEqual({ doing: [r], ended: [lost] })
      const later = splitRuns([r], t0 + 16 * 60_000)
      expect(later.doing).toEqual([])
      expect(later.ended[0]).toMatchObject({ id: 'job-1', state: 'lost', controls: [], step: expect.stringMatching(/lost contact/) })
      // a day later it is no longer mentioned
      expect(splitRuns([lost], t0 + 25 * 3600_000).ended).toEqual([])
    })

    it('shows no controls once lost by the clock', () => {
      render(<RunLine run={{ ...r, heard: { ...heard, lostAt: new Date(Date.now() - 1000).toISOString(), overdueAt: new Date(Date.now() - 2000).toISOString() } }} onPause={noop} onCancel={noop} />)
      expect(screen.queryByRole('button', { name: 'Controls for Routing the board' })).toBeNull()
    })
  })
})
