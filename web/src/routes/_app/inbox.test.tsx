import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DecisionCard } from '@/components/decision-card'
import type { InboxItem } from '@/lib/types'
import { decisionFor, inboxItems } from './inbox'

const q: InboxItem = {
  id: 'n2', kind: 'question', repo: 'acme/motor-driver', project: 'Motor driver', summary: 'Stall current? **It recommends 4.2 A**', createdAt: new Date().toISOString(),
  action: { label: 'Answer' }, recommended: { id: '4.2', label: 'Use 4.2 A' }, questionId: 'q-stall',
}

describe('Inbox', () => {
  it('keeps the four kinds only', () => {
    const odd = { ...q, id: 'x', kind: 'digest' as unknown as InboxItem['kind'] }
    expect(inboxItems([q, odd]).map((i) => i.id)).toEqual(['n2'])
  })

  it('Other answer needs your answer and a reason before it sends', async () => {
    const onChoose = vi.fn()
    const qc = new QueryClient()
    render(<QueryClientProvider client={qc}><DecisionCard decision={decisionFor(q)} onChoose={onChoose} /></QueryClientProvider>)
    expect(screen.getByRole('button', { name: 'Use 4.2 A' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Choose another' }))
    await userEvent.click(screen.getByLabelText(/Other answer/))
    const send = screen.getByRole('button', { name: 'Send this answer' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Your answer'), 'Use 3.8 A')
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Your reason'), 'Bench measured 3.8 A')
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(onChoose).toHaveBeenCalledWith({ option: '__other', recommended: false, reason: 'Bench measured 3.8 A', answer: 'Use 3.8 A' })
  })
})
