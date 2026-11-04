/**
 * memory.remember through the API: a person's explicit "remember this", recorded as one short-term user event under
 * their own person actor (personal) or the project's chat actor (project), always as the signed-in caller. Write
 * access is needed (a guest is refused), the access check comes before any AWS call, and only the project's own
 * memory is written.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AGENTS, AgentMemory, type ProjectMemories, type SendClient, chatActor, chatSession, parseActor, personActor } from '../../src/agents/runtime/memory.js'
import { type ActionDeps, type Context, REMEMBER_NOTE, needOf, perform, rememberText } from '../../src/api/actions.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'admin-1', email: 'admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'user-1', email: 'user-1@example.com', groups: ['trace-users'] }
const GUEST = { sub: 'guest-1', email: 'guest-1@example.com', groups: ['trace-guests'] }
const OUTSIDER = { sub: 'user-2', email: 'user-2@example.com', groups: ['trace-users'] }
const BOARD = 'acme/board'
const BOARD_MEMORY = 'trace_m_0000aaaa-abcdefghij'
const SECRET_MEMORY = 'trace_m_0000bbbb-abcdefghij'

const sent: { memoryId: string; cmd: unknown }[] = []
const clientFor = (memoryId: string): SendClient => ({
  send: async (cmd) => {
    sent.push({ memoryId, cmd })
    if (cmd instanceof CreateEventCommand) {
      const p = cmd.input.payload?.[0]
      return { event: { eventId: `e${sent.length}`, actorId: cmd.input.actorId, sessionId: cmd.input.sessionId, eventTimestamp: new Date(0), payload: p ? [p] : [] } }
    }
    return {}
  },
})
const memories: ProjectMemories = {
  forProject: (repo) => {
    const id = ({ 'acme/board': BOARD_MEMORY, 'acme/secret': SECRET_MEMORY } as Record<string, string>)[repo.toLowerCase()]
    return id ? new AgentMemory(id, clientFor(id)) : null
  },
}
const deps = (memory: ProjectMemories | null = memories): ActionDeps => ({
  github: async () => new FakeGitHub([BOARD, 'acme/secret']),
  cognito: () => new FakeCognito(),
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]),
  scratch: mkdtempSync(join(tmpdir(), 'trace-api-remember-')),
  memory: () => memory,
})
const ctx = (principal: Context['principal'], memory: ProjectMemories | null = memories): Context => ({ principal, deps: deps(memory) })
const events = () => sent.filter((s) => s.cmd instanceof CreateEventCommand).map((s) => ({ ...(s.cmd as CreateEventCommand).input, memoryId: s.memoryId }))

beforeAll(async () => {
  for (const [sub, email] of [['user-1', USER.email], ['guest-1', GUEST.email]] as const) await assign(ADMIN, { sub, email }, BOARD)
  await assign(ADMIN, { sub: 'user-2', email: OUTSIDER.email }, 'acme/secret')
})
beforeEach(() => { sent.length = 0 })

describe('memory.remember', () => {
  it('needs write', () => {
    expect(needOf('memory.remember')).toBe('write')
  })

  it('records a project fact under the project\'s chat actor, marked as asked for, in the thread\'s session', async () => {
    const r = await perform('memory.remember', { repo: BOARD, text: 'The board ships in a 3D-printed case.', thread: 'abcdefgh12' }, ctx(USER))
    expect(r.result).toMatchObject({ repo: BOARD, recorded: true, scope: 'project', actor: 'chat', session: chatSession('abcdefgh12'), note: REMEMBER_NOTE })
    const [e, ...rest] = events()
    expect(rest).toEqual([])
    expect(e).toMatchObject({ memoryId: BOARD_MEMORY, actorId: chatActor(BOARD).id, sessionId: 'chat-abcdefgh12' })
    expect(e?.actorId).toBe('acme/board/chat')
    expect(e?.payload).toEqual([{ conversational: { role: 'USER', content: { text: rememberText('project', 'The board ships in a 3D-printed case.') } } }])
    expect(rememberText('project', 'x')).toMatch(/asked trace to remember/)
  })

  it('records a personal preference under the caller\'s own person actor (their sub\'s hash, never the email)', async () => {
    await perform('memory.remember', { repo: BOARD, text: 'I like terse pull request descriptions.', scope: 'personal' }, ctx(USER))
    const [e] = events()
    expect(e?.actorId).toBe(personActor(BOARD, USER.sub).id)
    expect(parseActor(e?.actorId ?? '').kind).toBe('person')
    expect(JSON.stringify(e)).not.toContain(USER.email)
    expect(e?.sessionId).toMatch(/^remember-\d{8}$/)
  })

  it('takes no author from the request: an actor, a person or an email in the arguments is refused or ignored', async () => {
    await perform('memory.remember', { repo: BOARD, text: 'Use 0402 parts.', scope: 'personal', actor: 'acme/board/person/0000000000000000', by: 'admin@example.com' } as Record<string, unknown>, ctx(USER))
    expect(events()[0]?.actorId).toBe(personActor(BOARD, USER.sub).id)
  })

  it('refuses a guest (read only) and a stranger, before memory is touched', async () => {
    await expect(perform('memory.remember', { repo: BOARD, text: 'x', scope: 'personal' }, ctx(GUEST))).rejects.toThrow(AccessDenied)
    await expect(perform('memory.remember', { repo: 'acme/secret', text: 'x' }, ctx(USER))).rejects.toThrow(AccessDenied)
    expect(sent).toHaveLength(0)
  })

  it('writes only the project\'s own memory', async () => {
    await perform('memory.remember', { repo: 'acme/secret', text: 'Secret fact.' }, ctx(ADMIN))
    expect(events().map((e) => [e.memoryId, e.actorId])).toEqual([[SECRET_MEMORY, 'acme/secret/chat']])
  })

  it('is scrubbed and bounded, and says so when nothing is left', async () => {
    await perform('memory.remember', { repo: BOARD, text: 'the key is AKIAABCDEFGHIJKLMNOP for staging' }, ctx(USER))
    expect(JSON.stringify(events())).not.toContain('AKIAABCDEFGHIJKLMNOP')
    await expect(perform('memory.remember', { repo: BOARD, text: 'x'.repeat(2001) }, ctx(USER))).rejects.toThrow(/text/)
    await expect(perform('memory.remember', { repo: BOARD, text: '   ' }, ctx(USER))).rejects.toThrow(/text/)
  })

  it('says memory is off when the installation has none, and "no access" for a project without one', async () => {
    await expect(perform('memory.remember', { repo: BOARD, text: 'x' }, ctx(USER, null))).rejects.toThrow(/not enabled/)
    const only: ProjectMemories = { forProject: (repo) => (repo === 'acme/secret' ? memories.forProject(repo) : null) }
    await expect(perform('memory.remember', { repo: BOARD, text: 'x' }, ctx(USER, only))).rejects.toThrow(/no access/)
  })

  it('the chat is one of the actors memory.events and memory.list show', () => {
    expect(AGENTS).toContain('chat')
    expect(chatActor('Acme/My_Board.v2').id).toBe('acme/my_uboard_dv2/chat')
  })
})
