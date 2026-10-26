/**
 * `npm run deploy:ci` (src/infra/ci-deploy.ts): nothing up front. It reuses an authorized GitHub connection (its own
 * trace-ci-github first, then an installation's), else lets TraceCi create trace-ci-github, deploys without the runner,
 * waits for a person to authorize it, and deploys again with the runner.
 */
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import { GetConnectionCommand, ListConnectionsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-codeconnections'
import { describe, expect, it } from 'vitest'
import { CI_PREFER, ciOutputs, deployCi, takeConnectionArg } from '../../src/infra/ci-deploy.js'

const CI = 'arn:aws:codeconnections:us-east-1:123456789012:connection/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const INSTALL = 'arn:aws:codeconnections:us-east-1:123456789012:connection/11111111-2222-3333-4444-555555555555'
const URL = 'https://us-east-1.console.aws.amazon.com/codesuite/settings/connections?region=us-east-1'
type Conn = { arn: string; name: string; status: string }

/** A fake CodeConnections with these connections, GetConnection answering `statuses` in turn for any ARN. */
function connections(list: Conn[], statuses: string[] = []): { send: (c: unknown) => Promise<never>; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    send: async (c: unknown) => {
      sent.push((c as object).constructor.name)
      if (c instanceof ListConnectionsCommand) return { Connections: list.map((x) => ({ ConnectionArn: x.arn, ConnectionName: x.name, ConnectionStatus: x.status })) } as never
      if (c instanceof ListTagsForResourceCommand) return { Tags: [] } as never
      if (c instanceof GetConnectionCommand) {
        const known = list.find((x) => x.arn === c.input.ConnectionArn) ?? { arn: c.input.ConnectionArn ?? '', name: 'trace-ci-github', status: 'PENDING' }
        return { Connection: { ConnectionArn: known.arn, ConnectionName: known.name, ProviderType: 'GitHub', ConnectionStatus: statuses.shift() ?? known.status } } as never
      }
      throw new Error(`unexpected ${(c as object).constructor.name}`)
    },
  }
}

/** Runs deployCi against fakes; `stack` is TraceCi's outputs before the first deploy (null: none), `after` after it. */
async function run(o: { list: Conn[]; statuses?: string[]; stack?: Record<string, string> | null; after?: Record<string, string>; args?: string[]; env?: NodeJS.ProcessEnv; code?: number }) {
  const cdk: string[][] = []
  const lines: string[] = []
  let deployed = false
  const code = await deployCi({ args: o.args ?? [], env: o.env ?? {} }, {
    connections: connections(o.list, o.statuses), region: 'us-east-1',
    outputs: async () => (deployed ? (o.after ?? null) : (o.stack ?? null)),
    cdk: async (a) => { cdk.push(a); deployed = true; return o.code ?? 0 },
    report: (l) => lines.push(l),
    wait: { pollMs: 15_000, now: () => new Date(2026, 9, 26, 10, 42, 0).getTime(), sleep: async () => undefined },
  })
  return { code, cdk, lines }
}

describe('npm run deploy:ci', () => {
  it('reuses an authorized connection, its own first, then an installation\'s, saying which, and deploys once with the runner', async () => {
    expect(CI_PREFER).toEqual(['trace-ci-github', 'trace-github'])
    const both = await run({ list: [{ arn: INSTALL, name: 'trace-github', status: 'AVAILABLE' }, { arn: CI, name: 'trace-ci-github', status: 'AVAILABLE' }] })
    expect(both.lines).toEqual([`Using the GitHub connection trace-ci-github (${CI}), already authorized.`])
    expect(both.cdk).toEqual([['deploy', 'TraceCi', '--app', 'node dist/infra/ci-app.js', '-c', 'connectionReady=true', '-c', `connectionArn=${CI}`]])
    const install = await run({ list: [{ arn: INSTALL, name: 'trace-github', status: 'AVAILABLE' }, { arn: CI, name: 'trace-ci-github', status: 'PENDING' }] })
    expect(install.lines).toEqual([`Using the GitHub connection trace-github (${INSTALL}), already authorized.`])
    expect(install.cdk).toHaveLength(1)
    expect(install.cdk[0]).toContain(`connectionArn=${INSTALL}`)
  })

  it('with none authorized lets the stack create trace-ci-github, deploys without the runner, waits, and deploys again with it', async () => {
    const r = await run({ list: [], statuses: ['PENDING', 'AVAILABLE'], after: { GithubConnectionArn: CI, GithubConnectionCreated: 'true' }, args: ['--profile', 'ci'] })
    expect(r.code).toBe(0)
    // no connection ARN: the stack's own; the arguments after -- passed through
    expect(r.cdk).toEqual([
      ['deploy', 'TraceCi', '--app', 'node dist/infra/ci-app.js', '-c', 'connectionReady=false', '--profile', 'ci'],
      ['deploy', 'TraceCi', '--app', 'node dist/infra/ci-app.js', '-c', 'connectionReady=true', '--profile', 'ci'],
    ])
    expect(r.lines).toEqual([
      'No authorized GitHub connection in this account and region: the deploy creates trace-ci-github, without the build runners, and you authorize it once after the deploy.',
      `The GitHub connection trace-ci-github is waiting for a person to authorize it (once for this AWS account and region). Open ${URL}, choose trace-ci-github, then "Update pending connection": that installs or picks the AWS Connector for GitHub app. Give the app access to mteichtahl/trace. npm run deploy:ci carries on by itself once it is authorized.`,
      'Waiting for trace-ci-github to be authorized (status PENDING): checking again at 10:42:15.',
      'The GitHub connection trace-ci-github is authorized. Deploying TraceCi again: this only adds the build runner (mteichtahl/trace) and its GitHub webhook.',
    ])
  })

  it('keeps using the connection TraceCi created on a re-run, and stops at the timeout before the second deploy', async () => {
    const stack = { GithubConnectionArn: CI, GithubConnectionCreated: 'true' }
    const done = await run({ list: [{ arn: CI, name: 'trace-ci-github', status: 'AVAILABLE' }], stack, after: stack })
    expect(done.cdk).toEqual([['deploy', 'TraceCi', '--app', 'node dist/infra/ci-app.js', '-c', 'connectionReady=true']])
    expect(done.lines[0]).toBe(`Using the GitHub connection trace-ci-github (${CI}), which this stack created, already authorized.`)
    const cdk: string[][] = []
    let t = 0
    await expect(deployCi({ args: [], env: {} }, {
      connections: connections([{ arn: CI, name: 'trace-ci-github', status: 'PENDING' }]), region: 'us-east-1',
      outputs: async () => stack, cdk: async (a) => { cdk.push(a); return 0 }, report: () => undefined,
      wait: { pollMs: 60_000, timeoutMs: 120_000, now: () => t, sleep: async (ms) => { t += ms } },
    })).rejects.toThrow(/still not authorized after 2 minutes.*then run npm run deploy:ci again: it resumes from here with the same connection/)
    expect(cdk).toHaveLength(1)
  })

  it('takes a connection from TRACE_CONNECTION_ARN or -c connectionArn=, and stops when the first deploy fails', async () => {
    const list = [{ arn: INSTALL, name: 'mine', status: 'AVAILABLE' }, { arn: CI, name: 'trace-ci-github', status: 'AVAILABLE' }]
    const env = await run({ list, env: { TRACE_CONNECTION_ARN: INSTALL } })
    expect(env.cdk[0]).toContain(`connectionArn=${INSTALL}`)
    expect(env.lines[0]).toBe(`Using the GitHub connection mine (${INSTALL}) you gave, already authorized.`)
    const arg = await run({ list, args: ['-c', `connectionArn=${INSTALL}`, '--verbose'] })
    expect(arg.cdk).toEqual([['deploy', 'TraceCi', '--app', 'node dist/infra/ci-app.js', '-c', 'connectionReady=true', '-c', `connectionArn=${INSTALL}`, '--verbose']])
    expect(takeConnectionArg(['--context=connectionArn=x', '-c', 'a=b'])).toEqual({ given: 'x', rest: ['-c', 'a=b'] })
    const failed = await run({ list: [], code: 3 })
    expect(failed.code).toBe(3)
    expect(failed.cdk).toHaveLength(1)
  })

  it('reads TraceCi\'s outputs, or null when it is not deployed', async () => {
    const cfn = (r: () => unknown) => ({ send: async (c: unknown) => { expect(c).toBeInstanceOf(DescribeStacksCommand); return r() as never } })
    expect(await ciOutputs(cfn(() => ({ Stacks: [{ StackStatus: 'CREATE_COMPLETE', Outputs: [{ OutputKey: 'GithubConnectionArn', OutputValue: CI }] }] })))).toEqual({ GithubConnectionArn: CI })
    expect(await ciOutputs(cfn(() => { throw new Error('Stack with id TraceCi does not exist') }))).toBeNull()
    await expect(ciOutputs(cfn(() => { throw new Error('AccessDenied') }))).rejects.toThrow('AccessDenied')
  })
})
