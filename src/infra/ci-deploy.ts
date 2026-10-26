/**
 * `npm run deploy:ci` (scripts/deploy-ci.mjs builds, then runs main here): deploys TraceCi (src/infra/ci-app.ts),
 * trace's own CI runner, with nothing to give up front.
 *
 *   1 connection  the GitHub connection: TRACE_CONNECTION_ARN or `-c connectionArn=…` when given; else the one TraceCi
 *                 created on an earlier run (its output); else one already authorized in the account and region
 *                 (trace-ci-github, then trace-github, then any tagged trace:installation, then any), reused, so the
 *                 stack creates none; else none, and the stack creates trace-ci-github. Nothing is created here
 *   2 deploy      `cdk deploy TraceCi -c connectionReady=<whether that connection is AVAILABLE>`
 *   3 authorize   only when it was not: the console link, what to do once, and the time of the next check, until a
 *                 person authorizes it (30 minutes at most; running deploy:ci again resumes with the same connection)
 *   4 runner      then deploy again with connectionReady=true, which only adds the runner project and its webhook
 *
 * AWS credentials and region are the default chain's (AWS_REGION, AWS_DEFAULT_REGION, CDK_DEFAULT_REGION, the
 * profile). Arguments after `--` go to `cdk deploy`.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import { CodeConnectionsClient } from '@aws-sdk/client-codeconnections'
import { CI_CONNECTION_NAME, type ConnectionWait, connectionName, resolveConnection, waitForConnection } from '../installer/aws.js'
import { CI_PREFIX, CI_REPOSITORY, CI_STACK } from './ci-app.js'
import { CONNECTION_OUTPUT } from './props.js'

type Connections = Pick<CodeConnectionsClient, 'send'>

/** The repository's root (dist/infra/ → ../..), where `cdk` runs. */
const ROOT = join(import.meta.dirname, '..', '..')

/** Which connections deploy:ci reuses first: its own, then a default installation's. */
export const CI_PREFER = [CI_CONNECTION_NAME, connectionName('trace')] as const

export interface CiDeployDeps {
  connections: Connections
  region: string
  /** TraceCi's outputs, or null when it is not deployed */
  outputs: () => Promise<Record<string, string> | null>
  /** `cdk …`; its exit code */
  cdk: (args: string[]) => Promise<number>
  report: (line: string) => void
  /** the wait's clock and pace (tests) */
  wait?: Pick<ConnectionWait, 'now' | 'sleep' | 'pollMs' | 'timeoutMs'>
}

/** `-c connectionArn=X` / `--context connectionArn=X` / `-c=connectionArn=X` among the arguments: its value, and the
 * arguments without it (deploy:ci passes the connection it chose itself). */
export function takeConnectionArg(args: readonly string[]): { given?: string; rest: string[] } {
  const rest: string[] = []
  let given: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const inline = /^(?:-c|--context)=connectionArn=(.*)$/.exec(a)
    if (inline) { given = inline[1]; continue }
    const next = args[i + 1] ?? ''
    if ((a === '-c' || a === '--context') && next.startsWith('connectionArn=')) { given = next.slice('connectionArn='.length); i++; continue }
    rest.push(a)
  }
  return { ...(given ? { given } : {}), rest }
}

/** Deploy TraceCi, authorizing a new connection in between when needed. Returns the exit code. */
export async function deployCi(o: { args: readonly string[]; env?: NodeJS.ProcessEnv }, d: CiDeployDeps): Promise<number> {
  const env = o.env ?? process.env
  const { given: fromArgs, rest } = takeConnectionArg(o.args)
  const given = fromArgs || env.TRACE_CONNECTION_ARN || undefined
  const repository = env.TRACE_CI_REPOSITORY || CI_REPOSITORY
  const choice = await resolveConnection(d.connections, { prefix: CI_PREFIX, ...(given ? { given } : {}), deployed: await d.outputs(), prefer: CI_PREFER })
  d.report(choice.message)
  const deploy = (ready: boolean): Promise<number> => d.cdk([
    'deploy', CI_STACK, '--app', 'node dist/infra/ci-app.js', '-c', `connectionReady=${ready}`,
    ...(choice.pass ? ['-c', `connectionArn=${choice.pass}`] : []), ...rest,
  ])
  const first = await deploy(choice.ready)
  if (first !== 0 || choice.ready) return first

  const arn = (await d.outputs())?.[CONNECTION_OUTPUT]
  if (!arn) throw new Error(`${CI_STACK} has no output ${CONNECTION_OUTPUT}`)
  await waitForConnection(d.connections, { arn, name: choice.name, status: '' }, { region: d.region, repos: [repository], report: d.report, tool: 'npm run deploy:ci', ...d.wait })
  d.report(`The GitHub connection ${choice.name} is authorized. Deploying ${CI_STACK} again: this only adds the build runner (${repository}) and its GitHub webhook.`)
  return deploy(true)
}

/** TraceCi's outputs (DescribeStacks), or null when there is no such stack. */
export async function ciOutputs(cfn: Pick<CloudFormationClient, 'send'>): Promise<Record<string, string> | null> {
  try {
    const s = (await cfn.send(new DescribeStacksCommand({ StackName: CI_STACK }))).Stacks?.[0]
    if (!s || s.StackStatus === 'DELETE_COMPLETE') return null
    return Object.fromEntries((s.Outputs ?? []).map((x) => [x.OutputKey ?? '', x.OutputValue ?? '']))
  } catch (e) {
    if (/does not exist/.test(e instanceof Error ? e.message : String(e))) return null
    throw e
  }
}

/** The real thing: the default credential chain, the CDK CLI of this repository, output to the terminal. */
export async function main(args: readonly string[]): Promise<number> {
  const configured = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.CDK_DEFAULT_REGION
  const connections = new CodeConnectionsClient(configured ? { region: configured } : {})
  const region = await connections.config.region()
  const cfn = new CloudFormationClient({ region })
  const cdkBin = createRequire(import.meta.url).resolve('aws-cdk/bin/cdk')
  return deployCi({ args }, {
    connections, region,
    outputs: () => ciOutputs(cfn),
    cdk: (a) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [cdkBin, ...a], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, AWS_REGION: region } })
      p.on('error', reject)
      p.on('close', (code) => resolve(code ?? 1))
    }),
    report: (l) => console.log(`\n${l}\n`),
  })
}
