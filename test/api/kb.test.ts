/**
 * The knowledge base through the API: kb.search (read) runs Retrieve here on the project's own knowledge base;
 * kb.sync (write) is the kb.sync tool on the project's worker runtime. The access check comes first, and a project
 * that is not yours, or has no knowledge base here, gets the same 403.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RetrieveCommand, RetrieveCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, WRITE_TOOLS, perform, projectKbsFromEnv } from '../../src/api/actions.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { Registry } from '../../src/core/registry.js'
import { tools as kbTools } from '../../src/tools/kb/tools.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'admin-1', email: 'admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'user-kb', email: 'user-kb@example.com', groups: ['trace-users'] }
const GUEST = { sub: 'guest-kb', email: 'guest-kb@example.com', groups: ['trace-guests'] }
const BOARD_KB = 'KBBOARD001'
const SECRET_KB = 'KBSECRET01'

const retrieved: RetrieveCommand[] = []
const ran: unknown[] = []
const output: RetrieveCommandOutput = { $metadata: {}, retrievalResults: [{ content: { text: 'R1 is 39k.' }, score: 0.9, metadata: { source: 'summary', kind: 'kicad', path: 'hw/board.kicad_pro', commit: '0123456789abcdef' } }] }

const deps = (kbs: Record<string, string> = { 'acme/board': BOARD_KB, 'acme/secret': SECRET_KB }): ActionDeps => ({
  github: async () => new FakeGitHub(['acme/board', 'acme/secret']),
  cognito: () => new FakeCognito(),
  jobs: async () => ({
    repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [],
    runTool: async (p) => { ran.push(p); return { uploaded: 3 } },
  }),
  tools: () => new Registry(kbTools),
  scratch: mkdtempSync(join(tmpdir(), 'trace-api-kb-')),
  kbs: () => new Map(Object.entries(kbs)),
  retrieve: async () => ({ send: async (c: RetrieveCommand) => { retrieved.push(c); return output } }),
})
const ctx = (principal: Context['principal'], d: ActionDeps = deps()): Context => ({ principal, deps: d })
const reset = (): void => { retrieved.length = 0; ran.length = 0 }

beforeAll(async () => {
  await assign(ADMIN, { sub: USER.sub, email: USER.email }, 'acme/board')
  await assign(ADMIN, { sub: GUEST.sub, email: GUEST.email }, 'acme/board')
})

describe('the knowledge base through the API', () => {
  it('lets a guest search and not sync, and a user do both, each on that project\'s own knowledge base', async () => {
    reset()
    const g = await perform('kb.search', { repo: 'acme/board', query: 'divider resistor', filter: { kind: 'kicad' } }, ctx(GUEST))
    expect(g.result).toMatchObject({ repo: 'acme/board', enabled: true, results: [{ text: 'R1 is 39k.', citation: 'hw/board.kicad_pro@0123456789ab' }] })
    expect(retrieved.map((c) => c.input.knowledgeBaseId)).toEqual([BOARD_KB])
    expect(retrieved[0]?.input.retrievalConfiguration?.vectorSearchConfiguration?.filter).toEqual({ equals: { key: 'kind', value: 'kicad' } })
    await expect(perform('kb.sync', { repo: 'acme/board' }, ctx(GUEST))).rejects.toThrow(AccessDenied)
    expect(ran).toHaveLength(0)

    await perform('kb.search', { repo: 'ACME/Board', query: 'x' }, ctx(USER))
    expect(retrieved.at(-1)?.input.knowledgeBaseId).toBe(BOARD_KB)
    const s = await perform('kb.sync', { repo: 'acme/board', force: true }, ctx(USER))
    expect(s.result).toEqual({ uploaded: 3 })
    expect(ran).toEqual([{ kind: 'tool', repository: 'acme/board', name: 'kb.sync', args: { force: true, wait_minutes: 5 } }])
    // the generic tool action needs write for kb.sync too
    expect(WRITE_TOOLS.has('kb.sync')).toBe(true)
    await expect(perform('tool', { repo: 'acme/board', name: 'kb.sync', args: {} }, ctx(GUEST))).rejects.toThrow(AccessDenied)
  })

  it('answers the same 403 for a project you are not assigned to, and one without a knowledge base here, before AWS is touched', async () => {
    reset()
    for (const p of [GUEST, USER]) {
      await expect(perform('kb.search', { repo: 'acme/secret', query: 'x' }, ctx(p))).rejects.toThrow(AccessDenied)
      await expect(perform('kb.sync', { repo: 'acme/secret' }, ctx(p))).rejects.toThrow(AccessDenied)
    }
    // an admin may reach every project, but not one without a knowledge base in this installation
    const only = deps({ 'acme/board': BOARD_KB })
    await expect(perform('kb.search', { repo: 'acme/secret', query: 'x' }, ctx(ADMIN, only))).rejects.toThrow(/no access/)
    await expect(perform('kb.sync', { repo: 'acme/secret' }, ctx(ADMIN, only))).rejects.toThrow(/no access/)
    expect(retrieved).toHaveLength(0)
    expect(ran).toHaveLength(0)
    await perform('kb.search', { repo: 'acme/secret', query: 'x' }, ctx(ADMIN))
    expect(retrieved.map((c) => c.input.knowledgeBaseId)).toEqual([SECRET_KB])
  })

  it('answers enabled: false in an installation without knowledge bases, and learns them from TRACE_PROJECT_KBS', async () => {
    expect((await perform('kb.search', { repo: 'acme/board', query: 'x' }, ctx(GUEST, deps({})))).result).toEqual({ repo: 'acme/board', enabled: false, results: [] })
    await expect(perform('kb.sync', { repo: 'acme/board' }, ctx(USER, deps({})))).rejects.toThrow(/no knowledge bases/)
    expect(projectKbsFromEnv({ TRACE_PROJECT_KBS: `acme/board=${BOARD_KB} Acme/Secret=${SECRET_KB}` })).toEqual(new Map([['acme/board', BOARD_KB], ['acme/secret', SECRET_KB]]))
    expect(projectKbsFromEnv({}).size).toBe(0)
    await expect(perform('kb.search', { repo: 'acme/board', query: 'x', filter: { path_prefix: '*' } }, ctx(GUEST))).rejects.toThrow(/wildcards/)
  })
})
