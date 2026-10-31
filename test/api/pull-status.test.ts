// pull.status (src/api/actions.ts, github.ts pullStatus): one pull request's state and its head commit's checks, which
// the app's pull request card asks for again while the pull request is open.
import { describe, expect, it } from 'vitest'
import { HttpGitHub, checksOf } from '../../src/api/github.js'

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('a pull request\'s status', () => {
  it('counts the checks: running, passed, failed (named), and skipped or neutral as neither', () => {
    expect(checksOf([
      { name: 'build', status: 'in_progress', conclusion: null }, { name: 'tests', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'timed_out' },
      { name: 'deploy', status: 'completed', conclusion: 'skipped' },
    ])).toEqual({ total: 5, passed: 1, failed: 2, running: 1, skipped: 1, failing: ['lint'] })
  })

  it('reads the pull request and its head commit\'s check runs; merged wins over closed; checks the token cannot read are null', async () => {
    const calls: string[] = []
    const pr = { number: 1, title: 'Project purpose and requirements R1-R10', html_url: 'https://github.com/a/b/pull/1', state: 'open', draft: false, merged_at: null, mergeable_state: 'blocked', updated_at: '2026-10-31T07:40:00Z', head: { ref: 'claude/task-x', sha: 'abc123' } }
    const gh = new HttpGitHub('t', { base: 'https://api.test', fetch: (async (u: string) => {
      calls.push(new URL(u).pathname)
      if (u.endsWith('/pulls/1')) return json(pr)
      if (u.endsWith('/pulls/2')) return json({ ...pr, number: 2, state: 'closed', merged_at: '2026-10-31T08:00:00Z' })
      if (u.endsWith('/pulls/9')) return json({ message: 'Not Found' }, 404)
      if (u.includes('/commits/abc123/check-runs')) return calls.filter((c) => c.includes('check-runs')).length > 1 ? json({ message: 'no' }, 403) : json({ check_runs: [{ name: 'build', status: 'queued', conclusion: null }, { name: 'trace-prs', status: 'completed', conclusion: 'success' }] })
      return json({}, 500)
    }) as typeof fetch })
    expect(await gh.pullStatus('a/b', 1)).toEqual({
      number: 1, title: 'Project purpose and requirements R1-R10', url: 'https://github.com/a/b/pull/1', state: 'open', draft: false, mergeable: 'blocked',
      head: 'claude/task-x', sha: 'abc123', updated_at: '2026-10-31T07:40:00Z', checks: { total: 2, passed: 1, failed: 0, running: 1, skipped: 0, failing: [] },
    })
    expect(await gh.pullStatus('a/b', 2)).toMatchObject({ state: 'merged', checks: null })
    expect(await gh.pullStatus('a/b', 9)).toBeNull()
  })
})
