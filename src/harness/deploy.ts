/**
 * Deploys (from Potroller's deploy.yml), with the project's own commands from the deploy.* settings.
 *
 *   request   a passing build on the default branch opens (or moves) one deploy request issue. With deploy.auto it
 *             starts the deploy itself; otherwise it waits for a person's /approve.
 *   approve   /approve or /reject on the request (or "Run workflow"): only a PERSON with admin or maintain (and in
 *             deploy.approvers when set). A bot or app account is always refused, so the agents that write and merge
 *             the code can never also send it to production.
 *             Or an approval given in trace (docs/stay-in-trace.md "2. Deploys"): trace starts this workflow with the
 *             approval's name and the commit (workflow_dispatch inputs `approval` and `sha`), and approvedInTrace reads
 *             the record from the central store with the workflow's own AWS role (src/core/deploy-approvals.ts). Only
 *             the API can write that record, so the GitHub login that started the run is not judged (it is trace's
 *             token). It deploys only when the record exists, names this repository and that exact commit, has not
 *             expired, and today's checks pass: the build passed, the commit is on the default branch, and (a deploy)
 *             it is the newest that passed, or (a rollback) it ran in the environment before.
 *   guard     just before deploying: refuse if production already runs a newer commit (no accidental rollback), and
 *             say what production runs now (the rollback target).
 *   hold      the risk check said no: label the request deploy_held and ask a person.
 *   report    the result on the request; records the deployed commit and who, closes the request. A failed deploy is
 *             marked on the request too, so the app can show it (src/api/actions-deploys.ts reads these markers, only
 *             from requests the workflow's own account opened).
 *   rollbackReport  the rollback's result. A rollback a person approved in trace is recorded as a closed request of its
 *             own, opened by the workflow's account like every deploy record, so the app shows what runs now.
 */
import type { TraceConfig } from '../core/config.js'
import { type DeployApproval, DeployApprovals, approvalRefusal } from '../core/deploy-approvals.js'
import { ensureLabel, newestPassing } from './util.js'
import { ActorPayload, type Deps, type GitHub, IssueCommentPayload, WorkflowRunPayload, labelNames, payload, short } from './types.js'

const DEPLOY_SHA = /<!-- trace-deploy-sha: ([0-9a-f]{40}) -->/
const DEPLOYED_SHA = /<!-- trace-deployed-sha: ([0-9a-f]{40}) -->/
const DEPLOYED_SHA_G = /\n?<!-- trace-deployed-sha: [0-9a-f]{40} -->/g
const DEPLOYED_BY_G = /\n?<!-- trace-deployed-by: [^\n]*? -->/g
const FAILED_G = /\n?<!-- trace-deploy-failed: [^\n]*? -->/g
/** The workflow's own account: the only author whose deploy records are trusted (guard, and the app's reading). */
export const WORKFLOW_LOGIN = 'github-actions[bot]'
/** Text safe inside a one-line comment marker: no angle brackets, no line breaks, no `--`, short. */
export const markerText = (s: string): string => s.replace(/[<>\r\n]/g, ' ').replace(/-{2,}/g, '-').trim().slice(0, 120)

export async function request({ github, context, core, cfg }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  core.setOutput('go', 'false')
  if (!cfg.deploy.enabled) return core.info('deploy.enabled is off.')
  const run = payload(context, 'workflow_run', WorkflowRunPayload)
  if (!run || run.conclusion !== 'success' || run.head_branch !== cfg.branch || !['push', 'workflow_dispatch'].includes(run.event)) {
    return core.info('Not a passing build of the default branch.')
  }
  const sha = run.head_sha
  const auto = cfg.deploy.auto
  await ensureLabel(github, owner, repo, cfg, 'deploy')
  const last = (await github.rest.issues.listForRepo({ owner, repo, labels: cfg.labels.deploy, state: 'closed', per_page: 20 })).data
    .map((i) => DEPLOYED_SHA.exec(i.body ?? '')?.[1]).find((s): s is string => Boolean(s))
  let commits: string[] = []
  if (last) {
    const c = await github.rest.repos.compareCommits({ owner, repo, base: last, head: sha }).catch(() => null)
    commits = c ? c.data.commits.slice().reverse().slice(0, 30).map((x) => `- ${x.sha.slice(0, 7)} ${x.commit.message.split('\n')[0]}`) : []
  }
  const where = cfg.deploy.environment
  const body = [
    `The build passed on ${cfg.branch} at ${short(sha)} ([build](${run.html_url})). Deploy it to ${where}?`,
    '',
    auto
      ? `**This deploys automatically.**${cfg.deploy.risk_check ? ' It is held for `/approve` only if the risk check says so;' : ''} \`/reject\` skips it. A newer commit that passes moves this request to itself.`
      : `**Comment \`/approve ${sha.slice(0, 12)}\` to deploy it, or \`/reject\` to skip it.** A newer commit that passes moves this request to itself.`,
    '',
    last ? `Since the last deploy (${last.slice(0, 7)}):` : 'No earlier deploy is recorded here.',
    ...commits,
    '',
    cfg.deploy.url ? `Running at: ${cfg.deploy.url}` : '',
    `<!-- trace-deploy-sha: ${sha} -->`,
  ].join('\n')
  const title = `Deploy to ${where}: ${short(sha)}`
  const open = (await github.rest.issues.listForRepo({ owner, repo, labels: cfg.labels.deploy, state: 'open', per_page: 10 })).data.filter((i) => !i.pull_request)
  let number: number
  const existing = open[0]
  if (existing) {
    number = existing.number
    const was = DEPLOY_SHA.exec(existing.body ?? '')?.[1]
    if (was === sha) return core.info(`#${existing.number} already asks for ${sha}`)
    const deployed = DEPLOYED_SHA.exec(existing.body ?? '')?.[0]
    await github.rest.issues.update({ owner, repo, issue_number: existing.number, title, body: deployed ? `${body}\n${deployed}` : body })
    // A newer commit replaces a held one: the hold was about the older change, so the check judges again.
    if (labelNames(existing.labels).includes(cfg.labels.deploy_held)) {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: existing.number, name: cfg.labels.deploy_held }).catch(() => undefined)
    }
    await github.rest.issues.createComment({ owner, repo, issue_number: existing.number,
      body: `Moved to ${short(sha)}, the newer commit that passed${was ? ` (was ${short(was)})` : ''}. ${auto ? `Deploying ${short(sha)} automatically.` : `\`/approve\` now deploys ${short(sha)}.`}` })
  } else {
    const people = auto ? [] : cfg.deploy.approvers.map((a) => a.replace(/^@/, '')).filter((a) => !/\[bot\]$/i.test(a))
    number = (await github.rest.issues.create({ owner, repo, title, body, labels: [cfg.labels.deploy], ...(people.length ? { assignees: people } : {}) })).data.number
  }
  if (!auto) return
  // Only the newest passing commit goes out: a slow build of an older commit finishing late deploys nothing.
  const newest = await newestPassing(github, owner, repo, cfg)
  if (newest && newest !== sha) return core.info(`${short(sha)} is not the newest passing commit (${short(newest)} is): not deploying it.`)
  core.setOutput('go', 'true')
  core.setOutput('sha', sha)
  core.setOutput('issue', String(number))
}

/** Why `login` may not approve, or null when they may. */
export async function refusal(github: GitHub, owner: string, repo: string, cfg: TraceConfig, login: string, type?: string, agentLogin?: string): Promise<string | null> {
  // The agents act through a person's token (TRACE_TOKEN), so GitHub reports them as that person. Their login is
  // recorded at install (TRACE_AGENT_LOGIN) and can never approve: the agents that write the code don't ship it.
  if (agentLogin && login.toLowerCase() === agentLogin.toLowerCase()) return `@${login} is the account the trace agents act as, and it can't approve a deploy`
  let t = type
  if (t === undefined) t = (await github.rest.users.getByUsername({ username: login }).catch(() => null))?.data.type
  if (t === 'Bot' || /\[bot\]$/i.test(login)) return `@${login} is a bot or app account, and only a person can approve a deploy`
  const approvers = cfg.deploy.approvers.map((a) => a.replace(/^@/, '').toLowerCase())
  const perm = (await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login }).catch(() => null))?.data
  const role = (perm as { role_name?: string } | undefined)?.role_name ?? perm?.permission ?? 'none'
  if (!['admin', 'maintain'].includes(role) || (approvers.length > 0 && !approvers.includes(login.toLowerCase()))) {
    return `@${login} cannot approve a deploy (needs admin or maintain${approvers.length ? ', and to be in deploy.approvers' : ''}; has ${role})`
  }
  return null
}

export async function approve({ github, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  core.setOutput('go', 'false')
  if (!cfg.deploy.enabled) return core.info('deploy.enabled is off.')
  const dispatch = context.eventName === 'workflow_dispatch'
  if (dispatch && env.APPROVAL) return approvedInTrace({ github, context, core, cfg, env })
  const ic = dispatch ? null : payload(context, null, IssueCommentPayload)
  if (!dispatch) {
    if (!ic || ic.issue.pull_request || ic.issue.state !== 'open' || !labelNames(ic.issue.labels).includes(cfg.labels.deploy) || !/^\/(approve|reject)\b/.test(ic.comment.body)) {
      return core.info('Not an /approve or /reject on an open deploy request.')
    }
  } else if (context.ref !== `refs/heads/${cfg.branch}`) {
    return core.info('A deploy by hand runs from the default branch only.')
  }
  const who = ic ? ic.comment.user.login : context.actor
  const issue = ic ? ic.issue.number : null
  const say = async (body: string): Promise<void> => {
    if (issue) await github.rest.issues.createComment({ owner, repo, issue_number: issue, body })
    else core.info(body)
  }
  const senderType = ic ? ic.comment.user.type : payload(context, null, ActorPayload)?.sender?.type
  const why = await refusal(github, owner, repo, cfg, who, senderType, env.AGENT_LOGIN)
  if (why) return say(`${why}. Nothing was deployed.`)
  // A re-run keeps the first attempt's approver: whoever re-runs must be able to approve too, so a bot with Actions
  // access cannot replay a person's approval.
  const again = env.TRIGGERING_ACTOR
  if (again && again.toLowerCase() !== who.toLowerCase()) {
    const whyAgain = await refusal(github, owner, repo, cfg, again, undefined, env.AGENT_LOGIN)
    if (whyAgain) return say(`This is a re-run started by @${again}: ${whyAgain.replace(/^@\S+ /, '')}. Nothing was deployed.`)
  }
  if (ic && ic.comment.body.startsWith('/reject') && issue) {
    await github.rest.issues.update({ owner, repo, issue_number: issue, state: 'closed', state_reason: 'not_planned' })
    return say(`Rejected by @${who}: not deployed.`)
  }
  const live = issue ? (await github.rest.issues.get({ owner, repo, issue_number: issue })).data : null
  if (live && live.state !== 'open') return say('This request is closed. Nothing was deployed.')
  const sha = dispatch ? context.sha : DEPLOY_SHA.exec(live?.body ?? '')?.[1]
  if (!sha) return say('This request names no commit. Nothing was deployed.')
  // An approval names the commit the person saw (`/approve <sha>`), so a request that moved to a newer commit after
  // they read it — or a re-run after it moved — can't ship something they didn't approve.
  if (ic) {
    const named = /^\/approve\s+([0-9a-f]{7,40})\b/i.exec(ic.comment.body.trim())?.[1]?.toLowerCase()
    if (!named) return say(`Approve with the commit you reviewed: \`/approve ${sha.slice(0, 12)}\`. Nothing was deployed.`)
    if (!sha.startsWith(named)) return say(`You approved ${named}, but this request now asks for ${short(sha)}. Review it and \`/approve ${sha.slice(0, 12)}\`. Nothing was deployed.`)
  }
  const onBranch = await github.rest.repos.compareCommits({ owner, repo, base: sha, head: cfg.branch })
    .then((c) => ['identical', 'ahead'].includes(c.data.status)).catch(() => false)
  if (!onBranch) return say(`${short(sha)} is not on ${cfg.branch}. Nothing was deployed.`)
  const passed = async (event: string): Promise<number> =>
    (await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: cfg.build.workflow, head_sha: sha, event, status: 'success', per_page: 1 })).data.total_count
  if (!(await passed('push')) && !(await passed('workflow_dispatch'))) return say(`The build has not passed on ${short(sha)}. Nothing was deployed.`)
  const newest = await newestPassing(github, owner, repo, cfg)
  if (newest && newest !== sha) return say(`${short(sha)} is not the newest passing commit (${short(newest)} is). Nothing was deployed.`)
  if (issue) await say(`Approved by @${who}: deploying ${short(sha)} ([progress](${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId})).`)
  core.setOutput('go', 'true')
  core.setOutput('sha', sha)
  core.setOutput('issue', issue ? String(issue) : '')
  core.setOutput('by', who)
}

/** Whether `sha` is on the default branch (the branch is it, or ahead of it). */
const onDefault = async (github: GitHub, owner: string, repo: string, cfg: TraceConfig, sha: string): Promise<boolean> =>
  github.rest.repos.compareCommits({ owner, repo, base: sha, head: cfg.branch }).then((c) => ['identical', 'ahead'].includes(c.data.status)).catch(() => false)

/** Whether the build passed on `sha`: a push's or a run by hand, never a pull request's. */
async function buildPassed(github: GitHub, owner: string, repo: string, cfg: TraceConfig, sha: string): Promise<boolean> {
  for (const event of ['push', 'workflow_dispatch']) {
    if ((await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: cfg.build.workflow, head_sha: sha, event, status: 'success', per_page: 1 })).data.total_count) return true
  }
  return false
}

/** The commits the workflow's own closed deploy requests record as deployed, newest first. */
async function deployedBefore(github: GitHub, owner: string, repo: string, cfg: TraceConfig): Promise<string[]> {
  const closed = (await github.rest.issues.listForRepo({ owner, repo, labels: cfg.labels.deploy, state: 'closed', sort: 'updated', direction: 'desc', per_page: 50 })).data
  return closed.filter((i) => (i.user?.login ?? '') === WORKFLOW_LOGIN).map((i) => DEPLOYED_SHA.exec(i.body ?? '')?.[1]).filter((s): s is string => Boolean(s))
}

/**
 * deploy-approve for a run trace started with an approval a person gave in the app (workflow_dispatch inputs
 * `approval` and `sha`: env APPROVAL and SHA; docs/stay-in-trace.md "2. Deploys"). The record is read from the central
 * store with this job's own AWS role (TRACE_HOME). The login that started the run is trace's token, so it is not judged
 * as a person; a re-run by someone else is (they must be able to approve), so a bot with Actions access cannot replay
 * the approval. Nothing deploys unless every check passes; each refusal is said in the log (the app reads the result
 * from the run). `store`: where approvals are read (tests); by default TRACE_HOME's.
 *
 * A deploy sets go/sha/issue, as /approve does. A rollback sets `roll-back-to` instead: it goes back to a commit that
 * ran before, which is older than what runs now by design, so the deploy job's guard (which refuses to deploy over a
 * newer commit) would stop it; the workflow's rollback job deploys it, with deploy.rollback or deploy.command and
 * deploy.smoke on that commit, exactly as it does after a failed deploy.
 */
export async function approvedInTrace({ github, context, core, cfg, env }: Pick<Deps, 'github' | 'context' | 'core' | 'cfg' | 'env'>, store?: DeployApprovals | null): Promise<void> {
  const { owner, repo } = context.repo
  const repository = `${owner}/${repo}`
  core.setOutput('go', 'false')
  const sha = (env.SHA ?? '').trim().toLowerCase()
  const name = (env.APPROVAL ?? '').trim()
  const refuse = (why: string): void => core.info(`${why}. Nothing was deployed.`)
  if (context.ref !== `refs/heads/${cfg.branch}`) return refuse('A deploy approved in trace runs from the default branch only')
  const again = env.TRIGGERING_ACTOR
  if (again && again.toLowerCase() !== context.actor.toLowerCase()) {
    const whyAgain = await refusal(github, owner, repo, cfg, again, undefined, env.AGENT_LOGIN)
    if (whyAgain) return refuse(`This is a re-run started by @${again}: ${whyAgain.replace(/^@\S+ /, '')}`)
  }
  const approvals = store === undefined ? DeployApprovals.fromHome(env.TRACE_HOME) : store
  if (!approvals) return refuse('This step cannot read approvals given in trace (TRACE_HOME is not set for it)')
  let rec: DeployApproval | null
  try {
    rec = await approvals.get(repository, name)
  } catch (e) {
    return refuse(`The approval could not be read (${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`)
  }
  const why = approvalRefusal(rec, { repo: repository, sha })
  if (why || !rec) return refuse(why ?? 'No approval was found for this deploy in trace')
  if (!(await onDefault(github, owner, repo, cfg, sha))) return refuse(`${short(sha)} is not on ${cfg.branch}`)
  if (!(await buildPassed(github, owner, repo, cfg, sha))) return refuse(`The build has not passed on ${short(sha)}`)
  if (rec.action === 'rollback') {
    if (!(await deployedBefore(github, owner, repo, cfg)).includes(sha)) return refuse(`${short(sha)} has not run in ${cfg.deploy.environment} before, so it is not a rollback`)
    core.info(`Rolling ${cfg.deploy.environment} back to ${short(sha)}, approved in trace by ${rec.by_name}.`)
    core.setOutput('by', rec.by_name)
    core.setOutput('via', 'trace')
    core.setOutput('roll-back-to', sha)
    return
  }
  const newest = await newestPassing(github, owner, repo, cfg)
  if (newest && newest !== sha) return refuse(`${short(sha)} is not the newest passing commit (${short(newest)} is)`)
  // the request it answers, while it is still the workflow's own open request for this commit: the result goes there
  let issue = ''
  if (rec.issue) {
    const i = (await github.rest.issues.get({ owner, repo, issue_number: rec.issue }).catch(() => null))?.data
    if (i && i.state === 'open' && (i.user?.login ?? '') === WORKFLOW_LOGIN && DEPLOY_SHA.exec(i.body ?? '')?.[1] === sha) issue = String(rec.issue)
  }
  const text = `Approved in trace by ${rec.by_name}: deploying ${short(sha)} ([progress](${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId})).`
  if (issue) await github.rest.issues.createComment({ owner, repo, issue_number: Number(issue), body: text })
  else core.info(text)
  core.setOutput('go', 'true')
  core.setOutput('sha', sha)
  core.setOutput('issue', issue)
  core.setOutput('by', rec.by_name)
  core.setOutput('via', 'trace')
}

export async function guard({ github, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  const sha = env.SHA ?? ''
  // Deploy records are only trusted from requests the workflows opened (github-actions), and only for commits on the
  // default branch: an edited issue body can't point the rollback at unreviewed code.
  const fromWorkflow = (i: { user?: { login?: string | null } | null }): boolean => (i.user?.login ?? '') === 'github-actions[bot]'
  const closed = (await github.rest.issues.listForRepo({ owner, repo, labels: cfg.labels.deploy, state: 'closed', sort: 'updated', direction: 'desc', per_page: 30 })).data
  const shas = closed.filter(fromWorkflow).map((i) => DEPLOYED_SHA.exec(i.body ?? '')?.[1]).filter((s): s is string => Boolean(s))
  const open = env.ISSUE ? (await github.rest.issues.get({ owner, repo, issue_number: Number(env.ISSUE) })).data : null
  const fromOpen = open && fromWorkflow(open) ? DEPLOYED_SHA.exec(open.body ?? '')?.[1] : undefined
  if (fromOpen) shas.unshift(fromOpen)
  const onBranch = async (s: string): Promise<boolean> =>
    github.rest.repos.compareCommits({ owner, repo, base: s, head: cfg.branch }).then((c) => ['identical', 'ahead'].includes(c.data.status)).catch(() => false)
  let deployed: string | null = null
  for (const s of shas) {
    if (!(await onBranch(s))) { core.warning(`Ignoring a deploy record for ${short(s)}: it is not on ${cfg.branch}.`); continue }
    if (!deployed) { deployed = s; continue }
    const c = await github.rest.repos.compareCommits({ owner, repo, base: deployed, head: s }).catch(() => null)
    if (c?.data.status === 'ahead') deployed = s
  }
  if (!deployed) return core.info('No earlier deploy is recorded: nothing to compare with.')
  core.setOutput('before', deployed)
  if (deployed === sha) return core.info(`${short(sha)} is already deployed; deploying it again is harmless.`)
  const c = await github.rest.repos.compareCommits({ owner, repo, base: sha, head: deployed }).catch(() => null)
  if (c?.data.status === 'ahead') {
    const text = `Not deployed: ${cfg.deploy.environment} already runs ${short(deployed)}, which is newer than ${short(sha)}. Deploying this now would roll it back, so nothing was touched.`
    if (env.ISSUE) await github.rest.issues.createComment({ owner, repo, issue_number: Number(env.ISSUE), body: text })
    core.setFailed(text)
  } else {
    core.info(`${short(sha)} is newer than the deployed ${short(deployed)}: going ahead.`)
  }
}

export async function hold({ github, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  const issue = Number(env.ISSUE)
  const run = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
  const text = [
    `**Held for a person:** the risk check would not deploy ${short(env.SHA)} on its own ([log](${run})):`,
    '',
    (env.REASONS ?? '').trim() || '- (no reason given)',
    '',
    'Nothing was deployed. Comment `/approve` to deploy it as it is, or `/reject` to skip it.',
  ].join('\n')
  await core.summary.addRaw(text).write()
  if (!issue) return
  await ensureLabel(github, owner, repo, cfg, 'deploy_held')
  await github.rest.issues.addLabels({ owner, repo, issue_number: issue, labels: [cfg.labels.deploy_held] })
  const people = cfg.deploy.approvers.map((a) => a.replace(/^@/, '')).filter((a) => !/\[bot\]$/i.test(a))
  if (people.length) await github.rest.issues.addAssignees({ owner, repo, issue_number: issue, assignees: people }).catch(() => undefined)
  await github.rest.issues.createComment({ owner, repo, issue_number: issue, body: text })
}

export async function report({ github, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  const { SHA = '', ISSUE, BY = '', STATUS, GUARD, HELD, ROLLBACK, VIA } = env
  if (GUARD === 'failure' || HELD === 'true') return // already said why on the request
  const run = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
  const ok = STATUS === 'success'
  const who = VIA === 'trace' ? `approved in trace by ${BY}` : `by ${BY}`
  const text = ok
    ? `Deployed ${short(SHA)} to ${cfg.deploy.environment}, ${who}.${cfg.deploy.url ? ` ${cfg.deploy.url}` : ''} ([log](${run}))`
    : `The deploy of ${short(SHA)} ${STATUS === 'cancelled' ? 'was cancelled' : 'failed'} ([log](${run})).${ROLLBACK ? ` Rolling back to ${short(ROLLBACK)}, which ran before.` : ''} Comment \`/approve\` to try again.`
  await core.summary.addRaw(text).write()
  if (!ISSUE) return
  const n = Number(ISSUE)
  await github.rest.issues.createComment({ owner, repo, issue_number: n, body: text })
  const i = (await github.rest.issues.get({ owner, repo, issue_number: n })).data
  if (!ok) {
    // the app shows the last failure from the request (src/api/actions-deploys.ts): one marker, the newest
    const failed = `\n<!-- trace-deploy-failed: ${SHA} ${new Date().toISOString()} -->`
    await github.rest.issues.update({ owner, repo, issue_number: n, body: (i.body ?? '').replace(FAILED_G, '') + failed }).catch(() => undefined)
    return
  }
  const body = (i.body ?? '').replace(DEPLOYED_SHA_G, '').replace(DEPLOYED_BY_G, '').replace(FAILED_G, '')
    + `\n<!-- trace-deployed-sha: ${SHA} -->\n<!-- trace-deployed-by: ${markerText(BY.replace(/^@/, ''))} -->`
  const asks = DEPLOY_SHA.exec(i.body ?? '')?.[1]
  if (asks && asks !== SHA) {
    await github.rest.issues.update({ owner, repo, issue_number: n, body })
    await github.rest.issues.createComment({ owner, repo, issue_number: n, body: `This request now asks for ${short(asks)}${cfg.deploy.auto ? ', which deploys next.' : ': `/approve` to deploy that too.'}` })
  } else {
    await github.rest.issues.update({ owner, repo, issue_number: n, body, state: 'closed', state_reason: 'completed' })
  }
}

export async function rollbackReport({ github, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  const run = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
  const ok = env.STATUS === 'success'
  const asked = env.VIA === 'trace'
  const text = asked
    ? ok
      ? `Rolled back: ${cfg.deploy.environment} runs ${short(env.SHA)} again, approved in trace by ${env.BY || 'a person'} ([log](${run})).`
      : `**The rollback to ${short(env.SHA)} failed** ([log](${run})). ${cfg.deploy.environment} may be half-deployed: ${cfg.worker.escalate_to || 'a person'} needs to look.`
    : ok
      ? `Rolled back: ${cfg.deploy.environment} runs ${short(env.SHA)} again ([log](${run})). The failed commit needs a fix before it deploys.`
      : `**The rollback to ${short(env.SHA)} failed too** ([log](${run})). ${cfg.deploy.environment} may be half-deployed: ${cfg.worker.escalate_to || 'a person'} needs to look.`
  await core.summary.addRaw(text).write()
  if (env.ISSUE) await github.rest.issues.createComment({ owner, repo, issue_number: Number(env.ISSUE), body: text })
  if (!asked) return
  // A rollback a person asked for in trace is recorded as a closed request of its own, opened by the workflow's
  // account like every deploy record: what runs now (guard, the app) and the next request's "since the last deploy" then
  // read it. A failed one is recorded too (closed as not planned, with no deployed commit), so the app can say so.
  await ensureLabel(github, owner, repo, cfg, 'deploy')
  const by = markerText(env.BY ?? '')
  const marker = ok
    ? `<!-- trace-deployed-sha: ${env.SHA} -->\n<!-- trace-deployed-by: ${by} -->\n<!-- trace-rollback -->`
    : `<!-- trace-rollback-failed: ${env.SHA} ${new Date().toISOString()} -->\n<!-- trace-deployed-by: ${by} -->`
  const made = (await github.rest.issues.create({ owner, repo, title: `${ok ? 'Rolled back' : 'Rollback failed'}: ${cfg.deploy.environment} to ${short(env.SHA)}`, body: `${text}\n\n${marker}`, labels: [cfg.labels.deploy] })).data
  await github.rest.issues.update({ owner, repo, issue_number: made.number, state: 'closed', state_reason: ok ? 'completed' : 'not_planned' })
}

/** The deploy commands, as step outputs (the workflow runs them from env, never interpolated into a script). */
export function commands({ core, cfg }: Deps): void {
  core.setOutput('setup', cfg.deploy.setup)
  core.setOutput('risk_check', cfg.deploy.risk_check)
  core.setOutput('command', cfg.deploy.command)
  core.setOutput('smoke', cfg.deploy.smoke)
  core.setOutput('rollback', cfg.deploy.rollback)
  core.setOutput('enabled', String(cfg.deploy.enabled))
}
