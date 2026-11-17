/**
 * Where this worker runtime's project lives: GitHub, or trace's own GitLab (docs/gitlab-projects.md). One runtime
 * serves one project, so its environment says it once, set by its stack (src/infra/project.ts):
 *
 *   TRACE_GITLAB_URL     trace's GitLab, https://…            (absent: GitHub)
 *   TRACE_GITLAB_PATH    the project on it, <prefix>/<name>
 *   TRACE_GITLAB_SECRET  the agents' token for it (src/core/gitlab-token.ts: {"token": …}, rotated every 12 hours)
 *
 * On GitLab the runtime clones from and pushes to GitLab, and its GitHub client is the Octokit-shaped one the CI
 * harness uses there (src/harness/gitlab-octokit.ts): merge requests answer as pull requests. Before, it always went to
 * github.com, so a project moved to GitLab had every job fail at its push ("This repository was archived").
 */
import { Octokit } from '@octokit/rest'
import { gitlabOctokit } from '../../harness/gitlab-octokit.js'
import type { GitHub } from '../../harness/types.js'

export type RuntimeForge =
  | { kind: 'github' }
  | { kind: 'gitlab'; url: string; path: string; secret: string }

/** The forge this runtime's environment names. Pure. */
export function runtimeForge(env: Record<string, string | undefined> = process.env): RuntimeForge {
  const url = (env.TRACE_GITLAB_URL ?? '').trim().replace(/\/+$/, '')
  if (!url) return { kind: 'github' }
  const path = (env.TRACE_GITLAB_PATH ?? '').trim()
  const secret = (env.TRACE_GITLAB_SECRET ?? '').trim()
  if (!path || !secret) throw new Error('TRACE_GITLAB_URL is set without TRACE_GITLAB_PATH and TRACE_GITLAB_SECRET: deploy the project again')
  return { kind: 'gitlab', url, path, secret }
}

/** The address git clones and pushes. Pure. */
export function remoteUrl(f: RuntimeForge, repository: string): string {
  return f.kind === 'gitlab' ? `${f.url}/${f.path}.git` : `https://github.com/${repository}.git`
}

/** The host the token's header is for (git's http.<url>.extraheader). Pure. */
export function remoteBase(f: RuntimeForge): string {
  return f.kind === 'gitlab' ? `${f.url}/` : 'https://github.com/'
}

/** The user git's basic sign-in names with the token: GitHub's app tokens, GitLab's access tokens. Pure. */
export const remoteUser = (f: RuntimeForge): string => (f.kind === 'gitlab' ? 'oauth2' : 'x-access-token')

/** The secret holding the token (an ARN or a name). */
export function tokenSecret(f: RuntimeForge, env: Record<string, string | undefined> = process.env): string | undefined {
  return f.kind === 'gitlab' ? f.secret : env.TRACE_GITHUB_SECRET_ARN
}

/** The web address links in comments point at (a run's dispatch, the project). Pure. */
export const serverUrl = (f: RuntimeForge): string => (f.kind === 'gitlab' ? f.url : 'https://github.com')

/** The client for the project's issues, changes and settings: Octokit on GitHub, its GitLab twin on GitLab. */
export function forgeClient(f: RuntimeForge, repository: string): (token: string) => GitHub {
  if (f.kind === 'gitlab') return (token) => gitlabOctokit({ url: f.url, token, project: f.path, repository }) as unknown as GitHub
  return (token) => new Octokit({ auth: token, userAgent: 'trace-agent' }) as unknown as GitHub
}
