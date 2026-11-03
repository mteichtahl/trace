/**
 * A deploy approved in trace (docs/stay-in-trace.md "2. Deploys", src/harness/deploy.ts approvedInTrace): the workflow
 * reads the approval record the API wrote and deploys only when it exists, names this repository and the commit it was
 * started for, has not expired, and today's checks pass. A missing record, an expired one, another commit's or another
 * repository's each deploy nothing. A rollback approved in trace names a commit that ran before and goes to the
 * rollback job. The record's store and name rules (src/core/deploy-approvals.ts) are checked here too, and the
 * reports that name the person.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { backendFor } from '../../src/core/central.js'
import { APPROVAL_TTL_MS, DeployApprovals, approvalKey, approvalName, approvalRefusal, projectsHome } from '../../src/core/deploy-approvals.js'
import * as deploy from '../../src/harness/deploy.js'
import { SHA, cfgOf, context, deps, fakeCore, fakeGithub } from './fake.js'

const dir = mkdtempSync(join(tmpdir(), 'trace-deploy-approvals-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const store = new DeployApprovals(backendFor(dir))
const dcfg = () => cfgOf({ deploy: { enabled: true, command: './deploy.sh', environment: 'bench' } })
const REPO = 'o/r'

const approval = (o: Partial<Parameters<DeployApprovals['put']>[0]> = {}, at = new Date()) => ({
  repo: REPO, sha: SHA('a'), action: 'deploy' as const, by: 'alex@example.com', by_sub: 'sub-alex', by_name: 'Alex L.',
  at: at.toISOString(), expires: new Date(at.getTime() + APPROVAL_TTL_MS).toISOString(), issue: 3, ...o,
})

// GitHub as the checks see it: on main, built, the newest passing commit is `newest`, the request #3 is the workflow's
const github = (o: { newest?: string; built?: boolean; onMain?: boolean; deployed?: string[] } = {}) => fakeGithub({
  'repos.compareCommits': { status: o.onMain === false ? 'diverged' : 'ahead' },
  'actions.listWorkflowRuns': ({ head_sha }: Record<string, unknown>) =>
    (head_sha ? { total_count: o.built === false ? 0 : 1 } : { workflow_runs: [{ event: 'push', created_at: '2026', head_sha: o.newest ?? SHA('a') }] }),
  'issues.get': { number: 3, state: 'open', user: { login: 'github-actions[bot]' }, body: `<!-- trace-deploy-sha: ${SHA('a')} -->` },
  'issues.listForRepo': (o.deployed ?? []).map((s) => ({ user: { login: 'github-actions[bot]' }, body: `<!-- trace-deployed-sha: ${s} -->` })),
})
const dispatch = (approvalName: string, sha: string, extra: Record<string, string> = {}) =>
  context({ eventName: 'workflow_dispatch', ref: 'refs/heads/main', actor: 'trace-bot', payload: {} , ...extra })

async function run(name: string, sha: string, o: Parameters<typeof github>[0] = {}, env: Record<string, string> = {}, ctxExtra: Record<string, string> = {}) {
  const f = github(o)
  const core = fakeCore()
  await deploy.approvedInTrace(deps(f, core, dcfg(), dispatch(name, sha, ctxExtra), { APPROVAL: name, SHA: sha, ...env }), store)
  return { f, core }
}

describe('a deploy approved in trace', () => {
  it('a good record deploys its commit, names the person, and says so on the request', async () => {
    const name = await store.put(approval())
    const { f, core } = await run(name, SHA('a'))
    expect(core.outputs).toMatchObject({ go: 'true', sha: SHA('a'), issue: '3', by: 'Alex L.', via: 'trace' })
    expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/^Approved in trace by Alex L\.: deploying aaaaaaaaaaaa/)
  })

  it('a missing record deploys nothing, nor a name that is not an approval\'s', async () => {
    for (const name of [approvalName(SHA('a'), new Date(Date.now() - 1000)), '../../journey/journey.db', '']) {
      const { core } = await run(name, SHA('a'))
      expect(core.outputs.go).toBe('false')
      expect(core.outputs.sha).toBeUndefined()
      expect(core.infos.join('\n')).toMatch(/No approval was found.*Nothing was deployed/)
    }
  })

  it('an expired record deploys nothing', async () => {
    const at = new Date(Date.now() - APPROVAL_TTL_MS - 60_000)
    const name = await store.put(approval({}, at))
    const { core } = await run(name, SHA('a'))
    expect(core.outputs.go).toBe('false')
    expect(core.infos.join('\n')).toMatch(/expired/)
  })

  it('a record for another commit deploys nothing (the workflow was started for a different one)', async () => {
    const name = await store.put(approval({ sha: SHA('b') }, new Date(Date.now() - 5000)))
    const { core } = await run(name, SHA('a'))
    expect(core.outputs.go).toBe('false')
    expect(core.infos.join('\n')).toMatch(/approval is for bbbbbbbbbbbb, not aaaaaaaaaaaa/)
  })

  it('a record for another repository deploys nothing, even one filed under this project\'s folder', async () => {
    // the store would refuse to file it under o/r, so write it there by hand, as a stray write would
    const at = new Date(Date.now() - 7000)
    const rec = approval({ repo: 'mallory/r' }, at)
    const name = approvalName(rec.sha, at)
    await backendFor(dir).put(approvalKey(REPO, name), new TextEncoder().encode(JSON.stringify(rec)))
    const { core } = await run(name, SHA('a'))
    expect(core.outputs.go).toBe('false')
    expect(core.infos.join('\n')).toMatch(/another project/)
  })

  it('a good record still needs today\'s checks: on main, built, the newest that passed', async () => {
    const name = await store.put(approval({}, new Date(Date.now() - 9000)))
    expect((await run(name, SHA('a'), { onMain: false })).core.outputs.go).toBe('false')
    expect((await run(name, SHA('a'), { built: false })).core.outputs.go).toBe('false')
    const late = await run(name, SHA('a'), { newest: SHA('c') })
    expect(late.core.outputs.go).toBe('false')
    expect(late.core.infos.join('\n')).toMatch(/not the newest passing commit/)
  })

  it('runs from the default branch only, and a re-run by a bot cannot replay it', async () => {
    const name = await store.put(approval({}, new Date(Date.now() - 11000)))
    expect((await run(name, SHA('a'), {}, {}, { ref: 'refs/heads/feature' })).core.outputs.go).toBe('false')
    const again = await run(name, SHA('a'), {}, { TRIGGERING_ACTOR: 'helper[bot]' })
    expect(again.core.outputs.go).toBe('false')
    expect(again.core.infos.join('\n')).toMatch(/re-run started by @helper\[bot\]/)
  })

  it('without a store to read (TRACE_HOME not set), nothing is deployed', async () => {
    const core = fakeCore()
    await deploy.approvedInTrace(deps(github(), core, dcfg(), dispatch('x', SHA('a')), { APPROVAL: 'x', SHA: SHA('a') }), null)
    expect(core.outputs.go).toBe('false')
    expect(core.infos.join('\n')).toMatch(/TRACE_HOME is not set/)
  })

  it('approve takes the trace path for a dispatch with an approval, and skips the GitHub-login refusal', async () => {
    // TRACE_HOME unset in this test's environment for the harness: no store, so nothing deploys, but the bot actor
    // ("trace-bot", trace's token) is never judged as a person
    const f = github()
    const core = fakeCore()
    await deploy.approve(deps(f, core, dcfg(), dispatch('x', SHA('a')), { APPROVAL: 'x', SHA: SHA('a'), TRACE_HOME: '' }))
    expect(f.called('repos.getCollaboratorPermissionLevel')).toHaveLength(0)
    expect(core.outputs.go).toBe('false')
  })

  it('a rollback goes to the rollback job, only to a commit that ran before', async () => {
    const name = await store.put(approval({ sha: SHA('9'), action: 'rollback', issue: null }))
    const ok = await run(name, SHA('9'), { newest: SHA('a'), deployed: [SHA('a'), SHA('9')] })
    expect(ok.core.outputs).toMatchObject({ go: 'false', 'roll-back-to': SHA('9'), by: 'Alex L.', via: 'trace' })
    const never = await run(name, SHA('9'), { newest: SHA('a'), deployed: [SHA('a')] })
    expect(never.core.outputs['roll-back-to']).toBeUndefined()
    expect(never.core.infos.join('\n')).toMatch(/has not run in bench before/)
  })
})

describe('the approval record', () => {
  it('is written once: the same name again is refused, never overwritten', async () => {
    const at = new Date(Date.now() - 20_000)
    await store.put(approval({}, at))
    await expect(store.put(approval({ by_name: 'Mallory' }, at))).rejects.toThrow()
    expect((await store.get(REPO, approvalName(SHA('a'), at)))?.by_name).toBe('Alex L.')
  })

  it('lives under the journey\'s folder, which only the API writes', () => {
    expect(approvalKey('Acme/Board', 'x.json')).toBe('acme/board/journey/deploys/x.json')
    expect(projectsHome('s3://bucket/central')).toBe('s3://bucket/projects')
    expect(projectsHome('s3://bucket/trace/central/')).toBe('s3://bucket/trace/projects')
    expect(projectsHome('/tmp/home')).toBe('/tmp/home/projects')
    expect(projectsHome(undefined)).toBeNull()
  })

  it('refuses a record dated ahead of now, or one that lasts longer than trace gives', () => {
    const now = Date.now()
    const future = approval({}, new Date(now + 60 * 60_000))
    expect(approvalRefusal(future, { repo: REPO, sha: SHA('a'), now })).toMatch(/not one trace wrote/)
    const long = { ...approval({}, new Date(now)), expires: new Date(now + 24 * 60 * 60_000).toISOString() }
    expect(approvalRefusal(long, { repo: REPO, sha: SHA('a'), now })).toMatch(/not one trace wrote/)
    expect(approvalRefusal(approval({}, new Date(now)), { repo: 'O/R', sha: SHA('a'), now })).toBeNull()
  })
})

describe('reports name the person', () => {
  it('a deploy approved in trace says so, and records who for the app', async () => {
    const f = fakeGithub({ 'issues.get': { body: `x\n<!-- trace-deploy-sha: ${SHA('d')} -->` } })
    await deploy.report(deps(f, fakeCore(), dcfg(), context(), { SHA: SHA('d'), ISSUE: '4', BY: 'Alex L.', VIA: 'trace', STATUS: 'success' }))
    expect(String(f.called('issues.createComment')[0]!.args.body)).toMatch(/^Deployed dddddddddddd to bench, approved in trace by Alex L\./)
    const body = String(f.called('issues.update')[0]!.args.body)
    expect(body).toContain(`trace-deployed-sha: ${SHA('d')}`)
    expect(body).toContain('<!-- trace-deployed-by: Alex L. -->')
  })

  it('a failed deploy is marked on the request, which stays open', async () => {
    const f = fakeGithub({ 'issues.get': { body: `x\n<!-- trace-deploy-sha: ${SHA('d')} -->` } })
    await deploy.report(deps(f, fakeCore(), dcfg(), context(), { SHA: SHA('d'), ISSUE: '4', BY: '@marc', STATUS: 'failure' }))
    const u = f.called('issues.update')[0]!.args
    expect(u.state).toBeUndefined()
    expect(String(u.body)).toMatch(new RegExp(`trace-deploy-failed: ${SHA('d')} \\S+`))
  })

  it('a rollback approved in trace is recorded as a closed request of the workflow\'s own', async () => {
    const f = fakeGithub({ 'issues.create': { number: 9 } })
    await deploy.rollbackReport(deps(f, fakeCore(), dcfg(), context(), { SHA: SHA('9'), BY: 'Alex <L.> --x', VIA: 'trace', STATUS: 'success' }))
    const made = f.called('issues.create')[0]!.args
    expect(String(made.body)).toContain(`<!-- trace-deployed-sha: ${SHA('9')} -->`)
    expect(String(made.body)).toContain('<!-- trace-deployed-by: Alex  L.  -x -->')
    expect(String(made.body)).toContain('<!-- trace-rollback -->')
    expect(f.called('issues.update')[0]!.args).toMatchObject({ issue_number: 9, state: 'closed', state_reason: 'completed' })
  })
})
