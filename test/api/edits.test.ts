/**
 * People's app edits (docs/stay-in-trace.md "1. App edits", src/core/app-edits.ts, src/api/edits.ts,
 * src/api/apply-edits.ts) and fixing the repository's rule (src/api/actions-rules.ts).
 *
 * The rules first, as plain functions: which pull requests are edits (never a fork's, never one whose branch someone
 * pushed to), the verdict "applying" for an admin's own edit, who may accept a review edit (an admin who did not make
 * it), what trace recommends. Then the actions over a fake GitHub and real stores: the changes list shows edits beside
 * the specialists' changes, accept / ask / discard on an edit, applying (merged once ready, made again when the design
 * moved on, left alone when someone pushed), the inbox's review items for admins only, hook.apply for the web backend
 * alone, and repo.rules.fix (trace's rule put back, someone else's reported, never changed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { applyEdits } from '../../src/api/apply-edits.js'
import { resolveConflicts, resolveWords } from '../../src/api/conflicts.js'
import { type ChangeFacts, editAcceptance, editOf, editRecommendation, editVerdict, editsByBranch } from '../../src/api/changes.js'
import { editStore } from '../../src/api/edits.js'
import { requiresReview, withoutReview } from '../../src/api/actions-rules.js'
import { GitHubError, type CheckRunDetail, type MergeMethod, type PullDetail, type PullFile, type PullStatus, type PullSummary } from '../../src/api/github.js'
import { AccessDenied, type Principal, assign } from '../../src/core/access.js'
import { type AppEdit, appliesOf } from '../../src/core/app-edits.js'
import { backendFor } from '../../src/core/central.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { register } from '../../src/core/onboard.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const sha = (n: number): string => n.toString(16).padStart(40, 'b')
const REPO = 'acme/edits'

const edit = (o: Partial<AppEdit> = {}): AppEdit => ({
  repo: REPO, branch: 'trace/settings-quantity-1', kind: 'setting', title: 'Boards per build: 5 → 10', by: 'c-user@example.com', by_sub: 'c-user',
  by_name: 'CU', applies: 'review', commit: sha(1), number: 1, at: '2026-11-03T00:00:00.000Z', redo: { op: 'setting', key: 'worker.max_attempts', value: 4 }, ...o,
})
const checks = (o: Partial<NonNullable<PullStatus['checks']>> = {}): NonNullable<PullStatus['checks']> => ({ total: 1, passed: 1, failed: 0, running: 0, skipped: 0, failing: [], ...o })
const facts = (o: Partial<ChangeFacts> = {}): ChangeFacts => ({ state: 'open', draft: false, mergeable: 'clean', checks: checks(), ...o })

// ------------------------------------------------------------------ the rules

describe('which pull requests are edits (the commit, not the branch name, proves it)', () => {
  const byBranch = editsByBranch([edit()])
  it('the recorded branch at the recorded commit, in the repository itself', () => {
    expect(editOf({ head: 'trace/settings-quantity-1', headRepo: REPO, sha: sha(1) }, byBranch, REPO)?.title).toBe('Boards per build: 5 → 10')
  })
  it('not when someone pushed to its branch, nor from a fork, nor a branch with no record', () => {
    expect(editOf({ head: 'trace/settings-quantity-1', headRepo: REPO, sha: sha(2) }, byBranch, REPO)).toBeNull()
    expect(editOf({ head: 'trace/settings-quantity-1', headRepo: 'mallory/edits', sha: sha(1) }, byBranch, REPO)).toBeNull()
    expect(editOf({ head: 'trace/settings-other', headRepo: REPO, sha: sha(1) }, byBranch, REPO)).toBeNull()
  })
  it('an admin\'s own edit, a repository joining, its workflows and a hand-in apply on their own; anyone else\'s setting waits for an admin', () => {
    expect(appliesOf('setting', true)).toBe('auto')
    expect(appliesOf('setting', false)).toBe('review')
    expect(appliesOf('prompt', false)).toBe('review')
    for (const k of ['join', 'workflows', 'handin'] as const) expect(appliesOf(k, false)).toBe('auto')
  })
})

describe('the rules for an edit: verdict, recommendation, who may accept', () => {
  it('an auto edit whose checks passed is "applying", and needs nobody', () => {
    expect(editVerdict(facts(), edit({ applies: 'auto' }))).toBe('applying')
    expect(editRecommendation(facts(), edit({ applies: 'auto' }), true)).toEqual({ verdict: 'none', why: 'Its checks passed: trace applies it now.' })
    expect(editAcceptance(facts(), edit({ applies: 'auto' }), { admin: true, mine: true }).may_accept).toBe(false)
    expect(editRecommendation(facts({ checks: checks({ passed: 0, running: 1 }) }), edit({ applies: 'auto' }), true).why).toMatch(/trace applies it once they pass, with nothing for anyone to do/)
  })
  it('a repository joining with no checks at all applies once GitHub says it can merge; a setting change never does', () => {
    const none = facts({ checks: { total: 0, passed: 0, failed: 0, running: 0, skipped: 0, failing: [] } })
    expect(editVerdict(none, edit({ kind: 'join', applies: 'auto' }))).toBe('applying')
    expect(editVerdict(none, edit({ applies: 'auto' }))).toBe('checking')
    expect(editVerdict(facts({ checks: null, mergeable: 'blocked' }), edit({ kind: 'join', applies: 'auto' }))).not.toBe('applying')
  })
  it('a review edit: an admin who did not make it may accept; its author, and anyone else, may not', () => {
    expect(editAcceptance(facts(), edit(), { admin: true, mine: false })).toEqual({ may_accept: true, blockers: [] })
    expect(editAcceptance(facts(), edit(), { admin: true, mine: true }).blockers[0]).toBe('You made this change: another admin accepts it.')
    expect(editAcceptance(facts(), edit(), { admin: false, mine: false }).blockers[0]).toBe('Only an admin can accept a change someone made in the app.')
    expect(editRecommendation(facts(), edit(), false)).toMatchObject({ verdict: 'accept', why: expect.stringMatching(/CU made it in trace; accepting applies it\./) })
  })
})

describe('the rule fix: what counts as requiring a review', () => {
  it('an approving count above 0; code owners\' review is not one, and the fix keeps it and every other rule', () => {
    expect(requiresReview([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }])).toBe(true)
    // code owners' review guards the paths that steer trace against an agent merging past the hold label: kept
    expect(requiresReview([{ type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true } }])).toBe(false)
    expect(requiresReview([{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }, { type: 'deletion' }])).toBe(false)
    const fixed = withoutReview([{ type: 'deletion' }, { type: 'pull_request', parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true } }])
    expect(fixed).toEqual([{ type: 'deletion' }, { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true, require_last_push_approval: false, dismiss_stale_reviews_on_push: true } }])
  })
})

// ------------------------------------------------------------------ the actions

const ADMIN = { sub: 'c-admin', email: 'c-admin@example.com', groups: ['trace-admins'] }
const ADMIN2 = { sub: 'c-admin2', email: 'c-admin2@example.com', groups: ['trace-admins'] }
const USER = { sub: 'c-user', email: 'c-user@example.com', groups: ['trace-users'] }
const OTHER = { sub: 'c-other', email: 'c-other@example.com', groups: ['trace-users'] }
const BACKEND: Principal = { sub: 'hooks-client', email: null, groups: [], kind: 'backend', name: 'web-hooks' }

interface FakePull { detail: PullDetail; status: PullStatus }

/** A fake GitHub with open pull requests, and what trace did to them. */
class EditsGitHub extends FakeGitHub {
  pulls = new Map<number, FakePull>()
  did: string[] = []
  rulesets: { id: number; name: string; source_type?: string; rules: { type: string; parameters?: Record<string, unknown> }[] }[] = []
  classicReviews = false
  denyRules = false
  add(number: number, head: string, o: { mergeable?: string; checks?: PullStatus['checks']; headSha?: string; headRepo?: string } = {}): void {
    const detail: PullDetail = {
      number, title: `trace/${number}`, url: `https://github.com/${REPO}/pull/${number}`, state: 'open', draft: false, mergeable: o.mergeable ?? 'clean', body: '',
      labels: ['no-automerge'], created_at: `2026-11-0${number}T00:00:00Z`, updated_at: '2026-11-03T00:00:00Z',
      head: { ref: head, sha: o.headSha ?? sha(number), repo: o.headRepo ?? REPO }, base: { ref: 'main', sha: 'sha-main' }, author: 'trace-bot',
    }
    this.pulls.set(number, { detail, status: { number, title: detail.title, url: detail.url, state: 'open', draft: false, mergeable: detail.mergeable, head, sha: detail.head.sha, updated_at: detail.updated_at, checks: o.checks === undefined ? checks() : o.checks } })
  }
  override async openPulls(): Promise<never[]> {
    return [...this.pulls.values()].filter((p) => p.detail.state === 'open').map((p): PullSummary => ({
      number: p.detail.number, title: p.detail.title, head: p.detail.head.ref, draft: false, labels: p.detail.labels, url: p.detail.url, updated_at: p.detail.updated_at,
      created_at: p.detail.created_at, headRepo: p.detail.head.repo, author: p.detail.author, sha: p.detail.head.sha,
    })) as never[]
  }
  /** reads left that answer "unknown" before the real state (GitHub still working out mergeability) */
  unknownReads = new Map<number, number>()
  async pullStatus(_r: string, n: number): Promise<PullStatus | null> {
    const p = this.pulls.get(n)
    if (!p) return null
    const left = this.unknownReads.get(n) ?? 0
    if (left > 0) this.unknownReads.set(n, left - 1)
    return { ...p.status, ...(left > 0 ? { mergeable: 'unknown' } : {}), state: p.detail.state, sha: p.detail.head.sha }
  }
  /** a workflow_dispatch input the workflow does not declare: refused as GitHub does (422) */
  oldWorkflow = false
  override async dispatchWorkflow(_r: string, workflow: string, ref: string): Promise<void> { this.did.push(`dispatch ${workflow} ${ref}`) }
  async dispatchWorkflowWith(_r: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    if (this.oldWorkflow && Object.keys(inputs).length) throw new GitHubError(422, 'GitHub: 422', 'Unexpected inputs provided: ["retry"]')
    this.did.push(`dispatch ${workflow} ${ref} ${JSON.stringify(inputs)}`)
  }
  async pullDetail(_r: string, n: number): Promise<PullDetail | null> { return this.pulls.get(n)?.detail ?? null }
  extraFiles: PullFile[] = []
  async pullFiles(): Promise<PullFile[]> { return [{ path: '.trace/project.db', status: 'modified', additions: 0, deletions: 0, patch: null, previous: null }, ...this.extraFiles] }
  async pullCommits(): Promise<string[]> { return ['settings: build.quantity = 10'] }
  async checkRuns(): Promise<CheckRunDetail[]> { return [{ name: 'build', status: 'completed', conclusion: 'success', summary: 'Built.' }] }
  async mergeMethods(): Promise<MergeMethod[]> { return ['squash'] }
  async mergePull(_r: string, n: number, o: { method: MergeMethod; sha: string }): Promise<{ sha: string }> {
    this.did.push(`merge ${n} ${o.sha}`)
    const p = this.pulls.get(n)
    if (p) p.detail.state = 'merged'
    return { sha: `merged-${n}` }
  }
  async comment(_r: string, n: number, body: string): Promise<void> { this.did.push(`comment ${n} ${body.split('\n')[0]}`) }
  async closePull(_r: string, n: number): Promise<void> { this.did.push(`close ${n}`); const p = this.pulls.get(n); if (p) p.detail.state = 'closed' }
  async removeLabel(_r: string, n: number, l: string): Promise<boolean> { this.did.push(`unlabel ${n} ${l}`); return true }
  async openPull(_r: string, o: { head: string }): Promise<{ number: number; existed: boolean }> { this.did.push(`open ${o.head}`); return { number: 9, existed: false } }
  async resetBranch(_r: string, branch: string, s: string): Promise<void> { this.did.push(`reset ${branch} ${s}`) }
  override async putFile(repo: string, o: { path: string; branch: string; content: Uint8Array; message: string; sha: string | null }): Promise<{ commit: string }> {
    await super.putFile(repo, o)
    this.did.push(`put ${o.branch} ${o.path}`)
    return { commit: sha(77) }
  }
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.denyRules) throw new GitHubError(403, 'GitHub: 403')
    this.did.push(`${method} ${path.split('?')[0]}${body && method !== 'GET' ? ` ${JSON.stringify(body).slice(0, 120)}` : ''}`)
    const m = /\/rulesets\/(\d+)$/.exec(path)
    if (method === 'GET' && /\/rulesets(\?|$)/.test(path)) return this.rulesets.map(({ rules: _r, ...r }) => r)
    if (method === 'GET' && m) return this.rulesets.find((r) => r.id === Number(m[1]))
    if (method === 'GET' && path.endsWith('required_pull_request_reviews')) { if (!this.classicReviews) throw new GitHubError(404, 'GitHub: 404'); return { required_approving_review_count: 1 } }
    return {}
  }
}

const github = new EditsGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-edits-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-edits-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const jobsApi: JobsApi = { repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'x' }), jobStatus: async () => [] }
const cognito = new FakeCognito()
const deps: ActionDeps = { github: async () => github, cognito: () => cognito, jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Principal): Context => ({ principal, deps })
const run = async (who: Principal, action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await perform(action, args, ctx(who))).result as Record<string, unknown>
const decisions = async (): Promise<{ kind: string; summary: string; by: string | null }[]> => (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d)?.decisions ?? [])).result
const stored = async (branch: string): Promise<AppEdit | null> => editStore(ctx(ADMIN)).get(REPO, branch)

beforeAll(async () => {
  await register(REPO, null)
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, OTHER, REPO, { class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Edits' })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
})

beforeEach(async () => {
  github.pulls.clear(); github.did.length = 0; github.unknownReads.clear(); github.oldWorkflow = false; github.rulesets = []; github.classicReviews = false; github.denyRules = false; github.extraFiles = []
  github.add(1, 'trace/settings-quantity-1')
  await editStore(ctx(ADMIN)).put(edit())
})

describe('changes.list and change.get show edits beside the specialists\' changes', () => {
  it('an edit is listed with its kind and who made it ("you" to its author)', async () => {
    const mine = (await run(USER, 'changes.list', { repo: REPO })).changes as Record<string, unknown>[]
    expect(mine).toEqual([expect.objectContaining({ number: 1, kind: 'setting', title: 'Boards per build: 5 → 10', from: 'a setting change by you', mine: true, applies: 'review', verdict: 'ready' })])
    const theirs = (await run(ADMIN, 'changes.list', { repo: REPO })).changes as Record<string, unknown>[]
    expect(theirs[0]).toMatchObject({ from: 'a setting change by CU', mine: false })
  })

  it('someone pushed to its branch: it is not trace\'s edit, so it is neither listed nor found', async () => {
    github.add(1, 'trace/settings-quantity-1', { headSha: sha(5) })
    expect((await run(ADMIN, 'changes.list', { repo: REPO })).changes).toEqual([])
    await expect(run(ADMIN, 'change.get', { repo: REPO, number: 1 })).rejects.toThrow(/has no change #1 from trace/)
  })

  it('change.get: an admin who did not make it may accept; its author may not, and nobody may ask for changes', async () => {
    expect(await run(ADMIN, 'change.get', { repo: REPO, number: 1 })).toMatchObject({ kind: 'setting', may_accept: true, may_ask: false, may_discard: true, rule_blocks: false })
    expect(await run(USER, 'change.get', { repo: REPO, number: 1 })).toMatchObject({ may_accept: false, blockers: ['You made this change: another admin accepts it.'], may_discard: true })
    expect(await run(OTHER, 'change.get', { repo: REPO, number: 1 })).toMatchObject({ may_accept: false, may_discard: false })
  })
})

describe('accept, ask and discard on an edit', () => {
  it('an admin accepts someone\'s edit: merged at the head looked at, the record done, the decision logged', async () => {
    const r = await run(ADMIN, 'change.accept', { repo: REPO, number: 1, head_sha: sha(1) })
    expect(r).toMatchObject({ merged: true, next: 'It is applied.' })
    expect(github.did).toContain(`merge 1 ${sha(1)}`)
    expect(await stored('trace/settings-quantity-1')).toBeNull()
    expect((await decisions()).find((d) => d.kind !== 'journey.started')).toMatchObject({ kind: 'change.accepted', by: 'c-admin@example.com' })
  })

  it('its author cannot accept it, nor a contributor who is not an admin', async () => {
    await expect(run(USER, 'change.accept', { repo: REPO, number: 1, head_sha: sha(1) })).rejects.toThrow(/You made this change/)
    await expect(run(OTHER, 'change.accept', { repo: REPO, number: 1, head_sha: sha(1) })).rejects.toThrow(/Only an admin/)
    expect(github.did.filter((d) => d.startsWith('merge'))).toEqual([])
  })

  it('asking for changes is refused (there is no specialist); its author discards it, and the record is done', async () => {
    await expect(run(ADMIN, 'change.ask', { repo: REPO, number: 1, note: 'smaller' })).rejects.toThrow(/CU made this change in trace/)
    await expect(run(OTHER, 'change.discard', { repo: REPO, number: 1, reason: 'no' })).rejects.toThrow(/they or an admin can discard it/)
    expect(await run(USER, 'change.discard', { repo: REPO, number: 1, reason: 'Changed my mind' })).toEqual({ closed: true, jobs: [] })
    expect(github.did).toContain('close 1')
    expect(await stored('trace/settings-quantity-1')).toBeNull()
  })
})

describe('applying edits', () => {
  it('an admin\'s own edit whose checks passed is merged, the hold label taken off, change.applied logged, the record done', async () => {
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto', by: 'c-admin@example.com', by_sub: 'c-admin', by_name: 'CA' }))
    const done = await applyEdits(ctx(ADMIN), REPO)
    expect(done).toEqual([expect.objectContaining({ number: 1, did: 'applied' })])
    expect(github.did).toEqual(expect.arrayContaining([`merge 1 ${sha(1)}`, 'unlabel 1 no-automerge']))
    expect(await stored('trace/settings-quantity-1')).toBeNull()
    expect((await decisions()).find((d) => d.kind !== 'journey.started')).toMatchObject({ kind: 'change.applied', by: 'c-admin@example.com', summary: expect.stringMatching(/trace applied Boards per build: 5 → 10 \(made in trace by CA\)/) })
  })

  it('checks still running: it waits; a review edit is never merged here', async () => {
    github.add(1, 'trace/settings-quantity-1', { checks: checks({ passed: 0, running: 1 }), mergeable: 'blocked' })
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto' }))
    expect((await applyEdits(ctx(ADMIN), REPO))[0]).toMatchObject({ did: 'waiting' })
    github.add(1, 'trace/settings-quantity-1')
    await editStore(ctx(ADMIN)).put(edit())
    expect((await applyEdits(ctx(ADMIN), REPO))[0]).toMatchObject({ did: 'waiting', why: 'An admin accepts it.' })
    expect(github.did.filter((d) => d.startsWith('merge'))).toEqual([])
  })

  it('the design moved on (behind or in conflict): made again on the newest design, the branch reset, the record\'s commit moved', async () => {
    github.add(1, 'trace/settings-quantity-1', { mergeable: 'dirty' })
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto' }))
    const redone = (await applyEdits(ctx(ADMIN), REPO))[0]
    expect(redone, redone?.why).toMatchObject({ did: 'redone' })
    expect(github.did).toEqual(['reset trace/settings-quantity-1 sha-main', 'put trace/settings-quantity-1 .trace/project.db'])
    expect((await stored('trace/settings-quantity-1'))?.commit).toBe(sha(77))
  })

  it('someone pushed to its branch: left alone, never merged; merged or closed on GitHub: the record is done', async () => {
    github.add(1, 'trace/settings-quantity-1', { headSha: sha(5) })
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto' }))
    expect((await applyEdits(ctx(ADMIN), REPO))[0]).toMatchObject({ did: 'left' })
    github.pulls.get(1)!.detail.state = 'closed'
    expect((await applyEdits(ctx(ADMIN), REPO))[0]).toMatchObject({ did: 'done', why: 'It was closed.' })
    expect(await stored('trace/settings-quantity-1')).toBeNull()
  })

  it('hook.apply: the web backend\'s alone; it applies and says what it did', async () => {
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto' }))
    await expect(run(ADMIN, 'hook.apply', { repo: REPO })).rejects.toBeInstanceOf(AccessDenied)
    expect(await run(BACKEND, 'hook.apply', { repo: REPO })).toEqual({ repo: REPO, applied: [{ branch: 'trace/settings-quantity-1', number: 1, did: 'applied' }] })
  })
})

describe('a commit slipped in under trace\'s own (someone pushed to the branch before trace committed on it)', () => {
  const workflow: PullFile = { path: '.github/workflows/evil.yml', status: 'added', additions: 9, deletions: 0, patch: '+x', previous: null }
  it('is never applied: the edit changes files a setting does not write', async () => {
    github.extraFiles = [workflow]
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto' }))
    expect((await applyEdits(ctx(ADMIN), REPO))[0]).toMatchObject({ did: 'left', why: expect.stringMatching(/\.github\/workflows\/evil\.yml/) })
    expect(github.did.filter((d) => d.startsWith('merge'))).toEqual([])
  })
  it('is never accepted: the page says so, and accepting is refused', async () => {
    github.extraFiles = [workflow]
    expect(await run(ADMIN, 'change.get', { repo: REPO, number: 1 })).toMatchObject({ may_accept: false, blockers: [expect.stringMatching(/someone pushed to its branch/)] })
    await expect(run(ADMIN, 'change.accept', { repo: REPO, number: 1, head_sha: sha(1) })).rejects.toThrow(/someone pushed to its branch/)
  })
  it('an edit of one file may change that file only', async () => {
    github.extraFiles = [{ ...workflow, path: 'CLAUDE.md' }]
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto', kind: 'prompt', paths: ['CLAUDE.md'] }))
    expect((await applyEdits(ctx(ADMIN), REPO))[0]).toMatchObject({ did: 'left' })
  })
})

describe('the inbox: a review edit needs an admin who did not make it', () => {
  it('admins see it; its author and contributors do not', async () => {
    const items = async (p: Principal) => ((await run(p, 'inbox', {})).items as Record<string, unknown>[]).filter((i) => i.kind === 'review')
    expect(await items(ADMIN)).toEqual([expect.objectContaining({ summary: expect.stringMatching(/CU made a setting change, "Boards per build: 5 → 10"/), ref: expect.objectContaining({ to: '/p/acme~edits/changes/1' }) })])
    expect(await items(USER)).toEqual([])
    expect(await items(OTHER)).toEqual([])
  })
})

describe('repo.rules.fix', () => {
  it('trace\'s rule is made to require no review; someone else\'s is reported by name and never changed', async () => {
    github.rulesets = [
      { id: 1, name: 'trace', rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: true } }] },
      { id: 2, name: 'release', rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }] },
    ]
    const r = await run(ADMIN, 'repo.rules.fix', { repo: REPO })
    expect(r.done).toEqual(['trace\'s rule no longer requires a review: changes go in once their checks pass.'])
    expect((r.left as string[])[0]).toMatch(/The "release" rule also requires a review/)
    expect(github.did.filter((d) => d.startsWith('PUT'))).toEqual([expect.stringMatching(/^PUT \/repos\/acme\/edits\/rulesets\/1 /)])
    expect((await decisions()).find((d) => d.kind !== 'journey.started')).toMatchObject({ kind: 'repo.rules.fixed' })
  })

  it('no trace rule: it is added; classic protection\'s required reviews are removed', async () => {
    github.classicReviews = true
    const r = await run(ADMIN, 'repo.rules.fix', { repo: REPO })
    expect(r.done).toEqual([expect.stringMatching(/^Added trace's rule to main/), 'main\'s branch protection no longer requires a review.'])
    expect(github.did).toEqual(expect.arrayContaining([expect.stringMatching(/^POST \/repos\/acme\/edits\/rulesets .*"name":"trace"/), 'DELETE /repos/acme/edits/branches/main/protection/required_pull_request_reviews']))
  })

  it('admins only; a token that may not administer the repository is said plainly, and nothing changed', async () => {
    await expect(run(USER, 'repo.rules.fix', { repo: REPO })).rejects.toBeInstanceOf(AccessDenied)
    github.denyRules = true
    await expect(run(ADMIN, 'repo.rules.fix', { repo: REPO })).rejects.toThrow(/needs "Administration: read and write".*Nothing was changed/)
  })
})

void ADMIN2

describe('changes in conflict, found and set going by trace (src/api/conflicts.ts)', () => {
  const noWait = async (): Promise<void> => undefined

  it('waits for GitHub to settle, remakes trace\'s own edit, and starts the worker once for the rest', async () => {
    github.add(1, 'trace/settings-quantity-1', { mergeable: 'dirty' })
    github.add(2, 'claude/impl-regulator', { mergeable: 'dirty' })
    github.add(3, 'claude/emc-ferrite', { mergeable: 'dirty' })
    github.add(4, 'claude/clean-one')
    for (const n of [1, 2, 3, 4]) github.unknownReads.set(n, 2)
    await editStore(ctx(ADMIN)).put(edit({ applies: 'auto' }))
    const r = await resolveConflicts(ctx(BACKEND), REPO, { wait: noWait })
    expect(r).toMatchObject({ conflicts: [1, 2, 3], remade: [1], worker: [2, 3], left: [], checking: [], started: 'yes' })
    // the record-only merge looked first (GET only: no record in this fake, so nothing was merged)
    expect(github.did.filter((d) => !d.startsWith('GET '))).toEqual(['reset trace/settings-quantity-1 sha-main', 'put trace/settings-quantity-1 .trace/project.db', 'dispatch trace-worker.yml main'])
  })

  it('a change whose only conflict is the record, its rows apart: merged here, and the worker not started for it (log #213)', async () => {
    github.add(2, 'claude/task-renders', { mergeable: 'dirty' })
    github.add(3, 'claude/emc-ferrite', { mergeable: 'dirty' })
    const asked: number[] = []
    const r = await resolveConflicts(ctx(BACKEND), REPO, { wait: noWait, mergeRecord: async (_g, n, prefix) => { asked.push(n); expect(prefix).toBe('claude/'); return n === 2 ? { ok: true, commit: sha(9) } : { ok: false, why: 'docs/a.md changed on both sides' } } })
    expect(asked).toEqual([2, 3])
    expect(r).toMatchObject({ conflicts: [2, 3], record: [2], worker: [3], started: 'yes' })
    github.did.length = 0
    const only = await resolveConflicts(ctx(BACKEND), REPO, { wait: noWait, only: [2], mergeRecord: async () => ({ ok: true, commit: sha(9) }) })
    expect(only).toMatchObject({ record: [2], worker: [], started: 'not-needed' })
    expect(github.did.filter((d) => d.startsWith('dispatch'))).toEqual([])
    expect(resolveWords(2, only)).toMatch(/Only the project record was in conflict.*different rows/)
  })

  it('still unknown after settling: reported as checking, nothing started', async () => {
    github.add(2, 'claude/impl-regulator', { mergeable: 'dirty' })
    github.pulls.delete(1)
    github.unknownReads.set(2, 99)
    expect(await resolveConflicts(ctx(BACKEND), REPO, { wait: noWait })).toMatchObject({ conflicts: [], checking: [2], started: 'not-needed' })
    expect(github.did).toEqual([])
  })

  it('an edit that cannot be made again is left for a person; an edit someone pushed to goes to the worker', async () => {
    github.add(1, 'trace/settings-quantity-1', { mergeable: 'dirty' })
    await editStore(ctx(ADMIN)).put(edit({ redo: null }))
    expect(await resolveConflicts(ctx(BACKEND), REPO, { wait: noWait })).toMatchObject({ left: [1], worker: [] })
    github.add(1, 'trace/settings-quantity-1', { mergeable: 'dirty', headSha: sha(5) })
    expect(await resolveConflicts(ctx(BACKEND), REPO, { wait: noWait })).toMatchObject({ left: [], worker: [1], started: 'yes' })
  })

  it('hook.conflicts: the web backend\'s alone', async () => {
    github.add(2, 'claude/impl-regulator', { mergeable: 'dirty' })
    await expect(run(ADMIN, 'hook.conflicts', { repo: REPO })).rejects.toBeInstanceOf(AccessDenied)
    expect(await run(BACKEND, 'hook.conflicts', { repo: REPO })).toMatchObject({ repo: REPO, conflicts: [2], worker: [2], started: 'yes' })
    expect(await run(BACKEND, 'hook.conflicts', { repo: 'acme/not-a-project' })).toMatchObject({ conflicts: [], started: 'not-needed' })
  })

  it('change.resolve: a contributor asks; the worker is told which one, with its earlier attempts set aside', async () => {
    github.add(2, 'claude/impl-regulator', { mergeable: 'dirty' })
    github.add(3, 'claude/emc-ferrite', { mergeable: 'dirty' })
    const r = await run(USER, 'change.resolve', { repo: REPO, number: 2 })
    expect(r).toMatchObject({ conflict: true, worker: true, remade: false, text: expect.stringMatching(/bringing it up to date/) })
    expect(github.did.filter((d) => !d.startsWith('GET '))).toEqual(['dispatch trace-worker.yml main {"retry":"2"}'])
    expect((await decisions()).find((d) => d.kind === 'change.resolve')).toMatchObject({ by: 'c-user@example.com' })
  })

  it('change.resolve on a project whose workflow predates the retry input: started without it, and said so', async () => {
    github.add(2, 'claude/impl-regulator', { mergeable: 'dirty' })
    github.oldWorkflow = true
    expect(await run(USER, 'change.resolve', { repo: REPO, number: 2 })).toMatchObject({ worker: true, text: expect.stringMatching(/workflows are older/) })
    expect(github.did.filter((d) => !d.startsWith('GET '))).toEqual(['dispatch trace-worker.yml main'])
  })

  it('change.resolve on a change not in conflict starts nothing; an edit that cannot be made again is refused', async () => {
    expect(await run(USER, 'change.resolve', { repo: REPO, number: 1 })).toMatchObject({ conflict: false, worker: false, text: expect.stringMatching(/does not conflict/) })
    github.add(1, 'trace/settings-quantity-1', { mergeable: 'dirty' })
    await editStore(ctx(ADMIN)).put(edit({ redo: null }))
    await expect(run(USER, 'change.resolve', { repo: REPO, number: 1 })).rejects.toThrow(/Discard it and make it again/)
    expect(github.did).toEqual([])
  })
})
