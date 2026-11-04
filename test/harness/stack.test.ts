import { describe, expect, it } from 'vitest'
import * as prs from '../../src/harness/prs.js'
import { RESTACK_PER_RUN, StackUnclear, parentOf, restack } from '../../src/harness/stack.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from './fake.js'

const head = (n: number): string => `${n}`.padStart(40, 'c')
const pr = (number: number, ref: string, base = 'main', extra: Record<string, unknown> = {}) => ({
  number, title: `change ${number}`, draft: false, labels: [], created_at: '2026-11-03T00:00:00Z',
  head: { ref, sha: head(number), repo: { full_name: 'o/r' } }, base: { ref: base }, ...extra,
})
const commits = (...shas: string[]) => shas.map((sha, i) => ({ sha, commit: { message: `commit ${i}` } }))

describe('parentOf: by commit membership', () => {
  it("is the open change whose tip the branch holds; the nearest of a chain", async () => {
    const f = fakeGithub({
      'pulls.list': [pr(1, 'claude/a'), pr(2, 'claude/b', 'claude/a'), pr(3, 'claude/other')],
      'pulls.listCommits': [{ sha: 'unrelated' }],
    })
    // the branch holds A's and B's tips: B is the nearest (it is stacked on A)
    expect(await parentOf(f.gh, 'o', 'r', 'claude/c', 'main', new Set([head(1), head(2), 'mine']))).toEqual({ number: 2, ref: 'claude/b', title: 'change 2' })
  })

  it("finds a change whose tip moved on since the branch was made from it (its earlier commits are in the branch)", async () => {
    const f = fakeGithub({
      'pulls.list': [pr(1, 'claude/a')],
      // A's tip is newer (a revision, main merged in), but its first commit is in the branch
      'pulls.listCommits': [{ sha: 'a-first' }, { sha: head(1) }],
    })
    expect(await parentOf(f.gh, 'o', 'r', 'claude/c', 'main', new Set(['a-first', 'mine']))).toMatchObject({ number: 1 })
  })

  it('is null when the branch holds none of any open change; ignores forks', async () => {
    const fork = { ...pr(5, 'claude/a'), head: { ref: 'claude/a', sha: 'x', repo: { full_name: 'fork/r' } } }
    const f = fakeGithub({ 'pulls.list': [pr(1, 'claude/a'), fork], 'pulls.listCommits': [{ sha: 'theirs' }] })
    expect(await parentOf(f.gh, 'o', 'r', 'claude/c', 'main', new Set(['mine', 'x']))).toBeNull()
  })

  it('refuses a branch holding two unrelated open changes, and passes a failed lookup on (fail closed)', async () => {
    const f = fakeGithub({ 'pulls.list': [pr(1, 'claude/a'), pr(2, 'claude/b')] })
    await expect(parentOf(f.gh, 'o', 'r', 'claude/c', 'main', new Set([head(1), head(2)]))).rejects.toBeInstanceOf(StackUnclear)
    const g = fakeGithub({ 'pulls.list': [pr(1, 'claude/a')], 'pulls.listCommits': Object.assign(new Error('rate limited'), { status: 403 }) })
    await expect(parentOf(g.gh, 'o', 'r', 'claude/c', 'main', new Set(['mine']))).rejects.toThrow(/rate limited/)
  })
})

describe('open-pr, stacked', () => {
  const opened = (handlers: Record<string, unknown>, cfg = cfgOf()) => {
    const f = fakeGithub({ 'pulls.create': { number: 9, html_url: 'u' }, ...handlers })
    const core = fakeCore()
    return { f, core, done: prs.openPr(deps(f, core, cfg, context({ ref: 'refs/heads/claude/c' }), { OWN_TOKEN: 't' })) }
  }

  it('targets the parent branch and lists only its own commits', async () => {
    const { f, core, done } = opened({
      'pulls.list': (a: Record<string, unknown>) => (a.head ? [] : [pr(4, 'claude/a')]),
      'repos.compareCommits': (a: Record<string, unknown>) => (a.base === 'main'
        ? { ahead_by: 2, commits: commits(head(4), 'mine') }
        : { ahead_by: 1, commits: commits('mine') }),
    })
    await done
    const c = f.called('pulls.create')[0]!.args
    expect(c.base).toBe('claude/a')
    expect(String(c.body)).toMatch(/Stacked on #4/)
    expect(core.text).toMatch(/stacked on #4/)
  })

  it('opens nothing when it cannot tell (a failed lookup, two unrelated changes, more commits than listed)', async () => {
    const failing = opened({
      'pulls.list': (a: Record<string, unknown>) => (a.head ? [] : Object.assign(new Error('GitHub 502'), { status: 502 })),
      'repos.compareCommits': { ahead_by: 1, commits: commits('mine') },
    })
    await failing.done
    expect(failing.f.called('pulls.create')).toHaveLength(0)
    expect(failing.core.text).toMatch(/could not check whether `claude\/c` builds on another open pull request.*no PR was opened/)
    const two = opened({
      'pulls.list': (a: Record<string, unknown>) => (a.head ? [] : [pr(1, 'claude/a'), pr(2, 'claude/b')]),
      'repos.compareCommits': { ahead_by: 3, commits: commits(head(1), head(2), 'mine') },
    })
    await two.done
    expect(two.f.called('pulls.create')).toHaveLength(0)
    expect(two.core.text).toMatch(/#1 and #2, which are not stacked on each other/)
    const long = opened({ 'pulls.list': [], 'repos.compareCommits': { ahead_by: 300, commits: commits('mine') } })
    await long.done
    expect(long.f.called('pulls.create')).toHaveLength(0)
  })

  it('targets the default branch when prs.stack is off', async () => {
    const { f, done } = opened({
      'pulls.list': (a: Record<string, unknown>) => (a.head ? [] : [pr(4, 'claude/a')]),
      'repos.compareCommits': { ahead_by: 2, commits: commits(head(4), 'mine') },
    }, cfgOf({ prs: { stack: false } }))
    await done
    expect(f.called('pulls.create')[0]!.args.base).toBe('main')
  })
})

describe('automerge with stacks', () => {
  it('merges a PR others are stacked on with a merge commit, whatever prs.merge_method says', async () => {
    const payload = { pull_request: { number: 1, node_id: 'N1', draft: false, base: { ref: 'main' }, head: { sha: SHA('1'), ref: 'claude/a' }, labels: [] } }
    const f = fakeGithub({ 'pulls.listFiles': [], 'pulls.list': (a: Record<string, unknown>) => (a.base === 'claude/a' ? [pr(2, 'claude/b', 'claude/a')] : []) })
    await prs.automerge(deps(f, fakeCore(), cfgOf({ prs: { merge_method: 'squash' } }), context({ eventName: 'pull_request', payload }), { OWN_TOKEN: 't' }))
    expect(f.called('graphql')[0]!.args.method).toBe('MERGE')
    const g = fakeGithub({ 'pulls.listFiles': [], 'pulls.list': [] })
    await prs.automerge(deps(g, fakeCore(), cfgOf({ prs: { merge_method: 'squash' } }), context({ eventName: 'pull_request', payload }), { OWN_TOKEN: 't' }))
    expect(g.called('graphql')[0]!.args.method).toBe('SQUASH')
  })
})

describe('restack', () => {
  const rd = (f: ReturnType<typeof fakeGithub>, canPush = true) => ({ github: f.gh, owner: 'o', repo: 'r', defaultBranch: 'main', hold: 'no-automerge', canPush })
  const mergedBase = (o: Record<string, unknown> = {}) => ({ number: 1, merged_at: '2026-11-04', closed_at: '2026-11-04T01:00:00Z', base: { ref: 'main' }, head: { sha: head(1) }, ...o })

  it('moves a change whose base merged onto where it went, held while it moves, and brings it up to date', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.state === 'closed' ? [mergedBase()] : []),
      'repos.getBranch': Object.assign(new Error('Branch not found'), { status: 404 }),
    })
    const r = await restack(rd(f), [pr(2, 'claude/b', 'claude/a')])
    const order = f.calls.map((c) => c.key).filter((k) => ['issues.addLabels', 'pulls.update', 'pulls.updateBranch', 'issues.removeLabel'].includes(k))
    expect(order).toEqual(['issues.addLabels', 'pulls.update', 'pulls.updateBranch', 'issues.removeLabel'])
    expect(f.called('pulls.update')[0]!.args).toMatchObject({ pull_number: 2, base: 'main' })
    expect([...r.pushed]).toEqual([2])
    expect(r.lines.join()).toMatch(/#1 merged, so it now targets main and is up to date/)
  })

  it("trusts no old PR of a reused branch name: closed before the stacked PR opened, or the branch pushed to since", async () => {
    const old = fakeGithub({ 'pulls.list': (a: Record<string, unknown>) => (a.state === 'closed' ? [mergedBase({ closed_at: '2026-10-01T00:00:00Z' })] : []) })
    expect((await restack(rd(old), [pr(2, 'claude/b', 'claude/a')])).lines).toEqual([])
    const reused = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.state === 'closed' ? [mergedBase()] : []),
      'repos.getBranch': { commit: { sha: 'someone-else' } },
    })
    expect((await restack(rd(reused), [pr(2, 'claude/b', 'claude/a')])).lines).toEqual([])
    expect(old.called('pulls.update')).toHaveLength(0)
    expect(reused.called('pulls.update')).toHaveLength(0)
  })

  it('brings a change up to date with a base that moved on, and asks nothing when the base has not moved', async () => {
    const f = fakeGithub({ 'repos.compareCommits': { ahead_by: 1, behind_by: 2 } })
    const still = pr(3, 'claude/c', 'claude/b', { base: { ref: 'claude/b', sha: head(2) } })
    const r = await restack(rd(f), [pr(1, 'claude/a'), pr(2, 'claude/b', 'claude/a', { base: { ref: 'claude/a', sha: 'older' } }), still])
    expect(f.called('repos.compareCommits')).toHaveLength(1)
    expect(f.called('pulls.updateBranch').map((c) => c.args.pull_number)).toEqual([2])
    expect(r.lines.join()).toMatch(/#2: merged claude\/a \(#1\) in/)
  })

  it('holds a change whose base was closed unmerged and says why; writes nothing without a token', async () => {
    const closed = (a: Record<string, unknown>) => (a.state === 'closed' ? [mergedBase({ merged_at: null })] : [])
    const f = fakeGithub({ 'pulls.list': closed, 'repos.getBranch': { commit: { sha: head(1) } }, 'issues.listComments': [] })
    await restack(rd(f), [pr(2, 'claude/b', 'claude/a')])
    expect(f.called('pulls.update')).toHaveLength(0)
    expect(f.called('issues.addLabels')[0]!.args.labels).toEqual(['no-automerge'])
    expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/closed without merging.*Discard it/)
    const g = fakeGithub({ 'pulls.list': closed, 'repos.getBranch': { commit: { sha: head(1) } } })
    expect((await restack(rd(g, false), [pr(2, 'claude/b', 'claude/a')])).lines.join()).toMatch(/no TRACE_TOKEN/)
    expect(g.calls.filter((c) => !['pulls.list', 'repos.getBranch'].includes(c.key))).toEqual([])
  })

  it('tells a conflict from a head that moved, pushes nothing without a token, and keeps to its budget', async () => {
    const behind = { ahead_by: 1, behind_by: 1 }
    const conflict = Object.assign(new Error('merge conflict between base and head'), { status: 422 })
    const f = fakeGithub({ 'repos.compareCommits': () => behind, 'pulls.updateBranch': conflict })
    const many = [pr(1, 'claude/a'), ...Array.from({ length: RESTACK_PER_RUN + 1 }, (_, i) => pr(i + 2, `claude/s${i}`, 'claude/a'))]
    const r = await restack(rd(f), many)
    expect(r.lines.join()).toMatch(/conflict with #1: left for the worker/)
    expect(r.pushed.size).toBe(0)
    const moved = fakeGithub({ 'repos.compareCommits': () => behind, 'pulls.updateBranch': Object.assign(new Error("expected head sha didn't match current head ref."), { status: 422 }) })
    expect((await restack(rd(moved), many.slice(0, 2))).lines.join()).toMatch(/moved while it was looked at/)
    const ok = fakeGithub({ 'repos.compareCommits': () => behind })
    const capped = await restack(rd(ok), many, 2)
    expect(capped.pushed.size).toBe(2)
    expect(capped.lines.join()).toMatch(/next run/)
    const g = fakeGithub({ 'repos.compareCommits': () => behind })
    expect((await restack(rd(g, false), many.slice(0, 2))).lines.join()).toMatch(/no TRACE_TOKEN/)
    expect(g.called('pulls.updateBranch')).toHaveLength(0)
  })

  it("leaves a change based on a person's own branch (no pull request) alone", async () => {
    const f = fakeGithub({ 'pulls.list': [] })
    expect((await restack(rd(f), [pr(2, 'claude/b', 'release/1')])).lines).toEqual([])
    expect(f.called('pulls.update')).toHaveLength(0)
  })
})

describe('update queue with stacks', () => {
  it('restacks first, sharing one push budget with the database merges, and never pushes a PR twice', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.state === 'closed'
        ? [{ number: 1, merged_at: '2026-11-04', closed_at: '2026-11-04T01:00:00Z', base: { ref: 'main' }, head: { sha: head(1) } }]
        : [pr(2, 'claude/b', 'claude/a', { auto_merge: null })]),
      'repos.getBranch': Object.assign(new Error('Branch not found'), { status: 404 }),
    })
    const core = fakeCore()
    let resolved = 0
    await prs.updateQueue(deps(f, core, cfgOf(), context(), { OWN_TOKEN: 't' }), async () => { resolved++; return { ok: true as const, commit: 'x' } })
    expect(f.called('pulls.update')[0]!.args.base).toBe('main')
    expect(core.text).toMatch(/now targets main/)
    expect(resolved).toBe(0)
  })
})
