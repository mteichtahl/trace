/**
 * What a runtime that runs the API's code may do in AWS, made in one place for the two roles that run it:
 *
 *   people     the people's API runtime (`<prefix>_api`): everything below, including what only a person's action
 *              needs (admins' and people's own records: Cognito is granted beside it in stack.ts)
 *   systems    the external runtime (`<prefix>_external`, docs/external-access.md): the connected systems' API. Only
 *              what the actions open to systems (src/api/service-policy.ts) touch, traced action by action:
 *
 *                whoami, projects                     the access store, read; and access/services-seen/ written
 *                                                     (when each system last called: plain puts, never the store)
 *                status, settings.*, runs, run,       the GitHub token
 *                artifact, files.*
 *                journey.get, requirements.trace,     each project's journey record: read, and conditional writes
 *                design.get, cost.get, job.control    (its first import, job.control's holds); a system is never an
 *                                                     admin, so cost.get reads no ledger or actuals
 *                jobs.list, job, build.get            the agents' facts, job index and bench (journey-agent/), read;
 *                                                     the shipped orders' watches, read
 *                graph.neighbourhood (memory)         the projects' memory records and their inactive marks, read
 *                kb.search                            Retrieve on the projects' knowledge bases
 *                task, tool, tools.waits, kb.sync     InvokeAgentRuntime on the projects' workers
 *
 *              and never: Cognito, the central database, prompts, chats, the projects waiting to be created, the cost
 *              actuals, the order watch and its key, the integrations, the dictation vocabularies
 *
 * The people's role gets its statements in the order it always had, so its template does not change with this split.
 */
import type { Construct } from 'constructs'
import type * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { MEMORY_STATE } from '../agents/runtime/memory-state.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { SERVICES_SEEN } from '../core/services-seen.js'
import { ACTUALS_OBJECTS } from './cost.js'
import { KB_RETRIEVE_ACTIONS, knowledgeBaseArn } from './knowledge.js'
import { type TraceMemory, grantReadRecords } from './memory.js'
import { WATCH_OBJECTS } from './order-watch.js'
import { orderWatchSecretsPrefix } from '../core/integrations-catalog.js'
import { ACCESS_PREFIX, AGENT_FACTS, CENTRAL_PREFIX, PEOPLE_RECORDS, PROMPTS_PREFIX, grantPrefixes } from './project.js'
import { apiVocabularyStatement } from './voice.js'

const CHATS: (typeof PEOPLE_RECORDS)[number] = 'chats'
const JOURNEY: (typeof PEOPLE_RECORDS)[number] = 'journey'
const PENDING = 'installation/pending-projects'

export interface ApiGrantsProps {
  /** where the CDK constructs of the people's cost policy go (the stack) */
  scope: Construct
  /** the runtime's name: its own log group */
  runtimeName: string
  region: string
  account: string
  partition: string
  prefix: string
  /** the installation's tag on its runtimes (the workers' grant is scoped by it) */
  installationTag: string
  images: ecr.IRepository
  central: s3.IBucket
  githubToken: secrets.ISecret
  /** each project's worker runtime ARN */
  workers: readonly string[]
  memories: readonly TraceMemory[]
  /** each project's knowledge base id */
  knowledgeBases: readonly string[]
  /** the order watch's function ARN (people only: order.check_now) */
  orderWatchArn: string
}

/**
 * Grant `role` what the API's code needs: `people` true for the people's API runtime (every statement, in its
 * original order), false for the external runtime (only what the actions open to systems need; see the module comment).
 */
export function grantApiRuntime(role: iam.Role, p: ApiGrantsProps, o: { people: boolean }): void {
  const { people } = o
  const arn = (svc: string, rest: string): string => `arn:aws:${svc}:${p.region}:${p.account}:${rest}`
  p.images.grantPull(role)
  role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }))
  const logs = arn('logs', `log-group:/aws/bedrock-agentcore/runtimes/${p.runtimeName}-*`)
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], resources: [logs, `${logs}:log-stream:*`],
  }))
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [arn('logs', 'log-group:*')] }))
  role.addToPolicy(new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'], resources: ['*'] }))
  role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } }))
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
    resources: [arn('bedrock-agentcore', 'workload-identity-directory/default'), arn('bedrock-agentcore', 'workload-identity-directory/default/workload-identity/*')],
  }))
  p.githubToken.grantRead(role)
  if (people) {
    grantPrefixes(role, p.central, { conditional: [CENTRAL_PREFIX] })
    p.central.grantReadWrite(role, `${ACCESS_PREFIX}/*`)
    // the installation's prompt overrides (prompts.set / reset / revert, admins only, src/prompts/store.ts): read, and
    // write only with conditional puts (the central store's way); the workers and workflows only read them
    grantPrefixes(role, p.central, { conditional: [PROMPTS_PREFIX] })
    // which memory records are inactive, per project (memory.deactivate / reactivate, src/agents/runtime/memory-state.ts):
    // read and conditional writes under projects/<slug>/memory-state/ only, nothing else of projects/
    grantPrefixes(role, p.central, { conditional: [`${PROJECTS_PREFIX}/*/${MEMORY_STATE}`] })
    // each project's chats (chats.*, docs/web-build.md: not in the repository) and the projects created from the app
    // waiting for the next stack update (projects.create): read, and write only with conditional puts
    // and each project's journey record (journey.*, docs/web-build.md), under projects/<slug>/journey/
    grantPrefixes(role, p.central, { conditional: [`${PROJECTS_PREFIX}/*/${CHATS}`, `${PROJECTS_PREFIX}/*/${JOURNEY}`, PENDING] })
  } else {
    // systems: the access store read only (the verifier's lookup, projects), and when each system last called, as one
    // small object per system beside it (src/core/services-seen.ts): plain puts there, nothing else of access/
    grantPrefixes(role, p.central, { read: [ACCESS_PREFIX, `${PROJECTS_PREFIX}/*/${MEMORY_STATE}`] })
    role.addToPolicy(new iam.PolicyStatement({ sid: 'ServicesSeen', actions: ['s3:PutObject'], resources: [p.central.arnForObjects(`${ACCESS_PREFIX}/${SERVICES_SEEN}/*`)] }))
    // each project's journey record: read, and conditional writes (its first import; job.control's holds)
    grantPrefixes(role, p.central, { conditional: [`${PROJECTS_PREFIX}/*/${JOURNEY}`] })
  }
  // what each project's agents contribute to its journey (projects/<slug>/journey-agent, src/core/agent-facts.ts),
  // and its job index there (jobs.db, src/core/job-index.ts: jobs.list): read, never written by the API
  // (and what the bench measured, live: projects/<slug>/journey-agent/bench.db, src/core/bench.ts)
  grantPrefixes(role, p.central, { read: [`${PROJECTS_PREFIX}/*/${AGENT_FACTS}`] })
  if (people) {
    // cost and the build's shipping, in a policy of their own (the role's inline policy has a size limit, which CDK
    // would otherwise meet by moving statements into an overflow policy):
    //   the cost ledger (cost.get, usage.month; src/core/cost.ts): the installation's actuals and the price table fetched
    //   from the AWS price list (installation/cost/actuals.db, prices.json), which the cost read writes
    //   (src/infra/cost.ts), read only (each project's estimates are beside its agents' facts, read above); money for
    //   admins only
    //   the shipped orders followed with their carrier (order.update starts a watch, src/core/shipping.ts): read and
    //   conditional writes on installation/shipping/; order.check_now invokes the order watch, that function only
    const costPolicy = new iam.Policy(p.scope, 'ApiRuntimeRoleCostPolicy', { roles: [role] })
    const intoCost = { addToPrincipalPolicy: (st: iam.PolicyStatement) => costPolicy.addStatements(st) }
    grantPrefixes(intoCost, p.central, { read: [ACTUALS_OBJECTS], conditional: [WATCH_OBJECTS] })
    costPolicy.addStatements(new iam.PolicyStatement({ sid: 'OrderWatchCheckNow', actions: ['lambda:InvokeFunction'], resources: [p.orderWatchArn] }))
    // the order watch's carrier key (integrations.set for `dhl`, src/core/integrations-catalog.ts orderWatchSecretsPrefix):
    // admins set it, the API never reads it back
    costPolicy.addStatements(new iam.PolicyStatement({
      sid: 'ManageOrderWatchKey', actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:TagResource'],
      resources: [`arn:${p.partition}:secretsmanager:${p.region}:${p.account}:secret:${orderWatchSecretsPrefix(p.prefix)}*`],
    }))
  } else {
    // build.get's wait lines: the shipped orders' watches, read only
    grantPrefixes(role, p.central, { read: [WATCH_OBJECTS] })
  }
  // every project's worker runtime of this installation: by its exact ARN (from its nested stack's output, or the
  // runtime itself when flat), and on the runtime also by this installation's tag. InvokeAgentRuntime authorizes the
  // runtime and the runtime endpoint (Service Authorization Reference: both resource types take aws:ResourceTag);
  // the endpoint (DEFAULT, made by AgentCore) is not tagged by this stack, so its statement has the ARNs only
  if (p.workers.length) {
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeProjectWorkers', actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: [...p.workers],
      conditions: { StringEquals: { [`aws:ResourceTag/${p.installationTag}`]: p.prefix } },
    }))
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeProjectWorkerEndpoints', actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: p.workers.map((a) => `${a}/runtime-endpoint/*`),
    }))
  }
  grantReadRecords(role, p.memories)
  // dictation: the state of each project's vocabulary for voice.vocabulary (after its access check), nothing more
  if (people) role.addToPolicy(apiVocabularyStatement({ partition: p.partition, region: p.region, account: p.account, prefix: p.prefix }))
  // kb.search on any project's knowledge base, after the access check (src/api/actions.ts); nothing else of them.
  // The ARN is made from the id, so the parent takes one output per knowledge base from its nested stack, not two.
  if (p.knowledgeBases.length) {
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'RetrieveProjectKnowledgeBases', actions: [...KB_RETRIEVE_ACTIONS],
      resources: p.knowledgeBases.map((id) => knowledgeBaseArn(p.partition, p.region, p.account, id)),
    }))
  }
}
