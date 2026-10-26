/**
 * The CDK app of trace's own CI: one small stack, TraceCi, holding the CodeBuild runner project (src/infra/runner.ts)
 * that every GitHub Actions job of trace's own repository runs on (`runs-on: codebuild-trace-ci-<run id>-<attempt>`).
 * It is separate from the installation's stack (src/infra/app.ts): trace's repository is built on AWS whether or not
 * an installation onboards it, and the installation's own runner projects are per-project (src/infra/project.ts).
 *
 *   npm run deploy:ci -- -c connectionArn=arn:aws:codeconnections:<region>:<account>:connection/<id>
 *
 * Settings, from CDK context (-c) or the environment:
 *   connectionArn  / TRACE_CONNECTION_ARN   the AWS CodeConnections connection to GitHub (required)
 *   repository     / TRACE_CI_REPOSITORY    OWNER/REPO (default mteichtahl/trace)
 *   computeType    / TRACE_CI_COMPUTE_TYPE  (default BUILD_GENERAL1_LARGE)
 *   image          / TRACE_CI_IMAGE         (default aws/codebuild/standard:7.0)
 *   privileged     / TRACE_CI_PRIVILEGED    'true' for Docker-in-Docker (default false)
 * The account and region are the deploying credentials' (CDK_DEFAULT_ACCOUNT, CDK_DEFAULT_REGION).
 */
import { pathToFileURL } from 'node:url'
import { App, Stack } from 'aws-cdk-lib'
import { SELF_CI_PROJECT, projectSlug } from '../core/project.js'
import { InfraPropsSchema } from './props.js'
import { RunnerProject } from './runner.js'

export const CI_STACK = 'TraceCi'
export const CI_REPOSITORY = 'mteichtahl/trace'

export interface CiSettings { repository: string; connectionArn: string; computeType: string; image: string; privileged: boolean }

/** The CI stack's settings from context and the environment, checked as `runners` is (src/infra/props.ts). */
export function ciSettings(context: (key: string) => unknown, env: NodeJS.ProcessEnv = process.env): CiSettings {
  const get = (key: string, name: string): string | undefined => {
    const v = context(key) ?? env[name]
    return v === undefined || v === '' ? undefined : String(v)
  }
  const connectionArn = get('connectionArn', 'TRACE_CONNECTION_ARN')
  if (!connectionArn) {
    throw new Error('TraceCi needs the AWS CodeConnections connection to GitHub: pass -c connectionArn=arn:aws:codeconnections:<region>:<account>:connection/<id>, or set TRACE_CONNECTION_ARN')
  }
  const repository = projectSlug(get('repository', 'TRACE_CI_REPOSITORY') ?? CI_REPOSITORY)
  const runners = InfraPropsSchema.shape.runners.parse({
    connectionArn,
    computeType: get('computeType', 'TRACE_CI_COMPUTE_TYPE'),
    image: get('image', 'TRACE_CI_IMAGE'),
    privileged: get('privileged', 'TRACE_CI_PRIVILEGED') === undefined ? undefined : get('privileged', 'TRACE_CI_PRIVILEGED') === 'true',
  })
  return { repository, ...runners }
}

/** The TraceCi stack: trace's own runner project, named SELF_CI_PROJECT. */
export class TraceCiStack extends Stack {
  readonly runner: RunnerProject

  constructor(scope: App, id: string, s: CiSettings, env?: { account?: string; region?: string }) {
    super(scope, id, { env, description: `trace's own CI: the CodeBuild GitHub Actions runner project of ${s.repository}` })
    this.runner = new RunnerProject(this, 'Runner', { name: SELF_CI_PROJECT, ...s, tags: { 'trace:ci': s.repository } })
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
