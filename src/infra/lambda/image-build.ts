/**
 * The custom resource that builds the agent's container image: CloudFormation can't wait for a CodeBuild build by
 * itself, so `onEvent` starts the build and `isComplete` polls it until the image is in ECR. The image is tagged with
 * the source asset's hash, so an unchanged source never rebuilds and a changed one always does.
 *
 * `Wait: 'false'` (the GPU image, src/infra/gpu.ts) starts the build and does not wait for it: a failed GPU image
 * build then cannot fail the deploy and roll back the core with it. The installer waits for that build afterwards
 * (its id is the resource's BuildId) and starts it again if it failed (src/installer/aws.ts ensureGpuImage).
 *
 * A failed build's message carries the end of its log (buildLogTail), so the reason is in the deploy's own output;
 * the log group is kept when the stack rolls back (src/infra/stack.ts), so the whole log can be read too.
 *
 * The message must fit CloudFormation's custom resource response, 4096 bytes in all with the stack and request ids:
 * too long, and CloudFormation shows only "Response object is too long" and the reason is lost. The Provider framework
 * sends the message, a Logs line, and the error's stack after its first line (so a multi-line message's later lines
 * would go twice). buildFailure keeps the message to MESSAGE_MAX as JSON, and gives the error a one-line stack.
 */
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'

const cb = new CodeBuildClient({})

export type LogsClient = Pick<CloudWatchLogsClient, 'send'>
let logsClient: LogsClient | null = null
const realLogs = (): LogsClient => (logsClient ??= new CloudWatchLogsClient({}))

/** The most a failed build's message may be, in UTF-8 bytes as JSON (escaped newlines and quotes counted): what is left of
 * CloudFormation's 4096 bytes after the stack, request and physical ids, the Logs line and the JSON around them. */
export const MESSAGE_MAX = 2400
/** The most of a failed phase's context (the buildspec command, which runs to 700 characters) the message keeps. */
export const CONTEXT_MAX = 200
/** The most log a tail is read to, before buildFailure trims it to what fits. */
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
    const context = phase?.contexts?.map((x) => x.message).join('; ') ?? ''
    throw buildFailure(`the image build ${status.toLowerCase()} in ${phase?.phaseType ?? 'an unknown phase'}: ${clip(context, CONTEXT_MAX)} (logs: ${b?.logs?.deepLink ?? 'CodeBuild console'})`, tail)
  }
  return { IsComplete: true, Data: { ImageUri: props(event).ImageUri, BuildId: buildId } }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * The error a failed build ends in: `head` (the phase, the clipped command and the log link), then as much of the
 * log's tail as keeps the message within MESSAGE_MAX as JSON, trimmed from the front. Its stack is one line, so the
 * Provider framework does not send the message's later lines a second time.
 */
export function buildFailure(head: string, tail: string): Error {
  // CloudFormation counts bytes: as JSON (escapes) in UTF-8 (… and a log's own characters are more than one)
  const size = (m: string): number => Buffer.byteLength(JSON.stringify(m), 'utf8')
  let message = head
  while (size(message) > MESSAGE_MAX) message = clip(message, message.length - 50)
  if (tail) {
    const lines = tail.split('\n')
    const withTail = (from: number): string => `${message}\nThe end of its log:\n${from > 0 ? '…\n' : ''}${lines.slice(from).join('\n')}`
    // drop whole lines from the front until it fits; when not even the last line fits whole, the end of it
    let from = 0
    while (from < lines.length && size(withTail(from)) > MESSAGE_MAX) from++
    if (from < lines.length) message = withTail(from)
    else {
      let last = lines.at(-1) ?? ''
      const end = (l: string): string => `${message}\nThe end of its log:\n…${l}`
      while (last && size(end(last)) > MESSAGE_MAX) last = last.slice(Math.min(last.length, 50))
      if (last) message = end(last)
    }
  }
  const e = new Error(message)
  e.stack = `Error: ${message.split('\n')[0]}`
  return e
}
