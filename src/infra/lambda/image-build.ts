/**
 * The custom resource that builds the agent's container image: CloudFormation can't wait for a CodeBuild build by
 * itself, so `onEvent` starts the build and `isComplete` polls it until the image is in ECR. The image is tagged with
 * the source asset's hash, so an unchanged source never rebuilds and a changed one always does.
 *
 * `Wait: 'false'` (the GPU image, src/infra/gpu.ts) starts the build and does not wait for it: a failed GPU image
 * build then cannot fail the deploy and roll back the core with it. The installer waits for that build afterwards
 * (its id is the resource's BuildId) and starts it again if it failed (src/installer/aws.ts ensureGpuImage).
 *
 * A failed build's message carries the end of its log (buildLogTail): CloudFormation rolls the stack back, which
 * deletes the build project and its log group, so the reason must reach the deploy's own output before it goes.
 */
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'

const cb = new CodeBuildClient({})

export type LogsClient = Pick<CloudWatchLogsClient, 'send'>
let logsClient: LogsClient | null = null
const realLogs = (): LogsClient => (logsClient ??= new CloudWatchLogsClient({}))

/** How much of a failed build's log goes in its message: CloudFormation shows a resource's reason up to about 4 KB,
 * and the command and the log link take some of that. */
export const LOG_TAIL_CHARS = 2400
/** A log line that says what went wrong (Docker, apt, npm, pip, a shell `set -e` exit). */
const TELLING = /error|fail|denied|not found|no such|unauthori[sz]ed|forbidden|toomanyrequests|rate limit|timed? ?out|cannot|could not|unable|ERR!|exit code|returned a non-zero/i
/** apt's error prefix, case-sensitive and at a line's start (or after BuildKit's step prefix), so `source: x` is not one */
const APT_ERROR = /(^|\s)E: /

/**
 * The end of a failed build's log, for its error message: the lines that look like the cause (TELLING) among the
 * last 200, then the last 8 whatever they say, in log order, trimmed from the front to LOG_TAIL_CHARS. '' when the
 * log cannot be read: the message still has the phase and the link.
 */
export async function buildLogTail(logs: LogsClient, group: string | undefined, stream: string | undefined): Promise<string> {
  if (!group || !stream) return ''
  try {
    const r = await logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: false, limit: 200 }))
    const lines = (r.events ?? []).flatMap((e) => (e.message ?? '').split('\n')).map((l) => l.trimEnd()).filter((l) => l.trim())
    // the last 8 lines (all of them, in a shorter log)
    const lastFrom = Math.max(0, lines.length - 8)
    const keep = lines.filter((l, i) => TELLING.test(l) || APT_ERROR.test(l) || i >= lastFrom)
    let text = keep.join('\n')
    if (text.length > LOG_TAIL_CHARS) text = `…${text.slice(text.length - LOG_TAIL_CHARS)}`
    return text
  } catch {
    return ''
  }
}

interface Props { ProjectName: string; ImageUri: string; SourceHash: string; Wait: boolean }

const props = (e: CloudFormationCustomResourceEvent): Props => {
  const p = e.ResourceProperties as unknown as Partial<Props>
  if (!p.ProjectName || !p.ImageUri || !p.SourceHash) throw new Error('ProjectName, ImageUri and SourceHash are required')
  return { ProjectName: p.ProjectName, ImageUri: p.ImageUri, SourceHash: p.SourceHash, Wait: String(p.Wait ?? 'true') !== 'false' }
}

export async function onEvent(event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string; Data?: Record<string, string> }> {
  const p = props(event)
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId }
  const r = await cb.send(new StartBuildCommand({ projectName: p.ProjectName, environmentVariablesOverride: [{ name: 'IMAGE_TAG', value: p.SourceHash }] }))
  const id = r.build?.id
  if (!id) throw new Error('CodeBuild started no build')
  return { PhysicalResourceId: `${p.ImageUri}#${id}`, Data: { ImageUri: p.ImageUri, BuildId: id } }
}

export type BuildsClient = Pick<CodeBuildClient, 'send'>

/**
 * The Provider's isComplete handler. It takes the event only: Lambda calls every handler with (event, context,
 * callback), so a third parameter here would receive Lambda's callback, and calling it ends the invocation with null
 * (which the Provider framework then fails on: "Cannot read properties of null (reading 'IsComplete')"). The clients
 * are checkBuild's, for tests.
 */
export const isComplete = (event: CloudFormationCustomResourceEvent & { PhysicalResourceId?: string }): ReturnType<typeof checkBuild> =>
  checkBuild(event, { codebuild: cb, logs: realLogs() })

export async function checkBuild(event: CloudFormationCustomResourceEvent & { PhysicalResourceId?: string }, c: { codebuild: BuildsClient; logs: LogsClient }): Promise<{ IsComplete: boolean; Data?: Record<string, string> }> {
  if (event.RequestType === 'Delete') return { IsComplete: true }
  const buildId = (event.PhysicalResourceId ?? '').split('#')[1]
  if (!buildId) throw new Error('no build id on the resource')
  if (!props(event).Wait) return { IsComplete: true, Data: { ImageUri: props(event).ImageUri, BuildId: buildId } }
  const b = (await c.codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }))).builds?.[0]
  const status = b?.buildStatus
  if (status === 'IN_PROGRESS' || !status) return { IsComplete: false }
  if (status !== 'SUCCEEDED') {
    const phase = b?.phases?.find((ph) => ph.phaseStatus && ph.phaseStatus !== 'SUCCEEDED')
    const tail = await buildLogTail(c.logs, b?.logs?.groupName, b?.logs?.streamName)
    throw new Error(`the image build ${status.toLowerCase()} in ${phase?.phaseType ?? 'an unknown phase'}: ${phase?.contexts?.map((c) => c.message).join('; ') ?? ''} (logs: ${b?.logs?.deepLink ?? 'CodeBuild console'})${tail ? `\nThe end of its log:\n${tail}` : ''}`)
  }
  return { IsComplete: true, Data: { ImageUri: props(event).ImageUri, BuildId: buildId } }
}
