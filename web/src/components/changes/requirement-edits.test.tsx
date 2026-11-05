import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DecisionBar, barWords } from './decision-bar'
import { RequirementEditsNotice, acceptWithEdits } from './requirement-edits'
import type { RequirementEdits } from '@/lib/types'

const edits: RequirementEdits = {
  ids: ['REQ-367d71'], reopens: true, asked: null,
  says: 'Changes a requirement (REQ-367d71): accepting it reopens Define and every gate after it.',
  edits: [{ id: 'REQ-367d71', what: 'REQ-367d71: its acceptance criterion changes from "GND, 3V3, SCL, SDA" to "pin 1 is GND".' }],
}

describe('a change that edits an accepted requirement (test-esp32 log #112)', () => {
  it('says which requirement, what changes in it, and that nothing asked for it', () => {
    render(<RequirementEditsNotice edits={edits} />)
    expect(screen.getByRole('heading', { name: edits.says })).toBeInTheDocument()
    expect(screen.getByText(/its acceptance criterion changes from/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing asked for this edit.*Ask for changes to keep the requirement as agreed/)).toBeInTheDocument()
  })

  it('names what asked for it, when something did', () => {
    render(<RequirementEditsNotice edits={{ ...edits, asked: 'The answer to question Q-1 said it changes a requirement.' }} />)
    expect(screen.getByText('The answer to question Q-1 said it changes a requirement.')).toBeInTheDocument()
  })

  it('the decision bar says accepting reopens Define, before the person accepts', () => {
    const says = acceptWithEdits(edits)
    expect(says).toBe('Accepting adds it to the design and reopens Define: REQ-367d71 is agreed again, and every gate from Define on is signed again.')
    expect(barWords('ready', { state: 'open', blockers: [], from: 'the Verification specialist', verdict: 'ready' }, says)).toBe(says)
    expect(acceptWithEdits({ ...edits, reopens: false })).toBe('Accepting adds it to the design and sends REQ-367d71 back to Requirements review.')
  })

  it('the decision bar leads with Ask for changes when trace recommends it; Accept stays the person\'s choice', () => {
    const base = { state: 'open' as const, may_accept: true, blockers: [], title: 'OLED connector pin-order note', from: 'the Verification specialist', verdict: 'ready' as const }
    const noop = () => undefined
    const { unmount } = render(<DecisionBar change={{ ...base, recommendation: { verdict: 'accept', why: '' } }} part="contributor" note="" onAccept={noop} onAsk={noop} onDiscard={noop} />)
    const leading = screen.getByRole('button', { name: 'Accept into the design' }).className
    unmount()
    render(<DecisionBar change={{ ...base, recommendation: { verdict: 'ask', why: edits.says } }} part="contributor" note="" onAccept={noop} onAsk={noop} onDiscard={noop} />)
    expect(screen.getByRole('button', { name: 'Ask for changes' }).className).toBe(leading)
    const accept = screen.getByRole('button', { name: 'Accept into the design' }) as HTMLButtonElement
    expect(accept.className).not.toBe(leading)
    expect(accept.disabled).toBe(false)
  })
})
