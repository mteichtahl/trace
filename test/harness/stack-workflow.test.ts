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
})
