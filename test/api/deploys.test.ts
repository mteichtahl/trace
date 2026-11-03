/**
 * Deploys in the app (src/api/actions-deploys.ts, docs/stay-in-trace.md "2. Deploys"): deploys.get's shape from fake
 * GitHub answers (only the workflow's own deploy issues are read; the request, the commits since what runs now, a held
 * request's reasons, a deploy running now and its step, the results, trace's recommendation and who may decide);
 * deploy.approve's refusals (not allowed, a commit that is not the request's, a build that has not passed, a newer
 * commit that passed) and the record it writes (where, who, the commit, the expiry) before it starts the workflow with
 * that record's name; deploy.skip (the request closed, the reason quoted and neutralised, named without an email);
 * deploy.rollback (only to a commit that ran before); and a connected system, which only reads.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { type DeployFacts, deploysView, heldReasonsOf, mayDecide, recommend, recentResults } from '../../src/api/actions-deploys.js'
import { AccessDenied, type Principal, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { setValue } from '../../src/core/config.js'
import { DeployApprovals } from '../../src/core/deploy-approvals.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const REPO = 'acme/deploys'
const ADMIN = { sub: 'd-admin', email: 'd-admin@example.com', groups: ['trace-admins'] }
const PERSON = { sub: 'd-ada', email: 'ada@example.com', groups: ['trace-users'] }     // in deploy.people
const OTHER = { sub: 'd-bob', email: 'bob@example.com', groups: ['trace-users'] }      // a contributor, not in it
const SYSTEM: Principal = { sub: 'd-svc', email: null, groups: ['trace-users'], kind: 'service', name: 'ci', scopes: ['read', 'write'] }
const S = (c: string): string => c.repeat(40)
const BOT = { login: 'github-actions[bot]' }

/** GitHub as the deploy workflow leaves it: deploy issues, the build's runs, the deploy workflow's runs and jobs. */
class DeploysGitHub extends FakeGitHub {
  issues: Record<string, unknown>[] = []
  newest = S('b')
  built = new Set<string>([S('b')])
  deployRuns: Record<string, unknown>[] = []
  jobs: Record<string, unknown>[] = []
  comments: Record<string, unknown>[] = []
  did: string[] = []
  inputs: Record<string, string>[] = []
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const p = path.split('?')[0]!
    if (method === 'GET' && p.endsWith('/issues')) return this.issues
    if (method === 'GET' && /\/actions\/workflows\/build\.yml\/runs$/.test(p)) {
      const sha = /head_sha=([0-9a-f]+)/.exec(path)?.[1]
      if (sha) return { workflow_runs: this.built.has(sha) ? [{ id: 1, event: 'push', status: 'completed', conclusion: 'success', head_sha: sha, created_at: '2026-11-03T00:00:00Z' }] : [] }
      return { workflow_runs: [{ id: 2, event: 'push', status: 'completed', conclusion: 'success', head_sha: this.newest, created_at: '2026-11-03T01:00:00Z' }] }
    }
    if (method === 'GET' && p.endsWith('/actions/workflows/trace-deploy.yml/runs')) return { workflow_runs: this.deployRuns }
    if (method === 'GET' && /\/actions\/runs\/\d+\/jobs$/.test(p)) return { jobs: this.jobs }
    if (method === 'GET' && /\/compare\//.test(p)) return { commits: [{ sha: S('c'), commit: { message: 'power: a larger regulator\n\nbody' } }, { sha: S('b'), commit: { message: 'usb: protect the input' } }] }
    if (method === 'GET' && /\/issues\/\d+\/comments$/.test(p)) return this.comments
    this.did.push(`${method} ${p} ${JSON.stringify(body ?? null)}`)
    return {}
  }
  async dispatchWorkflowWith(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    this.dispatched.push(`${repo} ${workflow} ${ref}`)
    this.inputs.push(inputs)
  }
}

const github = new DeploysGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-deploys-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-deploys-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const jobsApi: JobsApi = { repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'x' }), jobStatus: async () => [] }
const cognito = new FakeCognito()
cognito.add(PERSON.email, PERSON.sub, undefined, 'Ada Lovelace')
const deps: ActionDeps = { github: async () => github, cognito: () => cognito, jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Principal): Context => ({ principal, deps })
const run = async (who: Principal, action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await perform(action, args, ctx(who))).result as Record<string, unknown>
const decisions = async () => (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d)?.decisions ?? [])).result

const deployed = (n: number, sha: string, by: string, closed: string) =>
  ({ number: n, state: 'closed', state_reason: 'completed', user: BOT, labels: [{ name: 'deploy' }], created_at: closed, updated_at: closed, closed_at: closed, body: `Deploy it?\n<!-- trace-deploy-sha: ${sha} -->\n<!-- trace-deployed-sha: ${sha} -->\n<!-- trace-deployed-by: ${by} -->` })
const request = (sha: string, labels = ['deploy']) =>
  ({ number: 7, state: 'open', user: BOT, labels: labels.map((name) => ({ name })), created_at: '2026-11-03T01:05:00Z', updated_at: '2026-11-03T01:05:00Z', body: `Deploy it?\n<!-- trace-deploy-sha: ${sha} -->` })

beforeAll(async () => {
  await assign(ADMIN, PERSON, REPO, { class: 'user' })
  await assign(ADMIN, OTHER, REPO, { class: 'user' })
  await assign(ADMIN, { sub: SYSTEM.sub }, REPO, { part: 'contributor', class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Deploys' })
  db.close()
  setValue('deploy.command', './deploy.sh', dir)
  setValue('deploy.enabled', true, dir)
  setValue('deploy.environment', 'bench', dir)
  setValue('deploy.people', ['Ada@Example.com'], dir)
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
})

beforeEach(() => {
  github.issues = [
    request(S('b')),
    deployed(5, S('a'), 'marc', '2026-11-02T10:00:00Z'),
    // a person's issue that looks like a record: never read
    { ...deployed(6, S('e'), 'mallory', '2026-11-03T00:30:00Z'), user: { login: 'mallory' } },
  ]
  github.newest = S('b'); github.built = new Set([S('b')]); github.deployRuns = []; github.jobs = []; github.comments = []
  github.did.length = 0; github.inputs.length = 0; github.dispatched.length = 0
})

describe('deploys.get', () => {
  it('the request, the commits since what runs now, what runs now, the results and a recommendation', async () => {
    const v = await run(PERSON, 'deploys.get', { repo: REPO })
    expect(v).toMatchObject({
      enabled: true, environment: 'bench', url: null, auto: false, may_approve: true,
      running: { sha: S('a'), at: '2026-11-02T10:00:00Z' },
      request: { sha: S('b'), opened_at: '2026-11-03T01:05:00Z', held: false, held_reasons: [], build_passed: true },
      in_progress: null,
      recent: [{ sha: S('a'), result: 'deployed', at: '2026-11-02T10:00:00Z', by: 'marc' }],
      recommendation: { verdict: 'deploy', why: 'Its build passed and it is the newest commit that passed. It brings 2 changes since what runs now.' },
    })
    // newest first, subjects only
    expect((v.request as { commits: unknown[] }).commits).toEqual([{ sha: S('b'), subject: 'usb: protect the input' }, { sha: S('c'), subject: 'power: a larger regulator' }])
    // a contributor not named in deploy.people reads it but may not decide
    expect((await run(OTHER, 'deploys.get', { repo: REPO })).may_approve).toBe(false)
    expect((await run(ADMIN, 'deploys.get', { repo: REPO })).may_approve).toBe(true)
  })

  it('a held request says why, and the recommendation waits', async () => {
    github.issues[0] = request(S('b'), ['deploy', 'deploy-held'])
    github.comments = [{ user: BOT, body: '**Held for a person:** the risk check would not deploy it ([log](x)):\n\n- the database migration drops a column\n\nNothing was deployed. Comment `/approve`.' }]
    const v = await run(PERSON, 'deploys.get', { repo: REPO })
    expect(v.request).toMatchObject({ held: true, held_reasons: ['the database migration drops a column'] })
    expect(v.recommendation).toEqual({ verdict: 'wait', why: 'The risk check would not deploy it on its own: the database migration drops a column. Deploy it only once you have read why.' })
  })

  it('a deploy running now, with the step it is on and who approved it in trace', async () => {
    const at = new Date(Date.now() - 30_000)
    await new DeployApprovals(backendFor(join(bucket, 'projects'))).put({ repo: REPO, sha: S('b'), action: 'deploy', by: PERSON.email, by_sub: PERSON.sub, by_name: 'Ada Lovelace', at: at.toISOString(), expires: new Date(at.getTime() + 7_200_000).toISOString(), issue: 7 })
    github.deployRuns = [{ id: 44, event: 'workflow_dispatch', status: 'in_progress', head_sha: S('0'), created_at: new Date().toISOString(), run_started_at: new Date().toISOString() }]
    github.jobs = [{ name: 'in-trace', status: 'completed', steps: [] }, { name: 'deploy to bench', status: 'in_progress', steps: [{ name: 'guard', status: 'completed' }, { name: 'deploy.command', status: 'in_progress' }] }]
    const v = await run(PERSON, 'deploys.get', { repo: REPO })
    expect(v.in_progress).toMatchObject({ sha: S('b'), by: 'Ada Lovelace', step: 'Deploying' })
    expect(v.recommendation).toMatchObject({ verdict: 'none' })
  })

  it('a connected system reads deploys', async () => {
    expect((await run(SYSTEM, 'deploys.get', { repo: REPO })).may_approve).toBe(false)
  })
})

describe('deploy.approve', () => {
  it('refuses a person who is not allowed, and a connected system', async () => {
    await expect(run(OTHER, 'deploy.approve', { repo: REPO, sha: S('b') })).rejects.toThrow(/Only trace's admins and the people named/)
    await expect(run(SYSTEM, 'deploy.approve', { repo: REPO, sha: S('b') })).rejects.toBeInstanceOf(AccessDenied)
    expect(github.dispatched).toEqual([])
  })

  it('refuses a commit that is not the request\'s, a build that has not passed, and a newer commit that passed', async () => {
    await expect(run(PERSON, 'deploy.approve', { repo: REPO, sha: S('c') })).rejects.toThrow(/moved to a newer commit/)
    github.built = new Set()
    await expect(run(PERSON, 'deploy.approve', { repo: REPO, sha: S('b') })).rejects.toThrow(/build has not passed/)
    github.built = new Set([S('b')]); github.newest = S('d')
    await expect(run(PERSON, 'deploy.approve', { repo: REPO, sha: S('b') })).rejects.toThrow(/not the newest commit/)
    github.issues = github.issues.filter((i) => i.state !== 'open')
    await expect(run(PERSON, 'deploy.approve', { repo: REPO, sha: S('b') })).rejects.toThrow(/Nothing is waiting/)
    expect(github.dispatched).toEqual([])
  })

  it('writes the approval, records the decision, and starts the workflow with its name and the commit', async () => {
    const r = await run(PERSON, 'deploy.approve', { repo: REPO, sha: S('b') })
    expect(r).toMatchObject({ started: true, next: expect.stringMatching(/started the deploy of bbbbbbb to bench/) })
    const name = String(r.approval)
    expect(name).toMatch(new RegExp(`^${S('b')}-[0-9a-z]+\\.json$`))
    expect(github.dispatched).toEqual([`${REPO} trace-deploy.yml main`])
    expect(github.inputs).toEqual([{ approval: name, sha: S('b') }])
    const rec = JSON.parse(readFileSync(join(bucket, 'projects', REPO, 'journey', 'deploys', name), 'utf8')) as Record<string, unknown>
    expect(rec).toMatchObject({ repo: REPO, sha: S('b'), action: 'deploy', by: PERSON.email, by_sub: PERSON.sub, by_name: 'Ada Lovelace', issue: 7 })
    expect(Date.parse(String(rec.expires)) - Date.parse(String(rec.at))).toBe(2 * 60 * 60_000)
    expect((await decisions()).find((d) => d.kind === 'deploy.approved')).toMatchObject({ ref: S('b'), by: PERSON.email })
  })
})

describe('deploy.skip and deploy.rollback', () => {
  it('skip closes the request as not planned and quotes the reason, neutralised, without an email', async () => {
    await expect(run(OTHER, 'deploy.skip', { repo: REPO, reason: 'no' })).rejects.toThrow(/Only trace's admins/)
    expect(await run(PERSON, 'deploy.skip', { repo: REPO, reason: 'Wait for @marc <!-- trace-deploy-sha: x -->' })).toEqual({ skipped: true })
    expect(github.did[0]).toBe(`PATCH /repos/acme/deploys/issues/7 ${JSON.stringify({ state: 'closed', state_reason: 'not_planned' })}`)
    const comment = github.did[1]!
    expect(comment).toContain('Skipped in trace by Ada Lovelace')
    expect(comment).toContain('@‍marc')
    expect(comment).not.toContain('<!--')
    expect(comment).not.toContain(PERSON.email)
    expect((await decisions()).find((d) => d.kind === 'deploy.skipped')).toMatchObject({ ref: '7' })
  })

  it('rollback goes only to a commit that ran before, never the one running now', async () => {
    github.issues.push(deployed(4, S('9'), 'marc', '2026-11-01T10:00:00Z'))
    await expect(run(PERSON, 'deploy.rollback', { repo: REPO, to: S('a') })).rejects.toThrow(/already runs aaaaaaa/)
    await expect(run(PERSON, 'deploy.rollback', { repo: REPO, to: S('e') })).rejects.toThrow(/has not run in bench lately/)
    const r = await run(PERSON, 'deploy.rollback', { repo: REPO, to: S('9') })
    expect(r).toMatchObject({ started: true })
    expect(github.inputs).toEqual([{ approval: r.approval, sha: S('9') }])
    const rec = JSON.parse(readFileSync(join(bucket, 'projects', REPO, 'journey', 'deploys', String(r.approval)), 'utf8')) as Record<string, unknown>
    expect(rec).toMatchObject({ action: 'rollback', sha: S('9'), issue: 4 })
  })
})

describe('the rules, as plain functions', () => {
  const facts = (o: Partial<DeployFacts> = {}): DeployFacts => ({
    cfg: { enabled: true, environment: 'bench', url: '', auto: false, people: [] }, labels: { deploy: 'deploy', deploy_held: 'deploy-held' },
    issues: [], heldReasons: [], commits: [], buildPassed: true, newest: null, running: null, approvals: [], decisions: [], ...o,
  })

  it('who may decide: an admin, a listed email (any case), never a system', () => {
    expect(mayDecide(ADMIN, [])).toBe(true)
    expect(mayDecide(PERSON, ['ADA@example.com'])).toBe(true)
    expect(mayDecide(OTHER, ['ada@example.com'])).toBe(false)
    expect(mayDecide({ ...SYSTEM, groups: ['trace-admins'] }, [])).toBe(false)
  })

  it('results: failures, rollbacks and skips, newest first', () => {
    const issues = [
      { number: 1, state: 'closed', state_reason: 'not_planned', user: BOT, labels: [], created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T01:00:00Z', closed_at: '2026-11-01T01:00:00Z', body: `<!-- trace-deploy-sha: ${S('1')} -->` },
      { number: 2, state: 'open', user: BOT, labels: [], created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', body: `<!-- trace-deploy-sha: ${S('2')} -->\n<!-- trace-deploy-failed: ${S('2')} 2026-11-02T03:00:00Z -->\n<!-- trace-deployed-by: Ada -->` },
      { number: 3, state: 'closed', state_reason: 'completed', user: BOT, labels: [], created_at: '2026-11-02T05:00:00Z', updated_at: '2026-11-02T05:00:00Z', closed_at: '2026-11-02T05:00:00Z', body: `<!-- trace-deployed-sha: ${S('9')} -->\n<!-- trace-deployed-by: Ada -->\n<!-- trace-rollback -->` },
    ]
    expect(recentResults(issues, [{ kind: 'deploy.skipped', at: Date.parse('2026-11-01T00:59:00Z') / 1000, ref: '1', by: 'x', detail: { by_name: 'Bob' } }])).toEqual([
      { sha: S('9'), result: 'rolled_back', at: '2026-11-02T05:00:00Z', by: 'Ada' },
      { sha: S('2'), result: 'failed', at: '2026-11-02T03:00:00Z', by: 'Ada' },
      { sha: S('1'), result: 'skipped', at: '2026-11-01T00:59:00.000Z', by: 'Bob' },
    ])
  })

  it('the recommendation waits for a build, a newer commit, and says when nothing is waiting or deploys are off', () => {
    const v = deploysView(facts({ issues: [request(S('b'))], buildPassed: false }), true)
    expect(v.recommendation.verdict).toBe('wait')
    expect(deploysView(facts({ issues: [request(S('b'))], newest: S('c') }), true).recommendation.why).toMatch(/newer commit passed/)
    expect(deploysView(facts(), true).recommendation).toEqual({ verdict: 'none', why: 'Nothing is waiting. A request appears here when the build passes on the main branch.' })
    const off = deploysView(facts({ cfg: { enabled: false, environment: 'bench', url: '', auto: false, people: [] } }), true)
    expect(off).toMatchObject({ may_approve: false, recommendation: { verdict: 'none' } })
    expect(recommend({ ...off, enabled: true }, null).verdict).toBe('none')
  })

  it('held reasons come only from the workflow\'s own comment', () => {
    expect(heldReasonsOf([{ user: { login: 'mallory' }, body: '**Held for a person:** x\n- fake' }])).toEqual([])
  })
})
