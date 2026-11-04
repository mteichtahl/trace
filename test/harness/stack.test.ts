import { describe, expect, it } from 'vitest'
import * as prs from '../../src/harness/prs.js'
import { RESTACK_PER_RUN, parentOf, restack } from '../../src/harness/stack.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from './fake.js'

const pr = (number: number, head: string, base = 'main', extra: Record<string, unknown> = {}) => ({
  number, title: `change ${number}`, draft: false, labels: [], created_at: `2026-11-0${number % 9}T00:00:00Z`,
  head: { ref: head, sha: SHA(String(number % 10)), repo: { full_name: 'o/r' } }, base: { ref: base }, ...extra,
})

/** compareCommits answered from a table of "base...head" → { ahead_by, behind_by }. */
const compare = (table: Record<string, { ahead_by: number; behind_by: number }>) => (a: Record<string, unknown>) => {
  const r = table[`${String(a.base)}...${String(a.head)}`]
  if (!r) return new Error('not found')
  return { ...r, commits: Array.from({ length: r.ahead_by }, (_, i) => ({ sha: SHA(String(i)), commit: { message: `commit ${i}` } })) }
}

describe('parentOf', () => {
  it('picks the nearest open branch the pushed branch is built on', async () => {
    const f = fakeGithub({
      'pulls.list': [pr(1, 'claude/a'), pr(2, 'claude/b', 'claude/a'), pr(3, 'claude/other')],
      'repos.compareCommits': compare({
        'claude/a...claude/c': { ahead_by: 3, behind_by: 0 },
        'claude/b...claude/c': { ahead_by: 1, behind_by: 0 },
        'claude/other...claude/c': { ahead_by: 4, behind_by: 2 },
        'main...claude/a': { ahead_by: 2, behind_by: 0 },
        'main...claude/b': { ahead_by: 4, behind_by: 0 },
      }),
    })
    const p = await parentOf(f.gh, 'o', 'r', 'claude/c', 'main')
    expect(p).toMatchObject({ number: 2, ref: 'claude/b', ahead: 1 })
  })

  it('is null for a branch built on nothing open, or on a branch already on main', async () => {
    const f = fakeGithub({
      'pulls.list': [pr(1, 'claude/a')],
      'repos.compareCommits': compare({ 'claude/a...claude/c': { ahead_by: 1, behind_by: 0 }, 'main...claude/a': { ahead_by: 0, behind_by: 3 } }),
    })
    expect(await parentOf(f.gh, 'o', 'r', 'claude/c', 'main')).toBeNull()
  })
})

describe('open-pr, stacked', () => {
  it('targets the parent branch and lists only its own commits', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.head ? [] : [pr(4, 'claude/a')]),
      'repos.compareCommits': compare({
        'main...claude/c': { ahead_by: 3, behind_by: 0 },
        'claude/a...claude/c': { ahead_by: 1, behind_by: 0 },
        'main...claude/a': { ahead_by: 2, behind_by: 0 },
      }),
      'pulls.create': { number: 9, html_url: 'u' },
    })
    const core = fakeCore()
    await prs.openPr(deps(f, core, cfgOf(), context({ ref: 'refs/heads/claude/c' }), { OWN_TOKEN: 't' }))
    const c = f.called('pulls.create')[0]!.args
    expect(c.base).toBe('claude/a')
    expect(String(c.body)).toMatch(/Stacked on #4/)
    expect(c.title).toBe('commit 0')
    expect(core.text).toMatch(/stacked on #4/)
  })

  it('targets the default branch when prs.stack is off', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.head ? [] : [pr(4, 'claude/a')]),
      'repos.compareCommits': compare({ 'main...claude/c': { ahead_by: 3, behind_by: 0 } }),
      'pulls.create': { number: 9, html_url: 'u' },
    })
    await prs.openPr(deps(f, fakeCore(), cfgOf({ prs: { stack: false } }), context({ ref: 'refs/heads/claude/c' }), { OWN_TOKEN: 't' }))
    expect(f.called('pulls.create')[0]!.args.base).toBe('main')
  })
})

describe('restack', () => {
  const rd = (f: ReturnType<typeof fakeGithub>, canPush = true) => ({ github: f.gh, owner: 'o', repo: 'r', defaultBranch: 'main', hold: 'no-automerge', canPush })

  it('moves a change whose base merged onto where the base went, and brings it up to date', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.state === 'closed' ? [{ number: 1, merged_at: '2026-11-04', closed_at: '2026-11-04', base: { ref: 'main' } }] : []),
    })
    const lines = await restack(rd(f), [pr(2, 'claude/b', 'claude/a')])
    expect(f.called('pulls.update')[0]!.args).toMatchObject({ pull_number: 2, base: 'main' })
    expect(f.called('pulls.updateBranch')[0]!.args).toMatchObject({ pull_number: 2 })
    expect(lines.join()).toMatch(/#1 merged, so it now targets main and is up to date/)
  })

  it('brings a change up to date with a base that moved on, and leaves one already up to date', async () => {
    const f = fakeGithub({
      'repos.compareCommits': compare({ 'claude/a...claude/b': { ahead_by: 1, behind_by: 2 }, 'claude/b...claude/c': { ahead_by: 1, behind_by: 0 } }),
    })
    const lines = await restack(rd(f), [pr(1, 'claude/a'), pr(2, 'claude/b', 'claude/a'), pr(3, 'claude/c', 'claude/b')])
    expect(f.called('pulls.updateBranch').map((c) => c.args.pull_number)).toEqual([2])
    expect(lines.join()).toMatch(/#2: merged claude\/a \(#1\) in/)
  })

  it('holds a change whose base was closed unmerged and says why, once', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.state === 'closed' ? [{ number: 1, merged_at: null, closed_at: '2026-11-04', base: { ref: 'main' } }] : []),
      'issues.listComments': [],
    })
    await restack(rd(f), [pr(2, 'claude/b', 'claude/a')])
    expect(f.called('pulls.update')).toHaveLength(0)
    expect(f.called('issues.addLabels')[0]!.args.labels).toEqual(['no-automerge'])
    expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/closed without merging/)
  })

  it('reports a conflict with its base for the worker, pushes nothing without a token, and caps pushes per run', async () => {
    const conflict = Object.assign(new Error('merge conflict'), { status: 422 })
    const behind = { ahead_by: 1, behind_by: 1 }
    const f = fakeGithub({ 'repos.compareCommits': () => behind, 'pulls.updateBranch': conflict })
    const many = [pr(1, 'claude/a'), ...Array.from({ length: RESTACK_PER_RUN + 1 }, (_, i) => pr(i + 2, `claude/s${i}`, 'claude/a'))]
    const lines = await restack(rd(f), many)
    expect(lines.join()).toMatch(/conflict with #1: left for the worker/)
    expect(f.called('pulls.updateBranch')).toHaveLength(RESTACK_PER_RUN)
    expect(lines.join()).toMatch(/next run/)
    const g = fakeGithub({ 'repos.compareCommits': () => behind })
    expect((await restack(rd(g, false), many.slice(0, 2))).join()).toMatch(/no TRACE_TOKEN/)
    expect(g.called('pulls.updateBranch')).toHaveLength(0)
  })

  it("leaves a change based on a person's own branch (no pull request) alone", async () => {
    const f = fakeGithub({ 'pulls.list': [] })
    expect(await restack(rd(f), [pr(2, 'claude/b', 'release/1')])).toEqual([])
    expect(f.called('pulls.update')).toHaveLength(0)
  })
})

describe('update queue with stacks', () => {
  it('restacks before the queue, and the queue sees only changes to the default branch', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.state === 'closed'
        ? [{ number: 1, merged_at: '2026-11-04', closed_at: '2026-11-04', base: { ref: 'main' } }]
        : [pr(2, 'claude/b', 'claude/a', { auto_merge: null })]),
    })
    const core = fakeCore()
    await prs.updateQueue(deps(f, core, cfgOf(), context(), { OWN_TOKEN: 't' }))
    expect(f.called('pulls.update')[0]!.args.base).toBe('main')
    expect(core.text).toMatch(/now targets main/)
  })
})
