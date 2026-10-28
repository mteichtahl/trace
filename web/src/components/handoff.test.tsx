import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HandoffRow, declinable, declineReason } from './handoff'
import { HandOff } from './chat/cards'
import { handle } from '@/mock/handlers'
import type { Handoff, ProjectJobs } from '@/lib/types'

const queued: Handoff = {
  id: 'ho1', from: 'thermal', fromName: 'Thermal', to: 'ams', toName: 'Analog and mixed-signal', fromWorkerJobId: 'job-th',
  question: 'What is the worst-case dissipation of the LDO U3 at 85 °C?', blocks: 'the junction temperature check of U3',
  evidence: [{ kind: 'run', id: 'run-1', label: 'run-1' }], recommendation: 'About 0.9 W.', acceptance: ['the dissipation in watts, with the run id'],
  summary: 'Thermal → Analog and mixed-signal: What is the worst-case dissipation of the LDO U3 at 85 °C?', state: 'queued',
  says: 'Queued for the Analog and mixed-signal specialist.', createdAt: new Date().toISOString(),
}
const answered: Handoff = {
  ...queued, id: 'ho2', state: 'answered', says: 'Answered.',
  answer: { answered: true, text: '0.85 W at 500 mA.', summary: '0.85 W at 500 mA.', evidence: [{ kind: 'run', id: 'run-9', label: 'run-9' }], confidence: 0.8, acceptanceMet: true, at: new Date().toISOString() },
}

describe('a hand-off between specialists', () => {
  it('says who asked whom, the question and where it stands; unfolded, the request and the answer', async () => {
    render(<HandoffRow handoff={answered} />)
    expect(screen.getByRole('button', { name: 'Hand-off from the Thermal specialist to the Analog and mixed-signal specialist' })).toBeInTheDocument()
    expect(screen.getByText(queued.question)).toBeInTheDocument()
    expect(screen.getByText('Answered', { selector: 'span' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Hand-off from the Thermal/ }))
    expect(screen.getByText('the junction temperature check of U3')).toBeInTheDocument()
    expect(screen.getByText('About 0.9 W.')).toBeInTheDocument()
    expect(screen.getByText('the dissipation in watts, with the run id')).toBeInTheDocument()
    expect(screen.getByText('0.85 W at 500 mA.')).toBeInTheDocument()
    expect(screen.getByText(/confidence 80% · everything asked for is there/)).toBeInTheDocument()
  })

  it('a pending one can be declined, with a reason in one line, by people who may change the project only', async () => {
    expect(declinable(queued)).toBe(true)
    expect(declinable(answered)).toBe(false)
    expect(declinable({ state: 'running' })).toBe(false)
    expect(declineReason(' ok ')).toBeNull()
    expect(declineReason('The bench\n measures it.')).toBe('The bench measures it.')
    const onDecline = vi.fn(async () => 'Its queued job was cancelled.')
    const { rerender } = render(<HandoffRow handoff={queued} />)
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    rerender(<HandoffRow handoff={answered} onDecline={onDecline} />)
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    rerender(<HandoffRow handoff={queued} onDecline={onDecline} />)
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    const send = screen.getByRole('button', { name: 'Decline' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Why it is declined'), 'The bench measures it on Friday')
    await userEvent.click(send)
    expect(onDecline).toHaveBeenCalledWith(queued, 'The bench measures it on Friday')
  })

  it('keeps what was typed when declining fails', async () => {
    const onDecline = vi.fn(async () => { throw new Error('Its job is already running: cancel that job instead.') })
    render(<HandoffRow handoff={queued} onDecline={onDecline} />)
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await userEvent.type(screen.getByLabelText('Why it is declined'), 'Not needed now')
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(screen.getByLabelText('Why it is declined')).toHaveValue('Not needed now')
  })

  it('in chat, the Hand-off row shows a recorded hand-off\'s request and answer', async () => {
    render(<HandOff specialist="Analog and mixed-signal" steps={[]} state="done" handoff={answered} />)
    expect(screen.getByText(/specialist asked the/)).toHaveTextContent('The Thermal specialist asked the Analog and mixed-signal: Answered.')
    await userEvent.click(screen.getByRole('button'))
    expect(screen.getByText('0.85 W at 500 mA.')).toBeInTheDocument()
  })

  it('mock mode lists hand-offs and declines a queued one, taking its job out of the queue', async () => {
    const list = async (): Promise<ProjectJobs> => ((await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action: 'jobs.list', repo: 'acme/soil-sensor' }) })).json()) as { result: ProjectJobs }).result
    const before = await list()
    const h = before.handoffs.find((x) => x.state === 'queued')!
    expect(before.jobs.find((j) => j.handoff?.id === h.id)?.title).toMatch(/^Asked by the Thermal specialist: /)
    const r = await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action: 'handoff.decline', repo: 'acme/soil-sensor', id: h.id, reason: 'Measured on the bench.' }) })).json() as { ok: boolean }
    expect(r.ok).toBe(true)
    const after = await list()
    expect(after.handoffs.find((x) => x.id === h.id)).toMatchObject({ state: 'declined', declined: { reason: 'Measured on the bench.' } })
    expect(after.jobs.some((j) => j.handoff?.id === h.id)).toBe(false)
  })
})
