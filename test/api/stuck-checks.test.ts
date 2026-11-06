/**
 * Checks no runner picks up (src/api/stuck-checks.ts, test-esp32 log #146): a project's checks sat queued for 20 hours
 * on its CodeBuild runner, whose every build failed in DOWNLOAD_SOURCE on the GitHub connection's credential, while the
 * app said "Checks running". What is stuck, why in CodeBuild's own words, what an admin does, and running them again
 * (cancel every stuck run, which frees its concurrency group; run again the newest of each workflow and branch).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AUTO_RETRY_S, CONNECTION_FIX, STUCK_AFTER_S, dueRetry, forgetRetries, queuedRuns, restartStuck, runnerBuildsOf, runnerFault, stuckOn, stuckView, stuckWords, waitedFor,
} from '../../src/api/stuck-checks.js'
import { reviewItems } from '../../src/api/inbox-review.js'
import { GitHubError } from '../../src/api/github.js'
import type { JobRow } from '../../src/core/job-index.js'

const AT = Date.parse('2026-11-05T07:00:00Z') / 1000
const iso = (s: number): string => new Date(s * 1000).toISOString()
// CodeBuild's message in run 2, as its DOWNLOAD_SOURCE phase gave it
const REFUSED = 'GitHub rejected the runner credential because it lacks the required permission (administration=write). Re-authorize the CodeConnections connection and grant the required permissions.'
const runsBody = (...rs: { id: number; sha: string; at: number; workflow?: number; branch?: string; status?: string }[]) => ({
  total_count: rs.length,
  workflow_runs: rs.map((r) => ({ id: r.id, name: 'trace-prs', workflow_id: r.workflow ?? 7, head_branch: r.branch ?? 'claude/task-a', head_sha: r.sha, status: r.status ?? 'queued', created_at: iso(r.at), run_started_at: iso(r.at) })),
})

describe('what is stuck', () => {
  it('a run queued half an hour or more is stuck; a newer one, or one on another commit, is not', () => {
    const runs = queuedRuns(runsBody({ id: 1, sha: 'aa', at: AT - 20 * 3600 }, { id: 2, sha: 'aa', at: AT - 60 }, { id: 3, sha: 'bb', at: AT - STUCK_AFTER_S }, { id: 4, sha: 'cc', at: AT - 7200, status: 'in_progress' }))
    expect(runs.map((r) => r.id)).toEqual([1, 2, 3])
    expect(stuckOn(runs, 'aa', AT)).toEqual({ runs: 1, since: iso(AT - 20 * 3600) })
    expect(stuckOn(runs, 'bb', AT)).toEqual({ runs: 1, since: iso(AT - STUCK_AFTER_S) })
    expect(stuckOn(runs, 'cc', AT)).toBeNull()
    expect(stuckOn(runs, undefined, AT)).toBeNull()
    expect(queuedRuns({ nonsense: true })).toEqual([])
  })

  it('reads CodeBuild\'s builds newest first, with the failed phase and its message', () => {
    const builds = runnerBuildsOf([
      { startTime: new Date('2026-11-04T10:42:00Z'), buildStatus: 'FAILED', phases: [{ phaseType: 'SUBMITTED', phaseStatus: 'SUCCEEDED' }, { phaseType: 'DOWNLOAD_SOURCE', phaseStatus: 'FAILED', contexts: [{ statusCode: 'CLIENT_ERROR', message: REFUSED }] }] },
      { startTime: new Date('2026-11-04T21:10:00Z'), buildStatus: 'FAILED', phases: [{ phaseType: 'DOWNLOAD_SOURCE', phaseStatus: 'FAILED', contexts: [{ message: REFUSED }] }] },
    ])
    expect(builds).toEqual([
      { at: '2026-11-04T21:10:00.000Z', status: 'FAILED', phase: 'DOWNLOAD_SOURCE', message: REFUSED },
      { at: '2026-11-04T10:42:00.000Z', status: 'FAILED', phase: 'DOWNLOAD_SOURCE', message: REFUSED },
    ])
  })
})

describe('why, in CodeBuild\'s words', () => {
  const failed = (message: string | null, phase = 'DOWNLOAD_SOURCE') => ({ at: iso(AT - 60), status: 'FAILED', phase, message })

  it('the connection lacking administration access is named as that', () => {
    expect(runnerFault([failed(REFUSED), failed(REFUSED)])).toEqual({
      why: 'the CodeBuild runner cannot get a GitHub runner token, because its GitHub connection lacks administration access', connection: true, failed: 2,
    })
  })

  it('another failure is said with its phase and message; a runner whose newest build passed is not at fault', () => {
    expect(runnerFault([failed('Cannot pull image', 'PROVISIONING')])).toEqual({ why: 'the CodeBuild runner\'s builds fail in PROVISIONING ("Cannot pull image")', connection: false, failed: 1 })
    expect(runnerFault([{ ...failed(null), status: 'SUCCEEDED' }, failed(REFUSED)])).toBeNull()
    expect(runnerFault([])).toBeNull()
    expect(runnerFault(null)).toBeNull()
  })

  it('says what an admin does: re-authorize the connection, then trace runs them again', () => {
    const on = { runs: 2, since: iso(AT - 20 * 3600) }
    const s = stuckView(on, { project: 'trace-ci-213dfa1f', builds: [failed(REFUSED)] }, AT)
    expect(s).toEqual({ runs: 2, since: on.since, runner: 'trace-ci-213dfa1f', connection: true, why: expect.stringMatching(/lacks administration access$/), fix: expect.stringContaining(CONNECTION_FIX) })
    expect(s.fix).toMatch(/Developer Tools, Settings, Connections.*"Administration: read and write".*trace then runs the stuck checks again itself/)
    expect(stuckWords(s, AT)).toBe(`Its checks cannot start: ${s.why}. They have waited 20 hours. ${s.fix}`)
  })

  it('without the builds, or without a CodeBuild runner, it says no runner picks them up, and where to look', () => {
    const on = { runs: 1, since: iso(AT - 3 * 3600) }
    const blind = stuckView(on, { project: 'trace-ci-213dfa1f', builds: null }, AT)
    expect(blind.why).toBe('no runner has picked it up in 3 hours')
    expect(blind.fix).toMatch(/CodeBuild runner trace-ci-213dfa1f, whose builds trace may not read.*DOWNLOAD_SOURCE.*administration access/)
    const github = stuckView(on, { project: null, builds: null }, AT)
    expect(github).toMatchObject({ runner: null, connection: false, why: 'no runner has picked it up in 3 hours' })
    expect(github.fix).toMatch(/GitHub's own runners/)
    // the runner builds nothing at all for them: its webhook
    expect(stuckView(on, { project: 'trace-ci-1', builds: [] }, AT).fix).toMatch(/webhook/)
  })

  it('says how long in plain words', () => {
    expect(waitedFor(iso(AT - 40 * 60), AT)).toBe('40 minutes')
    expect(waitedFor(iso(AT - 13 * 3600), AT)).toBe('13 hours')
    expect(waitedFor(iso(AT - 3 * 86400), AT)).toBe('3 days')
  })
})

describe('running them again', () => {
  /** a fake GitHub: what was done, and each run's status once cancelled */
  const fake = (o: { stopping?: number[]; refuse?: number } = {}) => {
    const did: string[] = []
    return {
      did,
      gh: {
        request: async (method: string, path: string): Promise<unknown> => {
          if (method !== 'GET') did.push(`${method} ${path}`)
          if (o.refuse && method === 'POST') throw new GitHubError(o.refuse, 'refused')
          const id = Number(/runs\/(\d+)$/.exec(path)?.[1])
          if (method === 'GET') return { id, status: o.stopping?.includes(id) ? 'in_progress' : 'completed' }
          return null
        },
      },
    }
  }
  const runs = queuedRuns(runsBody(
    { id: 11, sha: 'aa', at: AT - 20 * 3600, branch: 'claude/task-a' },
    // a newer run of the same workflow on the same branch: it is the one run again; the older only held the group
    { id: 12, sha: 'ab', at: AT - 13 * 3600, branch: 'claude/task-a' },
    { id: 21, sha: 'bb', at: AT - 13 * 3600, branch: 'claude/task-b' },
  ))
  const sleep = async () => {}

  it('cancels every stuck run, then runs again the newest of each workflow and branch', async () => {
    const f = fake()
    expect(await restartStuck(f.gh, 'acme/board', runs, { sleep })).toEqual({ cancelled: 3, rerun: 2, later: 0 })
    expect(f.did).toEqual([
      'POST /repos/acme/board/actions/runs/11/cancel', 'POST /repos/acme/board/actions/runs/12/cancel', 'POST /repos/acme/board/actions/runs/21/cancel',
      'POST /repos/acme/board/actions/runs/12/rerun', 'POST /repos/acme/board/actions/runs/21/rerun',
    ])
  })

  it('only the changes asked for; a run still stopping runs again on the next pass', async () => {
    const f = fake({ stopping: [21] })
    expect(await restartStuck(f.gh, 'acme/board', runs, { sleep, only: new Set(['bb']), tries: 2 })).toEqual({ cancelled: 1, rerun: 0, later: 1 })
    expect(f.did).toEqual(['POST /repos/acme/board/actions/runs/21/cancel'])
  })

  it('GitHub refusing is thrown, for the action to say in plain words', async () => {
    await expect(restartStuck(fake({ refuse: 403 }).gh, 'acme/board', runs, { sleep })).rejects.toThrow(GitHubError)
  })

  beforeEach(() => forgetRetries())

  it('trace tries on its own at most every 30 minutes, and only on a CodeBuild runner', () => {
    const look = { runs, runner: { project: 'trace-ci-1', builds: null } }
    expect(dueRetry('acme/board', look, AT)).toBe(true)
    expect(dueRetry('acme/board', look, AT + 60)).toBe(false)
    expect(dueRetry('acme/board', look, AT + AUTO_RETRY_S)).toBe(true)
    expect(dueRetry('acme/other', { runs, runner: { project: null, builds: null } }, AT)).toBe(false)
    expect(dueRetry('acme/other', { runs: [], runner: null }, AT)).toBe(false)
  })
})

describe('Next: a change whose checks cannot start', () => {
  it('says so, with what an admin does, instead of "its work counts once you accept it"', () => {
    const job: JobRow = {
      id: 'job-a', handle: null, session: null, kind: 'task', agent: 'docs', title: 'docs', number: null, requestedBySub: null, requestedBy: null, state: 'succeeded', step: null,
      queuedAt: null, startedAt: null, endedAt: AT - 3600, beatAt: null, where: null, branch: 'claude/task-a', parentJob: null, handoff: null, resumeOf: null, resumedBy: null,
      summary: null, error: null, payload: null, claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null, updatedAt: AT - 3600,
    }
    const stuck = stuckView({ runs: 1, since: iso(AT - 20 * 3600) }, { project: 'trace-ci-1', builds: [{ at: iso(AT), status: 'FAILED', phase: 'DOWNLOAD_SOURCE', message: REFUSED }] }, AT)
    const items = reviewItems({
      repo: 'acme/board', project: 'Board', stage: 'layout', at: AT, agentWords: { docs: 'Documentation' }, jobs: [job],
      rule: { repo: 'acme/board', defaultBranch: 'main', prefix: 'claude/', agentLogin: null },
      pulls: [{ number: 20, title: 'Docs record', head: 'claude/task-a', draft: false, labels: [], url: 'u', updated_at: iso(AT), headRepo: 'acme/board', sha: 'aa' }],
      stuck: (sha) => (sha === 'aa' ? stuck : null),
    })
    expect(items[0]).toMatchObject({ action: 'See why', summary: `Board: the checks of "Docs record" cannot start: ${stuck.why}. ${stuck.fix}` })
  })
})
