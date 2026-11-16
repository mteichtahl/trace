/**
 * Deploys on trace's GitLab (docs/gitlab-projects.md; the GitHub workflow is templates/workflows/trace-deploy.yml): the
 * same harness tasks in the same order, in one pipeline job, since GitLab passes no outputs from one job to the next
 * job's conditions as GitHub's `needs.*.outputs` do.
 *
 *   request    on a push to the default branch whose build passed: deploy-request (an automatic deploy goes at once;
 *              otherwise it waits for a person to approve it in trace)
 *   in trace   on a pipeline trace started with an approval (TRACE_INPUT_APPROVAL, TRACE_INPUT_SHA): deploy-approve
 *              reads the record only trace's API can write, as the project's own AWS role; it may also be a roll back
 *   deploy     deploy-commands, deploy-guard (refuse when the environment runs a newer commit), deploy.setup,
 *              deploy.risk_check for an automatic deploy (anything but exit 0 holds it: deploy-hold), deploy.command,
 *              deploy.smoke, deploy-report; a failure after the deploy began rolls back to the commit that ran before
 *   roll back  deploy.rollback, or deploy.command and deploy.smoke on the earlier commit; rollback-report
 *
 * The project's commands never see trace's credentials: the agents' token and the project's trace AWS role are taken
 * out of their environment; they get the deploy role (TRACE_DEPLOY_AWS_ROLE, through GitLab's ID token) when it is set,
 * and the project's own CI/CD variables, which are its deploy secrets as GitHub's secrets are.
 */

/** Runs one harness task with these inputs and answers what it output (its setOutput lines). Throws when it fails. */
export type Step = (task: string, inputs: Record<string, string>) => Promise<Record<string, string>>
/** Runs a shell command (bash -euo pipefail -c); answers whether it passed and what it printed. */
export type Shell = (cmd: string, env: Record<string, string>) => { ok: boolean; output: string }

export interface DeployDeps {
  step: Step
  sh: Shell
  /** check the commit out in the job's working copy */
  checkout: (sha: string) => void
  /** the deploy role's credentials (TRACE_DEPLOY_AWS_ROLE), or nothing when there is none */
  deployCredentials: () => Record<string, string>
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}

/** What the commands run with: the job's environment without trace's own credentials. */
export function commandEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const drop = new Set(['TRACE_GITLAB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_ID_TOKEN', 'CI_JOB_TOKEN'])
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k)) out[k] = v
  return { ...out, ...extra }
}

export async function gitlabDeploy(d: DeployDeps): Promise<{ deployed: boolean; rolledBack: string | null }> {
  const environment = d.env.TRACE_DEPLOY_ENVIRONMENT || 'production'
  const approval = d.env.TRACE_INPUT_APPROVAL ?? ''
  let go = false
  let sha = ''
  let issue = ''
  let by = ''
  let via = ''
  let auto = false
  let rollTo = ''
  if (approval) {
    const a = await d.step('deploy-approve', { APPROVAL: approval, SHA: d.env.TRACE_INPUT_SHA ?? '', TRIGGERING_ACTOR: d.env.GITLAB_USER_LOGIN ?? '' })
    go = a.go === 'true'; sha = a.sha ?? ''; issue = a.issue ?? ''; by = a.by ?? ''; rollTo = a['roll-back-to'] ?? ''; via = 'trace'
  } else {
    const r = await d.step('deploy-request', {})
    go = r.go === 'true'; sha = r.sha ?? ''; issue = r.issue ?? ''; auto = true; by = 'the pipeline (automatic deploy)'
  }
  if (!go && rollTo) { await rollBack(d, rollTo, { issue, by, via, environment }); return { deployed: false, rolledBack: rollTo } }
  if (!go || !sha) { d.log('nothing to deploy'); return { deployed: false, rolledBack: null } }

  d.checkout(sha)
  const cmd = await d.step('deploy-commands', {})
  let guard = 'success'
  let before = ''
  try {
    before = (await d.step('deploy-guard', { SHA: sha, ISSUE: issue })).before ?? ''
  } catch (e) {
    guard = 'failure'
    d.log(`deploy-guard: ${e instanceof Error ? e.message : String(e)}`)
  }
  const base = commandEnv(d.env, { ...d.deployCredentials(), DEPLOY_SHA: sha, DEPLOY_ENVIRONMENT: environment })
  let held = false
  let applied = true
  let smoked = true
  let ok = guard === 'success'
  if (ok && cmd.setup) ok = d.sh(cmd.setup, base).ok
  if (ok && auto && cmd.risk_check) {
    const r = d.sh(cmd.risk_check, base)
    if (!r.ok) {
      held = true
      await d.step('deploy-hold', { SHA: sha, ISSUE: issue, REASONS: r.output.split('\n').slice(-40).join('\n') })
    }
  }
  if (ok && !held) {
    applied = d.sh(cmd.command ?? '', base).ok
    smoked = applied && cmd.smoke ? d.sh(cmd.smoke, base).ok : applied
    ok = applied && smoked
  }
  const rollbackTo = !held && guard === 'success' && (!applied || !smoked) && before && before !== sha ? before : ''
  await d.step('deploy-report', {
    SHA: sha, ISSUE: issue, BY: by, VIA: via, STATUS: ok || held ? 'success' : 'failure', GUARD: guard, HELD: held ? 'true' : '', ROLLBACK: rollbackTo,
  })
  if (rollbackTo) { await rollBack(d, rollbackTo, { issue, by: '', via: '', environment }); return { deployed: false, rolledBack: rollbackTo } }
  if (!ok && !held) throw new Error(`the deploy of ${sha.slice(0, 12)} to ${environment} failed`)
  return { deployed: ok && !held, rolledBack: null }
}

async function rollBack(d: DeployDeps, to: string, o: { issue: string; by: string; via: string; environment: string }): Promise<void> {
  d.checkout(to)
  const cmd = await d.step('deploy-commands', {})
  const base = commandEnv(d.env, { ...d.deployCredentials(), DEPLOY_SHA: to, ROLLBACK_SHA: to, DEPLOY_ENVIRONMENT: o.environment })
  let ok = cmd.setup ? d.sh(cmd.setup, base).ok : true
  if (ok) {
    if (cmd.rollback) ok = d.sh(cmd.rollback, base).ok
    else ok = d.sh(cmd.command ?? '', base).ok && (!cmd.smoke || d.sh(cmd.smoke, base).ok)
  }
  await d.step('rollback-report', { SHA: to, ISSUE: o.issue, BY: o.by, VIA: o.via, STATUS: ok ? 'success' : 'failure' })
  if (!ok) throw new Error(`rolling ${o.environment} back to ${to.slice(0, 12)} failed`)
}
