/**
 * The pull-request half of the loop, generalised from Potroller's agent-pr, automerge and update-branches workflows.
 *
 *   openPr       a pushed branch that is ahead of the default branch and has no open PR gets one.
 *   automerge    every PR to the default branch merges itself once its required checks pass (unless held).
 *   updateQueue  first, trace's own PRs (held ones too) whose only conflict is .trace/project.db get the default branch
 *                merged in with the database merged (db-conflict.ts; up to DB_RESOLVE_PER_RUN a run); then the oldest
 *                auto-merge PR that is behind is brought up to date, one at a time, so each merge costs one rebuild
 *                rather than one per open PR.
 *
 * Actions that must start other workflows (opening a PR, merging, updating a branch) are taken with the repository's
 * TRACE_TOKEN: GitHub starts no workflow for an event made with GITHUB_TOKEN.
 */
import { commentOnce, globMatch } from './util.js'
import { resolveDbConflict } from './db-conflict.js'
import { type Deps, type GitHub, PullRequestPayload, errorMessage, errorStatus, labelNames, payload, short } from './types.js'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function openPr({ github, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  const say = async (s: string): Promise<void> => { await core.summary.addRaw(`${s}\n`).write() }
  if (!cfg.prs.auto_open) return say('prs.auto_open is off.')
  const branch = context.ref.replace(/^refs\/heads\//, '')
  if (!branch || branch === cfg.branch) return say('Push to the default branch: nothing to open.')
  if (cfg.prs.skip_branches.some((g) => globMatch(g, branch))) return say(`\`${branch}\` matches prs.skip_branches: no PR opened.`)
  const wip = cfg.prs.wip_marker
  if (wip && new RegExp(`(^|[-_/])${escapeRe(wip)}([-_/]|$)`, 'i').test(branch)) return say(`\`${branch}\` is marked work in progress: no PR opened.`)

  const open = (await github.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}`, per_page: 1 })).data
  if (open[0]) return say(`#${open[0].number} is already open for \`${branch}\`.`)
  const cmp = await github.rest.repos.compareCommits({ owner, repo, base: cfg.branch, head: branch }).catch(() => null)
  if (!cmp || cmp.data.ahead_by === 0) return say(`\`${branch}\` has nothing that ${cfg.branch} lacks: no PR opened.`)
  const compare = `${context.serverUrl}/${owner}/${repo}/compare/${cfg.branch}...${encodeURIComponent(branch)}?expand=1`
  if (!env.OWN_TOKEN) {
    core.warning('No TRACE_TOKEN secret: a PR opened with GITHUB_TOKEN would start no build, so none was opened.')
    return say(`No TRACE_TOKEN secret, so no PR was opened. Open it here: ${compare}`)
  }
  const commits = cmp.data.commits
  const subject = (m: string): string => m.split('\n')[0] ?? ''
  const first = subject(commits[0]?.commit.message ?? branch)
  const title = commits.length === 1 ? first : `${first.replace(/\.$/, '')} (+${commits.length - 1} more)`
  const rest = commits.length === 1 ? (commits[0]?.commit.message ?? '').split('\n').slice(1).join('\n').trim() : ''
  const body = [
    `Opened automatically for \`${branch}\` when it was pushed.${cfg.prs.auto_merge ? ` It merges itself once \`${cfg.build.required_check}\` passes; add the \`${cfg.labels.hold}\` label to hold it.` : ''}`,
    '',
    '### Commits',
    ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${subject(c.commit.message)}`),
    ...(rest ? ['', rest] : []),
  ].join('\n')
  const pr = await github.rest.pulls.create({ owner, repo, head: branch, base: cfg.branch, title: title.slice(0, 250), body })
  return say(`Opened #${pr.data.number}: ${pr.data.html_url}`)
}

const ENABLE = 'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { clientMutationId } }'
const DISABLE = 'mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }'

export async function automerge({ github, jobApi, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  const say = async (s: string): Promise<void> => { await core.summary.addRaw(`${s}\n`).write() }
  const pr = payload(context, 'pull_request', PullRequestPayload)
  if (!pr || pr.base.ref !== cfg.branch) return say('Not a pull request to the default branch.')
  if (!cfg.prs.auto_merge) return say('prs.auto_merge is off.')
  if (pr.draft) return say(`#${pr.number} is a draft: left alone.`)
  // `edited` only matters when the base changed (retargeted to the default branch).
  if (context.payload.action === 'edited' && !(context.payload.changes as { base?: unknown } | undefined)?.base) return say('Edited without a base change.')

  // TRACE_TOKEN, so the merge starts the build on the default branch; if GitHub rejects it (401: expired, revoked,
  // mistyped) say so and carry on with GITHUB_TOKEN, so a bad secret degrades instead of failing every PR.
  const attempt = async <T>(fn: (gh: GitHub) => Promise<T>): Promise<T> => {
    if (env.OWN_TOKEN) {
      try {
        return await fn(github)
      } catch (e) {
        if (errorStatus(e) !== 401) throw e
        const msg = 'TRACE_TOKEN is rejected by GitHub (401). Falling back to GITHUB_TOKEN, so the merge will not start the build on the default branch. Replace the secret.'
        core.warning(msg)
        await say(msg)
      }
    } else {
      core.warning('No TRACE_TOKEN secret: the merge is made with GITHUB_TOKEN, which starts no build on the default branch.')
    }
    return fn(jobApi)
  }

  // A PR that changes what steers the harness (workflows, settings, rules, ownership) is held for a person.
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 })
  const touched = files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])])
    .filter((f) => cfg.prs.protected_paths.some((g) => globMatch(g, f)))
  if (touched.length) {
    await attempt((gh) => gh.graphql(DISABLE, { id: pr.node_id })).catch(() => undefined)
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [cfg.labels.hold] }).catch(() => undefined)
    await commentOnce(github, owner, repo, pr.number, '<!-- trace: protected-paths -->',
      `This PR changes files that steer trace itself (${touched.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${touched.length > 8 ? ', …' : ''}), so it does not merge itself: a person reviews and merges it.`)
    return say(`#${pr.number} touches protected paths: held for a person.`)
  }

  if (labelNames(pr.labels).includes(cfg.labels.hold)) {
    await attempt((gh) => gh.graphql(DISABLE, { id: pr.node_id })).catch(() => undefined)
    return say(`#${pr.number} has the \`${cfg.labels.hold}\` label: auto-merge is off.`)
  }
  try {
    await attempt((gh) => gh.graphql(ENABLE, { id: pr.node_id, method: cfg.prs.merge_method.toUpperCase() }))
    return say(`Auto-merge is on for #${pr.number}: it merges when the required checks pass.`)
  } catch (e) {
    // GitHub refuses auto-merge on a PR that can merge right now ("clean status"): merge it directly.
    if (!/clean status|unstable status/i.test(errorMessage(e))) throw e
    await attempt((gh) => gh.rest.pulls.merge({ owner, repo, pull_number: pr.number, merge_method: cfg.prs.merge_method, sha: pr.head.sha }))
    return say(`#${pr.number} could merge at once: merged.`)
  }
}

/** At most this many conflicted PRs are merged up per run: each push starts a build. */
export const DB_RESOLVE_PER_RUN = 3
const PROJECT_DB_FILE = '.trace/project.db'

export async function updateQueue({ github, jobApi, context, core, cfg, env }: Deps, resolve = resolveDbConflict): Promise<void> {
  const { owner, repo } = context.repo
  const lines: string[] = []
  const say = (s: string): void => { lines.push(s); core.info(s) }
  const flush = async (): Promise<void> => { await core.summary.addRaw(lines.map((l) => `- ${l}`).join('\n') + '\n').write() }
  if (!cfg.prs.update_queue) { say('prs.update_queue is off.'); return flush() }
  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: cfg.branch, per_page: 100 })
  // trace's own PRs (held ones too) whose only conflict is the project database: every agent job adds its runs to
  // that one file, so each merge leaves the rest in conflict, and GitHub's merge button cannot run its merge driver
  if (env.OWN_TOKEN && cfg.worker.own_branch_prefix) {
    let resolved = 0
    for (const p of open.filter((x) => !x.draft && x.head?.repo?.full_name === `${owner}/${repo}` && Boolean(x.head?.ref?.startsWith(cfg.worker.own_branch_prefix)))) {
      if (resolved >= DB_RESOLVE_PER_RUN) break
      const pr = (await github.rest.pulls.get({ owner, repo, pull_number: p.number })).data
      if (pr.mergeable_state !== 'dirty') continue
      const r = await resolve({ remote: `${context.serverUrl}/${owner}/${repo}.git`, head: pr.head.ref, base: cfg.branch, token: env.OWN_TOKEN })
      if (r.ok) { resolved++; say(`#${pr.number}: its only conflict was ${PROJECT_DB_FILE}; merged ${cfg.branch} into ${pr.head.ref} with the project database merged (${short(r.commit)}).`) }
      else say(`#${pr.number} has a conflict with ${cfg.branch}: ${r.why}.`)
    }
  }
  const prs = open
    .filter((p) => p.auto_merge && !p.draft && !labelNames(p.labels).includes(cfg.labels.hold))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  // Check runs are read with the job's token: a fine-grained personal token can't read the Checks API.
  const testsOf = async (sha: string): Promise<string> => {
    const runs = (await jobApi.rest.checks.listForRef({ owner, repo, ref: sha, check_name: cfg.build.required_check, per_page: 5 })).data.check_runs
    const r = runs[0]
    return r ? (r.status === 'completed' ? r.conclusion ?? 'none' : 'pending') : 'none'
  }
  let acted = false
  for (const p of prs) {
    const pr = (await github.rest.pulls.get({ owner, repo, pull_number: p.number })).data
    const state = pr.mergeable_state // clean | behind | blocked | dirty | unstable | unknown
    const tests = await testsOf(pr.head.sha)
    if (state === 'dirty') { say(`#${pr.number} has a conflict with ${cfg.branch}: left for the worker.`); continue }
    if (state !== 'behind') {
      // A PR already building after an update is the queue's head: wait for it rather than start a second build.
      if (tests === 'pending') { say(`#${pr.number} is up to date and building: waiting for it.`); acted = true; break }
      say(`#${pr.number} is ${state} (${cfg.build.required_check}: ${tests}).`)
      continue
    }
    if (['failure', 'cancelled', 'timed_out'].includes(tests)) { say(`#${pr.number} is behind but its last build failed: skipped.`); continue }
    if (!env.OWN_TOKEN) { say(`#${pr.number} would be updated from ${cfg.branch}, but there is no TRACE_TOKEN secret.`); acted = true; break }
    await github.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha })
    say(`Updated #${pr.number} (${pr.head.ref}, was ${short(pr.head.sha)}) from ${cfg.branch}: its build starts now.`)
    acted = true
    break
  }
  if (!acted && !prs.length) say('No open auto-merge PRs.')
  return flush()
}
