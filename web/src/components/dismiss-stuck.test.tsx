import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NeedsYouCard } from './needs-you-card'
import { dismissReason } from './dismiss-stuck'
import type { InboxItem } from '@/lib/types'

const stuck: InboxItem = {
  id: 'question:st1', kind: 'stuck', repo: 'acme/board', project: 'Soil sensor', summary: 'Soil sensor: the router is stuck: 3 nets cannot fit.',
  createdAt: new Date().toISOString(), action: { label: 'See options' }, questionId: 'st1',
}

describe('dismissing a stuck report', () => {
  it('takes a reason of one line, 3 to 300 characters', () => {
    expect(dismissReason('  ok ')).toBeNull()
    expect(dismissReason('U4 moves;\n the router is rerun.')).toBe('U4 moves; the router is rerun.')
    expect(dismissReason('x'.repeat(301))).toBeNull()
  })

  it('needs the reason before it sends, and sends the item with it', async () => {
    const onDismiss = vi.fn(async () => undefined)
    render(<NeedsYouCard item={stuck} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    const send = screen.getByRole('button', { name: 'Dismiss' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Why it can be dismissed'), 'U4 moves to the other side')
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(onDismiss).toHaveBeenCalledWith(stuck, 'U4 moves to the other side')
  })

  it('keeps what was typed when sending fails', async () => {
    const onDismiss = vi.fn(async () => { throw new Error('offline') })
    render(<NeedsYouCard item={stuck} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await userEvent.type(screen.getByLabelText('Why it can be dismissed'), 'The probe is retired')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByLabelText('Why it can be dismissed')).toHaveValue('The probe is retired')
  })

  it('is offered on stuck reports only, and only when the screen can send it', () => {
    const { rerender } = render(<NeedsYouCard item={{ ...stuck, kind: 'question' }} onDismiss={async () => undefined} />)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    rerender(<NeedsYouCard item={stuck} />)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
