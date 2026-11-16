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

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const context = gitlabContext(env)
  const token = env.TRACE_GITLAB_TOKEN ?? ''
  if (!token) throw new Error('TRACE_GITLAB_TOKEN is empty: the job could not read its project\'s agents\' token')
  const pr = (context.payload.pull_request as { number?: number } | undefined)?.number
  const client = (t: string): GitHub => gitlabOctokit({
    url: env.CI_SERVER_URL ?? '', token: t, project: env.CI_PROJECT_PATH ?? '', repository: env.TRACE_REPOSITORY ?? env.CI_PROJECT_PATH ?? '',
    ...(pr ? { mergeRequests: [pr] } : {}),
  }) as unknown as GitHub
  await run({ github: client(token), context, core: consoleCore, getOctokit: client })
}
