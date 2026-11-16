import { describe, expect, it } from 'vitest'
import { type DeployDeps, commandEnv, gitlabDeploy } from '../../src/harness/gitlab-deploy.js'

/** A deploy world: each task's outputs, which commands pass, and what happened in order. */
function world(o: { outputs?: Record<string, Record<string, string>>; fails?: string[]; env?: NodeJS.ProcessEnv; guardFails?: boolean } = {}) {
  const did: string[] = []
  const envs: Record<string, string>[] = []
  const inputs: Record<string, Record<string, string>> = {}
  const d: DeployDeps = {
    env: { TRACE_GITLAB_TOKEN: 'glpat', AWS_ACCESS_KEY_ID: 'trace-role', PROJECT_SECRET: 's3', ...o.env },
    log: () => {},
    step: async (task, i) => {
      did.push(task)
      inputs[task] = i
      if (task === 'deploy-guard' && o.guardFails) throw new Error('newer commit running')
      return o.outputs?.[task] ?? {}
    },
    sh: (cmd, e) => { did.push(`sh ${cmd}`); envs.push(e); return { ok: !(o.fails ?? []).includes(cmd), output: `${cmd} said no` } },
    checkout: (sha) => { did.push(`checkout ${sha}`) },
    deployCredentials: () => ({ AWS_ACCESS_KEY_ID: 'deploy-role' }),
  }
  return { d, did, envs, inputs }
}
const commands = { command: 'deploy', smoke: 'smoke', setup: 'setup', risk_check: 'risk' }

describe('a deploy on trace\'s GitLab', () => {
  it('an automatic deploy: request, commands, guard, setup, risk check, command, smoke, report', async () => {
    const w = world({ outputs: { 'deploy-request': { go: 'true', sha: 'abc', issue: '4' }, 'deploy-commands': commands, 'deploy-guard': { before: 'old' } } })
    expect(await gitlabDeploy(w.d)).toEqual({ deployed: true, rolledBack: null })
    expect(w.did).toEqual(['deploy-request', 'checkout abc', 'deploy-commands', 'deploy-guard', 'sh setup', 'sh risk', 'sh deploy', 'sh smoke', 'deploy-report'])
    expect(w.inputs['deploy-report']).toMatchObject({ SHA: 'abc', ISSUE: '4', STATUS: 'success', GUARD: 'success', HELD: '', ROLLBACK: '' })
  })

  it('never gives the commands trace\'s token or role, and gives them the deploy role and the project\'s variables', async () => {
    const w = world({ outputs: { 'deploy-request': { go: 'true', sha: 'abc' }, 'deploy-commands': { command: 'deploy' } } })
    await gitlabDeploy(w.d)
    for (const e of w.envs) {
      expect(e.TRACE_GITLAB_TOKEN).toBeUndefined()
      expect(e.AWS_ACCESS_KEY_ID).toBe('deploy-role')
      expect(e.PROJECT_SECRET).toBe('s3')
      expect(e).toMatchObject({ DEPLOY_SHA: 'abc', DEPLOY_ENVIRONMENT: 'production' })
    }
    expect(commandEnv({ AWS_SESSION_TOKEN: 'x', CI_JOB_TOKEN: 'y', KEEP: 'z' }, {})).toEqual({ KEEP: 'z' })
  })

  it('a risk check that does not pass holds an automatic deploy for a person', async () => {
    const w = world({ outputs: { 'deploy-request': { go: 'true', sha: 'abc', issue: '4' }, 'deploy-commands': commands }, fails: ['risk'] })
    expect(await gitlabDeploy(w.d)).toEqual({ deployed: false, rolledBack: null })
    expect(w.did).toContain('deploy-hold')
    expect(w.did).not.toContain('sh deploy')
    expect(w.inputs['deploy-hold']?.REASONS).toContain('risk said no')
    expect(w.inputs['deploy-report']?.HELD).toBe('true')
  })

  it('a smoke failure after the deploy began rolls back to the commit that ran before', async () => {
    const w = world({ outputs: { 'deploy-request': { go: 'true', sha: 'abc' }, 'deploy-commands': { ...commands, rollback: 'undo' }, 'deploy-guard': { before: 'old' } }, fails: ['smoke'] })
    expect(await gitlabDeploy(w.d)).toEqual({ deployed: false, rolledBack: 'old' })
    expect(w.inputs['deploy-report']).toMatchObject({ STATUS: 'failure', ROLLBACK: 'old' })
    expect(w.did.slice(w.did.indexOf('deploy-report') + 1)).toEqual(['checkout old', 'deploy-commands', 'sh setup', 'sh undo', 'rollback-report'])
    expect(w.inputs['rollback-report']).toMatchObject({ SHA: 'old', STATUS: 'success' })
  })

  it('an approval given in trace deploys its commit and reports it as trace\'s, and the risk check is for automatic deploys only', async () => {
    const w = world({ env: { TRACE_INPUT_APPROVAL: 'ap-1', TRACE_INPUT_SHA: 'abc' }, outputs: { 'deploy-approve': { go: 'true', sha: 'abc', by: 'Marc' }, 'deploy-commands': commands } })
    await gitlabDeploy(w.d)
    expect(w.inputs['deploy-approve']).toMatchObject({ APPROVAL: 'ap-1', SHA: 'abc' })
    expect(w.did).not.toContain('sh risk')
    expect(w.inputs['deploy-report']).toMatchObject({ BY: 'Marc', VIA: 'trace' })
  })

  it('a roll back asked for in trace runs the earlier commit\'s rollback', async () => {
    const w = world({ env: { TRACE_INPUT_APPROVAL: 'rb-1' }, outputs: { 'deploy-approve': { go: 'false', 'roll-back-to': 'old', by: 'Marc' }, 'deploy-commands': { command: 'deploy', rollback: 'undo' } } })
    expect(await gitlabDeploy(w.d)).toEqual({ deployed: false, rolledBack: 'old' })
    expect(w.did).toEqual(['deploy-approve', 'checkout old', 'deploy-commands', 'sh undo', 'rollback-report'])
    expect(w.inputs['rollback-report']).toMatchObject({ SHA: 'old', BY: 'Marc', VIA: 'trace', STATUS: 'success' })
  })

  it('a guard that refuses deploys nothing and reports the refusal', async () => {
    const w = world({ outputs: { 'deploy-request': { go: 'true', sha: 'abc' }, 'deploy-commands': commands }, guardFails: true })
    await expect(gitlabDeploy(w.d)).rejects.toThrow(/failed/)
    expect(w.did).not.toContain('sh deploy')
    expect(w.inputs['deploy-report']).toMatchObject({ STATUS: 'failure', GUARD: 'failure' })
  })
})
