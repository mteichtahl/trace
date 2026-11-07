import { describe, expect, it, vi } from 'vitest'

const events = [
  { type: 'RUN_STARTED' },
  { type: 'TEXT_MESSAGE_START', messageId: 'a' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'You can change it later.' }, { type: 'TEXT_MESSAGE_END', messageId: 'a' },
  { type: 'TEXT_MESSAGE_START', messageId: 'b' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b', delta: '- The text is your own wording.' }, { type: 'TEXT_MESSAGE_END', messageId: 'b' },
  { type: 'RUN_FINISHED' },
]
vi.mock('@/components/chat/agent', () => ({
  signedFetch: async () => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 }),
}))

// test-esp32 #85: a reply in several text messages ran together ("…later.- The text is your own wording.")
describe('askOnce', () => {
  it('starts each text message of the reply on a new paragraph', async () => {
    const { askOnce } = await import('./agui-once')
    expect(await askOnce({ prompt: 'x' })).toBe('You can change it later.\n\n- The text is your own wording.')
  })
})
