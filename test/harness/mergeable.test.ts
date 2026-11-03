import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTLE, conflicted, settle, unsettled } from '../../src/harness/mergeable.js'
import * as prs from '../../src/harness/prs.js'
import * as worker from '../../src/harness/worker.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from './fake.js'

const real = { ...SETTLE }
let slept = 0
beforeEach(() => { slept = 0; SETTLE.sleep = async (ms) => { slept += ms } })
afterEach(() => { Object.assign(SETTLE, real) })

/** GitHub's answers for one pull request, one per read: the last repeats. */
const reads = (seq: Record<number, { mergeable: boolean | null; mergeable_state: string }[]>) => {
  const seen: Record<number, number> = {}
  return ({ pull_number }: Record<string, unknown>) => {
    const n = pull_number as number
    const i = Math.min(seen[n] ?? 0, (seq[n]?.length ?? 1) - 1)
    seen[n] = (seen[n] ?? 0) + 1
    return { number: n, ...seq[n]?.[i], head: { sha: SHA(String(n)), ref: `claude/${n}`, repo: { full_name: 'o/r' } } }
  }
}
const UNKNOWN = { mergeable: null, mergeable_state: 'unknown' }
const DIRTY = { mergeable: false, mergeable_state: 'dirty' }
const CLEAN = { mergeable: true, mergeable_state: 'clean' }

describe('mergeability', () => {
  it('reads unknown as not settled, and an absent field as settled', () => {
    expect(unsettled(UNKNOWN)).toBe(true)
    expect(unsettled({})).toBe(false)
    expect(conflicted(DIRTY)).toBe(true)
    expect(conflicted(CLEAN)).toBe(false)
  })

  it('reads again only what GitHub has not finished, and stops after SETTLE.rounds', async () => {
    const f = fakeGithub({ 'pulls.get': reads({ 1: [UNKNOWN, UNKNOWN, DIRTY], 2: [CLEAN], 3: [UNKNOWN] }) })
    const got = await settle(f.gh, 'o', 'r', [1, 2, 3])
    expect(got.get(1)?.mergeable_state).toBe('dirty')
    expect(got.get(2)?.mergeable_state).toBe('clean')
    expect(got.get(3)?.mergeable_state).toBe('unknown')
    const by = (n: number) => f.called('pulls.get').filter((c) => c.args.pull_number === n).length
    expect([by(1), by(2), by(3)]).toEqual([3, 1, SETTLE.rounds])
    expect(slept).toBe((SETTLE.rounds - 1) * SETTLE.waitMs)
  })
})

describe('worker pick after a push to the default branch', () => {
  const now = Date.parse('2026-11-03T06:00:00Z')
  const pull = (n: number, ref: string) => ({ number: n, draft: false, head: { ref, sha: SHA(String(n)), repo: { full_name: 'o/r' } }, labels: [], title: ref, body: '' })

  it('finds a conflict GitHub was still working out when the pick began', async () => {
    const f = fakeGithub({
      'pulls.list': [pull(5, 'claude/a'), pull(6, 'claude/b')],
      'pulls.get': reads({ 5: [UNKNOWN, DIRTY], 6: [UNKNOWN, CLEAN] }),
      'issues.listComments': [],
      'issues.listForRepo': [],
    })
    const core = fakeCore()
    await worker.pick(deps(f, core, cfgOf(), context(), { AGENT_LOGIN: 'trace-agent' }), now)
    const items = JSON.parse(core.outputs.items!) as { number: number; kind: string }[]
    expect(items).toEqual([expect.objectContaining({ number: 5, kind: 'conflict' })])
  })

  it('asked again from trace: the earlier attempts are set aside and a person\'s fresh branch is not waited on', async () => {
    const attempt = (n: number) => ({ user: { login: 'trace-agent' }, body: `<!-- trace-attempt: ${SHA(String(n))} -->` })
    const comments: Record<number, unknown[]> = { 7: [attempt(7), attempt(7), attempt(7)], 8: [] }
    const f = fakeGithub({
      'pulls.list': [pull(7, 'claude/c'), pull(8, 'marc/d')],
      'pulls.get': reads({ 7: [DIRTY], 8: [DIRTY] }),
      'repos.getCommit': { commit: { committer: { date: new Date(now - 60e3).toISOString() } } },
      'issues.listComments': ({ issue_number }: Record<string, unknown>) => comments[issue_number as number] ?? [],
      'issues.createComment': ({ issue_number, body }: Record<string, unknown>) => {
        comments[issue_number as number]?.push({ user: { login: 'trace-agent' }, body })
        return {}
      },
      'issues.listForRepo': [],
    })
    // without asking: #7 used its attempts, #8 is someone's branch pushed a minute ago
    let core = fakeCore()
    await worker.pick(deps(f, core, cfgOf(), context(), { AGENT_LOGIN: 'trace-agent' }), now)
    expect(JSON.parse(core.outputs.items!)).toEqual([])
    // asked from trace: both are taken, each with a retry marker first
    core = fakeCore()
    await worker.pick(deps(f, core, cfgOf(), context(), { AGENT_LOGIN: 'trace-agent', RETRY: '7, 8, nope' }), now)
    expect((JSON.parse(core.outputs.items!) as { number: number }[]).map((i) => i.number)).toEqual([7, 8])
    const bodies = (comments[7] as { body: string }[]).map((c) => c.body)
    expect(bodies.at(-2)).toContain(worker.retryMarker(SHA('7')))
    expect(bodies.at(-1)).toContain('trace-claim')
  })

  it('reads RETRY as positive whole numbers only', () => {
    expect([...worker.retried(' 3,4  x,-1, 2.5 ,')]).toEqual([3, 4])
    expect(worker.retried(undefined).size).toBe(0)
  })
})

describe('update queue after a push to the default branch', () => {
  it('resolves a database-only conflict GitHub was still working out', async () => {
    const open = [{ number: 9, draft: false, head: { ref: 'claude/db', repo: { full_name: 'o/r' } }, labels: [], created_at: '2026' }]
    const f = fakeGithub({ 'pulls.list': open, 'pulls.get': reads({ 9: [UNKNOWN, DIRTY] }) })
    const resolved: string[] = []
    await prs.updateQueue(deps(f, fakeCore(), cfgOf(), context(), { OWN_TOKEN: 't' }), async (i) => {
      resolved.push(i.head)
      return { ok: true, commit: SHA('m') }
    })
    expect(resolved).toEqual(['claude/9'])
  })
})
