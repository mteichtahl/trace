/**
 * Where a project lives on trace's GitLab (docs/gitlab-projects.md): `<prefix>/<name>`, the installation's group and
 * the repository's own name. A project keeps its identity (`owner/name`, the key every name and record of it is made
 * from) wherever it lives; only its address on the forge changes. Two GitLab projects of one installation may not share
 * a name (props.ts checks it).
 */
import { projectSlug } from './project.js'

/** The repository's name, lower case: `mteichtahl/Test-ESP32` → `test-esp32`. */
export const repositoryName = (repository: string): string => projectSlug(repository).split('/').at(-1) ?? ''

/** Its project path on trace's GitLab. */
export const gitlabProjectPath = (prefix: string, repository: string): string => `${prefix}/${repositoryName(repository)}`

/** The secret holding its agents' current GitLab token (src/core/gitlab-token.ts agentTokenSecretName). */
export const gitlabAgentSecret = (prefix: string, repository: string): string => `${prefix}/gitlab/agents/${repositoryName(repository)}`

/** The address trace's GitLab hook for a project calls: the hooks endpoint, with trace's name for the project (GitLab
 * names it by its path; src/web/hooks.ts readGitlabDelivery reads the name from here). */
export const gitlabHookUrl = (appUrl: string, repository: string): string =>
  `${appUrl.replace(/\/+$/, '')}/api/hooks/gitlab?repo=${encodeURIComponent(projectSlug(repository))}`
