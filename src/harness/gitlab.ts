/**
 * The harness in a GitLab pipeline job (docs/gitlab-projects.md, build step 5): the same tasks as the GitHub action
 * (src/harness/index.ts run), with GitLab's job environment as the event and trace's GitLab answering the client
 * (src/harness/gitlab-octokit.ts). Bundled to harness/dist/gitlab.cjs; the generated `.gitlab-ci.yml`
 * (templates/gitlab/trace.gitlab-ci.yml) fetches it at trace's ref and runs `node gitlab.cjs`.
 *
 * What a job gives it:
 *   TRACE_TASK            the task (open-pr, automerge, update-queue, …)
 *   TRACE_GITLAB_TOKEN    the agents' token (the project's own secret, read with the job's AWS role); TRACE_TOKEN, the
 *                         person's merging token, is never in a GitLab job: only trace's API merges
 *   TRACE_REPOSITORY      trace's name for the project (owner/name), which the harness keys everything by
 *   CI_*                  GitLab's own: the server, the project path, the pipeline, the commit, the merge request
 */
import { z } from 'zod'
import type { GitHub, Context, Core } from './types.js'
import { gitlabOctokit } from './gitlab-octokit.js'
import { run } from './index.js'

/** GitHub's event name for what started the pipeline (CI_PIPELINE_SOURCE). */
export function eventName(source: string | undefined): string {
  switch (source) {
    case 'merge_request_event': return 'pull_request'
    case 'schedule': return 'schedule'
    case 'web': case 'api': case 'trigger': case 'pipeline': return 'workflow_dispatch'
    case 'chat': return 'workflow_dispatch'
    default: return 'push'
  }
}

/** The run as the harness reads it, from a GitLab job's environment. */
export function gitlabContext(env: NodeJS.ProcessEnv): Context {
  const repository = env.TRACE_REPOSITORY ?? env.CI_PROJECT_PATH ?? ''
  const [owner = '', repo = ''] = repository.split('/')
  const event = eventName(env.CI_PIPELINE_SOURCE)
  const iid = Number(env.CI_MERGE_REQUEST_IID ?? NaN)
  const payload: Record<string, unknown> = {}
  if (event === 'pull_request' && Number.isFinite(iid)) {
    payload.action = 'synchronize'
    payload.pull_request = {
      number: iid, title: env.CI_MERGE_REQUEST_TITLE ?? '', draft: env.CI_MERGE_REQUEST_DRAFT === 'true',
      head: { ref: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? '', sha: env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA || '', repo: { full_name: repository } },
      base: { ref: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? '' },
      labels: (env.CI_MERGE_REQUEST_LABELS ?? '').split(',').filter(Boolean).map((name) => ({ name })),
      user: { login: env.GITLAB_USER_LOGIN ?? '' },
    }
  }
  if (event === 'workflow_dispatch') {
    payload.inputs = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('TRACE_INPUT_')).map(([k, v]) => [k.slice('TRACE_INPUT_'.length).toLowerCase().replace(/_/g, '-'), v ?? '']))
  }
  payload.sender = { login: env.GITLAB_USER_LOGIN ?? '', type: /^project_\d+_bot/.test(env.GITLAB_USER_LOGIN ?? '') ? 'Bot' : 'User' }
  const branch = env.CI_COMMIT_BRANCH ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? env.CI_COMMIT_REF_NAME ?? ''
  return {
    repo: { owner, repo }, serverUrl: env.CI_SERVER_URL ?? '', runId: Number(env.CI_PIPELINE_ID ?? 0), eventName: event,
    ref: env.CI_COMMIT_TAG ? `refs/tags/${env.CI_COMMIT_TAG}` : `refs/heads/${branch}`, sha: env.CI_COMMIT_SHA ?? '',
    actor: env.GITLAB_USER_LOGIN ?? '', payload,
  }
}

/** Plain lines, as GitLab's job log shows them. */
export const consoleCore: Core = {
  info: (m) => console.log(m),
  warning: (m) => console.log(`WARNING: ${m}`),
  setFailed: (m) => { console.error(`ERROR: ${m}`); process.exitCode = 1 },
  setOutput: (name, value) => console.log(`${name}=${value}`),
  summary: { addRaw: (t) => ({ write: async () => { console.log(t) } }) },
}

/**
 * The pipeline this job is in, as GitHub's workflow_run (for ci-doctor, which on GitHub runs after the build and on
 * GitLab runs as the build's last stage): failed when any other job of it failed (allowed failures aside).
 */
export async function pipelineAsRun(client: ReturnType<typeof gitlabOctokit>, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const id = Number(env.CI_PIPELINE_ID ?? 0)
  const self = Number(env.CI_JOB_ID ?? 0)
  const { data } = await client.rest.actions.listJobsForWorkflowRunAttempt({ run_id: id }) as { data: { jobs: { id: number; conclusion: string | null }[] } }
  const others = data.jobs.filter((j) => j.id !== self)
  const failed = others.some((j) => j.conclusion === 'failure')
  const iid = Number(env.CI_MERGE_REQUEST_IID ?? NaN)
  return {
    id, name: env.CI_PIPELINE_NAME || 'trace-ci', run_number: Number(env.CI_PIPELINE_IID ?? id), run_attempt: 1,
    head_branch: env.CI_COMMIT_BRANCH ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? null, head_sha: env.CI_COMMIT_SHA ?? '',
    event: eventName(env.CI_PIPELINE_SOURCE), conclusion: failed ? 'failure' : 'success', html_url: env.CI_PIPELINE_URL ?? '',
    pull_requests: Number.isFinite(iid) ? [{ number: iid, base: { repo: { name: (env.TRACE_REPOSITORY ?? '').split('/')[1] ?? '' } } }] : [],
  }
}

/** A core that keeps what a task outputs (worker-pick's items and runner), and says it in the log as consoleCore does. */
export function capturingCore(): Core & { outputs: Record<string, string> } {
  const outputs: Record<string, string> = {}
  return { ...consoleCore, outputs, setOutput: (name, value) => { outputs[name] = value; consoleCore.setOutput(name, value) } }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const context = gitlabContext(env)
  const token = env.TRACE_GITLAB_TOKEN ?? ''
  if (!token) throw new Error('TRACE_GITLAB_TOKEN is empty: the job could not read its project\'s agents\' token')
  const pr = (context.payload.pull_request as { number?: number } | undefined)?.number
  const make = (t: string) => gitlabOctokit({
    url: env.CI_SERVER_URL ?? '', token: t, project: env.CI_PROJECT_PATH ?? '', repository: env.TRACE_REPOSITORY ?? env.CI_PROJECT_PATH ?? '',
    ...(pr ? { mergeRequests: [pr] } : {}),
  })
  const client = (t: string): GitHub => make(t) as unknown as GitHub
  const task = env.TRACE_TASK ?? ''

  // ci-doctor: on GitHub it runs on the build's workflow_run; here it is the build's last stage, so the run is this pipeline
  if (task === 'ci-doctor') context.payload.workflow_run = await pipelineAsRun(make(token), env)

  // worker: GitLab has no job matrix made from another job's output, so the pick and each item's dispatch run in one
  // job, one item after another (worker.runner agentcore: the AgentCore runtime does the work; dispatch only starts it)
  if (task === 'worker') {
    const pick = capturingCore()
    process.env.TRACE_TASK = 'worker-pick'
    await run({ github: client(token), context, core: pick, getOctokit: client })
    const items = z.array(z.record(z.string(), z.unknown())).catch([]).parse((() => { try { return JSON.parse(pick.outputs.items ?? '[]') as unknown } catch { return [] } })())
    const runner = pick.outputs.runner ?? ''
    if (runner && runner !== 'agentcore') { consoleCore.info(`worker.runner is ${runner}: on trace's GitLab the work runs on AgentCore only`); return }
    let failed = 0
    for (const item of items) {
      process.env.TRACE_TASK = 'worker-dispatch'
      process.env.ITEM = JSON.stringify(item)
      process.env.AGENT = String((item.route as { kind?: string } | undefined)?.kind ?? '')
      try {
        await run({ github: client(token), context, core: consoleCore, getOctokit: client })
      } catch (e) {
        failed++
        consoleCore.warning(`dispatch #${String(item.number ?? '?')}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failed) throw new Error(`${failed} of ${items.length} items could not be dispatched`)
    return
  }

  await run({ github: client(token), context, core: consoleCore, getOctokit: client })
}
