/**
 * One onboarded project's names in AWS, shared by the stack (src/infra), the worker (src/agents), the API (src/api)
 * and the GPU jobs (src/gpu). Pure: no AWS calls, no settings.
 *
 *   slug           owner/repo, lower case (GitHub names are case-insensitive). Used where `/` is allowed and
 *                  readable names help: S3 prefixes, the secret's name, tag values.
 *   hash           the first 8 hex digits of the slug's sha256. Used where `/` is not allowed or length is short:
 *                  the runtime's name, the job definition's, the roles', CloudFormation ids and output names.
 *
 *   S3             projects/<slug>/…        the project's own data
 *                  projects/<slug>/kb/…     its knowledge base's documents and their metadata sidecars (src/tools/kb)
 *                  jobs/<slug>/<id>/…       its GPU jobs' files (src/gpu/protocol.ts)
 *   Bedrock        <prefix>-kb-<hash>       its knowledge base (`-g<n>` appended at generation n > 0)
 *   Secrets        <prefix>/github-token/<slug>   (`@g<n>` appended at generation n > 0)
 *   AgentCore      <prefix>_w_<hash>        its worker runtime ([a-zA-Z][a-zA-Z0-9_]{0,47})
 *                  <prefix>_m_<hash>        its memory (the same pattern and length; `_g<n>` appended at generation n > 0)
 *   Batch          <prefix>-gpu-<hash>      its GPU job definition
 *                  <prefix>-cpu-<hash>      its CPU job definition
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
/**
 * A project's generation (projectSettings `generation`, 0 unless the installer bumped it): the names a removed
 * project can leave behind in the account (its memory, kept with retainData; its memory's log delivery sources and
 * destinations; its token secret, through its recovery window) carry it when it is above 0, so the project can be
 * added again without colliding with them. Generation 0 is the names as they always were.
 */
const gen = (generation: number, sep: string): string => (generation > 0 ? `${sep}g${generation}` : '')

/** The project's AgentCore memory (CfnMemory Name: `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`, at most 36 characters here). */
export const memoryName = (prefix: string, repository: string, generation = 0): string => `${under(prefix)}_m_${projectHash(repository)}${gen(generation, '_')}`
/** The IAM pattern every project's worker runtime ARN of this installation matches (runtime ids are `<name>-<suffix>`). */
export const workerRuntimeNamePattern = (prefix: string): string => `${under(prefix)}_w_*`
/** `@` is in no repository name, so `owner/repo@g1` can never be another repository's generation 0. */
export const githubSecretName = (prefix: string, repository: string, generation = 0): string => `${prefix}/github-token/${projectSlug(repository)}${gen(generation, '@')}`
export const gpuJobDefinitionName = (prefix: string, repository: string): string => `${prefix}-gpu-${projectHash(repository)}`
/** The project's CPU job definition (the CPU queue: openEMS, Verilator, formal, nextpnr sent remote). */
/** A repository's AWS CodeBuild runner project (an onboarded project's, or a build-only repository's such as trace's
 * own): every GitHub Actions job of the repository runs there, in the installation's AWS account, once it exists.
 * Workflows name it through the repository variable TRACE_CODEBUILD_PROJECT (src/infra/runner.ts). */
export const runnerProjectName = (prefix: string, repository: string): string => `${prefix}-ci-${projectHash(repository)}`
/** The repository variable naming that runner project. The installer sets it only once the runner project exists, so
 * it is the workflows' "the AWS runner is there" signal: set, every job runs on it; unset, on GITHUB_HOSTED_FALLBACK. */
export const RUNNER_VARIABLE = 'TRACE_CODEBUILD_PROJECT'
/** The GitHub-hosted runner every workflow job uses while its repository has no AWS CodeBuild runner yet. */
export const GITHUB_HOSTED_FALLBACK = 'ubuntu-24.04'
/** The AWS CodeConnections connection to GitHub a stack creates when it is given none (src/infra/runner.ts
 * GithubConnection): `<prefix>-github`. At most 32 characters (a prefix is at most 21). */
export const connectionName = (prefix: string): string => `${prefix}-github`
export const cpuJobDefinitionName = (prefix: string, repository: string): string => `${prefix}-cpu-${projectHash(repository)}`
/** A project memory's log delivery source and destination name (`[\w-]{1,60}`, unique in the account and region). */
export const memoryDeliveryName = (prefix: string, repository: string, kind: 'logs' | 'traces', generation = 0): string =>
  `${prefix}-m-${projectHash(repository)}${gen(generation, '-')}-${kind}`

/** The project's Bedrock knowledge base (`([0-9a-zA-Z][_-]?){1,100}`): `<prefix>-kb-<hash>`, `-g<n>` at generation n > 0. */
export const knowledgeBaseName = (prefix: string, repository: string, generation = 0): string =>
  `${prefix.replace(/-{2,}/g, '-').replace(/-$/, '')}-kb-${projectHash(repository)}${gen(generation, '-')}`
/** Its S3 data source's name (`([0-9a-zA-Z][_-]?){1,100}`, unique within its knowledge base). */
export const KB_DATA_SOURCE_NAME = 'trace-repository'
/** Where its knowledge base's documents are (and the only prefix its data source and its service role read). */
export const KB_FOLDER = 'kb'
export const projectKbPrefix = (repository: string): string => `${projectDataPrefix(repository)}/${KB_FOLDER}`

/** The tag every per-project resource and every Batch job carries: its slug. */
export const PROJECT_TAG = 'trace:project'
