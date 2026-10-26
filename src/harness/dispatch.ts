/**
 * worker-dispatch: hands one item from worker-pick to the trace agent on Bedrock AgentCore Runtime (the workflow's
 * configure-aws-credentials step provides the AWS credentials; TRACE_AGENT_RUNTIME_ARN names the runtime), then says
 * so on the item.
 */
import { type DispatchOptions, dispatch } from '../agent/dispatch.js'
import type { Accepted } from '../agent/schemas.js'
import { type Deps, type TaskEnv, errorMessage } from './types.js'
import { type WorkItem, WorkItemSchema } from './worker.js'

export type DispatchFn = (item: WorkItem, repository: string, opts: DispatchOptions) => Promise<Accepted>

export async function dispatchTask({ github, context, core, env }: Deps, send: DispatchFn = dispatch): Promise<void> {
  const item = WorkItemSchema.parse(JSON.parse(env.ITEM || '{}'))
  const { owner, repo } = context.repo
  const repository = `${owner}/${repo}`
  const runtimeArn = (env as TaskEnv & { TRACE_AGENT_RUNTIME_ARN?: string }).TRACE_AGENT_RUNTIME_ARN || process.env.TRACE_AGENT_RUNTIME_ARN
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
  if (!runtimeArn) {
    core.setFailed('TRACE_AGENT_RUNTIME_ARN is not set (repository variable TRACE_AGENT_RUNTIME_ARN): set it, or set worker.runner to actions.')
    return
  }
  let r: Accepted
  try {
    r = await send(item, repository, { runtimeArn, runUrl })
  } catch (e) {
    core.setFailed(`Dispatching #${item.number} to the trace agent failed: ${errorMessage(e)}`)
    return
  }
  core.setOutput('job', r.jobId)
  const body = r.accepted
    ? `Dispatched to the trace agent on AgentCore (job ${r.jobId}). [run](${runUrl})`
    : `Already being worked on by the trace agent on AgentCore (job ${r.jobId}).`
  await github.rest.issues.createComment({ owner, repo, issue_number: item.number, body })
  core.info(`#${item.number}: ${r.accepted ? 'dispatched' : 'already running'} (job ${r.jobId})`)
}
