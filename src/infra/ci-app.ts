/**
 * The CDK app of trace's own CI: one small stack, TraceCi, holding the CodeBuild runner project (src/infra/runner.ts)
 * that every GitHub Actions job of trace's own repository runs on (`runs-on: codebuild-trace-ci-<run id>-<attempt>`).
 * It is separate from the installation's stack (src/infra/app.ts): trace's repository is built on AWS whether or not
 * an installation onboards it, and the installation's own runner projects are per-project (src/infra/project.ts).
 *
 *   npm run deploy:ci        (scripts/deploy-ci.mjs, src/infra/ci-deploy.ts: nothing to give up front)
 *
 * deploy:ci reuses a GitHub connection already authorized in the account and region (the stack then creates none),
 * else the stack creates `trace-ci-github`, deploys without the runner, shows where to authorize it, waits, and
 * deploys again with the runner (runners.connectionReady, src/infra/runner.ts).
 *
 * Settings, from CDK context (-c) or the environment:
 *   connectionArn   / TRACE_CONNECTION_ARN    an existing AWS CodeConnections connection to GitHub to reuse (optional:
 *                                             without it the stack creates trace-ci-github)
 *   connectionReady / TRACE_CONNECTION_READY  'false' while that connection is not authorized yet: no runner project
 *                                             (default true)
 *   repository      / TRACE_CI_REPOSITORY     OWNER/REPO (default mteichtahl/trace)
 *   computeType     / TRACE_CI_COMPUTE_TYPE   (default BUILD_GENERAL1_LARGE)
 *   image           / TRACE_CI_IMAGE          (default aws/codebuild/standard:7.0)
 *   privileged      / TRACE_CI_PRIVILEGED     'true' for Docker-in-Docker (default false)
 * The account and region are the deploying credentials' (CDK_DEFAULT_ACCOUNT, CDK_DEFAULT_REGION).
 */
import { pathToFileURL } from 'node:url'
import { App, Stack } from 'aws-cdk-lib'
import { SELF_CI_PROJECT, projectSlug } from '../core/project.js'
import { InfraPropsSchema } from './props.js'
import { GithubConnection, RunnerProject } from './runner.js'

export const CI_STACK = 'TraceCi'
export const CI_REPOSITORY = 'mteichtahl/trace'
/** The prefix of the connection TraceCi creates when it is given none: `trace-ci-github` (connectionName). */
export const CI_PREFIX = SELF_CI_PROJECT

export interface CiSettings { repository: string; connectionArn?: string | undefined; connectionReady: boolean; computeType: string; image: string; privileged: boolean }

/** The CI stack's settings from context and the environment, checked as `runners` is (src/infra/props.ts). */
export function ciSettings(context: (key: string) => unknown, env: NodeJS.ProcessEnv = process.env): CiSettings {
  const get = (key: string, name: string): string | undefined => {
    const v = context(key) ?? env[name]
    return v === undefined || v === '' ? undefined : String(v)
  }
  const connectionArn = get('connectionArn', 'TRACE_CONNECTION_ARN')
  const ready = get('connectionReady', 'TRACE_CONNECTION_READY')
  if (ready !== undefined && ready !== 'true' && ready !== 'false') throw new Error(`connectionReady must be true or false, not ${ready}`)
  const repository = projectSlug(get('repository', 'TRACE_CI_REPOSITORY') ?? CI_REPOSITORY)
  const runners = InfraPropsSchema.shape.runners.parse({
    ...(connectionArn ? { connectionArn } : {}),
    ...(ready !== undefined ? { connectionReady: ready === 'true' } : {}),
    computeType: get('computeType', 'TRACE_CI_COMPUTE_TYPE'),
    image: get('image', 'TRACE_CI_IMAGE'),
    privileged: get('privileged', 'TRACE_CI_PRIVILEGED') === undefined ? undefined : get('privileged', 'TRACE_CI_PRIVILEGED') === 'true',
  })
  // TraceCi always reaches GitHub through a connection (runners.auth is the installation's choice)
  const { auth: _auth, ...rest } = runners
  return { repository, ...rest }
}

/** The TraceCi stack: the GitHub connection (given, or trace-ci-github created here) and, once it is authorized,
 * trace's own runner project, named SELF_CI_PROJECT. */
export class TraceCiStack extends Stack {
  readonly connection: GithubConnection
  readonly runner: RunnerProject | null

  constructor(scope: App, id: string, s: CiSettings, env?: { account?: string; region?: string }) {
    super(scope, id, { env, description: `trace's own CI: the CodeBuild GitHub Actions runner project of ${s.repository}` })
    this.connection = new GithubConnection(this, 'GithubConnection', { prefix: CI_PREFIX, connectionArn: s.connectionArn, tags: { 'trace:ci': s.repository } })
    this.runner = s.connectionReady
      ? new RunnerProject(this, 'Runner', {
          name: SELF_CI_PROJECT, repository: s.repository, connectionArn: this.connection.connectionArn,
          computeType: s.computeType, image: s.image, privileged: s.privileged, tags: { 'trace:ci': s.repository },
        })
      : null
  }
}

// run as the app (`cdk deploy TraceCi --app "node dist/infra/ci-app.js"`), not when imported by the tests
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = new App()
  new TraceCiStack(app, CI_STACK, ciSettings((k) => app.node.tryGetContext(k)), {
    account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION,
  })
  app.synth()
}
