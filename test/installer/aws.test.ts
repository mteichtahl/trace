/**
 * The installer's AWS calls around the deploy (src/installer/aws.ts), against fake SDK clients: the nested stacks'
 * outputs, which projects the stack has, which fixed names are taken in the account, and the GPU image build.
 */
import { ListMemoriesCommand } from '@aws-sdk/client-bedrock-agentcore-control'
import { DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation'
import { DescribeDeliveryDestinationsCommand, DescribeDeliverySourcesCommand } from '@aws-sdk/client-cloudwatch-logs'
import { BatchGetBuildsCommand, StartBuildCommand } from '@aws-sdk/client-codebuild'
import { DescribeSecretCommand, ResourceNotFoundException } from '@aws-sdk/client-secrets-manager'
import { describe, expect, it } from 'vitest'
import { AnswersSchema } from '../../src/installer/answers.js'
import { type NameClients, deployedProjects, ensureGpuImage, nameIndex, stackOutputs } from '../../src/installer/aws.js'
import { chooseGenerations, projectNames } from '../../src/installer/bootstrap.js'
import { InfraPropsSchema, projectHash, projectOutputs } from '../../src/infra/props.js'

const A = 'mteichtahl/board'
const B = 'mteichtahl/fw'
const HA = projectHash(A)
const HB = projectHash(B)
const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }

/** A fake client: `answer` maps each command to its response (or throws), and every command is recorded. */
function fake(answer: (c: { input: Record<string, unknown> }) => unknown): { send: (c: unknown) => Promise<never>; sent: { name: string; input: Record<string, unknown> }[] } {
  const sent: { name: string; input: Record<string, unknown> }[] = []
  return {
    sent,
    send: async (c: unknown) => {
      const cmd = c as { input: Record<string, unknown>; constructor: { name: string } }
      sent.push({ name: cmd.constructor.name, input: cmd.input })
      return answer(cmd) as never
    },
  }
}

const stack = (outputs: Record<string, string>): { Stacks: unknown[] } => ({ Stacks: [{ Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] })

describe("the stack's outputs", () => {
  const nestedA = `arn:aws:cloudformation:us-east-1:123456789012:stack/TraceStack-Project${HA}Stack-1/abc`
  const nestedB = `arn:aws:cloudformation:us-east-1:123456789012:stack/TraceStack-Project${HB}Stack-2/def`
  const parent = { Layout: 'nested', TraceHome: 's3://b/central', UserPoolId: 'pool' }
  const resources = [
    // two pages, as ListStackResources returns them for a parent with many resources
    { StackResourceSummaries: [{ LogicalResourceId: 'Central7FB44904', ResourceType: 'AWS::S3::Bucket', PhysicalResourceId: 'b' }, { LogicalResourceId: `Project${HA}StackNestedStackProject${HA}StackNestedStackResource7E025588`, ResourceType: 'AWS::CloudFormation::Stack', PhysicalResourceId: nestedA }], NextToken: 't2' },
    { StackResourceSummaries: [{ LogicalResourceId: `Project${HB}StackNestedStackProject${HB}StackNestedStackResource24B83ACE`, ResourceType: 'AWS::CloudFormation::Stack', PhysicalResourceId: nestedB }] },
  ]
  const cfn = (o: { aOutputs?: Record<string, string> } = {}) => fake((c) => {
    if (c instanceof ListStackResourcesCommand) return resources[c.input.NextToken === 't2' ? 1 : 0]
    if (c instanceof DescribeStacksCommand) {
      if (c.input.StackName === 'TraceStack') return stack(parent)
      if (c.input.StackName === nestedA) {
        return stack(o.aOutputs ?? {
          Repository: A, [projectOutputs(A).runtimeArn]: 'arn:runtime/a', [projectOutputs(A).roleArn]: 'arn:role/a', [projectOutputs(A).memoryId]: 'trace_m_a-0123456789',
          // a nested stack can never supply another project's output, nor the parent's
          [projectOutputs(B).runtimeArn]: 'arn:runtime/forged', TraceHome: 's3://forged',
          TraceStackProjectXStackProjectXRuntimeAgentRuntimeArn: 'cdk-reference-output',
        })
      }
      if (c.input.StackName === nestedB) return stack({ Repository: B, [projectOutputs(B).runtimeArn]: 'arn:runtime/b', [projectOutputs(B).secretArn]: 'arn:secret/b' })
    }
    throw new Error(`unexpected ${JSON.stringify(c.input)}`)
  })

  it("reads each project's outputs from its nested stack (the parent carries none), and only that project's", async () => {
    const c = cfn()
    const out = await stackOutputs(creds, 'us-east-1', 'TraceStack', c)
    expect(out).toEqual({
      ...parent,
      [projectOutputs(A).runtimeArn]: 'arn:runtime/a', [projectOutputs(A).roleArn]: 'arn:role/a', [projectOutputs(A).memoryId]: 'trace_m_a-0123456789',
      [projectOutputs(B).runtimeArn]: 'arn:runtime/b', [projectOutputs(B).secretArn]: 'arn:secret/b',
    })
    // ListStackResources (paged), never DescribeStackResources (which stops at 100 resources)
    expect(c.sent.map((x) => x.name)).toEqual(['DescribeStacksCommand', 'ListStackResourcesCommand', 'ListStackResourcesCommand', 'DescribeStacksCommand', 'DescribeStacksCommand'])
  })

  it('refuses a nested stack whose Repository output is not the project its logical id names', async () => {
    await expect(stackOutputs(creds, 'us-east-1', 'TraceStack', cfn({ aOutputs: { Repository: B } }))).rejects.toThrow(/says it is mteichtahl\/fw's/)
  })

  it('reads a flat stack as it always did: its own outputs, no listing', async () => {
    const c = fake((x) => (x instanceof DescribeStacksCommand ? stack({ Layout: 'flat', [projectOutputs(A).runtimeArn]: 'arn:runtime/a' }) : null))
    expect(await stackOutputs(creds, 'us-east-1', 'TraceStack', c)).toEqual({ Layout: 'flat', [projectOutputs(A).runtimeArn]: 'arn:runtime/a' })
    expect(c.sent).toHaveLength(1)
  })

  it('knows which projects the stack has, in either layout, and none when there is no stack', async () => {
    expect(await deployedProjects(cfn(), 'TraceStack')).toEqual(new Set([HA, HB]))
    const flat = fake(() => ({ StackResourceSummaries: [{ LogicalResourceId: `Project${HA}RuntimeC2E59563` }, { LogicalResourceId: `ObservabilityProject${HB}MemoryLogsSource1234ABCD` }, { LogicalResourceId: 'ApiRuntime' }] }))
    expect(await deployedProjects(flat, 'TraceStack')).toEqual(new Set([HA, HB]))
    const none = fake(() => { throw Object.assign(new Error('Stack with id TraceStack does not exist'), { name: 'ValidationError' }) })
    expect(await deployedProjects(none, 'TraceStack')).toEqual(new Set())
    const denied = fake(() => { throw new Error('AccessDenied') })
    await expect(deployedProjects(denied, 'TraceStack')).rejects.toThrow(/AccessDenied/)
  })
})

describe('which names are taken in the account', () => {
  const props = InfraPropsSchema.parse({ account: '123456789012', region: 'us-east-1', repositories: [A, B], model: 'm-x', adminEmail: 'a@example.com' })
  const clients = (o: { memories: string[]; deliveries: string[]; secrets: Record<string, 'live' | 'deleted'> }) => {
    const agentcore = fake((c) => {
      if (!(c instanceof ListMemoriesCommand)) throw new Error('unexpected')
      // two pages
      const half = Math.ceil(o.memories.length / 2)
      return c.input.nextToken ? { memories: o.memories.slice(half).map((id) => ({ id })) } : { memories: o.memories.slice(0, half).map((id) => ({ id })), nextToken: 'n' }
    })
    const logs = fake((c) => {
      if (c instanceof DescribeDeliverySourcesCommand) return { deliverySources: o.deliveries.filter((d) => d.endsWith('-logs')).map((name) => ({ name })) }
      if (c instanceof DescribeDeliveryDestinationsCommand) return { deliveryDestinations: o.deliveries.filter((d) => d.endsWith('-traces')).map((name) => ({ name })) }
      throw new Error('unexpected')
    })
    const secrets = fake((c) => {
      if (!(c instanceof DescribeSecretCommand)) throw new Error('unexpected')
      const s = o.secrets[String(c.input.SecretId)]
      if (!s) throw new ResourceNotFoundException({ message: 'Secrets Manager can\'t find the specified secret.', $metadata: {} })
      return { Name: c.input.SecretId, ...(s === 'deleted' ? { DeletedDate: new Date() } : {}) }
    })
    return { agentcore, logs, secrets }
  }

  it("finds a retained memory by its id, a delivery source or destination by name, and a secret even in its recovery window", async () => {
    const c = clients({
      memories: [`trace_m_${HA}-AbCdEfGhIj`, `trace_m_${HA}_g1-AbCdEfGhIj`, 'other_memory-0123456789', `trace_m_${HB}_g1-AbCdEfGhIj`],
      deliveries: [`trace-m-${HA}-logs`, `trace-m-${HB}-traces`],
      secrets: { [`trace/github-token/${A}`]: 'deleted', [`trace/github-token/${B}@g1`]: 'live' },
    })
    const index = nameIndex(c as unknown as NameClients)
    expect(await index.taken(projectNames(props, A, 0))).toEqual([`trace_m_${HA}`, `trace-m-${HA}-logs`, `trace/github-token/${A}`])
    expect(await index.taken(projectNames(props, A, 2))).toEqual([])
    // generation 0 of B: only its traces destination; trace_m_<hb>_g1 is not generation 0's memory
    expect(await index.taken(projectNames(props, B, 0))).toEqual([`trace-m-${HB}-traces`])
    expect(await index.taken(projectNames(props, B, 1))).toEqual([`trace_m_${HB}_g1`, `trace/github-token/${B}@g1`])
    // the listings are read once
    expect(c.agentcore.sent).toHaveLength(2)
    expect(c.logs.sent.map((x) => x.name)).toEqual(['DescribeDeliverySourcesCommand', 'DescribeDeliveryDestinationsCommand'])
  })

  it('takes the first free generation for a project the stack does not have, and leaves the ones it has alone', async () => {
    const c = clients({
      memories: [`trace_m_${HA}-AbCdEfGhIj`, `trace_m_${HB}-AbCdEfGhIj`],
      deliveries: [`trace-m-${HA}-g1-logs`],
      secrets: { [`trace/github-token/${A}`]: 'deleted' },
    })
    const a = AnswersSchema.parse({
      aws: { region: 'us-east-1', account: '123456789012' }, agents: { model: 'm-x' }, adminEmail: 'a@example.com',
      projects: [{ repo: A }, { repo: B }],
    })
    // B is in the stack: its memory is its own
    const r = await chooseGenerations(a, props, new Set([HB]), nameIndex(c as unknown as NameClients).taken)
    expect(r.changed).toEqual([{ repo: A, from: 0, to: 2, taken: [`trace_m_${HA}`, `trace/github-token/${A}`, `trace-m-${HA}-g1-logs`] }])
    expect(r.answers.projects.map((p) => [p.repo, p.generation])).toEqual([[A, 2], [B, 0]])
    // without memory, only the secret counts
    const noMemory = InfraPropsSchema.parse({ ...props, memory: { enabled: false } })
    expect(projectNames(noMemory, A, 0)).toEqual({ memories: [], deliveries: [], secrets: [`trace/github-token/${A}`] })
    // a generation is never lowered: a project at 3 whose names are free stays at 3
    const at3 = { ...a, projects: [{ ...a.projects[0]!, generation: 3 }] }
    expect((await chooseGenerations(at3, props, new Set(), async () => [])).answers.projects[0]?.generation).toBe(3)
  })
})

describe('the GPU image build', () => {
  const run = new Date('2026-10-26T10:00:00Z')
  const build = (status: string, start: string, extra: Record<string, unknown> = {}) => ({ builds: [{ id: 'x', buildStatus: status, startTime: new Date(start), ...extra }] })

  it('waits for a running build and reports it built', async () => {
    let n = 0
    const cb = fake((c) => (c instanceof BatchGetBuildsCommand ? build(n++ < 2 ? 'IN_PROGRESS' : 'SUCCEEDED', '2026-10-26T10:05:00Z') : null))
    expect(await ensureGpuImage(cb, { buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, pollMs: 0 })).toEqual({ ok: true, detail: 'the GPU image abc is built (trace-gpu-image:1)' })
    expect(cb.sent).toHaveLength(3)
  })

  it('starts again, once and with the same tag, a build that failed before this run', async () => {
    const cb = fake((c) => {
      if (c instanceof StartBuildCommand) return { build: { id: 'trace-gpu-image:2' } }
      if (c instanceof BatchGetBuildsCommand) return (c.input.ids as string[])[0] === 'trace-gpu-image:1' ? build('FAILED', '2026-10-20T10:00:00Z') : build('SUCCEEDED', '2026-10-26T10:30:00Z')
      return null
    })
    const lines: string[] = []
    const r = await ensureGpuImage(cb, { buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, pollMs: 0, log: (l) => lines.push(l) })
    expect(r.ok).toBe(true)
    const start = cb.sent.find((x) => x.name === 'StartBuildCommand')
    expect(start?.input).toEqual({ projectName: 'trace-gpu-image', environmentVariablesOverride: [{ name: 'IMAGE_TAG', value: 'abc' }] })
    expect(lines.join()).toMatch(/started it again \(trace-gpu-image:2\)/)
  })

  it("reports, and does not retry, a build this run's deploy started that failed", async () => {
    const cb = fake((c) => (c instanceof BatchGetBuildsCommand ? build('FAILED', '2026-10-26T10:05:00Z', { phases: [{ phaseType: 'BUILD', phaseStatus: 'FAILED' }], logs: { deepLink: 'https://logs' } }) : null))
    const r = await ensureGpuImage(cb, { buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, pollMs: 0 })
    expect(r).toEqual({ ok: false, detail: 'the GPU image build trace-gpu-image:1 failed in BUILD (logs: https://logs)' })
    expect(cb.sent.map((x) => x.name)).toEqual(['BatchGetBuildsCommand'])
  })

  it('gives up waiting at the timeout, and says there is nothing to wait for without a build id', async () => {
    const cb = fake(() => build('IN_PROGRESS', '2026-10-26T10:05:00Z'))
    expect((await ensureGpuImage(cb, { buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, pollMs: 0, timeoutMs: -1 })).detail).toMatch(/still running/)
    expect((await ensureGpuImage(cb, { buildId: '', imageTag: 'abc', startedAfter: run })).ok).toBe(false)
  })
})
