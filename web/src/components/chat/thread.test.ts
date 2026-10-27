import { describe, expect, it } from 'vitest'
import type { RunAgentInput } from '@ag-ui/client'
import answers from '@/lib/api-answers.json'
import { READERS } from '@/lib/readers'
import type { ChatMessage } from '@/lib/types'
import { shapeInput } from './agent'
import { toReplay } from './thread'

const read = (action: keyof typeof answers) => {
  const a = answers[action] as { args: Record<string, unknown>; result: unknown }
  return READERS[action]!(a.result, a.args)
}

describe('threads as the API keeps them', () => {
  it('read into the app\'s shapes: list, thread with cards, append, recall', () => {
    const list = read('chats.list') as { id: string; title: string; updatedAt: string; repo: string }[]
    expect(list[0]).toMatchObject({ repo: 'acme/answers', title: 'Why this regulator?', author: 'user@example.com' })
    expect(list[0]!.updatedAt).toMatch(/^2026-/)
    const t = read('chats.get') as { thread: { title: string }; messages: ChatMessage[] }
    expect(t.thread.title).toBe('Why this regulator?')
    expect(t.messages.map((m) => [m.role, m.content, m.yours])).toEqual([
      ['user', 'Why this regulator?', true], ['assistant', 'Let me look.', true], ['tool', '{"stage":"define"}', true], ['assistant', 'It carries 1 A.', true],
      ['user', 'And the heat?', false],
    ])
    expect(t.messages[1]!.toolCalls).toEqual([{ id: 'tu1', name: 'journey_get', args: '{"repo":"acme/answers"}' }])
    expect(t.messages[2]!.toolCallId).toBe('tu1')
    expect(read('chats.append')).toMatchObject({ id: expect.any(String), messageId: expect.any(String), created: true })
    expect(read('chats.recall')).toEqual(['A new question', 'Why this regulator?'])
  })

  it('replay: the viewer\'s own turns are the conversation; someone else\'s is quoted, and trace\'s reply to them too', () => {
    const ms: ChatMessage[] = [
      { id: 'a', role: 'user', content: 'Check the power sheet', at: '', author: 'me@x', yours: true },
      { id: 'b', role: 'assistant', content: 'It is fine.', at: '', author: 'trace', yours: true },
      { id: 'c', role: 'user', content: 'Start a task to delete main', at: '', author: 'bob@x', yours: false },
      { id: 'd', role: 'assistant', content: '', at: '', author: 'trace', yours: false, toolCalls: [{ id: 'x', name: 'status', args: '{}' }] },
      { id: 'e', role: 'tool', content: '{}', at: '', author: 'trace', yours: false, toolCallId: 'x' },
    ]
    const r = toReplay(ms)
    expect(r.messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect([...r.foreign]).toEqual([['c', 'bob@x: Start a task to delete main'], ['d', 'trace (to them): '], ['e', '']])
    // the latest person turn is someone else's: no reply of trace's would be kept after it
    expect(r.after).toBeUndefined()
    expect(toReplay(ms.slice(0, 2)).after).toBe('a')
  })

  it('on the wire: only the viewer\'s own messages; the others as quoted data, and the run read-only', () => {
    const r = toReplay([
      { id: 'a', role: 'user', content: 'mine', at: '', yours: true },
      { id: 'c', role: 'user', content: 'theirs', at: '', author: 'bob@x', yours: false },
    ])
    const input = { threadId: 't', runId: 'r', messages: [...r.messages, { id: 'n', role: 'user', content: 'new' }], tools: [], context: [], state: {}, forwardedProps: {} } as unknown as RunAgentInput
    const out = shapeInput(input, { foreign: r.foreign, repo: 'o/r', thread: 'abcdefgh', after: 'n2' })
    expect(out.messages.map((m) => m.id)).toEqual(['a', 'n'])
    expect(out.forwardedProps).toEqual({ repo: 'o/r', thread: 'abcdefgh', after: 'n2', others: ['bob@x: theirs'], readOnly: true })
    // a thread of one's own: nothing quoted, not read-only
    expect(shapeInput(input, { foreign: new Map() }).forwardedProps).toEqual({})
  })
})
