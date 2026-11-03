/**
 * The installation's runs log group (docs/progress-and-logs.md; the names are src/core/run-logs.ts's): one CloudWatch
 * Logs group, `/trace/<prefix>/runs`, in the main stack (src/infra/stack.ts), kept a month and deleted with the stack
 * (logs are not data). What may touch it:
 *
 *   worker runtime   each project's (src/infra/project.ts): CreateLogStream and PutLogEvents on job/<slug>/* and
 *                    tool/<slug>/* only, its own jobs' and tool calls' streams; TRACE_RUNS_LOG_GROUP in its environment
 *   runner           each repository's CodeBuild runner (src/infra/runner.ts): the same on gha/<slug>/* only, the
 *                    streams `tracectl check` and the harness actions write while a check runs there; TRACE_RUNS_LOG_GROUP
 *                    as a project environment variable, so every build of it has it
 *   API              the people's API runtime (src/infra/api-grants.ts): GetLogEvents on its streams, DescribeLogStreams
 *                    and FilterLogEvents on the group; read only
 *   journey events   the web app's JourneyEvents function (src/infra/web.ts): a subscription filter sends it every batch
 *                    written, and it publishes `log.appended` (a count, never the text)
 *
 * The ARNs are made from the group's name rather than taken from the construct, so a project's nested stack needs no
 * parameter for them. Stream names hold '/', which log stream ARNs allow. The repository in them is the slug (lower
 * case): the writers name their streams that way, as the API reads them (src/core/access.ts RepoSlug).
 *
 * IAM authorizes CreateLogStream, PutLogEvents and GetLogEvents on the log-stream resource
 * (…:log-group:<name>:log-stream:<stream>), DescribeLogStreams and FilterLogEvents on the log-group (…:log-group:<name>,
 * matched with and without the trailing ':*').
 */
import * as iam from 'aws-cdk-lib/aws-iam'
import { projectSlug } from '../core/project.js'
import { runsLogGroup } from '../core/run-logs.js'

export interface Where { partition: string; region: string; account: string }

/** A region's partition, as a plain string (where a policy must stay small and the stack's own is a token). */
export const partitionOf = (region: string): string => (region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws')

/** The group's ARN (the log-group resource), without the trailing ':*'. */
export const runsGroupArn = (w: Where, prefix: string): string => `arn:${w.partition}:logs:${w.region}:${w.account}:log-group:${runsLogGroup(prefix)}`

/** The ARN pattern of the group's streams whose names start with `streamPrefix` (`job/owner/repo/` …). */
export const runsStreamsArn = (w: Where, prefix: string, streamPrefix: string): string => `${runsGroupArn(w, prefix)}:log-stream:${streamPrefix}*`

/** What a writer may do: make its streams and put events in them. */
export const RUN_LOG_WRITE_ACTIONS = ['logs:CreateLogStream', 'logs:PutLogEvents'] as const

/**
 * One statement: write the runs group's streams of these kinds for one repository (`job`, `tool` for a worker; `gha`
 * for a runner).
 */
export function runLogsWriteStatement(w: Where, prefix: string, repository: string, kinds: readonly ('job' | 'tool' | 'gha')[], sid = 'RunLogsWrite'): iam.PolicyStatement {
  const slug = projectSlug(repository)
  return new iam.PolicyStatement({ sid, actions: [...RUN_LOG_WRITE_ACTIONS], resources: kinds.map((k) => runsStreamsArn(w, prefix, `${k}/${slug}/`)) })
}

/** The API's read: GetLogEvents on every stream of the group, DescribeLogStreams and FilterLogEvents on the group. */
export function runLogsReadStatements(w: Where, prefix: string): iam.PolicyStatement[] {
  const group = runsGroupArn(w, prefix)
  return [
    new iam.PolicyStatement({ sid: 'RunLogsReadStreams', actions: ['logs:GetLogEvents'], resources: [`${group}:log-stream:*`] }),
    new iam.PolicyStatement({ sid: 'RunLogsReadGroup', actions: ['logs:DescribeLogStreams', 'logs:FilterLogEvents'], resources: [group, `${group}:*`] }),
  ]
}
