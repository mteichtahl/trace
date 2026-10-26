/**
 * CI on AWS: GitHub Actions jobs of the onboarded repositories (and runners.extraRepos) run on AWS CodeBuild-hosted
 * runners, so no build or CI job needs a GitHub-hosted runner.
 *
 * The stack holds only what does not touch GitHub: the runners' CodeBuild service role (CloudWatch Logs for its own
 * projects, nothing else). The installer then makes, per repository, a CodeBuild runner project `<prefix>-ci-<hash>`
 * with a WORKFLOW_JOB_QUEUED webhook (src/installer/runners.ts) and sets the repository variable
 * TRACE_CODEBUILD_PROJECT, which the trace workflows' `runs-on` turns into the runner label
 * `codebuild-<project>-<run_id>-<run_attempt>`. Doing that outside CloudFormation means a repository the token cannot
 * administer fails on its own (its workflows stay on GitHub's runners and the summary says why) instead of rolling
 * back the deploy, and needs no token at deploy time.
 *
 * The role is deliberately empty of AWS access: every job a runner takes, a pull request's included, can use the
 * container's credentials, so they reach only the job's own logs. Workflows reach AWS through their repository's
 * GitHub OIDC role (default branch only), exactly as on GitHub's runners. GitHub access for webhooks and runner
 * registration is CodeBuild's account source credential (ImportSourceCredentials), which no job can read.
 */
import { CfnOutput, Stack } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import { RUNNER_ROLE_OUTPUT } from './props.js'

/** A runner project's name: `<prefix>-ci-<hash>` (CodeBuild allows 2–255 of [A-Za-z0-9_-]). */
export const runnerProjectName = (prefix: string, hash: string): string => `${prefix}-ci-${hash}`

export class RunnerSupport extends Construct {
  readonly role: iam.Role

  constructor(scope: Construct, id: string, p: { prefix: string }) {
    super(scope, id)
    const { region, account, partition } = Stack.of(this)
    this.role = new iam.Role(this, 'Role', {
      roleName: `${p.prefix}-ci-runner-${region}`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': account } } }),
      description: 'trace CI runners (CodeBuild-hosted GitHub Actions runners): their own build logs, nothing else',
    })
    const logs = `arn:${partition}:logs:${region}:${account}:log-group:/aws/codebuild/${p.prefix}-ci-*`
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logs, `${logs}:log-stream:*`] }))
    new CfnOutput(Stack.of(this), RUNNER_ROLE_OUTPUT, { value: this.role.roleArn, description: 'The CI runners\' CodeBuild service role (the installer makes the runner projects)' })
  }
}
