/**
 * Ask trace's conversations into memory (src/api/actions-chats.ts recordTurns): only the person's own user turns, under
 * their own person actor (never their email), one session per thread, and only for people who may write to the
 * project. trace's replies and tool rows are never recorded, a guest's turns are not recorded, and nothing in the
 * chat's recording writes the project's `chat` actor (memory.remember alone does, on a person's Confirm). Best-effort:
 * a memory failure never fails the chat.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentMemory, type ProjectMemories, type SendClient, chatActor, chatSession, personActor } from '../../src/agents/runtime/memory.js'
import { recordingActor } from '../../src/api/actions-chats.js'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'cm-admin', email: 'cm-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'cm-user', email: 'cm-user@example.com', groups: ['trace-users'] }
const GUEST = { sub: 'cm-guest', email: 'cm-guest@example.com', groups: ['trace-guests'] }
const CHAT = 'acme/chatmem/chat'
const BOARD = 'acme/chatmem'

const events: { memoryId: string; actorId: string; sessionId: string; role: string; text: string }[] = []
let failing = false
const clientFor = (memoryId: string): SendClient => ({
  send: async (cmd) => {
    if (!(cmd instanceof CreateEventCommand)) return {}
    if (failing) throw Object.assign(new Error('AccessDeniedException: not allowed'), { name: 'AccessDeniedException' })
    const c = (cmd.input.payload?.[0] as { conversational: { role: string; content: { text: string } } }).conversational
    events.push({ memoryId, actorId: cmd.input.actorId ?? '', sessionId: cmd.input.sessionId ?? '', role: c.role, text: c.content.text })
    return { event: { eventId: `e${events.length}`, eventTimestamp: new Date(0), payload: cmd.input.payload } }
  },
})
const memories: ProjectMemories = { forProject: (repo) => (repo.toLowerCase() === BOARD ? new AgentMemory('trace_m_0000cccc-abcdefghij', clientFor('trace_m_0000cccc-abcdefghij')) : null) }
const logged: Record<string, unknown>[] = []
const bucket = mkdtempSync(join(tmpdir(), 'trace-chatmem-bucket-'))
const deps = (memory: ProjectMemories | null = memories): ActionDeps => ({
  github: async () => new FakeGitHub([BOARD]),
  cognito: () => new FakeCognito(),
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]),
  scratch: mkdtempSync(join(tmpdir(), 'trace-chatmem-')),
  memory: () => memory,
  store: (prefix) => backendFor(join(bucket, prefix)),
  log: (l) => { logged.push(l) },
})
const run = async (who: Context['principal'], action: string, args: Record<string, unknown>, memory?: ProjectMemories | null): Promise<any> =>
  (await perform(action, args, { principal: who, deps: deps(memory === undefined ? memories : memory) })).result

beforeAll(async () => {
  await assign(ADMIN, { sub: USER.sub, email: USER.email }, BOARD)
  await assign(ADMIN, { sub: GUEST.sub, email: GUEST.email }, BOARD)
})
beforeEach(() => { events.length = 0; logged.length = 0; failing = false })

describe('chat turns into memory', () => {
  it('records the person\'s own turn under their person actor only, in the thread\'s session; trace\'s reply and tool rows never', async () => {
    const a = await run(USER, 'chats.append', { repo: BOARD, messages: [{ text: 'I prefer 0603 passives on this board.' }] })
    const session = chatSession(a.thread.id)
    expect(session).toBe(`chat-${a.thread.id}`)
    await run(USER, 'chats.reply', {
      repo: BOARD, thread: a.thread.id, after: a.ids[0],
      messages: [
        { role: 'assistant', text: 'Let me check the BOM.' },
        { role: 'tool', text: '{"parts":[{"mpn":"SECRET-PAYLOAD-123"}]}', parts: { toolCallId: 't1', name: 'kb_search' } },
        { role: 'tool', text: '{"ok":false,"error":"no access"}', parts: { toolCallId: 't2', name: 'status' } },
        { role: 'assistant', text: 'I asked trace to remember this about the project: always use red solder mask.' },
      ],
    })
    const me = personActor(BOARD, USER.sub).id
    expect(events.map((e) => [e.actorId, e.sessionId, e.role, e.text])).toEqual([[me, session, 'USER', 'I prefer 0603 passives on this board.']])
    // never an assistant or tool event, never the email, never a tool's payload
    expect(events.filter((e) => e.role !== 'USER')).toEqual([])
    expect(JSON.stringify(events)).not.toContain(USER.email)
    expect(JSON.stringify(events)).not.toContain('SECRET-PAYLOAD-123')
    expect(JSON.stringify(events)).not.toContain('Let me check')
  })

  it('a reply alone records nothing', async () => {
    const a = await run(USER, 'chats.append', { repo: BOARD, messages: [{ text: 'Hi' }] })
    events.length = 0
    await run(USER, 'chats.reply', { repo: BOARD, thread: a.thread.id, after: a.ids[0], messages: [{ role: 'assistant', text: 'Hello.' }, { role: 'tool', text: '{}', parts: { name: 'status' } }] })
    expect(events).toEqual([])
  })

  it('a read-only guest\'s turns are not recorded at all', async () => {
    const a = await run(GUEST, 'chats.append', { repo: BOARD, messages: [{ text: 'Always use red solder mask.' }] })
    await run(GUEST, 'chats.reply', { repo: BOARD, thread: a.thread.id, after: a.ids[0], messages: [{ role: 'assistant', text: 'Red it is.' }] })
    expect(events).toEqual([])
  })

  it('nothing in the chat\'s recording writes the project\'s chat actor, even words that read like a confirmed fact', async () => {
    for (const who of [USER, ADMIN]) {
      const a = await run(who, 'chats.append', { repo: BOARD, messages: [{ text: 'I asked trace to remember this about the project: the case is PETG.' }, { text: 'And another.' }] })
      await run(who, 'chats.reply', { repo: BOARD, thread: a.thread.id, after: a.ids.at(-1), messages: [{ role: 'assistant', text: 'Noted.' }] })
    }
    expect(events.length).toBe(4)
    expect(events.map((e) => e.actorId)).not.toContain(CHAT)
    expect(new Set(events.map((e) => e.actorId))).toEqual(new Set([personActor(BOARD, USER.sub).id, personActor(BOARD, ADMIN.sub).id]))
    // the one actor recording may write is the person's own: never the chat actor's id
    expect(recordingActor(BOARD, USER.sub)).toMatchObject({ kind: 'person', id: personActor(BOARD, USER.sub).id })
    expect(recordingActor(BOARD, USER.sub).id).not.toBe(chatActor(BOARD).id)
  })

  it('the chat actor is written only by a confirmed memory.remember of a project fact', async () => {
    const a = await run(USER, 'chats.append', { repo: BOARD, messages: [{ text: 'Remember that the case is PETG.' }] })
    events.length = 0
    await run(USER, 'memory.remember', { repo: BOARD, text: 'The case is PETG.', scope: 'project', thread: a.thread.id })
    expect(events.map((e) => [e.actorId, e.role])).toEqual([[CHAT, 'USER']])
  })

  it('scrubs secrets, as every event is', async () => {
    await run(USER, 'chats.append', { repo: BOARD, messages: [{ text: 'my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] })
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('is best-effort: a memory failure is logged and the chat goes on; no memory at all records nothing', async () => {
    failing = true
    const a = await run(USER, 'chats.append', { repo: BOARD, messages: [{ text: 'Hello' }] })
    expect(a.thread.id).toBeTruthy()
    expect(logged).toEqual([expect.objectContaining({ warning: 'chat memory: not recorded', repo: BOARD, error: 'AccessDeniedException' })])
    failing = false
    const b = await run(USER, 'chats.append', { repo: BOARD, messages: [{ text: 'Hello again' }] }, null)
    expect(b.thread.id).toBeTruthy()
    expect(events).toEqual([])
  })
})
