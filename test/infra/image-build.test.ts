/**
 * A failed image build says why (src/infra/lambda/image-build.ts buildLogTail): its message carries the end of the
 * build's log, because the stack's rollback deletes the build project and its log group before anyone can read them.
 */
import { GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { describe, expect, it } from 'vitest'
import { LOG_TAIL_CHARS, type LogsClient, buildLogTail } from '../../src/infra/lambda/image-build.js'
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
})
