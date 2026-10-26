/**
 * The installer's AWS calls around the deploy (src/installer/aws.ts), against fake SDK clients: the nested stacks'
 * outputs, which projects the stack has, which fixed names are taken in the account, and the GPU image build.
 */
import { ListMemoriesCommand } from '@aws-sdk/client-bedrock-agentcore-control'
import { DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation'
import { DescribeDeliveryDestinationsCommand, DescribeDeliverySourcesCommand } from '@aws-sdk/client-cloudwatch-logs'
import { BatchGetBuildsCommand, StartBuildCommand } from '@aws-sdk/client-codebuild'
import { GetConnectionCommand, ListConnectionsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-codeconnections'
import { DescribeSecretCommand, ResourceNotFoundException } from '@aws-sdk/client-secrets-manager'
import { describe, expect, it } from 'vitest'
import { AnswersSchema } from '../../src/installer/answers.js'
import { type WaitNotice, activeWaits, checkNow } from '../../src/core/wait.js'
import {
  CONNECTION_WAIT_WHY, GPU_WAIT_WHY, type NameClients, clockTime, deployedProjects, ensureGpuImage, nameIndex, resolveConnection, reusableConnection, stackOutputs, waitForConnection,
} from '../../src/installer/aws.js'
import { chooseGenerations, projectNames } from '../../src/installer/bootstrap.js'
import { InfraPropsSchema, projectHash, projectOutputs } from '../../src/infra/props.js'

const A = 'mteichtahl/board'
const B = 'mteichtahl/fw'
const HA = projectHash(A)
const HB = projectHash(B)
const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }
const CONNECTION = 'arn:aws:codeconnections:us-east-1:123456789012:connection/11111111-2222-3333-4444-555555555555'

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

  /** A clock that moves only when the wait sleeps; a sleep cut short (Check now) moves it by nothing. */
  const clock = (start = Date.parse('2026-10-26T10:10:00Z')) => {
    let t = start
    const slept: number[] = []
    return {
      now: () => t, slept,
      sleep: async (ms: number, early: AbortSignal) => { slept.push(ms); if (!early.aborted) t += ms },
    }
  }

  it('is a declared timer: every 30 seconds by default, each check reported with when the next one is, and why', async () => {
    let n = 0
    const cb = fake((c) => (c instanceof BatchGetBuildsCommand ? build(n++ < 3 ? 'IN_PROGRESS' : 'SUCCEEDED', '2026-10-26T10:05:00Z') : null))
    const c = clock()
    const seen: WaitNotice[] = []
    const r = await ensureGpuImage(cb, { buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, now: c.now, sleep: c.sleep, report: (x) => seen.push(x) })
    expect(r.ok).toBe(true)
    expect(c.slept).toEqual([30_000, 30_000, 30_000])
    expect(seen.map((x) => x.checks)).toEqual([1, 2, 3, 4])
    expect(seen.every((x) => x.source === 'timer' && x.why === GPU_WAIT_WHY && x.what === 'the GPU image abc to build')).toBe(true)
    expect(seen[0]).toMatchObject({ state: 'IN_PROGRESS', lastCheckedAt: '2026-10-26T10:10:00.000Z', nextCheckAt: '2026-10-26T10:10:30.000Z', intervalMs: 30_000 })
    expect(seen.at(-1)).toMatchObject({ state: 'SUCCEEDED', nextCheckAt: null })
    // off the record once it ends
    expect(activeWaits().some((x) => x.id === seen[0]?.id)).toBe(false)
  })

  it('checks a build it started again at once, and retries only once', async () => {
    const c = clock()
    const cb = fake((x) => {
      if (x instanceof StartBuildCommand) return { build: { id: 'trace-gpu-image:2' } }
      if (x instanceof BatchGetBuildsCommand) return build('FAILED', (x.input.ids as string[])[0] === 'trace-gpu-image:1' ? '2026-10-20T10:00:00Z' : '2026-10-20T11:00:00Z')
      return null
    })
    const r = await ensureGpuImage(cb, { buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, now: c.now, sleep: c.sleep })
    expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/^the GPU image build trace-gpu-image:2 failed/) })
    expect(cb.sent.map((x) => x.name)).toEqual(['BatchGetBuildsCommand', 'StartBuildCommand', 'BatchGetBuildsCommand'])
    expect(c.slept).toEqual([])
  })

  it('stops at its deadline (3 hours by default), on time, the build carrying on', async () => {
    const c = clock()
    const t0 = c.now()
    const cb = fake(() => build('IN_PROGRESS', '2026-10-26T10:05:00Z'))
    const r = await ensureGpuImage(cb, { buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, now: c.now, sleep: c.sleep })
    expect(r.detail).toMatch(/is still running; run the installer again later/)
    expect(c.now() - t0).toBe(3 * 3600_000)
    expect(cb.sent).toHaveLength(3 * 3600_000 / 30_000 + 1)
  })

  it('checks now when asked (checkNow with the id it reported), without waiting out the interval', async () => {
    let n = 0
    const cb = fake((c) => (c instanceof BatchGetBuildsCommand ? build(n++ < 1 ? 'IN_PROGRESS' : 'SUCCEEDED', '2026-10-26T10:05:00Z') : null))
    const started = Date.now()
    const r = await ensureGpuImage(cb, {
      buildId: 'trace-gpu-image:1', imageTag: 'abc', startedAfter: run, pollMs: 60_000, now: () => Date.now() - 10_000,
      report: (x) => { if (x.nextCheckAt) setTimeout(() => expect(checkNow(x.id)).toBe(true), 5) },
    })
    expect(r.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('the GitHub connection the CodeBuild runners use', () => {
  const OTHER = 'arn:aws:codeconnections:us-east-1:123456789012:connection/99999999-8888-7777-6666-555555555555'
  const CI = 'arn:aws:codeconnections:us-east-1:123456789012:connection/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const TAGGED = 'arn:aws:codeconnections:us-east-1:123456789012:connection/bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
  const URL = 'https://us-east-1.console.aws.amazon.com/codesuite/settings/connections?region=us-east-1'
  type Conn = { arn: string; name: string; status: string; tagged?: boolean }
  /** a fake CodeConnections: these connections (two pages), and GetConnection answering `statuses` in turn */
  const connections = (o: { list: Conn[]; statuses?: string[]; provider?: string }) => {
    const statuses = [...(o.statuses ?? [])]
    return fake((c) => {
      if (c instanceof ListConnectionsCommand) {
        const page = c.input.NextToken ? o.list.slice(1) : o.list.slice(0, 1)
        return { Connections: page.map((x) => ({ ConnectionArn: x.arn, ConnectionName: x.name, ConnectionStatus: x.status, ProviderType: 'GitHub' })), ...(c.input.NextToken ? {} : { NextToken: 'p2' }) }
      }
      if (c instanceof ListTagsForResourceCommand) {
        const known = o.list.find((x) => x.arn === c.input.ResourceArn)
        return { Tags: known?.tagged ? [{ Key: 'trace:installation', Value: 'lab' }] : [] }
      }
      if (c instanceof GetConnectionCommand) {
        const known = o.list.find((x) => x.arn === c.input.ConnectionArn)
        if (!known) throw Object.assign(new Error('Connection not found'), { name: 'ResourceNotFoundException' })
        return { Connection: { ConnectionArn: c.input.ConnectionArn, ConnectionName: known.name, ProviderType: o.provider ?? 'GitHub', ConnectionStatus: statuses.shift() ?? known.status } }
      }
      throw new Error(`unexpected ${JSON.stringify(c.input)}`)
    })
  }
  /** a clock that only moves when the installer sleeps */
  const clock = (start = new Date(2026, 9, 26, 10, 42, 0).getTime()) => {
    let t = start
    const slept: number[] = []
    return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms }, slept }
  }

  it('reuses an authorized connection in order: <prefix>-github, trace-ci-github, one tagged trace:installation, any; never a pending one', async () => {
    const mine = { arn: CONNECTION, name: 'trace-github', status: 'AVAILABLE' }
    const ci = { arn: CI, name: 'trace-ci-github', status: 'AVAILABLE' }
    const tagged = { arn: TAGGED, name: 'lab-github', status: 'AVAILABLE', tagged: true }
    const any = { arn: OTHER, name: 'someone-else', status: 'AVAILABLE' }
    const prefer = ['trace-github', 'trace-ci-github']
    expect((await reusableConnection(connections({ list: [any, tagged, ci, mine] }), prefer))?.name).toBe('trace-github')
    expect((await reusableConnection(connections({ list: [any, tagged, ci] }), prefer))?.name).toBe('trace-ci-github')
    expect((await reusableConnection(connections({ list: [any, tagged] }), prefer))?.name).toBe('lab-github')
    expect((await reusableConnection(connections({ list: [any] }), prefer))?.name).toBe('someone-else')
    expect(await reusableConnection(connections({ list: [{ ...mine, status: 'PENDING' }, { ...ci, status: 'ERROR' }] }), prefer)).toBeNull()
    // deploy:ci's order: its own first
    expect((await reusableConnection(connections({ list: [mine, ci] }), ['trace-ci-github', 'trace-github']))?.name).toBe('trace-ci-github')
  })

  it('says plainly which authorized connection it reused, and passes it to the stack, which then creates none', async () => {
    const c = connections({ list: [{ arn: OTHER, name: 'someone-else', status: 'PENDING' }, { arn: CI, name: 'trace-ci-github', status: 'AVAILABLE' }] })
    const r = await resolveConnection(c, { prefix: 'trace', deployed: null })
    expect(r).toEqual({ pass: CI, arn: CI, name: 'trace-ci-github', ready: true, message: `Using the GitHub connection trace-ci-github (${CI}), already authorized.` })
    expect(c.sent.map((x) => x.name)).toEqual(['ListConnectionsCommand', 'ListConnectionsCommand'])
    expect(c.sent[0]?.input).toMatchObject({ ProviderTypeFilter: 'GitHub' })
    // never creates anything
    expect(c.sent.map((x) => x.name).filter((n) => /Create/.test(n))).toEqual([])
  })

  it('lets the stack create <prefix>-github when no connection is authorized, and says the runners wait for it', async () => {
    const r = await resolveConnection(connections({ list: [{ arn: OTHER, name: 'someone-else', status: 'PENDING' }] }), { prefix: 'lab', deployed: null })
    expect(r).toEqual({ name: 'lab-github', ready: false, message: 'No authorized GitHub connection in this account and region: the deploy creates lab-github, without the build runners, and you authorize it once after the deploy.' })
    // a pending <prefix>-github left in the account (a deleted stack kept it) is given to the stack, which cannot make another
    const left = await resolveConnection(connections({ list: [{ arn: CONNECTION, name: 'trace-github', status: 'PENDING' }] }), { prefix: 'trace', deployed: null })
    expect(left).toMatchObject({ pass: CONNECTION, arn: CONNECTION, ready: false })
  })

  it("keeps using the connection the stack created, authorized or not, without passing it (the stack keeps managing it)", async () => {
    const deployed = { GithubConnectionArn: CONNECTION, GithubConnectionCreated: 'true' }
    const pending = await resolveConnection(connections({ list: [{ arn: CONNECTION, name: 'trace-github', status: 'PENDING' }, { arn: OTHER, name: 'x', status: 'AVAILABLE' }] }), { prefix: 'trace', deployed })
    expect(pending).toEqual({ arn: CONNECTION, name: 'trace-github', ready: false, message: `The GitHub connection this stack created, trace-github (${CONNECTION}) is not authorized yet (PENDING): the deploy goes ahead without the build runners, and you authorize it once after the deploy.` })
    const ready = await resolveConnection(connections({ list: [{ arn: CONNECTION, name: 'trace-github', status: 'AVAILABLE' }] }), { prefix: 'trace', deployed })
    expect(ready).toEqual({ arn: CONNECTION, name: 'trace-github', ready: true, message: `Using the GitHub connection trace-github (${CONNECTION}), which this stack created, already authorized.` })
    // one it was given before (not its own) is passed again while it is authorized
    const given = await resolveConnection(connections({ list: [{ arn: OTHER, name: 'x', status: 'AVAILABLE' }] }), { prefix: 'trace', deployed: { GithubConnectionArn: OTHER, GithubConnectionCreated: 'false' } })
    expect(given).toMatchObject({ pass: OTHER, ready: true })
  })

  it('uses the connection the answers give, checks it is a GitHub one, and never lists', async () => {
    const c = connections({ list: [{ arn: OTHER, name: 'mine', status: 'AVAILABLE' }] })
    expect(await resolveConnection(c, { prefix: 'trace', given: OTHER })).toEqual({ pass: OTHER, arn: OTHER, name: 'mine', ready: true, message: `Using the GitHub connection mine (${OTHER}) you gave, already authorized.` })
    expect(c.sent.map((x) => x.name)).toEqual(['GetConnectionCommand'])
    expect(await resolveConnection(connections({ list: [{ arn: OTHER, name: 'mine', status: 'PENDING' }] }), { prefix: 'trace', given: OTHER })).toMatchObject({ pass: OTHER, ready: false })
    await expect(resolveConnection(connections({ list: [{ arn: OTHER, name: 'bb', status: 'AVAILABLE' }], provider: 'Bitbucket' }), { prefix: 'trace', given: OTHER })).rejects.toThrow(/a Bitbucket connection, not a GitHub one/)
    await expect(resolveConnection(connections({ list: [] }), { prefix: 'trace', given: CONNECTION })).rejects.toThrow(/does not exist in this account and region/)
    await expect(resolveConnection(connections({ list: [{ arn: OTHER, name: 'e', status: 'ERROR' }] }), { prefix: 'trace', given: OTHER })).rejects.toThrow(/status ERROR/)
  })

  it('waits for a person to authorize it, saying what to do once and when it checks next', async () => {
    const c = connections({ list: [{ arn: CONNECTION, name: 'lab-github', status: 'PENDING' }], statuses: ['PENDING', 'PENDING', 'AVAILABLE'] })
    const lines: string[] = []
    const k = clock()
    await waitForConnection(c, { arn: CONNECTION, name: 'lab-github', status: '' }, { region: 'us-east-1', repos: [A, B], report: (l) => lines.push(l), pollMs: 15_000, ...k })
    expect(k.slept).toEqual([15_000, 15_000])
    expect(lines).toEqual([
      `The GitHub connection lab-github is waiting for a person to authorize it (once for this AWS account and region). Open ${URL}, choose lab-github, then "Update pending connection": that installs or picks the AWS Connector for GitHub app. Give the app access to ${A}, ${B}. The installer carries on by itself once it is authorized.`,
      'Waiting for lab-github to be authorized (status PENDING): checking again at 10:42:15.',
      'Waiting for lab-github to be authorized (status PENDING): checking again at 10:42:30.',
    ])
  })

  it('gives up at the timeout with the link, and says running the tool again resumes', async () => {
    const c = connections({ list: [{ arn: CONNECTION, name: 'trace-github', status: 'PENDING' }] })
    const lines: string[] = []
    const k = clock()
    await expect(waitForConnection(c, { arn: CONNECTION, name: 'trace-github', status: 'PENDING' }, { region: 'us-east-1', repos: [A], report: (l) => lines.push(l), pollMs: 60_000, timeoutMs: 5 * 60_000, ...k }))
      .rejects.toThrow(`the GitHub connection trace-github was still not authorized after 5 minutes. Authorize it at ${URL} ("Update pending connection"), then run the installer again: it resumes from here with the same connection`)
    // checks at +1..+5 minutes, then stops rather than sleep past the deadline
    expect(k.slept).toEqual([60_000, 60_000, 60_000, 60_000, 60_000])
    expect(lines.filter((l) => l.startsWith('Waiting for')).map((l) => /at (\S+)\.$/.exec(l)?.[1])).toEqual(['10:43:00', '10:44:00', '10:45:00', '10:46:00', '10:47:00'])
    // the instructions are said once, not on every check
    expect(lines.filter((l) => l.includes('Update pending connection'))).toHaveLength(1)
  })

  it('puts each check on the record for the page (countdown, Check now), with why it is a timer', async () => {
    const c = connections({ list: [{ arn: CONNECTION, name: 'trace-github', status: 'PENDING' }], statuses: ['PENDING', 'AVAILABLE'] })
    const seen: WaitNotice[] = []
    await waitForConnection(c, { arn: CONNECTION, name: 'trace-github', status: 'PENDING' }, { region: 'us-east-1', repos: [A], report: () => undefined, onWait: (n) => seen.push(n), pollMs: 60_000, ...clock() })
    expect(seen[0]).toMatchObject({ what: 'trace-github to be authorized', source: 'timer', why: CONNECTION_WAIT_WHY, state: 'PENDING', intervalMs: 60_000 })
    expect(seen[0]?.nextCheckAt).not.toBeNull()
    expect(seen.at(-1)).toMatchObject({ state: 'AVAILABLE', nextCheckAt: null })
  })

  it('stops on a connection in ERROR', async () => {
    const c = connections({ list: [{ arn: CONNECTION, name: 'x', status: 'PENDING' }], statuses: ['ERROR'] })
    await expect(waitForConnection(c, { arn: CONNECTION, name: 'x', status: 'PENDING' }, { region: 'us-east-1', repos: [A], report: () => undefined, pollMs: 1, ...clock() })).rejects.toThrow(/status ERROR/)
  })

  it('prints the time of day as HH:MM:SS', () => {
    expect(clockTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('03:04:05')
  })
})
