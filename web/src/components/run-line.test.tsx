import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RunLine } from './run-line'
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
})
