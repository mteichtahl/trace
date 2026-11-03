/**
 * Work trace gave up on (src/core/stuck-work.ts, src/harness/worker.ts pick): an item at worker.max_attempts becomes a
 * stuck note in the agents' facts, once per item and head, saying what was tried and trace's recommendation; it shows
 * as a "Needs you" item of kind stuck; it is resolved once the item moves on; a claimed item's note stands; and a pick
 * whose facts cannot be written still escalates on GitHub.
 */
import { describe, expect, it } from 'vitest'
import { AgentFactsStore, loadAgentFacts } from '../../src/core/agent-facts.js'
import { S3Backend } from '../../src/core/central.js'
import { type Viewer, inboxItems, loadJourney, startJourney } from '../../src/core/journey.js'
import { JourneyStore } from '../../src/core/journey-store.js'
import { parseKey, reportWords, sourceKey, stuckNote, stuckRequests, syncStuckWork } from '../../src/core/stuck-work.js'
import * as worker from '../../src/harness/worker.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from '../harness/fake.js'
import { FakeS3 } from './fake-s3.js'

const CONTRIB: Viewer = { hash: 'h-user', label: 'u@example.com', admin: false, part: 'contributor', sub: 'sub-user-0001' }
const store = () => new AgentFactsStore(new S3Backend('bucket', 'projects', new FakeS3()), 'o/r')
const item = { kind: 'ci-red' as const, number: 12, sha: SHA('a'), title: 'Fix the ERC on the power sheet', attempts: 3, lastReport: 'ERC still reports pin 4 of U3 unconnected.' }

describe('a stuck work item', () => {
  it('says what was tried, its last report and trace\'s recommendation, in plain words', () => {
    const n = stuckNote(item)
    expect(n.key).toBe(`ci-red#12@${'a'.repeat(12)}`)
    expect(n.why).toBe('trace tried 3 times to fix the failing build on change #12 ("Fix the ERC on the power sheet") and could not, so it stopped trying. Its last attempt reported: ERC still reports pin 4 of U3 unconnected.')
    expect(n.recommendation).toMatch(/^Read the failing step on the project overview/)
    expect(stuckNote({ ...item, kind: 'agent-fix', sha: 'issue', lastReport: null }).why).toBe('trace tried 3 times to do request #12 ("Fix the ERC on the power sheet") and could not, so it stopped trying.')
    expect(parseKey(sourceKey({ kind: 'agent-fix', number: 7, sha: 'issue' }))).toEqual({ kind: 'agent-fix', number: 7, sha: 'issue' })
    expect(parseKey('nonsense')).toBeNull()
    expect(reportWords('**trace Verification specialist**\n\nIts report:\n\n> The tests fail.\n> Pin 4 is open.\n<!-- trace-report: x -->')).toBe('The tests fail. Pin 4 is open.')
  })

  it('is recorded once per item and head, shows under Needs you, and is resolved when the item moves on', async () => {
    const s = store()
    const j = new JourneyStore(new S3Backend('bucket', 'projects', new FakeS3()), 'o/r')
    await j.update((db) => { startJourney(db, { template: 'board', by: 'a@example.com', name: 'Board' }); return { result: null } })
    const r = (await j.read((db) => loadJourney(db))).result!

    expect((await s.update((db) => ({ result: syncStuckWork(db, [item, { ...item, kind: 'agent-fix', number: 7, sha: 'issue' }]) }))).result.added).toHaveLength(2)
    // a second pick finds the same: nothing new
    expect((await s.update((db) => ({ result: syncStuckWork(db, [item, { ...item, kind: 'agent-fix', number: 7, sha: 'issue' }]) }))).result).toEqual({ added: [], resolved: [] })
    const facts = (await s.read((db) => loadAgentFacts(db))).result
    expect((await s.read((db) => stuckRequests(db))).result).toEqual(new Set([7]))

    const inbox = inboxItems('o/r', r, CONTRIB, undefined, facts).filter((i) => i.kind === 'stuck')
    expect(inbox).toHaveLength(2)
    expect(inbox[0]).toMatchObject({ kind: 'stuck', blocking: true, action: 'See options' })
    expect(inbox[0]!.summary).toMatch(/^Board: the trace worker is stuck: trace tried 3 times to fix the failing build on change #12.*It recommends: Read the failing step/)

    // a new push on #12 (another head) and #7 claimed by a running attempt: #12's old note goes, #7's stands, #12's new head is new
    const moved = { ...item, sha: SHA('b') }
    const out = (await s.update((db) => ({ result: syncStuckWork(db, [moved], [sourceKey({ kind: 'agent-fix', number: 7, sha: 'issue' })]) }))).result
    expect(out).toEqual({ added: [sourceKey(moved)], resolved: [sourceKey(item)] })
    // nothing stuck any more: every note resolved, and the inbox is clear
    await s.update((db) => ({ result: syncStuckWork(db, []) }))
    const after = (await s.read((db) => loadAgentFacts(db))).result
    expect(inboxItems('o/r', r, CONTRIB, undefined, after).filter((i) => i.kind === 'stuck')).toEqual([])
  })
})

describe('the pick', () => {
  const now = Date.parse('2026-11-03T06:00:00Z')
  const pull = { number: 4, draft: false, head: { ref: 'claude/d', sha: SHA('4'), repo: { full_name: 'o/r' } }, labels: [{ name: 'ci-red' }], title: 'Fix the ERC' }
  const attempts = [1, 2, 3].map(() => ({ user: { login: 'trace-agent' }, body: `<!-- trace-attempt: ${SHA('4')} -->` }))
  const report = { user: { login: 'github-actions[bot]' }, body: '**trace Implementation specialist**\n\nIts report:\n\n> U3 pin 4 has no net.\n<!-- trace-report: x -->' }
  const gh = () => fakeGithub({
    'pulls.list': [pull], 'issues.listComments': [...attempts, report], 'issues.listForRepo': [],
  })

  it('escalates on GitHub once and records the stuck note for the app, with the last report', async () => {
    const s = store()
    const f = gh()
    await worker.pick(deps(f, fakeCore(), cfgOf({ worker: { escalate_to: 'marc' } }), context(), { AGENT_LOGIN: 'trace-agent' }), now, undefined, s)
    expect(f.called('issues.createComment').map((c) => String(c.args.body)).filter((b) => b.includes('trace-escalated'))).toHaveLength(1)
    const stuck = (await s.read((db) => loadAgentFacts(db))).result.stuck
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatchObject({ agent: 'the trace worker', resolvedAt: null, sources: [{ kind: 'work-item', ref: `ci-red#4@${'4'.repeat(12)}`, label: 'Change #4' }] })
    expect(stuck[0]!.why).toMatch(/tried 3 times.*Its last attempt reported: U3 pin 4 has no net\./)
  })

  it('goes on when the facts cannot be written: the GitHub mention stands', async () => {
    const broken = { update: async () => { throw new Error('AccessDenied') } } as unknown as AgentFactsStore
    const core = fakeCore()
    const f = gh()
    await worker.pick(deps(f, core, cfgOf(), context(), { AGENT_LOGIN: 'trace-agent' }), now, undefined, broken)
    expect(core.warnings.join()).toMatch(/could not be recorded for the app: AccessDenied/)
    expect(f.called('issues.createComment').some((c) => String(c.args.body).includes('trace-escalated'))).toBe(true)
  })
})
