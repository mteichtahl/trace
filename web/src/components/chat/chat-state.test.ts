// The Ask trace panel's thread choice (chat-state.ts): the last conversation reopened when the panel opens never
// replaces one a person started meanwhile, and a first message that creates its thread keeps the view it was typed in.
import { beforeEach, describe, expect, it } from 'vitest'
import { panel, reopenLast, setThread, threadCreated } from './chat-state'

const REPO = 'acme/soil-sensor'

describe('the panel thread', () => {
  beforeEach(() => panel.set((s) => ({ ...s, threads: {}, opened: {}, history: false })))

  it('reopens the last conversation when nothing was chosen or started yet', () => {
    reopenLast(REPO, 'th-old')
    expect(panel.get().threads[REPO]).toBe('th-old')
    expect(panel.get().opened[REPO]).toBe(1)
  })

  it('keeps a conversation started while the last one was being looked up (the lookup answers late)', () => {
    // the person sent a message in the new conversation the panel showed: it made its thread
    threadCreated(REPO, 'th-new')
    // then the lookup, which read the list before that thread existed, answers with an older one
    reopenLast(REPO, 'th-old')
    expect(panel.get().threads[REPO]).toBe('th-new')
  })

  it('keeps a new conversation a person chose, and a thread they picked, over a late lookup', () => {
    setThread(REPO, undefined)
    reopenLast(REPO, 'th-old')
    expect(panel.get().threads[REPO]).toBeUndefined()
    setThread(REPO, 'th-picked')
    reopenLast(REPO, 'th-old')
    expect(panel.get().threads[REPO]).toBe('th-picked')
  })

  it('rebuilds the view when a person opens a thread, never when a first message creates one', () => {
    setThread(REPO, undefined)
    const before = panel.get().opened[REPO]
    threadCreated(REPO, 'th-new')
    expect(panel.get().opened[REPO]).toBe(before)
    expect(panel.get().threads[REPO]).toBe('th-new')
    setThread(REPO, 'th-other')
    expect(panel.get().opened[REPO]).toBe((before ?? 0) + 1)
  })
})
