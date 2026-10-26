/**
 * CI on AWS, the installer's part (the stack's is src/infra/runners.ts): CodeBuild-hosted GitHub Actions runners.
 *
 *   source credential  CodeBuild's account-level GitHub credential (ImportSourceCredentials, a personal access
 *                      token): what CodeBuild uses to make each repository's webhook and to register each job's
 *                      just-in-time runner. Done by API, no console step. An account that already has a GitHub
 *                      credential keeps it (it may be another team's: overwriting it would break their projects),
 *                      unless trace imported it itself, in which case the token is refreshed.
 *   runner project     `<prefix>-ci-<hash>` per repository: source GITHUB at the repository, image
 *                      aws/codebuild/standard:8.0 (Ubuntu 24.04, as `ubuntu-24.04` on GitHub), the stack's runner
 *                      role, logs in /aws/codebuild/<name>
 *   webhook            WORKFLOW_JOB_QUEUED, so each queued job whose label is codebuild-<name>-<run_id>-<attempt>
 *                      starts one build that runs it
 *   variable           TRACE_CODEBUILD_PROJECT=<name> on the repository, which the trace workflows' `runs-on` reads.
 *                      A repository whose runner could not be made has the variable removed, so its jobs stay on
 *                      GitHub's runners instead of waiting for a runner that will never come.
 *
 * The token needs, on each repository, Administration and Webhooks read and write (fine-grained), or `repo` (classic)
 * with admin on the repository (CodeBuild's "GitHub access token" requirements).
 */
import {
  type CodeBuildClient, CreateProjectCommand, CreateWebhookCommand, DeleteProjectCommand, DeleteWebhookCommand, ImportSourceCredentialsCommand,
  ListProjectsCommand, ListSourceCredentialsCommand, UpdateProjectCommand, UpdateWebhookCommand,
} from '@aws-sdk/client-codebuild'
import { projectHash } from '../infra/props.js'
import { runnerProjectName } from '../infra/runners.js'

type CodeBuild = Pick<CodeBuildClient, 'send'>

/** The CodeBuild image the runners use: Ubuntu 24.04, like GitHub's ubuntu-24.04 (CodeBuild's EC2 compute images). */
export const RUNNER_IMAGE = 'aws/codebuild/standard:8.0'

const named = (e: unknown, ...names: string[]): boolean => names.includes((e as { name?: string }).name ?? '')
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Make sure CodeBuild has a GitHub source credential. `ours`: trace imported the one there now (an earlier run), so it
 * is refreshed with this token. Returns what was done.
 */
export async function ensureSourceCredential(cb: CodeBuild, token: string, ours: boolean): Promise<{ state: 'imported' | 'refreshed' | 'existing'; detail: string }> {
  const list = (await cb.send(new ListSourceCredentialsCommand({}))).sourceCredentialsInfos ?? []
  const github = list.find((c) => c.serverType === 'GITHUB')
  if (github && !ours) return { state: 'existing', detail: `CodeBuild already has a GitHub ${String(github.authType ?? 'credential').toLowerCase().replace(/_/g, ' ')} in this account and region; trace uses it and leaves it alone` }
  await cb.send(new ImportSourceCredentialsCommand({ serverType: 'GITHUB', authType: 'PERSONAL_ACCESS_TOKEN', token, shouldOverwrite: true }))
  return github ? { state: 'refreshed', detail: 'CodeBuild\'s GitHub credential (trace\'s) refreshed with this token' } : { state: 'imported', detail: 'the token imported as CodeBuild\'s GitHub source credential (account and region)' }
}

export interface RunnerSpec { prefix: string; repo: string; roleArn: string; computeType: string }

/** The runner project's settings (CreateProject and UpdateProject take the same). */
export function runnerProject(s: RunnerSpec): ConstructorParameters<typeof CreateProjectCommand>[0] {
  const name = runnerProjectName(s.prefix, projectHash(s.repo))
  return {
    name,
    description: `trace: GitHub Actions runner for ${s.repo} (CodeBuild-hosted)`,
    source: { type: 'GITHUB', location: `https://github.com/${s.repo}`, buildspec: '' },
    artifacts: { type: 'NO_ARTIFACTS' },
    environment: { type: 'LINUX_CONTAINER', image: RUNNER_IMAGE, computeType: s.computeType as never, privilegedMode: false },
    serviceRole: s.roleArn,
    timeoutInMinutes: 480,
    logsConfig: { cloudWatchLogs: { status: 'ENABLED', groupName: `/aws/codebuild/${name}` } },
    tags: [{ key: 'trace:installation', value: s.prefix }, { key: 'trace:project', value: s.repo.toLowerCase() }],
  }
}

const FILTERS = [[{ type: 'EVENT' as const, pattern: 'WORKFLOW_JOB_QUEUED' }]]

/** Make (or update) one repository's runner project and its webhook. Returns the project name. */
export async function ensureRunner(cb: CodeBuild, s: RunnerSpec): Promise<string> {
  const p = runnerProject(s)
  try {
    await cb.send(new CreateProjectCommand(p))
  } catch (e) {
    if (!named(e, 'ResourceAlreadyExistsException')) throw e
    await cb.send(new UpdateProjectCommand(p))
  }
  try {
    await cb.send(new CreateWebhookCommand({ projectName: p.name, filterGroups: FILTERS }))
  } catch (e) {
    if (!named(e, 'ResourceAlreadyExistsException')) throw new Error(`the webhook on ${s.repo}: ${msg(e)} (the token needs Administration and Webhooks read and write on it)`)
    await cb.send(new UpdateWebhookCommand({ projectName: p.name, filterGroups: FILTERS }))
  }
  return p.name ?? ''
}

/** Every runner project of this installation (`<prefix>-ci-…`). */
export async function runnerProjects(cb: CodeBuild, prefix: string): Promise<string[]> {
  const out: string[] = []
  let nextToken: string | undefined
  do {
    const r = await cb.send(new ListProjectsCommand({ ...(nextToken ? { nextToken } : {}) }))
    for (const n of r.projects ?? []) if (n.startsWith(`${prefix}-ci-`)) out.push(n)
    nextToken = r.nextToken
  } while (nextToken)
  return out
}

/** Remove a runner project and its webhook (CodeBuild deletes the GitHub hook with it). */
export async function removeRunner(cb: CodeBuild, name: string): Promise<void> {
  try { await cb.send(new DeleteWebhookCommand({ projectName: name })) } catch (e) { if (!named(e, 'ResourceNotFoundException', 'InvalidInputException')) throw e }
  try { await cb.send(new DeleteProjectCommand({ name })) } catch (e) { if (!named(e, 'ResourceNotFoundException')) throw e }
}

/** The repositories that get a runner: every project's, and runners.extraRepos, once each. */
export function runnerRepos(projects: readonly string[], extra: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const r of [...projects, ...extra]) if (!seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r)
  return [...seen.values()]
}
