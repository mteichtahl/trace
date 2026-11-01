/**
 * Changes (src/api/actions-changes.ts, src/api/changes.ts): the pull requests trace's jobs opened, reviewed and
 * accepted in the app. The rules (verdict, recommendation, may_accept and its blockers, requirement ids, the summary)
 * as plain functions; then the actions over a fake GitHub and a real job index and journey store: the list, one
 * change, accept (re-checked, the hold label removed, a required review refused in plain words), ask (a revision job
 * with the same specialist on the same branch), discard, who may do what, and journey.get with a change open (and
 * with GitHub unreachable).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { mergeMethod } from '../../src/api/actions-changes.js'
import {
  type ChangeFacts, acceptance, fileKind, recommendationOf, requirementIds, summaryBullets, verdictOf,
} from '../../src/api/changes.js'
import { type CheckRunDetail, GitHubError, HttpGitHub, type MergeMethod, type PullDetail, type PullFile, type PullStatus, type PullSummary } from '../../src/api/github.js'
import { AccessDenied, type Principal, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { putJob } from '../../src/core/job-index.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

// ------------------------------------------------------------------ the rules

const checks = (o: Partial<NonNullable<PullStatus['checks']>> = {}): NonNullable<PullStatus['checks']> => ({ total: 2, passed: 2, failed: 0, running: 0, skipped: 0, failing: [], ...o })
const facts = (o: Partial<ChangeFacts> = {}): ChangeFacts => ({ state: 'open', draft: false, mergeable: 'clean', checks: checks(), ...o })

describe('the rules: verdict, recommendation, may_accept', () => {
  it('ready: every check passed and it can merge → accept, naming the checks and the requirements', () => {
    expect(verdictOf(facts())).toBe('ready')
    expect(recommendationOf(facts(), { passed: ['build', 'trace-prs'], requirements: ['R4', 'R7'] })).toEqual({
      verdict: 'accept', why: 'All 2 checks passed (build and trace-prs), and it can be merged. It covers R4 and R7.',
    })
    expect(acceptance(facts(), true)).toEqual({ may_accept: true, blockers: [] })
  })

  it('a check failing → ask, naming it; it may not be accepted', () => {
    const f = facts({ mergeable: 'unstable', checks: checks({ passed: 1, failed: 1, failing: ['kicad-erc'] }) })
    expect(verdictOf(f)).toBe('failing')
    expect(recommendationOf(f)).toEqual({ verdict: 'ask', why: 'The kicad-erc check failed. Ask trace to fix it before accepting.' })
    expect(acceptance(f, true)).toEqual({ may_accept: false, blockers: ['The kicad-erc check failed.'] })
  })

  it('checks running → wait; a conflict → none, trace brings it up to date', () => {
    const running = facts({ mergeable: 'blocked', checks: checks({ passed: 1, running: 1 }) })
    expect(verdictOf(running)).toBe('checking')
    expect(recommendationOf(running)).toEqual({ verdict: 'wait', why: '1 check is still running. Wait for it to finish.' })
    expect(acceptance(running, true).blockers).toEqual(['1 check is still running.'])
    const conflict = facts({ mergeable: 'dirty' })
    expect(verdictOf(conflict)).toBe('conflict')
    expect(recommendationOf(conflict)).toEqual({ verdict: 'none', why: 'It conflicts with changes accepted since it was made. trace will bring it up to date.' })
    expect(acceptance(conflict, true).may_accept).toBe(false)
  })

  it('blocked by the repository\'s rules with checks done says so; a draft waits; a reviewer is told who may accept', () => {
    expect(verdictOf(facts({ mergeable: 'blocked' }))).toBe('blocked')
    expect(recommendationOf(facts({ mergeable: 'blocked' })).why).toMatch(/approving review.*passing checks only/)
    expect(recommendationOf(facts({ draft: true })).verdict).toBe('wait')
    expect(acceptance(facts(), false)).toEqual({ may_accept: false, blockers: ['Only a contributor on this project can accept a change.'] })
    expect(acceptance(facts({ state: 'merged' }), true).blockers).toEqual(['It is already accepted into the design.'])
  })

  it('requirement ids from the title, body and commits, ranges spelled out; the summary\'s sources in order', () => {
    expect(requirementIds('Project purpose and requirements R1-R3', 'Covers R7 and R4.', 'fix R4')).toEqual(['R1', 'R2', 'R3', 'R7', 'R4'])
    expect(requirementIds('r4 is not one; nor is PR12 or R1-R900')).toEqual(['R1'])
    expect(summaryBullets({ jobSummary: 'Did it:\n- drew the regulator sheet\n- ran the rule check', body: '- other', commits: [] })).toEqual(['drew the regulator sheet', 'ran the rule check'])
    expect(summaryBullets({ jobSummary: null, body: 'Opened automatically.\n\n### Commits\n- abc1234 design: sheets\n- def5678 erc: clean', commits: ['x'] })).toEqual(['design: sheets', 'erc: clean'])
    expect(summaryBullets({ jobSummary: null, body: '', commits: ['first line\n\nbody', 'second'] })).toEqual(['first line', 'second'])
  })

  it('file kinds for the review page, and the merge method: squash first', () => {
    expect(fileKind('hw/power.kicad_sch', null)).toBe('schematic')
    expect(fileKind('hw/board.kicad_pcb', null)).toBe('board')
    expect(fileKind('docs/render.png', null)).toBe('image')
    expect(fileKind('README.md', '@@ -1 +1 @@')).toBe('text')
    expect(fileKind('.trace/project.db', null)).toBe('binary')
    expect(mergeMethod(['merge', 'squash'])).toBe('squash')
    expect(mergeMethod(['rebase', 'merge'])).toBe('merge')
  })
})

// ------------------------------------------------------------------ the GitHub calls

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('HttpGitHub: the changes\' calls', () => {
  it('merges with the method and the head sha, keeps GitHub\'s message on a refusal, and removes a label (false when absent)', async () => {
    const asked: string[] = []
    const gh = new HttpGitHub('t', { base: 'https://api.test', fetch: (async (u: string, init?: RequestInit) => {
      const path = `${init?.method ?? 'GET'} ${new URL(u).pathname}`
      asked.push(`${path} ${String(init?.body ?? '')}`)
      if (path === 'PUT /repos/a/b/pulls/1/merge') return json({ sha: 'm1', merged: true })
      if (path === 'PUT /repos/a/b/pulls/2/merge') return json({ message: 'At least 1 approving review is required by reviewers with write access.' }, 405)
      if (path === 'DELETE /repos/a/b/issues/1/labels/no-automerge') return json([])
      if (path === 'GET /repos/a/b') return json({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true })
      return json({ message: 'Not Found' }, 404)
    }) as typeof fetch })
    expect(await gh.mergePull('a/b', 1, { method: 'squash', sha: 'h1' })).toEqual({ sha: 'm1' })
    expect(asked[0]).toContain('"merge_method":"squash","sha":"h1"')
    const e = await gh.mergePull('a/b', 2, { method: 'squash', sha: 'h2' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GitHubError)
    expect((e as GitHubError).said).toMatch(/approving review/)
    expect(await gh.removeLabel('a/b', 1, 'no-automerge')).toBe(true)
    expect(await gh.removeLabel('a/b', 3, 'no-automerge')).toBe(false)
    expect(await gh.mergeMethods('a/b')).toEqual(['merge', 'rebase'])
  })
})

// ------------------------------------------------------------------ the actions

const ADMIN = { sub: 'c-admin', email: 'c-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'c-user', email: 'c-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'c-rev', email: 'c-rev@example.com', groups: ['trace-users'] }
const OUTSIDER = { sub: 'c-out', email: 'c-out@example.com', groups: ['trace-users'] }
const SYSTEM: Principal = { sub: 'c-svc', email: null, groups: ['trace-users'], kind: 'service', name: 'ci', scopes: ['read', 'write'] }
const REPO = 'acme/changes'

interface FakePull { detail: PullDetail; status: PullStatus; files: PullFile[]; commits: string[]; runs: CheckRunDetail[] }

/** The fixtures' fake GitHub with pull requests: what the changes read, and a log of what they did. */
class ChangesGitHub extends FakeGitHub {
  pulls = new Map<number, FakePull>()
  did: string[] = []
  mergeRefusal: GitHubError | null = null
  down = false
  methods: MergeMethod[] = ['merge', 'squash']
  add(number: number, head: string, o: { mergeable?: string; checks?: PullStatus['checks']; labels?: string[]; title?: string; body?: string } = {}): void {
    const title = o.title ?? `Change ${number}`
    const detail: PullDetail = {
      number, title, url: `https://github.com/${REPO}/pull/${number}`, state: 'open', draft: false, mergeable: o.mergeable ?? 'clean', body: o.body ?? '',
      labels: o.labels ?? [], created_at: `2026-10-3${number % 10}T00:00:00Z`, updated_at: '2026-11-01T00:00:00Z', head: { ref: head, sha: `head-${number}` }, base: { ref: 'main', sha: 'base-sha' },
    }
    const c = o.checks === undefined ? { total: 1, passed: 1, failed: 0, running: 0, skipped: 0, failing: [] } : o.checks
    this.pulls.set(number, {
      detail, status: { number, title, url: detail.url, state: 'open', draft: false, mergeable: detail.mergeable, head, sha: detail.head.sha, updated_at: detail.updated_at, checks: c },
      files: [{ path: 'hw/power.kicad_sch', status: 'modified', additions: 10, deletions: 2, patch: null, previous: null }, { path: 'docs/notes.md', status: 'added', additions: 3, deletions: 0, patch: '@@ +1,3 @@', previous: null }],
      commits: [`${title}\n\ncovers R2`], runs: [{ name: 'build', status: 'completed', conclusion: c && c.failed ? 'failure' : 'success', summary: 'Built.' }],
    })
  }
  private live(): void { if (this.down) throw new Error('GitHub is unreachable') }
  override async openPulls(): Promise<never[]> {
    this.live()
    return [...this.pulls.values()].filter((p) => p.detail.state === 'open').map((p): PullSummary => ({
      number: p.detail.number, title: p.detail.title, head: p.detail.head.ref, draft: false, labels: p.detail.labels, url: p.detail.url, updated_at: p.detail.updated_at, created_at: p.detail.created_at,
    })) as never[]
  }
  async pullStatus(_r: string, n: number): Promise<PullStatus | null> { this.live(); const p = this.pulls.get(n); return p ? { ...p.status, state: p.detail.state } : null }
  async pullDetail(_r: string, n: number): Promise<PullDetail | null> { this.live(); return this.pulls.get(n)?.detail ?? null }
  async pullFiles(_r: string, n: number): Promise<PullFile[]> { return this.pulls.get(n)?.files ?? [] }
  async pullCommits(_r: string, n: number): Promise<string[]> { return this.pulls.get(n)?.commits ?? [] }
  async checkRuns(_r: string, sha: string): Promise<CheckRunDetail[]> { return [...this.pulls.values()].find((p) => p.detail.head.sha === sha)?.runs ?? [] }
  async mergeMethods(): Promise<MergeMethod[]> { return this.methods }
  async mergePull(_r: string, n: number, o: { method: MergeMethod; sha: string }): Promise<{ sha: string }> {
    if (this.mergeRefusal) throw this.mergeRefusal
    this.did.push(`merge ${n} ${o.method} ${o.sha}`)
    const p = this.pulls.get(n)
    if (p) p.detail.state = 'merged'
    return { sha: `merged-${n}` }
  }
  async comment(_r: string, n: number, body: string): Promise<void> { this.did.push(`comment ${n} ${body}`) }
  async closePull(_r: string, n: number): Promise<void> { this.did.push(`close ${n}`); const p = this.pulls.get(n); if (p) p.detail.state = 'closed' }
  async removeLabel(_r: string, n: number, l: string): Promise<boolean> { this.did.push(`unlabel ${n} ${l}`); const p = this.pulls.get(n); if (!p?.detail.labels.includes(l)) return false; p.detail.labels = p.detail.labels.filter((x) => x !== l); return true }
}

const github = new ChangesGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-changes-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-changes-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const started: Parameters<JobsApi['startJob']>[0][] = []
const jobsApi: JobsApi = { repositoryOf: () => null, startJob: async (p) => { started.push(p); return { accepted: true, jobId: 'trace-api-00000000-aaaaaaaaaaaaaaaaaaaaaaaa.job-rev' } }, jobStatus: async () => [] }
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Principal): Context => ({ principal, deps })
const run = async (who: Principal, action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await perform(action, args, ctx(who))).result as Record<string, unknown>
const decisions = async (): Promise<{ kind: string; summary: string; by: string | null; ref: string | null }[]> => (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d)?.decisions ?? [])).result

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  await assign(ADMIN, { sub: SYSTEM.sub }, REPO, { part: 'contributor', class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Changes' })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  const now = Date.now() / 1000
  await jobIndex(ctx(ADMIN), REPO).update((d) => {
    putJob(d, 'job-req', { kind: 'task', agent: 'verify', title: 'Write the requirements', state: 'succeeded', branch: 'claude/task-reqs', endedAt: now - 600, summary: '- extracted R1 to R4\n- each with a measurable criterion',
      payload: JSON.stringify({ request: 'Extract the requirements so define.measurable can be met' }) }, now)
    putJob(d, 'job-sch', { kind: 'task', agent: 'impl', title: 'Draw the schematic', state: 'succeeded', branch: 'claude/task-sch', endedAt: now - 300 }, now)
    putJob(d, 'job-wip', { kind: 'task', agent: 'impl', title: 'Still checking', state: 'succeeded', branch: 'claude/task-wip', endedAt: now - 200 }, now)
    return { result: null }
  })
})

beforeEach(() => {
  github.pulls.clear(); github.did.length = 0; github.mergeRefusal = null; github.down = false; started.length = 0
  github.add(1, 'claude/task-reqs', { title: 'Project purpose and requirements R1-R4', labels: ['no-automerge'] })
  github.add(2, 'claude/task-sch', { mergeable: 'unstable', checks: { total: 2, passed: 1, failed: 1, running: 0, skipped: 0, failing: ['kicad-erc'] } })
  github.add(3, 'marc/my-own', {})
  github.add(4, 'claude/task-wip', { mergeable: 'blocked', checks: { total: 2, passed: 1, failed: 0, running: 1, skipped: 0, failing: [] } })
})

describe('changes.list and change.get', () => {
  it('lists trace\'s open changes oldest first, never a person\'s own, each with its verdict and who made it', async () => {
    const r = await run(USER, 'changes.list', { repo: REPO })
    const cs = r.changes as Record<string, unknown>[]
    expect(cs.map((c) => [c.number, c.verdict, c.from])).toEqual([[1, 'ready', 'the Verification specialist'], [2, 'failing', 'the Implementation specialist'], [4, 'checking', 'the Implementation specialist']])
    expect(cs[0]).toMatchObject({ held: true, stage: 'define', state: 'open', job_id: expect.stringMatching(/\.job-req$/) })
    // a reviewer reads them; a stranger gets "no access"
    expect(((await run(REVIEWER, 'changes.list', { repo: REPO })).changes as unknown[]).length).toBe(3)
    await expect(run(OUTSIDER, 'changes.list', { repo: REPO })).rejects.toThrow(AccessDenied)
  })

  it('one change in full: what trace did, files, checks, requirements, the recommendation, and who may accept', async () => {
    const d = await run(USER, 'change.get', { repo: REPO, number: 1 })
    expect(d).toMatchObject({
      number: 1, summary: ['extracted R1 to R4', 'each with a measurable criterion'], requirements: ['R1', 'R2', 'R3', 'R4'],
      files: [{ path: 'hw/power.kicad_sch', kind: 'schematic', status: 'modified' }, { path: 'docs/notes.md', kind: 'text', status: 'added' }],
      checks_list: [{ name: 'build', state: 'passed', summary: 'Built.' }],
      recommendation: { verdict: 'accept', why: 'Its check passed (build), and it can be merged. It covers R1, R2, R3 and R4.' },
      may_accept: true, blockers: [], base: { ref: 'main', sha: 'base-sha' }, head: { ref: 'claude/task-reqs', sha: 'head-1' },
    })
    expect(await run(REVIEWER, 'change.get', { repo: REPO, number: 1 })).toMatchObject({ may_accept: false, blockers: ['Only a contributor on this project can accept a change.'] })
    expect(await run(USER, 'change.get', { repo: REPO, number: 2 })).toMatchObject({ recommendation: { verdict: 'ask' }, may_accept: false })
    await expect(run(USER, 'change.get', { repo: REPO, number: 3 })).rejects.toThrow(/no change #3 from trace/)
  })

  it('one file\'s diff, with before and after refs (an added file has no before)', async () => {
    expect(await run(USER, 'change.diff', { repo: REPO, number: 1, path: 'hw/power.kicad_sch' })).toEqual({
      path: 'hw/power.kicad_sch', kind: 'schematic', patch: null, before: { ref: 'base-sha' }, after: { ref: 'head-1' }, binary: true,
    })
    expect(await run(USER, 'change.diff', { repo: REPO, number: 1, path: 'docs/notes.md' })).toMatchObject({ before: null, patch: '@@ +1,3 @@', binary: false })
    await expect(run(USER, 'change.diff', { repo: REPO, number: 1, path: '../etc/passwd' })).rejects.toThrow(/a path inside the repository/)
  })
})

describe('change.accept', () => {
  it('merges a ready change (squash first), removes the hold label, and records who accepted it', async () => {
    const r = await run(USER, 'change.accept', { repo: REPO, number: 1, note: 'Looks right.' })
    expect(r).toMatchObject({ merged: true, sha: 'merged-1', stage: 'define', next: expect.stringMatching(/counts in the design now.*Define/) })
    expect(github.did).toEqual(['merge 1 squash head-1', 'unlabel 1 no-automerge', `comment 1 Accepted by ${USER.email}: Looks right.`])
    const d = (await decisions()).find((x) => x.kind === 'change.accepted')
    expect(d).toMatchObject({ by: USER.email, ref: '1', summary: expect.stringMatching(/accepted "Project purpose and requirements R1-R4" from the Verification specialist into the design\. It covers R1, R2, R3, R4/) })
  })

  it('refuses when it is not ready now, saying why, and merges nothing', async () => {
    await expect(run(USER, 'change.accept', { repo: REPO, number: 2 })).rejects.toThrow(/cannot be accepted now\. The kicad-erc check failed\./)
    await expect(run(USER, 'change.accept', { repo: REPO, number: 4 })).rejects.toThrow(/1 check is still running/)
    expect(github.did).toEqual([])
  })

  it('a repository that requires a review: plain words saying so and that the guided flow expects checks-only rules', async () => {
    github.mergeRefusal = new GitHubError(405, 'GitHub PUT merge: 405', 'At least 1 approving review is required by reviewers with write access.')
    await expect(run(USER, 'change.accept', { repo: REPO, number: 1 })).rejects.toThrow(/requires an approving review.*passing checks only/)
    expect((await decisions()).filter((x) => x.kind === 'change.accepted' && x.ref === '1').length).toBe(1) // only the earlier test's
  })
})

describe('change.ask and change.discard', () => {
  it('ask: a revision job with the same specialist on the same branch, a comment naming who asked, and the decision', async () => {
    const r = await run(USER, 'change.ask', { repo: REPO, number: 2, note: 'Fix the rule check finding on the regulator sheet.' })
    expect(r).toEqual({ job_id: 'trace-api-00000000-aaaaaaaaaaaaaaaaaaaaaaaa.job-rev' })
    expect(started).toEqual([expect.objectContaining({ kind: 'task', repository: REPO, agent: 'impl', branch: 'claude/task-sch', requestedBy: USER.email, requestedBySub: USER.sub })])
    expect(started[0]?.request).toMatch(/Fix the rule check finding[\s\S]*push to the same branch/)
    expect(github.did).toEqual([`comment 2 Asked by ${USER.email}: Fix the rule check finding on the regulator sheet.\n\nThe Implementation specialist is revising it on this branch.`])
    expect((await decisions()).find((x) => x.kind === 'change.asked')).toMatchObject({ by: USER.email, ref: '2' })
    await expect(run(USER, 'change.ask', { repo: REPO, number: 2, note: '' })).rejects.toThrow()
  })

  it('discard: comments the reason, closes it, records it; a closed one cannot be discarded again', async () => {
    expect(await run(USER, 'change.discard', { repo: REPO, number: 4, reason: 'We chose the other regulator.' })).toEqual({ closed: true })
    expect(github.did).toEqual([`comment 4 Discarded by ${USER.email}: We chose the other regulator.`, 'close 4'])
    expect((await decisions()).find((x) => x.kind === 'change.discarded')).toMatchObject({ by: USER.email, ref: '4', summary: expect.stringMatching(/discarded "Change 4": We chose the other regulator/) })
    await expect(run(USER, 'change.discard', { repo: REPO, number: 4, reason: 'again' })).rejects.toThrow(/discarded already/)
  })
})

describe('who may do what', () => {
  it('a reviewer reads but cannot accept, ask or discard; a stranger gets "no access"', async () => {
    for (const [action, extra] of [['change.accept', {}], ['change.ask', { note: 'x' }], ['change.discard', { reason: 'x' }]] as const) {
      await expect(run(REVIEWER, action, { repo: REPO, number: 1, ...extra })).rejects.toThrow(AccessDenied)
      await expect(run(OUTSIDER, action, { repo: REPO, number: 1, ...extra })).rejects.toThrow(AccessDenied)
    }
    expect(github.did).toEqual([])
    expect(started).toEqual([])
  })

  it('a connected system reads changes, and is refused every write even with the write scope and the contributor part', async () => {
    expect(((await run(SYSTEM, 'changes.list', { repo: REPO })).changes as unknown[]).length).toBe(3)
    expect(await run(SYSTEM, 'change.get', { repo: REPO, number: 1 })).toMatchObject({ number: 1 })
    for (const [action, extra] of [['change.accept', {}], ['change.ask', { note: 'x' }], ['change.discard', { reason: 'x' }]] as const) {
      await expect(run(SYSTEM, action, { repo: REPO, number: 1, ...extra })).rejects.toThrow(/not open to connected systems/)
    }
    expect(github.did).toEqual([])
  })
})

describe('journey.get with changes open', () => {
  it('a ready change is a step before the criterion its job named, and the next step is to review it', async () => {
    const j = await run(USER, 'journey.get', { repo: REPO })
    const next = j.next as Record<string, unknown>
    expect(next).toMatchObject({ kind: 'review', ref: { kind: 'change', id: '1' }, summary: 'trace finished Project purpose and requirements R1-R4. Review it and accept it into the design.' })
    expect(next.recommendation).toMatch(/^trace recommends accepting it\. /)
    const define = (j.stages as { id: string; steps: { id: string; state: string }[] }[]).find((s) => s.id === 'define')
    expect(define?.steps.map((s) => `${s.id}:${s.state}`)).toEqual(['change:2:later', 'change:4:later', 'define.accepted:later', 'change:1:now', 'define.measurable:next', 'sign:define:later'])
    expect(j.changes_unavailable).toBeUndefined()
  })

  it('GitHub unreachable: the journey is answered without changes, and says so', async () => {
    github.down = true
    const j = await run(USER, 'journey.get', { repo: REPO })
    expect(j.next).toMatchObject({ kind: 'task', ref: { kind: 'criterion', id: 'define.accepted' } })
    const define = (j.stages as { id: string; steps: { id: string }[] }[]).find((s) => s.id === 'define')
    expect(define?.steps.some((s) => s.id.startsWith('change:'))).toBe(false)
    expect(j.changes_unavailable).toMatch(/unreachable/)
  })
})
