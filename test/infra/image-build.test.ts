/**
 * A failed image build says why (src/infra/lambda/image-build.ts buildLogTail): its message carries the end of the
 * build's log, because the stack's rollback deletes the build project and its log group before anyone can read them.
 */
import { GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { describe, expect, it } from 'vitest'
import { BatchGetBuildsCommand } from '@aws-sdk/client-codebuild'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'
import { type BuildsClient, CONTEXT_MAX, LOG_TAIL_CHARS, type LogsClient, buildFailure, buildLogTail, checkBuild, isComplete } from '../../src/infra/lambda/image-build.js'
import { onEvent as runnerWebhook } from '../../src/infra/lambda/runner-webhook.js'
import { onEvent as transactionSearch } from '../../src/infra/lambda/transaction-search.js'
import { InfraPropsSchema } from '../../src/infra/props.js'
import { RUNNERS, synth } from './templates.js'

const logsWith = (messages: string[], fail = false): { client: LogsClient; asked: Record<string, unknown>[] } => {
  const asked: Record<string, unknown>[] = []
  const client: LogsClient = {
    send: (async (cmd: unknown) => {
      if (!(cmd instanceof GetLogEventsCommand)) throw new Error('unexpected command')
      asked.push(cmd.input as unknown as Record<string, unknown>)
      if (fail) throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' })
      return { events: messages.map((message) => ({ message })) }
    }) as LogsClient['send'],
  }
  return { client, asked }
}

describe("a failed image build's log tail", () => {
  it('keeps the lines that say what went wrong and the last few, in order, from the end of the log', async () => {
    const noise = Array.from({ length: 40 }, (_, i) => `#7 [3/9] RUN apt-get install … step ${i}\n`)
    const { client, asked } = logsWith([
      'trace: no published image for this source: building it\n',
      ...noise.slice(0, 20),
      'ERROR: failed to solve: ubuntu:24.04: toomanyrequests: You have reached your pull rate limit\n',
      '#8 12.3 E: Unable to locate package kicad\n',
      ...noise.slice(20),
      '[Container] Command did not exit successfully docker build … exit status 1\n',
    ])
    const tail = await buildLogTail(client, 'TraceStack-AgentImageBuildLogs', 'stream-1')
    expect(asked[0]).toMatchObject({ logGroupName: 'TraceStack-AgentImageBuildLogs', logStreamName: 'stream-1', startFromHead: false })
    const lines = tail.split('\n')
    // the cause, though 21 lines from the end
    expect(lines[0]).toMatch(/toomanyrequests: You have reached your pull rate limit/)
    // apt's own error line too, and not a line that only has "e: " in it (the first, "source: building")
    expect(lines[1]).toMatch(/E: Unable to locate package kicad/)
    expect(tail).not.toContain('no published image')
    // then the last 8, ending with the command that failed
    expect(lines.slice(2)).toHaveLength(8)
    expect(lines.at(-1)).toMatch(/Command did not exit successfully/)
    // the noise in between is left out
    expect(tail).not.toContain('step 5')
  })

  it('stays within what CloudFormation shows, keeping the end', async () => {
    const long = Array.from({ length: 150 }, (_, i) => `npm ERR! line ${i} ${'x'.repeat(40)}\n`)
    const tail = await buildLogTail(logsWith(long).client, 'g', 's')
    expect(tail.length).toBeLessThanOrEqual(LOG_TAIL_CHARS + 1)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail).toContain('line 149')
  })

  it('is empty when there is no log, or it cannot be read: the message still has the phase and the link', async () => {
    expect(await buildLogTail(logsWith(['x']).client, undefined, 's')).toBe('')
    expect(await buildLogTail(logsWith(['x'], true).client, 'g', 's')).toBe('')
  })

  it("lets only the poll function read only the agent image build's log group", () => {
    const s = synth(InfraPropsSchema.parse({ account: '123456789012', region: 'us-east-1', repositories: ['a/b'], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'm@example.com', runners: RUNNERS }), 'ImageLogs')
    type St = { Sid?: string; Action: string | string[]; Resource: unknown }
    const policies = Object.entries(s.parent.findResources('AWS::IAM::Policy') as Record<string, { Properties: { PolicyDocument: { Statement: St[] } } }>)
    const withTail = policies.filter(([, p]) => p.Properties.PolicyDocument.Statement.some((x) => x.Sid === 'ImageBuildLogTail'))
    expect(withTail.map(([id]) => id)).toHaveLength(1)
    expect(withTail[0]?.[0]).toMatch(/^ImageBuildPoll/)
    const st = withTail[0]?.[1].Properties.PolicyDocument.Statement.find((x) => x.Sid === 'ImageBuildLogTail')
    expect(st?.Action).toBe('logs:GetLogEvents')
    expect(JSON.stringify(st?.Resource)).toMatch(/AgentImageBuildLogs/)
    expect(JSON.stringify(st?.Resource)).not.toContain('"*"')
  }, 300_000)

  const pollEvent = (wait: boolean) => ({
    RequestType: 'Create', PhysicalResourceId: 'uri#trace-agent-image:42',
    ResourceProperties: { ServiceToken: 'x', ProjectName: 'trace-agent-image', ImageUri: 'uri', SourceHash: 'h', Wait: String(wait) },
  }) as unknown as CloudFormationCustomResourceEvent & { PhysicalResourceId: string }
  const failed: BuildsClient = {
    send: (async (cmd: unknown) => {
      if (!(cmd instanceof BatchGetBuildsCommand)) throw new Error('unexpected command')
      return { builds: [{ buildStatus: 'FAILED', phases: [{ phaseType: 'BUILD', phaseStatus: 'FAILED', contexts: [{ message: 'Error while executing command: docker build … exit status 1' }] }], logs: { groupName: 'g', streamName: 's', deepLink: 'https://console/link' } }] }
    }) as BuildsClient['send'],
  }

  it('fails a failed build with its phase, its link and the end of its log', async () => {
    const logs = logsWith(['Step 3/9 : RUN apt-get update\n', 'E: Failed to fetch http://ports.ubuntu.com/… 503 Service Unavailable\n']).client
    const err = await checkBuild(pollEvent(true), { codebuild: failed, logs }).then(() => null, (e: unknown) => e as Error)
    expect(err?.message).toMatch(/^the image build failed in BUILD: Error while executing command: docker build … exit status 1 \(logs: https:\/\/console\/link\)/)
    expect(err?.message).toMatch(/The end of its log:\nStep 3\/9 : RUN apt-get update\nE: Failed to fetch .* 503 Service Unavailable$/)
  })

  it('takes the event only, as Lambda calls it: its callback is never mistaken for a client', async () => {
    // Lambda calls every handler (event, context, callback): a handler with a parameter for anything else gets the
    // callback there, and calling it ends the invocation with null ("Cannot read properties of null (reading
    // 'IsComplete')" in the Provider framework)
    for (const h of [isComplete, runnerWebhook, transactionSearch]) expect(h.length).toBeLessThanOrEqual(1)
    const callback = (): never => { throw new Error('Lambda\'s callback was called') }
    const handler = isComplete as unknown as (e: unknown, ctx: unknown, cb: unknown) => ReturnType<typeof isComplete>
    expect(await handler(pollEvent(false), {}, callback)).toEqual({ IsComplete: true, Data: { ImageUri: 'uri', BuildId: 'trace-agent-image:42' } })
  })

  /** What CloudFormation receives for a failed resource, as the Provider framework builds it (aws-cdk-lib
   * custom-resources provider-framework runtime): the handler's message, a blank line, its Logs line and a blank
   * line, then the error's stack after its first line (Lambda's trace), in a response with the stack, request and
   * physical ids. CloudFormation refuses one over 4096 bytes ("Response object is too long"). */
  const responseBytes = (e: Error): number => {
    const message = [e.message, '', `Logs: /aws/lambda/TraceStack-ImageBuildPollAF9FCDC2-${'M'.repeat(12)}`, ''].join('\n')
    const trace = (e.stack ?? '').split('\n')
    const reason = [message, ...trace.slice(1)].join('\n')
    return Buffer.byteLength(JSON.stringify({
      Status: 'FAILED', Reason: reason,
      StackId: `arn:aws:cloudformation:ap-southeast-2:346073464284:stack/TraceStack/${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(12)}`,
      RequestId: '8ff0f4f7-27ea-4cd6-a232-d197a6118285',
      PhysicalResourceId: `346073464284.dkr.ecr.ap-southeast-2.amazonaws.com/trace-agent:${'a'.repeat(64)}#trace-agent-image:${'b'.repeat(36)}`,
      LogicalResourceId: 'AgentImage', NoEcho: false,
    }), 'utf8')
  }
  const link = `https://console.aws.amazon.com/cloudwatch/home?region=ap-southeast-2#logsV2:log-groups/log-group/TraceStack-AgentImageBuildLogsFB8FD3E5-${'x'.repeat(12)}/log-events/${'8'.repeat(36)}`

  it('fits what CloudFormation accepts, however long the command and the log', async () => {
    // the buildspec command (about 700 characters), clipped as checkBuild clips it
    const command = `Error while executing command: export DOCKER_BUILDKIT=1 PINNED="" ${'x'.repeat(700)}. Reason: exit status 1`
    const head = `the image build failed in BUILD: ${command.slice(0, CONTEXT_MAX - 1)}… (logs: ${link})`
    const cases = {
      // a long log, every line telling, with quotes, backslashes and multi-byte characters JSON and UTF-8 make longer
      quoted: Array.from({ length: 200 }, (_, i) => `npm ERR! "step ${i}" failed \\ ✗ ${'é'.repeat(30)}`).join('\n'),
      // one line longer than the whole budget
      oneLine: `#9 ERROR: ${'ü'.repeat(5000)} the end`,
      empty: '',
    }
    for (const [name, tail] of Object.entries(cases)) {
      const e = buildFailure(head, tail)
      expect(responseBytes(e), name).toBeLessThanOrEqual(4096)
      // the cause is still there: the head whole, and the end of the log
      expect(e.message.startsWith(head), name).toBe(true)
      if (name === 'quoted') expect(e.message).toMatch(/"step 199" failed/)
      if (name === 'oneLine') expect(e.message).toMatch(/the end$/)
      // a one-line stack: the framework would send a multi-line message's later lines twice
      expect(e.stack?.split('\n'), name).toHaveLength(1)
    }
  })

  it('keeps the build log group when the stack rolls back, so the whole log can be read', () => {
    const s = synth(InfraPropsSchema.parse({ account: '123456789012', region: 'us-east-1', repositories: ['a/b'], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'm@example.com', runners: RUNNERS }), 'ImageLogsKept')
    const groups = Object.entries(s.parent.findResources('AWS::Logs::LogGroup') as Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>).filter(([id]) => id.startsWith('AgentImageBuildLogs'))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.[1]).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' })
  }, 300_000)
})
