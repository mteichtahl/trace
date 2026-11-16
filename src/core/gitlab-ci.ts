/**
 * A project's `.gitlab-ci.yml` on trace's GitLab (templates/gitlab/trace.gitlab-ci.yml; docs/gitlab-projects.md, build
 * step 5): the template with the project's own values put in. Every placeholder must be filled: a value left out is
 * an error, never an empty string in a pipeline.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GitlabCiValues {
  /** trace's source repository on GitHub (owner/name), where the harness bundle is fetched from */
  source: string
  /** its ref (the installation follows `main`) */
  ref: string
  /** the project's default branch */
  branch: string
  /** trace's name for the project (owner/name) */
  repository: string
  /** its CodeBuild runner project (runnerProjectName) */
  runner: string
  /** the label that holds a change (config `hold`) */
  hold: string
  /** where it deploys (config deploy.environment) */
  environment?: string
}

const SAFE = /^[A-Za-z0-9._\/-]+$/

export function renderGitlabCi(template: string, given: GitlabCiValues): string {
  const v = { ...given, environment: given.environment ?? 'production' }
  for (const [k, x] of Object.entries(v)) if (!SAFE.test(x)) throw new Error(`${k} must be letters, digits, '.', '_', '-' or '/': ${JSON.stringify(x)}`)
  const out = template
    .replaceAll('__TR_SOURCE__', v.source).replaceAll('__TR_REF__', v.ref).replaceAll('__TR_BRANCH__', v.branch)
    .replaceAll('__TR_REPOSITORY__', v.repository).replaceAll('__TR_RUNNER__', v.runner).replaceAll('__TR_HOLD__', v.hold).replaceAll('__TR_ENVIRONMENT__', v.environment)
  const left = /__TR_[A-Z]+__/.exec(out)
  if (left) throw new Error(`the GitLab pipeline template has a value not filled in: ${left[0]}`)
  return out
}

/** The template as shipped (templates/gitlab/trace.gitlab-ci.yml under trace's root). */
export const gitlabCiTemplate = (root: string): string => readFileSync(join(root, 'templates', 'gitlab', 'trace.gitlab-ci.yml'), 'utf8')

/** The kinds of project build trace makes (templates/gitlab/build/<kind>.yml), as on GitHub (templates/build). */
export const GITLAB_BUILDS = ['empty', 'kicad', 'python', 'rust'] as const
export type GitlabBuild = (typeof GITLAB_BUILDS)[number]

/** A project's `.gitlab/build.yml`: its kind's template with its runner and default branch put in. */
export function renderGitlabBuild(root: string, kind: GitlabBuild, v: { runner: string; branch: string }): string {
  for (const [k, x] of Object.entries(v)) if (!SAFE.test(x)) throw new Error(`${k} must be letters, digits, '.', '_', '-' or '/': ${JSON.stringify(x)}`)
  const out = readFileSync(join(root, 'templates', 'gitlab', 'build', `${kind}.yml`), 'utf8').replaceAll('__TR_RUNNER__', v.runner).replaceAll('__TR_BRANCH__', v.branch)
  const left = /__TR_[A-Z]+__/.exec(out)
  if (left) throw new Error(`the GitLab build template has a value not filled in: ${left[0]}`)
  return out
}
