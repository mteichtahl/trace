import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let resolveSpeak: (v: { url: string; marks: never[] }) => void = () => {}
vi.mock('@/lib/api', () => ({
  api: vi.fn(() => new Promise((r) => { resolveSpeak = r })),
}))

const { enqueueSpeech, isSpeaking, speak, speech, stopSpeaking } = await import('./speech')

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  stopSpeaking()
  vi.restoreAllMocks()
})

describe('stopping the voice', () => {
  it('shows a loading voice as speaking, so Stop is offered straight away', () => {
    void speak('m1', 'Hello there')
    expect(speech.get()).toMatchObject({ messageId: 'm1', loading: true, playing: false })
    expect(isSpeaking()).toBe(true)
  })

  it('never starts a voice that was stopped while it was loading', async () => {
    const p = speak('m1', 'Hello there')
    stopSpeaking()
    resolveSpeak({ url: 'blob:x', marks: [] })
    await p
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(speech.get()).toMatchObject({ messageId: null, loading: false, playing: false })
  })

  it('clears replies queued to be read next', async () => {
    const p = speak('m1', 'First')
    enqueueSpeech('m2', 'Second')
    stopSpeaking()
    resolveSpeak({ url: 'blob:x', marks: [] })
    await p
    expect(isSpeaking()).toBe(false)
  })

  it('stops with Escape', async () => {
    const { stopOnEscape } = await import('./speech')
    stopOnEscape()
    void speak('m1', 'Hello there')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(isSpeaking()).toBe(false)
  })
})
