/**
 * The pull-request half of the loop, generalised from Potroller's agent-pr, automerge and update-branches workflows.
 *
 *   openPr       a pushed branch that is ahead of the default branch and has no open PR gets one. A branch built on
 *                another open PR's branch is stacked on it (stack.ts): its PR targets that branch, not the default one.
 *                It is titled by the first commit that is not a specialist's record (src/core/change-contents.ts),
 *                and a PR still titled as a record is titled again once a push brings work into it.
 *   automerge    every PR to the default branch merges itself once its required checks pass (unless held).
 *   updateQueue  first the stacks are kept in order (stack.ts restack); then trace's own PRs (held ones too) whose only conflict is .trace/project.db get the default branch
 *                merged in with the database merged (db-conflict.ts; up to DB_RESOLVE_PER_RUN a run); then the oldest
 *                auto-merge PR that is behind is brought up to date, one at a time, so each merge costs one rebuild
 *                rather than one per open PR. Mergeability is settled before it is judged (mergeable.ts).
 *
 * Actions that must start other workflows (opening a PR, merging, updating a branch) are taken with the repository's
 * TRACE_TOKEN: GitHub starts no workflow for an event made with GITHUB_TOKEN.
 */
import { changeTitle, recordTitle } from '../core/change-contents.js'
import { commentOnce, globMatch } from './util.js'
import { resolveDbConflict } from './db-conflict.js'
import { settle } from './mergeable.js'
import { StackUnclear, parentOf, restack, stackLine } from './stack.js'
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
  if (open[0]) return retitle(github, { owner, repo, pr: open[0], ownToken: Boolean(env.OWN_TOKEN) }, say)
  const toDefault = await github.rest.repos.compareCommits({ owner, repo, base: cfg.branch, head: branch }).catch(() => null)
  if (!toDefault || toDefault.data.ahead_by === 0) return say(`\`${branch}\` has nothing that ${cfg.branch} lacks: no PR opened.`)
  // built on another open PR's branch: stacked on it, so the PR shows only this branch's own commits. Any doubt opens
  // nothing: a PR to the default branch carrying another change's commits would merge them unaccepted
  let parent: Awaited<ReturnType<typeof parentOf>> = null
  if (cfg.prs.stack) {
    const listed = toDefault.data.commits
    if (listed.length < toDefault.data.ahead_by) {
      core.warning(`${branch} is ${toDefault.data.ahead_by} commits ahead of ${cfg.branch}, more than GitHub lists: no PR opened.`)
      return say(`\`${branch}\` has more commits than trace can check for stacking (${toDefault.data.ahead_by}): no PR opened. Open it by hand.`)
    }
    try {
      parent = await parentOf(github, owner, repo, branch, cfg.branch, new Set(listed.map((c) => c.sha)))
    } catch (e) {
      const why = e instanceof StackUnclear ? e.message : `trace could not check whether \`${branch}\` builds on another open pull request (${errorMessage(e)}), so no PR was opened. Push again, or re-run this job, to try again.`
      core.warning(why)
      return say(why)
    }
  }
  const base = parent?.ref ?? cfg.branch
  const cmp = parent ? await github.rest.repos.compareCommits({ owner, repo, base, head: branch }) : toDefault
  const compare = `${context.serverUrl}/${owner}/${repo}/compare/${base}...${encodeURIComponent(branch)}?expand=1`
  if (!env.OWN_TOKEN) {
    core.warning('No TRACE_TOKEN secret: a PR opened with GITHUB_TOKEN would start no build, so none was opened.')
    return say(`No TRACE_TOKEN secret, so no PR was opened. Open it here: ${compare}`)
  }
  const commits = cmp.data.commits
  const subject = (m: string): string => m.split('\n')[0] ?? ''
  // named by the work in it, not by a specialist's record that came first (test-esp32 log #144)
  const title = changeTitle(commits.map((c) => c.commit.message)) || branch
  const rest = commits.length === 1 ? (commits[0]?.commit.message ?? '').split('\n').slice(1).join('\n').trim() : ''
  const body = [
    `Opened automatically for \`${branch}\` when it was pushed.${cfg.prs.auto_merge ? ` It merges itself once \`${cfg.build.required_check}\` passes${parent ? ` and it targets \`${cfg.branch}\`` : ''}; add the \`${cfg.labels.hold}\` label to hold it.` : ''}`,
    ...(parent ? ['', stackLine(parent, cfg.branch)] : []),
    '',
    '### Commits',
    ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${subject(c.commit.message)}`),
    ...(rest ? ['', rest] : []),
  ].join('\n')
  const pr = await github.rest.pulls.create({ owner, repo, head: branch, base, title: title.slice(0, 250), body })
  return say(`Opened #${pr.data.number}${parent ? `, stacked on #${parent.number}` : ''}: ${pr.data.html_url}`)
}

/**
 * A push to a branch whose pull request is open: its title, when it is still a specialist's record title (as opened:
 * a person who renamed it is left alone), is named again by the work its commits now hold. In the test run a "docs
 * specialist's record" change came to carry a whole case design, a schematic field and board text under that title
 * (test-esp32 log #144).
 */
async function retitle(github: GitHub, o: { owner: string; repo: string; pr: { number: number; title: string; base: { ref: string } }; ownToken: boolean }, say: (s: string) => Promise<void>): Promise<void> {
  const { owner, repo, pr } = o
  const already = `#${pr.number} is already open for its branch.`
  if (!recordTitle(pr.title)) return say(already)
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pr.number, per_page: 100 }).catch(() => null)
  const title = commits ? changeTitle(commits.map((c) => c.commit.message)) : ''
  if (!title || recordTitle(title) || title === pr.title) return say(already)
  if (!o.ownToken) return say(`${already} It holds more than a record now; with a TRACE_TOKEN secret it would be retitled "${title}".`)
  await github.rest.pulls.update({ owner, repo, pull_number: pr.number, title: title.slice(0, 250) })
  return say(`${already} It holds more than a specialist's record now: retitled "${title}".`)
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
  // a PR others are stacked on merges with a merge commit, whatever the setting: squashed or rebased, the PRs above
  // would hold commits the default branch no longer has, and conflict with them (docs/stacked-changes.md)
  const above = cfg.prs.stack && cfg.prs.merge_method !== 'merge'
    ? (await github.rest.pulls.list({ owner, repo, state: 'open', base: pr.head.ref ?? '', per_page: 1 })).data.length > 0
    : false
  const method = above ? 'merge' : cfg.prs.merge_method
  if (above) await say(`#${pr.number} has changes stacked on it: it merges with a merge commit, not by ${cfg.prs.merge_method}.`)
  try {
    await attempt((gh) => gh.graphql(ENABLE, { id: pr.node_id, method: method.toUpperCase() }))
    return say(`Auto-merge is on for #${pr.number}: it merges when the required checks pass.`)
  } catch (e) {
    // GitHub refuses auto-merge on a PR that can merge right now ("clean status"): merge it directly.
    if (!/clean status|unstable status/i.test(errorMessage(e))) throw e
    await attempt((gh) => gh.rest.pulls.merge({ owner, repo, pull_number: pr.number, merge_method: method, sha: pr.head.sha }))
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
  const all = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 })
  // the stacks first (one push budget with the database merges below: each push starts a build). A PR moved onto the
  // default branch here is seen by the next run's queue, not this one's (the list was read before it moved)
  let pushed = new Set<number>()
  if (cfg.prs.stack) {
    const r = await restack({ github, owner, repo, defaultBranch: cfg.branch, hold: cfg.labels.hold, canPush: Boolean(env.OWN_TOKEN) }, all, DB_RESOLVE_PER_RUN)
    for (const l of r.lines) say(l)
    pushed = r.pushed
  }
  const open = all.filter((p) => (p.base?.ref ?? cfg.branch) === cfg.branch)
  // a stacked PR (based on another PR's branch) can be in conflict with its base too: resolved the same way
  const ownStacked = all.filter((p) => (p.base?.ref ?? cfg.branch) !== cfg.branch)
  // trace's own PRs (held ones too) whose only conflict is the project database: every agent job adds its runs to
  // that one file, so each merge leaves the rest in conflict, and GitHub's merge button cannot run its merge driver
  if (env.OWN_TOKEN && cfg.worker.own_branch_prefix) {
    let resolved = pushed.size
    // settled first: right after the push that starts this run GitHub reads every one as "unknown" (mergeable.ts)
    const own = [...open, ...ownStacked].filter((x) => !pushed.has(x.number) && !x.draft && x.head?.repo?.full_name === `${owner}/${repo}` && Boolean(x.head?.ref?.startsWith(cfg.worker.own_branch_prefix)))
    const settled = await settle(github, owner, repo, own.map((p) => p.number))
    for (const p of own) {
      if (resolved >= DB_RESOLVE_PER_RUN) break
      const pr = settled.get(p.number)
      if (!pr || pr.mergeable_state !== 'dirty') continue
      const base = pr.base?.ref ?? cfg.branch
      const r = await resolve({ remote: `${context.serverUrl}/${owner}/${repo}.git`, head: pr.head.ref, base, token: env.OWN_TOKEN })
      if (r.ok) { resolved++; say(`#${pr.number}: its only conflict was ${PROJECT_DB_FILE}; merged ${base} into ${pr.head.ref} with the project database merged (${short(r.commit)}).`) }
      else say(`#${pr.number} has a conflict with ${base}: ${r.why}.`)
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
