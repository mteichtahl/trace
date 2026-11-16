/**
 * Which forge a project's repository lives on, and one client that answers for both (docs/gitlab-projects.md).
 *
 * The API's actions ask `deps.github()` for one installation-wide client and pass the repository on every call. The
 * router keeps that shape: it is a GitHubApi whose every repository call goes to trace's own GitLab when the repository
 * is one of the installation's GitLab projects, and to GitHub otherwise, so no action changes while projects move.
 * GitHub's raw REST calls (`request`, `requestText`) name no repository and stay GitHub's.
 *
 * Where a GitLab project needs something the GitLab client does not do, the call is refused with a 501 in plain words
 * rather than quietly going to GitHub, where the repository is not.
 */
import { z } from 'zod'
import { GitHubError, type GitHubApi, HttpGitHub } from './github.js'
import { HttpGitLab } from './gitlab.js'
import { gitlabProjectPath } from '../core/gitlab-path.js'

/** Every GitHubApi call that names a repository first. Typed as a record so a call added to GitHubApi must be listed. */
const REPOSITORY_CALLS: Record<Exclude<keyof GitHubApi, 'request' | 'requestText'>, true> = {
  defaultBranch: true, repoExists: true, branchSha: true, tree: true, fileInfo: true, rawFile: true, fileSha: true, createBranch: true,
  putFile: true, commits: true, openPulls: true, mergedPullFor: true, openIssues: true, workflowRuns: true, dispatchWorkflow: true,
  lastDeploy: true, pullStatus: true, pullDetail: true, pullFiles: true, pullCommits: true, checkRuns: true, checkRun: true,
  checkAnnotations: true, mergeMethods: true, mergePull: true, comment: true, closePull: true, removeLabel: true, repoVariable: true,
  openPull: true, resetBranch: true, commitFiles: true, dispatchWorkflowWith: true,
}

/** The repositories that live on trace's GitLab, from TRACE_GITLAB_REPOS (space separated `group/project`). */
export function gitlabRepos(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(/\s+/).map((r) => r.trim().toLowerCase()).filter(Boolean))
}

type Call = (repo: string, ...rest: unknown[]) => Promise<unknown>

/**
 * One client for both forges. `gitlab` is null on an installation without trace's GitLab: every repository is then
 * GitHub's, as before.
 */
export function forgeRouter(o: { github: () => Promise<GitHubApi>; gitlab: (() => Promise<GitHubApi>) | null; onGitlab: (repo: string) => boolean }): GitHubApi {
  const out: Record<string, unknown> = {
    request: async (method: string, path: string, body?: unknown) => {
      const gh = await o.github()
      if (!gh.request) throw new GitHubError(501, 'this installation cannot make that GitHub call')
      return gh.request(method, path, body)
    },
    requestText: async (path: string, max: number) => {
      const gh = await o.github()
      if (!gh.requestText) throw new GitHubError(501, 'this installation cannot read that from GitHub')
      return gh.requestText(path, max)
    },
  }
  for (const name of Object.keys(REPOSITORY_CALLS) as (keyof typeof REPOSITORY_CALLS)[]) {
    out[name] = async (repo: string, ...rest: unknown[]) => {
      const lab = o.gitlab !== null && o.onGitlab(repo)
      const client = lab ? await (o.gitlab as () => Promise<GitHubApi>)() : await o.github()
      const call = client[name] as Call | undefined
      if (!call) {
        throw new GitHubError(501, lab
          ? `${repo} is on trace's GitLab, which cannot do this yet (${name})`
          : `this installation cannot do this for ${repo} (${name})`)
      }
      return call.call(client, repo, ...rest)
    }
  }
  return out as unknown as GitHubApi
}

const secretCache = new Map<string, { value: string; at: number }>()

/** A secret's text from Secrets Manager, kept ten minutes. */
async function secretText(arn: string): Promise<string> {
  const had = secretCache.get(arn)
  if (had && Date.now() - had.at < 600_000) return had.value
  const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager')
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }))
  const raw = (r.SecretString ?? '').trim()
  // `<prefix>/gitlab/admin-token` is either the token itself or { "token": "…" }
  const parsed = z.object({ token: z.string().min(1) }).loose().safeParse((() => { try { return JSON.parse(raw) as unknown } catch { return null } })())
  const value = parsed.success ? parsed.data.token : raw
  if (!value) throw new Error('the GitLab token secret is empty')
  secretCache.set(arn, { value, at: Date.now() })
  return value
}

/**
 * The API runtime's forge client from its environment: TRACE_GITLAB_URL, TRACE_GITLAB_SECRET_ARN and
 * TRACE_GITLAB_REPOS turn trace's GitLab on; without the first two, everything is GitHub as before.
 */
export function forgeFromEnv(env: Record<string, string | undefined>, githubToken: () => Promise<string>): GitHubApi {
  const url = env.TRACE_GITLAB_URL?.trim()
  const arn = env.TRACE_GITLAB_SECRET_ARN?.trim()
  const repos = gitlabRepos(env.TRACE_GITLAB_REPOS)
  return forgeRouter({
    github: async () => new HttpGitHub(await githubToken()),
    // a project keeps trace's name for it wherever it lives; on GitLab it is at <prefix>/<name> (src/core/gitlab-path.ts)
    gitlab: url && arn ? async () => new HttpGitLab(env.TRACE_GITLAB_TOKEN?.trim() || await secretText(arn), {
      base: url, ...(env.TRACE_PREFIX ? { pathOf: (r: string) => gitlabProjectPath(env.TRACE_PREFIX as string, r) } : {}),
    }) : null,
    onGitlab: (repo) => repos.has(repo.toLowerCase()),
  })
}
