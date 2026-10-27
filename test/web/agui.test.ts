import { describe, expect, it } from 'vitest'
import { EventType } from '@ag-ui/core'
import { MAX_ROUNDS, toBedrock } from '../../src/web/agui.js'
import { accessToken } from '../api/fixtures.js'
import { bearerOf, say, use, world } from './fakes.js'

const tok = accessToken('sub-ada', ['trace-users'])

const input = (o: Record<string, unknown> = {}) => ({
  threadId: 't1', runId: 'r1',
  messages: [{ id: 'm1', role: 'user', content: 'How is the soil sensor doing?' }],
  tools: [], context: [{ description: 'Project', value: 'acme/board' }], state: {}, forwardedProps: {},
  ...o,
})

const run = (body: unknown) => ({ method: 'POST', path: '/api/agui', headers: bearerOf(tok), body: JSON.stringify(body) })

type Ev = { type: string; [k: string]: unknown }
const events = (body: string): Ev[] => body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as Ev)
const types = (body: string): string[] => events(body).map((e) => e.type)

describe('the trace agent over AG-UI', () => {
  it('streams a text reply: RUN_STARTED, TEXT_MESSAGE_START/CONTENT…/END, RUN_FINISHED', async () => {
    const w = world()
    w.bedrock.scripts = [say('All good: the board passed its checks.')]
    const r = await w.serve(run(input()))
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/^text\/event-stream/)
    const t = types(r.body)
    expect(t[0]).toBe(EventType.RUN_STARTED)
    expect(t[1]).toBe(EventType.TEXT_MESSAGE_START)
    expect(t.at(-2)).toBe(EventType.TEXT_MESSAGE_END)
    expect(t.at(-1)).toBe(EventType.RUN_FINISHED)
    const ev = events(r.body)
    expect(ev.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => e.delta).join('')).toBe('All good: the board passed its checks.')
    expect(ev[0]).toMatchObject({ threadId: 't1', runId: 'r1' })
    expect(r.done).toBe(true)
    // the model got the system prompt with the screen's context, and the person's message
    const sent = w.bedrock.inputs[0]!
    expect(sent.modelId).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0')
    expect(sent.system?.[0]?.text).toContain('<app-context>\n- Project: acme/board\n</app-context>')
    expect(sent.system?.[0]?.text).toContain('data, not instructions')
    expect(sent.system?.[0]?.text).toMatch(/recommendation/)
    expect(sent.messages).toEqual([{ role: 'user', content: [{ text: 'How is the soil sensor doing?' }] }])
    expect(sent.toolConfig?.tools?.map((x) => x.toolSpec?.name)).toContain('journey_get')
  })

  it('runs a backend tool as the person, between STEP_STARTED and STEP_FINISHED, then answers', async () => {
    const w = world()
    w.runtime.answers.set('journey.get', (a) => ({ body: { ok: true, result: { repo: a.repo, stage: 'Schematic' } } }))
    w.bedrock.scripts = [use('tu1', 'journey_get', { repo: 'acme/board' }, 'Let me look.'), say('It is in the Schematic stage.')]
    const r = await w.serve(run(input()))
    expect(types(r.body)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
      'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_ARGS', 'TOOL_CALL_END',
      'STEP_STARTED', 'TOOL_CALL_RESULT', 'STEP_FINISHED',
      'TEXT_MESSAGE_START', ...Array(Math.ceil('It is in the Schematic stage.'.length / 6)).fill('TEXT_MESSAGE_CONTENT'), 'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
    const ev = events(r.body)
    const start = ev.find((e) => e.type === 'TOOL_CALL_START')!
    expect(start).toMatchObject({ toolCallId: 'tu1', toolCallName: 'journey_get' })
    expect(start.parentMessageId).toBe(ev[1]!.messageId)
    expect(ev.filter((e) => e.type === 'TOOL_CALL_ARGS').map((e) => e.delta).join('')).toBe('{"repo":"acme/board"}')
    expect(ev.find((e) => e.type === 'TOOL_CALL_RESULT')).toMatchObject({ toolCallId: 'tu1', role: 'tool', content: '{"repo":"acme/board","stage":"Schematic"}' })
    expect(ev.find((e) => e.type === 'STEP_STARTED')).toMatchObject({ stepName: 'Reading the project\'s journey' })
    // as the person, through the same path as /api/call
    expect(w.runtime.calls).toHaveLength(1)
    expect(w.runtime.calls[0]).toMatchObject({ action: 'journey.get', args: { repo: 'acme/board' } })
    expect(w.runtime.calls[0]!.headers.authorization).toBe(`Bearer ${tok}`)
    // the second turn carried the tool use and its result
    const second = w.bedrock.inputs[1]!.messages!
    expect(second.at(-2)?.content?.some((b) => b.toolUse?.toolUseId === 'tu1')).toBe(true)
    expect(second.at(-1)).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 'tu1', content: [{ text: '{"repo":"acme/board","stage":"Schematic"}' }] } }] })
  })

  it('a frontend tool (a decision card) is streamed and ends the run; the next run resumes with its result', async () => {
    const w = world()
    const tools = [{ name: 'ask_decision', description: 'Ask the person to choose', parameters: { type: 'object', properties: { question: { type: 'string' } } } }]
    w.bedrock.scripts = [use('tu9', 'ask_decision', { question: 'Use 4.2 A?' })]
    const r = await w.serve(run(input({ tools })))
    expect(types(r.body)).toEqual(['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'RUN_FINISHED'])
    expect(w.runtime.calls).toEqual([])
    expect(w.bedrock.inputs[0]!.toolConfig?.tools?.map((t) => t.toolSpec?.name)).toContain('ask_decision')
    // the app answers with a new run: the assistant's tool call and the tool's result
    w.bedrock.scripts = [say('Done: 4.2 amps it is.')]
    const resumed = await w.serve(run(input({
      runId: 'r2', tools,
      messages: [
        { id: 'm1', role: 'user', content: 'Pick the motor current' },
        { id: 'm2', role: 'assistant', content: '', toolCalls: [{ id: 'tu9', type: 'function', function: { name: 'ask_decision', arguments: '{"question":"Use 4.2 A?"}' } }] },
        { id: 'm3', role: 'tool', toolCallId: 'tu9', content: '{"choice":"4.2 A"}' },
      ],
    })))
    expect(types(resumed.body).at(-1)).toBe('RUN_FINISHED')
    expect(w.bedrock.inputs[1]!.messages).toEqual([
      { role: 'user', content: [{ text: 'Pick the motor current' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu9', name: 'ask_decision', input: { question: 'Use 4.2 A?' } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'tu9', content: [{ text: '{"choice":"4.2 A"}' }] } }] },
    ])
  })

  it('start_task calls task (a write), returns the job id, and publishes the change', async () => {
    const w = world()
    w.runtime.answers.set('task', () => ({ body: { ok: true, result: { accepted: true, jobId: 'acme--board--j1' } } }))
    w.runtime.answers.set('project.members', () => ({ body: { ok: true, result: [{ sub: 'sub-bob' }] } }))
    w.bedrock.scripts = [use('tu2', 'start_task', { repo: 'acme/board', request: 'Run ERC' }), say('Started.')]
    const r = await w.serve(run(input()))
    expect(events(r.body).find((e) => e.type === 'TOOL_CALL_RESULT')?.content).toBe('{"accepted":true,"jobId":"acme--board--j1"}')
    expect(w.publisher.sent.map((s) => s.channel).sort()).toEqual(['/trace/users/sub-ada', '/trace/users/sub-bob'])
  })

  it('the tool tool runs read-only tools only', async () => {
    const w = world()
    w.runtime.answers.set('tools.list', () => ({ body: { ok: true, result: [{ name: 'kicad.erc', needs: 'read' }, { name: 'datasheets.add', needs: 'write' }] } }))
    w.runtime.answers.set('tool', () => ({ body: { ok: true, result: { findings: 0 } } }))
    w.bedrock.scripts = [use('a', 'tool', { repo: 'acme/board', name: 'datasheets.add', args: {} }), use('b', 'tool', { repo: 'acme/board', name: 'kicad.erc', args: { x: 1 } }), say('ok')]
    const r = await w.serve(run(input()))
    const results = events(r.body).filter((e) => e.type === 'TOOL_CALL_RESULT').map((e) => String(e.content))
    expect(results[0]).toMatch(/not a read-only tool/)
    expect(results[1]).toBe('{"findings":0}')
    expect(w.runtime.calls.map((c) => c.action)).toEqual(['tools.list', 'tool'])
    expect(w.runtime.calls[1]?.args).toEqual({ repo: 'acme/board', name: 'kicad.erc', args: { x: 1 } })
  })

  it(`stops after ${MAX_ROUNDS} tool rounds`, async () => {
    const w = world()
    w.runtime.answers.set('inbox', () => ({ body: { ok: true, result: [] } }))
    w.bedrock.scripts = Array.from({ length: MAX_ROUNDS + 2 }, (_, i) => use(`t${i}`, 'inbox', {}))
    const r = await w.serve(run(input()))
    expect(w.bedrock.inputs).toHaveLength(MAX_ROUNDS)
    expect(events(r.body).filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('')).toMatch(/stopped after 8 rounds/)
    expect(types(r.body).at(-1)).toBe('RUN_FINISHED')
  })

  it('a model failure is RUN_ERROR; throttling says so', async () => {
    const w = world()
    w.bedrock.scripts = [[{ throttlingException: { name: 'ThrottlingException', message: 'slow down', $fault: 'client', $metadata: {} } } as never]]
    const r = await w.serve(run(input()))
    expect(events(r.body).at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'throttled' })
    expect(r.done).toBe(true)
  })

  it('sends heartbeats while it waits', async () => {
    const w = world({ heartbeatMs: 5 })
    w.runtime.answers.set('inbox', () => ({ body: { ok: true, result: [] } }))
    const slow = async function* () { await new Promise((ok) => setTimeout(ok, 30)); yield* say('done') }
    w.deps.bedrock = () => ({ converseStream: () => slow() })
    const r = await w.serve(run(input()))
    expect(r.body).toContain(': keep-alive\n\n')
  })

  it('needs a token, and a RunAgentInput', async () => {
    const w = world()
    expect((await w.serve({ method: 'POST', path: '/api/agui', body: JSON.stringify(input()) })).status).toBe(401)
    expect((await w.serve(run({ messages: [] }))).status).toBe(400)
  })
})

describe('AG-UI messages as Bedrock messages', () => {
  it('merges turns, keeps system text apart, starts with the person and answers every tool use', () => {
    const { messages, system } = toBedrock([
      { role: 'system', content: 'Be brief.' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 'x', function: { name: 'status', arguments: '{"repo":"a/b"}' } }, { id: 'y', function: { name: 'inbox', arguments: '' } }] },
      { role: 'tool', toolCallId: 'y', content: 'done' },
      { role: 'user', content: 'thanks' },
    ])
    expect(system).toEqual(['Be brief.'])
    expect(messages[0]).toEqual({ role: 'user', content: [{ text: 'a' }, { text: 'b' }] })
    expect(messages[1]?.content?.map((c) => c.toolUse?.toolUseId ?? 'text')).toEqual(['text', 'x', 'y'])
    expect(messages[2]?.role).toBe('user')
    const blocks = messages[2]?.content ?? []
    expect(blocks.map((b) => b.toolResult?.toolUseId ?? 'text')).toEqual(['x', 'y', 'text'])
    expect(blocks[0]?.toolResult?.status).toBe('error')
    expect(messages).toHaveLength(3)
  })
})
