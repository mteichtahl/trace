/**
 * One onboarded project's names in AWS, shared by the stack (src/infra), the worker (src/agent), the API (src/api)
 * and the GPU jobs (src/gpu). Pure: no AWS calls, no settings.
 *
 *   slug           owner/repo, lower case (GitHub names are case-insensitive). Used where `/` is allowed and
 *                  readable names help: S3 prefixes, the secret's name, tag values.
 *   hash           the first 8 hex digits of the slug's sha256. Used where `/` is not allowed or length is short:
 *                  the runtime's name, the job definition's, the roles', CloudFormation ids and output names.
 *
 *   S3             projects/<slug>/…        the project's own data
 *                  jobs/<slug>/<id>/…       its GPU jobs' files (src/gpu/protocol.ts)
 *   Secrets        <prefix>/github-token/<slug>
 *   AgentCore      <prefix>_w_<hash>        its worker runtime ([a-zA-Z][a-zA-Z0-9_]{0,47})
 *   Batch          <prefix>-gpu-<hash>      its GPU job definition
 *
 * A slug always contains exactly one `/`, so `projects/a/b/*` never matches `projects/a/bc/…` and nothing without a
 * slash (such as `jobs/_local/`) is ever a project's.
 */
import { createHash } from 'node:crypto'

/** OWNER/REPO in GitHub's own character set. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.][A-Za-z0-9._-]{0,99}$/

export class ProjectNameError extends Error {
  override name = 'ProjectNameError'
}

/** owner/repo, lower case; anything else (a branch suffix, `..`, a path) is refused. */
export function projectSlug(repository: string): string {
  const r = repository.trim()
  if (!REPO.test(r) || r.includes('..')) throw new ProjectNameError(`not a repository: ${JSON.stringify(repository)}`)
  return r.toLowerCase()
}

/** 8 hex digits naming the project where a slug does not fit. */
export const projectHash = (repository: string): string => createHash('sha256').update(projectSlug(repository)).digest('hex').slice(0, 8)

/** The same project? (GitHub names are case-insensitive.) */
export const sameProject = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** S3 prefixes (no leading or trailing slash). */
export const PROJECTS_PREFIX = 'projects'
export const JOBS_PREFIX = 'jobs'
/** GPU jobs submitted outside any project (a laptop with admin credentials): never a project's prefix. */
export const LOCAL_JOBS = '_local'

export const projectDataPrefix = (repository: string): string => `${PROJECTS_PREFIX}/${projectSlug(repository)}`
export const projectJobsPrefix = (repository: string): string => `${JOBS_PREFIX}/${projectSlug(repository)}`

const under = (prefix: string): string => prefix.replace(/-/g, '_')

/** The project's worker runtime (AgentCore names: a letter, then letters, digits and underscores, at most 48). */
export const workerRuntimeName = (prefix: string, repository: string): string => `${under(prefix)}_w_${projectHash(repository)}`
/** The IAM pattern every project's worker runtime ARN of this installation matches (runtime ids are `<name>-<suffix>`). */
export const workerRuntimeNamePattern = (prefix: string): string => `${under(prefix)}_w_*`
export const githubSecretName = (prefix: string, repository: string): string => `${prefix}/github-token/${projectSlug(repository)}`
export const gpuJobDefinitionName = (prefix: string, repository: string): string => `${prefix}-gpu-${projectHash(repository)}`

/** The tag every per-project resource and every Batch job carries: its slug. */
export const PROJECT_TAG = 'trace:project'
