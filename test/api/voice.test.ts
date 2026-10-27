/** Dictation's project vocabulary through the API: voice.vocabulary (read) reads its state here; voice.vocabulary.sync
 * (write) runs the voice.vocabulary tool on the project's worker. The access check comes first. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, WRITE_TOOLS, perform } from '../../src/api/actions.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { projectHash } from '../../src/core/project.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'admin-v', email: 'admin-v@example.com', groups: ['trace-admins'] }
const USER = { sub: 'user-v', email: 'user-v@example.com', groups: ['trace-users'] }
const GUEST = { sub: 'guest-v', email: 'guest-v@example.com', groups: ['trace-guests'] }
const OUTSIDER = { sub: 'out-v', email: 'out-v@example.com', groups: ['trace-users'] }
const asked: string[] = []
const ran: unknown[] = []
const states = new Map<string, 'READY' | 'PENDING' | 'FAILED'>()
const deps: ActionDeps = {
  github: async () => new FakeGitHub(['acme/board']),
  cognito: () => new FakeCognito(),
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [], runTool: async (p) => { ran.push(p); return { languages: [] } } }),
  tools: () => new Registry([]),
  scratch: mkdtempSync(join(tmpdir(), 'trace-api-voice-')),
  installationPrefix: 'trace',
  vocabularies: async () => ({ get: async (name) => { asked.push(name); const s = states.get(name); return s ? { state: s, ...(s === 'FAILED' ? { failure: 'bad phrase' } : {}) } : null } }),
}
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const name = `trace-${projectHash('acme/board')}-en-AU`

beforeAll(async () => {
  await assign(ADMIN, { sub: USER.sub, email: USER.email }, 'acme/board')
  await assign(ADMIN, { sub: GUEST.sub, email: GUEST.email }, 'acme/board')
})

describe('voice.vocabulary', () => {
  it('answers the state of the project\'s vocabulary for a language; usable only when READY', async () => {
    expect((await perform('voice.vocabulary', { repo: 'acme/board', language: 'en-AU' }, ctx(GUEST))).result).toMatchObject({ name, state: 'NONE', usable: false, note: expect.stringMatching(/next push/) })
    states.set(name, 'PENDING')
    expect((await perform('voice.vocabulary', { repo: 'acme/board', language: 'en-AU' }, ctx(GUEST))).result).toMatchObject({ state: 'PENDING', usable: false })
    states.set(name, 'FAILED')
    expect((await perform('voice.vocabulary', { repo: 'acme/board', language: 'en-AU' }, ctx(USER))).result).toMatchObject({ state: 'FAILED', usable: false, failure: 'bad phrase' })
    states.set(name, 'READY')
    expect((await perform('voice.vocabulary', { repo: 'acme/board', language: 'en-AU' }, ctx(USER))).result).toMatchObject({ state: 'READY', usable: true })
    expect(asked.every((n) => n === name)).toBe(true)
  })

  it('a language without English number words gets no vocabulary, and no call', async () => {
    const before = asked.length
    expect((await perform('voice.vocabulary', { repo: 'acme/board', language: 'fr-FR' }, ctx(USER))).result).toMatchObject({ name: null, state: 'NONE', usable: false, note: expect.stringMatching(/English/) })
    expect(asked.length).toBe(before)
  })

  it('"no access" first, the same for a project that does not exist; sync needs write and runs on the worker', async () => {
    const before = asked.length
    await expect(perform('voice.vocabulary', { repo: 'acme/board', language: 'en-AU' }, ctx(OUTSIDER))).rejects.toThrow(AccessDenied)
    await expect(perform('voice.vocabulary', { repo: 'acme/nothing', language: 'en-AU' }, ctx(OUTSIDER))).rejects.toThrow(AccessDenied)
    expect(asked.length).toBe(before)
    await expect(perform('voice.vocabulary.sync', { repo: 'acme/board' }, ctx(GUEST))).rejects.toThrow(AccessDenied)
    await perform('voice.vocabulary.sync', { repo: 'acme/board' }, ctx(USER))
    expect(ran).toEqual([{ kind: 'tool', repository: 'acme/board', name: 'voice.vocabulary', args: { wait_minutes: 3 } }])
    expect(WRITE_TOOLS.has('voice.vocabulary')).toBe(true)
  })
})
