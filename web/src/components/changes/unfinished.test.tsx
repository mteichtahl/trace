import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DecisionBar, barWords } from './decision-bar'
import { VERDICT_WORDS, changeLine } from '@/lib/guided'
import { verdictOf } from '@/lib/readers'

const change = { state: 'open' as const, may_accept: true, blockers: [], title: 'trace: board renders, incomplete export, not for approval', from: 'the Rendering specialist', verdict: 'unfinished' as const }

describe('a change its specialist says is not finished', () => {
  it('reads "Not finished" in the list, says why, and keeps the verdict the API sent', () => {
    expect(VERDICT_WORDS.unfinished.pill).toBe('Not finished')
    expect(changeLine({ ...change, checks: null } as never)).toBe('The Rendering specialist says it is not finished. trace recommends asking for changes.')
    expect(verdictOf({ verdict: 'unfinished', checks: null, mergeable: 'clean' })).toBe('unfinished')
  })

  it('leads with Ask for changes and says accepting takes it as it is; Accept is still the person\'s choice', () => {
    expect(barWords('ready', change)).toMatch(/^The Rendering specialist says this is not finished\. trace recommends asking for changes; accepting adds it to the design as it is\.$/)
    render(<DecisionBar change={change} part="contributor" note="" onAccept={() => undefined} onAsk={() => undefined} onDiscard={() => undefined} />)
    const ask = screen.getByRole('button', { name: 'Ask for changes' })
    const accept = screen.getByRole('button', { name: /Accept into the design/ })
    expect((accept as HTMLButtonElement).disabled).toBe(false)
    // the recommended step is the filled, larger button
    expect(ask.className).not.toBe(accept.className)
  })
})

describe('a change with an answer of yours not in it yet (test-esp32 log #131)', () => {
  const answers = [{ question: 'aqf54afeab7d8d4a', text: 'How does a user clear the saved Wi-Fi network?' }]
  const waiting = { ...change, title: 'Wi-Fi setup in the user guide', from: 'the Documentation specialist', answers }

  it('says trace is applying the answer, in the list and the bar, never "accept"', () => {
    const line = 'Waiting for trace to apply your answer to "How does a user clear the saved Wi-Fi network?". Once it has, this updates by itself.'
    expect(changeLine({ ...waiting, checks: null } as never)).toBe(line)
    expect(barWords('ready', waiting)).toBe(line)
  })

  it('does not lead with Ask for changes while trace applies it; does once trace will not on its own', () => {
    const { unmount } = render(<DecisionBar change={waiting} part="contributor" note="" onAccept={() => undefined} onAsk={() => undefined} onDiscard={() => undefined} />)
    const calm = screen.getByRole('button', { name: 'Ask for changes' }).className
    unmount()
    const stopped = { ...waiting, answers: [{ ...answers[0]!, stopped: 'its job was cancelled by alex@example.com' }] }
    expect(barWords('ready', stopped)).toBe('trace has not applied your answer to "How does a user clear the saved Wi-Fi network?": its job was cancelled by alex@example.com. Ask for changes with the answer before accepting it.')
    render(<DecisionBar change={stopped} part="contributor" note="" onAccept={() => undefined} onAsk={() => undefined} onDiscard={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Ask for changes' }).className).not.toBe(calm)
  })
})
