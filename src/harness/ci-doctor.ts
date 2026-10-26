/**
 * Looks at every finished build and does the first thing a person would (from Potroller's ci-doctor).
 *
 *   - Flaky failure (runner lost, network, 5xx, rate limit, a setup step) on the first attempt: re-run the failed jobs
 *     once. Never a cancelled run, never a second time.
 *   - Every failure matches one of ci_doctor.dispatch_on: start that workflow instead (a known, mechanical repair).
 *   - Real failure (or a flake that failed again): on a PR, label it ci_red and comment once with the failing jobs; on
 *     the default branch, open or update one agent_fix issue. The worker picks both up.
 *   - A pass: take ci_red off and close the default-branch issue.
 */
import type { TraceConfig } from '../core/config.js'
import { commentOnce, ensureLabel } from './util.js'
import { type Deps, WorkflowRunPayload, errorStatus, payload, short } from './types.js'

export const FLAKY: readonly RegExp[] = [
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|TLS handshake timeout/i,
  /\b50[234]\b.*(Bad Gateway|Service Unavailable|Gateway Time-?out)|Gateway Time-?out|status code 50[234]/i,
  /rate limit|toomanyrequests|429 Too Many Requests|secondary rate limit/i,
  /The runner has received a shutdown signal|lost communication with the server|The operation was canceled|runner.*(lost|stopped)/i,
  /Could not resolve host|Temporary failure in name resolution|Connection reset by peer/i,
  /npm (ERR!|error) (network|code E(CONNRESET|TIMEDOUT|AI_AGAIN))|pip.*ReadTimeoutError/i,
]
const SETUP_STEPS = /^(Set up job|Set up runner|Run actions\/checkout|Run actions\/setup-|Checkout|Cache|Install)/i
const MAIN_MARKER = '<!-- trace: ci-doctor default-branch -->'

export interface JobLike {
  name: string
  conclusion: string | null
  html_url: string | null
  steps?: ReadonlyArray<{ name: string; conclusion: string | null }> | undefined
}

export type Verdict =
  | { kind: 'flaky'; detail: string }
  | { kind: 'dispatch'; detail: string; workflow: string }
  | { kind: 'real'; detail: string }

/** Why one failed job failed. Pure, for tests. */
export function judge(job: JobLike, log: string, cfg: TraceConfig): Verdict {
  const steps = job.steps ?? []
  const step = steps.find((s) => s.conclusion === 'failure')
  if (step && SETUP_STEPS.test(step.name)) return { kind: 'flaky', detail: `failed in setup step "${step.name}"` }
  if (!steps.length) return { kind: 'flaky', detail: 'the job never started a step: runner lost' }
  for (const d of cfg.ci_doctor.dispatch_on) {
    if (new RegExp(d.match).test(log)) return { kind: 'dispatch', detail: d.note ?? `matches ${d.match}`, workflow: d.workflow }
  }
  const patterns = [...FLAKY, ...cfg.ci_doctor.flaky_patterns.map((p) => new RegExp(p, 'i'))]
  for (const re of patterns) {
    const m = re.exec(log)
    if (m) return { kind: 'flaky', detail: m[0].slice(0, 80) }
  }
  return { kind: 'real', detail: `step "${step?.name ?? '?'}"` }
}

export async function ciDoctor({ github, jobApi, context, core, cfg, env }: Deps): Promise<void> {
  const { owner, repo } = context.repo
  const run = payload(context, 'workflow_run', WorkflowRunPayload)
  if (!cfg.ci_doctor.enabled) return core.info('ci_doctor.enabled is off.')
  if (!run || !(run.conclusion === 'failure' || run.conclusion === 'success')) return core.info('Not a failed or passed run: nothing to do.')
  const branch = run.head_branch ?? ''
  const onMain = branch === cfg.branch && ['push', 'schedule', 'workflow_dispatch'].includes(run.event)
  const prs = run.pull_requests.filter((p) => p.base.repo.name === repo).map((p) => p.number)
  if (!prs.length && !onMain && run.event === 'pull_request') {
    // pull_requests is empty for a fork's PR or before GitHub links it: look it up.
    const open = (await github.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}`, per_page: 1 })).data
    if (open[0]) prs.push(open[0].number)
  }
  const mainIssue = async (): Promise<{ number: number } | undefined> =>
    (await github.rest.issues.listForRepo({ owner, repo, labels: cfg.labels.agent_fix, state: 'open', per_page: 50 })).data
      .find((i) => !i.pull_request && (i.body ?? '').includes(MAIN_MARKER))

  if (run.conclusion === 'success') {
    for (const n of prs) await github.rest.issues.removeLabel({ owner, repo, issue_number: n, name: cfg.labels.ci_red }).catch(() => undefined)
    if (onMain) {
      const i = await mainIssue()
      if (i) {
        await github.rest.issues.createComment({ owner, repo, issue_number: i.number, body: `The build passes on ${cfg.branch} again at ${short(run.head_sha)} ([run](${run.html_url})). Closing.` })
        await github.rest.issues.update({ owner, repo, issue_number: i.number, state: 'closed', state_reason: 'completed' })
      }
    }
    return
  }

  const jobs = (await github.rest.actions.listJobsForWorkflowRunAttempt({ owner, repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100 })).data.jobs
  const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out')
  if (!failed.length) return core.info('No failed job (cancelled or skipped only): nothing to do.')
  // The summary gate (the required check) fails whenever another job did: judge the jobs, not the gate.
  const judged = failed.filter((j) => j.name !== cfg.build.required_check || failed.length === 1)
  const why = new Map<string, Verdict>()
  for (const j of judged) {
    let log = ''
    if ((j.steps ?? []).length) {
      try {
        const r = await github.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { owner, repo, job_id: j.id })
        log = String(r.data).slice(-60_000)
      } catch {
        log = ''
      }
    }
    why.set(j.name, judge(j, log, cfg))
  }
  core.info(JSON.stringify(Object.fromEntries(why), null, 2))
  const verdicts = [...why.values()]

  const targets = [...new Set(verdicts.map((v) => (v.kind === 'dispatch' ? v.workflow : '')))]
  const first = verdicts[0]
  if (first && verdicts.every((v) => v.kind === 'dispatch') && targets.length === 1 && targets[0]) {
    const workflow = targets[0]
    await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: workflow, ref: cfg.branch })
      .catch((e: unknown) => core.warning(`Could not start ${workflow} (${errorStatus(e)})`))
    for (const n of prs) {
      await commentOnce(github, owner, repo, n, `<!-- trace: ci-doctor dispatch ${run.head_sha} -->`,
        `The build failed only on a known, mechanical cause (${first.detail}). Started \`${workflow}\` to repair it; this PR is brought up to date and rebuilt once that lands.`)
    }
    await core.summary.addRaw(`Every failure on ${short(run.head_sha)} matches ci_doctor.dispatch_on: started ${workflow}.`).write()
    return
  }

  const allFlaky = verdicts.every((v) => v.kind === 'flaky')
  if (allFlaky && run.run_attempt === 1 && cfg.ci_doctor.rerun_flaky) {
    try {
      await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: run.id })
    } catch (e) {
      if (!env.OWN_TOKEN) throw e
      core.info(`Re-run with TRACE_TOKEN refused (${errorStatus(e)}); using GITHUB_TOKEN`)
      await jobApi.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: run.id })
    }
    await core.summary.addRaw(`Re-ran the failed jobs of [${run.name ?? 'the build'} #${run.run_number}](${run.html_url}) once: ${[...why].map(([k, v]) => `${k}: ${v.detail}`).join('; ')}`).write()
    return
  }

  const lines = judged.map((j) => { const v = why.get(j.name); return `- [${j.name}](${j.html_url ?? run.html_url}): ${v?.kind} (${v?.detail})` })
  const body = [
    `The build failed on ${short(run.head_sha)} ([run](${run.html_url}), attempt ${run.run_attempt}).`,
    '',
    ...lines,
    '',
    ...(allFlaky ? ['It looked flaky but failed again after a re-run, so it is treated as real.', ''] : []),
    `The worker picks this up (fix, validate, push).${cfg.worker.escalate_to ? ` It asks ${cfg.worker.escalate_to} only after ${cfg.worker.max_attempts} failed attempts or when it is blocked.` : ''}`,
  ].join('\n')

  if (onMain) {
    await ensureLabel(github, owner, repo, cfg, 'agent_fix')
    const i = await mainIssue()
    if (i) await github.rest.issues.createComment({ owner, repo, issue_number: i.number, body })
    else await github.rest.issues.create({ owner, repo, title: `Build failing on ${cfg.branch} (${run.event})`, labels: [cfg.labels.agent_fix], body: `${body}\n${MAIN_MARKER}` })
    return
  }
  await ensureLabel(github, owner, repo, cfg, 'ci_red')
  for (const n of prs) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: n, labels: [cfg.labels.ci_red] })
    await commentOnce(github, owner, repo, n, `<!-- trace: ci-doctor ${run.head_sha} -->`, body)
  }
}
