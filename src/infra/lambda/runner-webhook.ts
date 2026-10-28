/**
 * The custom resource that gives a CodeBuild runner project (src/infra/runner.ts) its GitHub webhook, filtered on
 * EVENT = WORKFLOW_JOB_QUEUED, without ever failing the deploy over it.
 *
 * Why not the project's own Triggers: CloudFormation makes that webhook with the project, and when GitHub refuses it
 * (the AWS Connector for GitHub app not installed on the repository, a token without admin:repo_hook, an old hook of
 * the same project left on the repository, GitHub's limit on a repository's hooks), CodeBuild answers "Failed to create
 * webhook. GitHub API limit reached or permission issue encountered" and the whole stack rolls back. A runner is only
 * ever a faster place to run the jobs: the workflows run on GitHub's runners without one. So a refused webhook leaves
 * the runner project in place, unused, and this resource reports it:
 *
 *   Runner  the project's name when it has its webhook (the value of the runner's TRACE_CODEBUILD_PROJECT output), or
 *           RUNNER_NONE when it has none, so the tools leave the repository's jobs on GitHub's runners
 *   Reason  why it has none ('' when it has one)
 *
 * Create and Update: a project that already has its webhook keeps it; one without is given one (and the resource's
 * Attempt property changes on every deploy, so the next deploy tries again). Delete: the webhook goes, best effort (the
 * project, deleted with it, would take it anyway). Nothing here throws over GitHub.
 */
import { BatchGetProjectsCommand, CodeBuildClient, CreateWebhookCommand, DeleteWebhookCommand, type WebhookFilter } from '@aws-sdk/client-codebuild'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'
import { RUNNER_NONE } from '../../core/project.js'

/** The one filter every runner's webhook has: a workflow job was queued. */
export const RUNNER_FILTER_GROUPS: WebhookFilter[][] = [[{ type: 'EVENT', pattern: 'WORKFLOW_JOB_QUEUED' }]]

export type Clients = { codebuild: Pick<CodeBuildClient, 'send'> }

export interface Result { PhysicalResourceId: string; Data?: { Runner: string; Reason: string } }

const message = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 400)

/** Whether the project has its webhook now. */
async function hasWebhook(c: Clients, name: string): Promise<boolean> {
  const r = await c.codebuild.send(new BatchGetProjectsCommand({ names: [name] }))
  const p = r.projects?.[0]
  if (!p) throw new Error(`the CodeBuild project ${name} does not exist`)
  return Boolean(p.webhook?.url || p.webhook?.payloadUrl)
}

/** Make sure the project has its webhook; never throws. */
export async function ensureWebhook(c: Clients, name: string): Promise<{ Runner: string; Reason: string }> {
  try {
    if (await hasWebhook(c, name)) return { Runner: name, Reason: '' }
    await c.codebuild.send(new CreateWebhookCommand({ projectName: name, filterGroups: RUNNER_FILTER_GROUPS, buildType: 'BUILD' }))
    return { Runner: name, Reason: '' }
  } catch (e) {
    // a webhook made by a request that timed out on our side but went through counts as made
    if ((e as { name?: string }).name === 'ResourceAlreadyExistsException') return { Runner: name, Reason: '' }
    return { Runner: RUNNER_NONE, Reason: message(e) }
  }
}

let clients: Clients | null = null
const real = (): Clients => (clients ??= { codebuild: new CodeBuildClient({}) })

/** The Provider's handler (Lambda passes its context second, so the clients are not a parameter here). */
export const onEvent = (event: CloudFormationCustomResourceEvent): Promise<Result> => handle(event, real())

export async function handle(event: CloudFormationCustomResourceEvent, c: Clients): Promise<Result> {
  const name = String((event.ResourceProperties as { ProjectName?: unknown }).ProjectName ?? '')
  if (!name) throw new Error('ProjectName is required')
  const id = `runner-webhook-${name}`
  if (event.RequestType === 'Delete') {
    try { await c.codebuild.send(new DeleteWebhookCommand({ projectName: name })) } catch { /* gone already, or the project is */ }
    return { PhysicalResourceId: event.PhysicalResourceId }
  }
  const r = await ensureWebhook(c, name)
  if (r.Runner === RUNNER_NONE) console.log(`${name}: no webhook, so its repository's jobs stay on GitHub's runners: ${r.Reason}`)
  return { PhysicalResourceId: id, Data: r }
}
