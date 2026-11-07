// trace's own stacked pull requests (.github/workflows/stack.yml, docs/stacked-changes.md): the workflow's script, run
// against the harness tests' fake GitHub, as github-script would run it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { SHA, fakeCore, fakeGithub } from './fake.js'

const workflow = parse(readFileSync(new URL('../../.github/workflows/stack.yml', import.meta.url), 'utf8')) as {
  on: { pull_request: { types: string[] } }; jobs: { restack: { steps: { with: { script: string; 'github-token': string } }[] } }
}
const step = workflow.jobs.restack.steps[0]!.with
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...a: string[]) => (...x: unknown[]) => Promise<unknown>
const run = (f: ReturnType<typeof fakeGithub>, action: string, pr: Record<string, unknown>) => {
  const core = fakeCore()
  const script = new AsyncFunction('github', 'context', 'core', step.script)
  return { core, done: script(f.gh, { repo: { owner: 'mteichtahl', repo: 'trace' }, payload: { action, pull_request: pr } }, core) }
}
const pr = (number: number, head: string, base: string, extra: Record<string, unknown> = {}) => ({
  number, head: { ref: head, sha: SHA(String(number % 10)), repo: { full_name: 'mteichtahl/trace' } }, base: { ref: base }, ...extra,
})

describe('stack.yml', () => {
  it('runs on a merge or close and on a push to a pull request, with TRACE_TOKEN when there is one', () => {
    expect(workflow.on.pull_request.types).toEqual(['closed', 'synchronize'])
    expect(step['github-token']).toMatch(/secrets\.TRACE_TOKEN \|\| github\.token/)
  })

  it('moves the pull requests built on a merged one onto its base and brings them up to date', async () => {
    const f = fakeGithub({ 'pulls.list': (a: Record<string, unknown>) => (a.base === 'claude/a' ? [pr(2, 'claude/b', 'claude/a')] : []) })
    const { core, done } = run(f, 'closed', pr(1, 'claude/a', 'main', { merged: true }))
    await done
    expect(f.called('pulls.update')[0]!.args).toMatchObject({ pull_number: 2, base: 'main' })
    // the merges API, not "Update branch", which GitHub refuses for a stacked pull request
    expect(f.called('repos.merge')[0]!.args).toMatchObject({ base: 'claude/b', head: 'main' })
    expect(f.called('pulls.updateBranch')).toHaveLength(0)
    expect(core.text).toMatch(/#2: #1 merged, so it now targets `main` and is up to date/)
  })

  it('brings up to date the ones GitHub already moved (merged branch deleted), and only those built on it', async () => {
    const f = fakeGithub({
      'pulls.list': (a: Record<string, unknown>) => (a.base === 'main' ? [pr(2, 'claude/b', 'main'), pr(3, 'claude/other', 'main')] : []),
      'repos.compareCommits': (a: Record<string, unknown>) => (a.head === SHA('2') ? { ahead_by: 1, behind_by: 0 } : { ahead_by: 2, behind_by: 5 }),
    })
    const { core, done } = run(f, 'closed', pr(1, 'claude/a', 'main', { merged: true }))
    await done
    expect(f.called('pulls.update')).toHaveLength(0)
    expect(f.called('repos.merge').map((c) => [c.args.base, c.args.head])).toEqual([['claude/b', 'main']])
    expect(core.text).toMatch(/GitHub moved it onto `main`/)
  })

  it('merges new commits into the ones built on a pushed pull request, and says when that conflicts', async () => {
    const f = fakeGithub({
      'pulls.list': [pr(2, 'claude/b', 'claude/a'), pr(3, 'claude/c', 'claude/a')],
      'repos.merge': (a: Record<string, unknown>) => (a.base === 'claude/c' ? Object.assign(new Error('Merge conflict'), { status: 409 }) : {}),
    })
    const { core, done } = run(f, 'synchronize', pr(1, 'claude/a', 'main'))
    await done
    expect(f.called('repos.merge').map((c) => [c.args.base, c.args.head])).toEqual([['claude/b', 'claude/a'], ['claude/c', 'claude/a']])
    expect(core.text).toMatch(/#2: merged #1's new commits in/)
    expect(core.text).toMatch(/#3 conflicts with #1/)
  })

  it('tells the ones built on a pull request closed unmerged, and ignores a fork', async () => {
    const f = fakeGithub({ 'pulls.list': [pr(2, 'claude/b', 'claude/a')], 'issues.listComments': [] })
    await run(f, 'closed', pr(1, 'claude/a', 'main', { merged: false })).done
    expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/closed without merging/)
    // said once
    const again = fakeGithub({ 'pulls.list': [pr(2, 'claude/b', 'claude/a')], 'issues.listComments': [{ body: 'x\n<!-- stack: base-closed #1 -->' }] })
    await run(again, 'closed', pr(1, 'claude/a', 'main', { merged: false })).done
    expect(again.called('issues.createComment')).toHaveLength(0)
    expect(f.called('pulls.update')).toHaveLength(0)
    const g = fakeGithub()
    await run(g, 'closed', { ...pr(1, 'claude/a', 'main', { merged: true }), head: { ref: 'claude/a', sha: SHA('1'), repo: { full_name: 'someone/trace' } } }).done
    expect(g.calls).toHaveLength(0)
  })

  // #237: #361 merged into #356's branch seconds after #356 had merged, before this workflow moved it to main, so its
  // commits reached no branch that merges on and missed main
  describe('a pull request merged into a branch already merged', () => {
    const T0 = '2026-11-07T03:00:00Z'
    const T1 = '2026-11-07T03:00:20Z'
    const child = pr(4, 'claude/b', 'claude/a', { merged: true, merged_at: T1, merge_commit_sha: SHA('9') })
    const parent = pr(1, 'claude/a', 'main', { merged: true, merged_at: T0 })
    const lists = (closed: Record<string, unknown[]>, extra: (a: Record<string, unknown>) => unknown[] = () => []) => (a: Record<string, unknown>) => {
      if (a.head && a.state === 'closed') return closed[String(a.head)] ?? []
      if (a.head) return []
      return extra(a)
    }

    it('opens a pull request carrying its commits on to main, says so on it, and moves the ones built on it to main', async () => {
      const f = fakeGithub({
        'pulls.list': lists({ 'mteichtahl:claude/a': [parent] }, (a) => (a.base === 'claude/b' ? [pr(5, 'claude/c', 'claude/b')] : [])),
        'repos.compareCommits': { ahead_by: 2, behind_by: 0 },
        'pulls.create': { number: 99 },
      })
      const { core, done } = run(f, 'closed', child)
      await done
      expect(f.called('git.createRef')[0]!.args).toMatchObject({ ref: 'refs/heads/stack/carry-4', sha: SHA('9') })
      expect(f.called('repos.compareCommits')[0]!.args).toMatchObject({ base: 'main', head: SHA('9') })
      expect(f.called('pulls.create')[0]!.args).toMatchObject({ head: 'stack/carry-4', base: 'main', title: 'Carry #4 on to main' })
      expect(f.called('issues.createComment')[0]!.args).toMatchObject({ issue_number: 4 })
      expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/after #1 had merged, so its commits did not reach `main`\. #99 carries them on/)
      // #5, built on #4, goes where the commits go, not onto the merged branch
      expect(f.called('pulls.update')[0]!.args).toMatchObject({ pull_number: 5, base: 'main' })
      expect(f.called('repos.merge')[0]!.args).toMatchObject({ base: 'claude/c', head: 'main' })
      expect(core.text).toMatch(/#4 merged into `claude\/a` after #1 had merged: #99 carries its commits on to `main`/)
    })

    it('goes up the stack past every branch that merged, to the first still open', async () => {
      const f = fakeGithub({
        'pulls.list': lists({ 'mteichtahl:claude/a': [pr(1, 'claude/a', 'claude/x', { merged: true, merged_at: T0 })], 'mteichtahl:claude/x': [pr(7, 'claude/x', 'claude/y', { merged: true, merged_at: T0 })] }),
        'repos.compareCommits': { ahead_by: 1, behind_by: 0 },
        'pulls.create': { number: 99 },
      })
      await run(f, 'closed', child).done
      expect(f.called('pulls.create')[0]!.args).toMatchObject({ base: 'claude/y' })
    })

    it('does nothing more when the commits are there already, the base merged after it, or the base is still open', async () => {
      const there = fakeGithub({ 'pulls.list': lists({ 'mteichtahl:claude/a': [parent] }), 'repos.compareCommits': { ahead_by: 0, behind_by: 3 } })
      const t = run(there, 'closed', child)
      await t.done
      expect(there.called('pulls.create')).toHaveLength(0)
      expect(t.core.text).toMatch(/its commits are on `main` already/)
      // merged into its base before the base merged: its commits went with the base
      const before = fakeGithub({ 'pulls.list': lists({ 'mteichtahl:claude/a': [{ ...parent, merged_at: '2026-11-07T03:01:00Z' }] }) })
      await run(before, 'closed', child).done
      expect(before.called('repos.compareCommits')).toHaveLength(0)
      expect(before.called('git.createRef')).toHaveLength(0)
      // the base's pull request is open: the normal case
      const open = fakeGithub({ 'pulls.list': (a: Record<string, unknown>) => (a.head === 'mteichtahl:claude/a' && a.state === 'open' ? [pr(1, 'claude/a', 'main')] : []) })
      await run(open, 'closed', child).done
      expect(open.called('git.createRef')).toHaveLength(0)
    })

    it('run again, it keeps the pull request it opened', async () => {
      const f = fakeGithub({
        'pulls.list': (a: Record<string, unknown>) => (a.head === 'mteichtahl:claude/a' && a.state === 'closed' ? [parent] : a.head === 'mteichtahl:stack/carry-4' ? [{ number: 99 }] : []),
        'repos.compareCommits': { ahead_by: 2, behind_by: 0 },
        'git.createRef': () => Object.assign(new Error('Reference already exists'), { status: 422 }),
      })
      await run(f, 'closed', child).done
      expect(f.called('pulls.create')).toHaveLength(0)
      expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/#99 carries them on/)
      // and says it once
      const said = fakeGithub({
        'pulls.list': (a: Record<string, unknown>) => (a.head === 'mteichtahl:claude/a' && a.state === 'closed' ? [parent] : a.head === 'mteichtahl:stack/carry-4' ? [{ number: 99 }] : []),
        'repos.compareCommits': { ahead_by: 2, behind_by: 0 },
        'git.createRef': () => Object.assign(new Error('Reference already exists'), { status: 422 }),
        'issues.listComments': [{ body: 'x\n<!-- stack: carried by #99 -->' }],
      })
      await run(said, 'closed', child).done
      expect(said.called('issues.createComment')).toHaveLength(0)
    })
  })
})
