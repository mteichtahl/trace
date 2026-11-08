/**
 * worker-dispatch: hands one item from worker-pick to the trace agent on Bedrock AgentCore Runtime (the workflow's
 * configure-aws-credentials step provides the AWS credentials; TRACE_AGENT_RUNTIME_ARN names the runtime), then says
 * so on the item.
 */
import { type DispatchOptions, dispatch, newTraceContext } from '../agents/runtime/dispatch.js'
import type { Accepted } from '../agents/runtime/schemas.js'
import { type Deps, type TaskEnv, errorMessage } from './types.js'
import { type WorkItem, itemFromEnv, routeLine } from './worker.js'

export type DispatchFn = (item: WorkItem, repository: string, opts: DispatchOptions) => Promise<Accepted>

export async function dispatchTask({ github, context, core, env }: Deps, send: DispatchFn = dispatch): Promise<void> {
  const item = itemFromEnv(env)
  const { owner, repo } = context.repo
  const repository = `${owner}/${repo}`
  const runtimeArn = (env as TaskEnv & { TRACE_AGENT_RUNTIME_ARN?: string }).TRACE_AGENT_RUNTIME_ARN || process.env.TRACE_AGENT_RUNTIME_ARN
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
  if (!runtimeArn) {
    core.setFailed('TRACE_AGENT_RUNTIME_ARN is not set (repository variable TRACE_AGENT_RUNTIME_ARN): set it, or set worker.runner to actions.')
    return
  }
  // the item may have moved on since worker-pick claimed it: trace merges a record-only conflict itself (src/api/
  // record-merge.ts) and a person may push. Dispatched anyway, an agent was paid to find nothing to do (test-esp32-run2
  // R64: #23 picked up 2 s before trace pushed its merge, dispatched 30 s after)
  const moved = await movedOn(github, owner, repo, item)
  if (moved) {
    await github.rest.issues.createComment({ owner, repo, issue_number: item.number, body: `Not dispatched: ${moved} since it was picked up, so there is nothing for the agent to do. [run](${runUrl})` })
    core.info(`#${item.number}: not dispatched, ${moved}`)
    return
  }
  // This step has no OpenTelemetry SDK: it makes the trace context itself (a child of any TRACEPARENT the workflow
  // set), and the runtime continues it, so workflow → agent → tools → GPU jobs is one trace.
  const trace = newTraceContext(process.env)
  const traceId = trace.traceparent.split('-')[1] ?? ''
  core.setOutput('trace', traceId)
  let r: Accepted
  try {
    r = await send(item, repository, { runtimeArn, runUrl, trace })
  } catch (e) {
    core.setFailed(`Dispatching #${item.number} to the trace agent failed: ${errorMessage(e)}`)
    return
  }
  core.setOutput('job', r.jobId)
  const body = r.accepted
    ? `Dispatched to the trace agent on AgentCore (job ${r.jobId}, trace \`${traceId}\`). ${routeLine(item.route)} [run](${runUrl})`
    : `Already being worked on by the trace agent on AgentCore (job ${r.jobId}).`
  await github.rest.issues.createComment({ owner, repo, issue_number: item.number, body })
  core.info(`#${item.number}: ${r.accepted ? 'dispatched' : 'already running'} (job ${r.jobId}, specialist ${item.route?.kind ?? 'routed by the runtime'}, trace ${traceId})`)
}

/**
 * Why a pull request item no longer needs the agent, or null: it was closed, its branch moved on from the commit it was
 * picked up at, or (a conflict) GitHub says it can merge now. An issue, or a PR that cannot be read, is dispatched.
 */
export async function movedOn(github: Deps['github'], owner: string, repo: string, item: WorkItem): Promise<string | null> {
  if (item.kind !== 'conflict' && item.kind !== 'ci-red') return null
  try {
    const p = (await github.rest.pulls.get({ owner, repo, pull_number: item.number })).data as { state?: string; merged?: boolean; head?: { sha?: string }; mergeable?: boolean | null }
    if (p.state === 'closed') return p.merged ? 'it was merged' : 'it was closed'
    if (p.head?.sha && p.head.sha !== item.sha) return `its branch moved on (${item.sha.slice(0, 7)} → ${p.head.sha.slice(0, 7)})`
    if (item.kind === 'conflict' && p.mergeable === true) return 'it is no longer in conflict'
    return null
  } catch {
    return null
  }
}
