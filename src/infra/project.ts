/**
 * One onboarded project (one entry of `repositories`): its own worker runtime, the roles around it, its GitHub token
 * secret, its AgentCore memory, its GPU job definition and its CodeBuild runner project. The stack makes one per
 * repository, so adding or removing a repository (running the installer again) adds or removes exactly these resources.
 *
 * The worker runtime runs Claude with Bash, so whatever its execution role allows, the agent can do directly with
 * the role's credentials. That role is therefore the line between projects, and it allows only:
 *
 *   S3        read central/* (the datasheets and parts database every project shares, by design) and write it
 *             only with a conditional put (If-Match / If-None-Match: the central store always writes that way, see
 *             src/core/central.ts), never delete it; read/write projects/<slug>/* and jobs/<slug>/*; list only those
 *             prefixes; nothing of access/*, nor of any other project. projects/<slug>/memory-state/* (which memory
 *             records people marked inactive) is read only: writes there are denied. prompts/* (the installation's
 *             prompt overrides) is read only too: nothing grants a write there. projects/<slug>/journey and /chats
 *             (what people decided and said) are read only as well. projects/<slug>/journey-agent (the agents' own
 *             facts about the journey: questions, criterion checks, stuck notes) is written, but only with a
 *             conditional put and never deleted (AgentFactsConditional), the way its store writes
 *   memory    its own memory only (<prefix>_m_<hash>), and on it still only events of actors `<owner>/<repo>/*` and
 *             records under `/trace/<owner>/<repo>/*` (the encodings of src/agents/runtime/memory.ts), as defence in depth
 *   secret    <prefix>/github-token/<slug> only
 *   Batch     SubmitJob only with its own job definitions (GPU, and CPU when there is the CPU queue), on the shared
 *             queues, and only tagged trace:project=<slug>; TerminateJob only on jobs tagged with its slug;
 *             DescribeJobs (no resource-level permissions exist); to wait on its jobs' state-change events
 *             (src/gpu/batch.ts), SQS on queues named <prefix>-<hash>-wait-* only, and Subscribe (its own wait queues
 *             as the only endpoint), Unsubscribe and ListSubscriptionsByTopic on its own job-events topic only;
 *             ListQueues (no resource-level permission), to sweep its left-over wait queues
 *   events    (nested layout only) its own SNS topic <prefix>-<hash>-batch-events (made with or without GPU jobs), an
 *             EventBridge rule <prefix>-<hash>-journey-events sending it the central bucket's "Object Created" events of
 *             its journey record (projects/<slug>/journey/journey.db, which only the API writes), so a worker waiting in
 *             journey.ask is told when a person answers; and, with GPU jobs, an EventBridge rule (default bus) sending it the
 *             "Batch Job State Change" events of the stack's queues whose job definition is one of its own (prefix
 *             match on the definition's ARN without the revision): it submits only with those (ProjectGpuSubmit, and
 *             src/gpu/batch.ts placement uses only TRACE_GPU_JOB_DEFINITION / TRACE_CPU_JOB_DEFINITION, which are
 *             them), so its topic carries its own jobs' events and no other project's. One rule per project: the
 *             default bus allows 300 rules per region by default, and `repositories` is at most 60 (props.ts)
 *   telemetry its own runtime's log group, X-Ray, PutMetricData in the bedrock-agentcore namespace
 *   model     Bedrock InvokeModel on Anthropic models and the account's inference profiles
 *   knowledge bedrock:Retrieve and Start/Get/ListIngestionJob on its own knowledge base only (nested layout,
 *             src/infra/knowledge.ts); its documents are S3 under projects/<slug>/kb/, inside its own prefix
 *   gateway   bedrock-agentcore:InvokeGateway on the installation's library gateway only (gateway.enabled,
 *             src/infra/gateway.ts), which serves the shared datasheets and parts tools
 *
 * Its GitHub OIDC role (assumed by that repository's default-branch workflows only) may invoke only this runtime,
 * read the central store and write it the same conditional way (the worker.runner=actions fallback is the worker
 * in GitHub Actions), read/write projects/<slug>/*, and use its own project's memory exactly as the worker role may
 * (the same actions, actor and namespace conditions: the fallback is the worker, and remembers as it does; the
 * installer sets the repository variable TRACE_MEMORY_ID). Its job role (GPU and CPU jobs) may read/write
 * jobs/<slug>/* only.
 *
 * Its CodeBuild runner project (src/infra/runner.ts, named runnerProjectName: <prefix>-ci-<hash>) is where every
 * GitHub Actions job of the repository runs once it exists (GitHub's runners until then). CodeBuild reaches GitHub
 * through the installation's CodeConnections connection (runners.auth 'connection': the one given in
 * `runners.connectionArn`, or the one the stack created: the parent's, passed in like its other shared values), or
 * through the account's CodeBuild GitHub source credential (runners.auth 'token'); the runner's service role may write
 * its own log group and use that connection, nothing else in AWS, so a job still reaches AWS only by assuming the OIDC
 * role above, exactly as on a GitHub-hosted runner. The installer sets the repository variable TRACE_CODEBUILD_PROJECT
 * from its Project<hash>RunnerProject output, and only then: the variable is what moves the workflows from GitHub's
 * runners to this one. With a connection it exists only once that is authorized (`runners.connectionReady`,
 * src/infra/runner.ts): until then the project has no runner, no runner role or log group, and no such output.
 *
 * Its names that can outlive it in the account (its memory, kept with retainData; its memory's delivery sources and
 * destinations; its secret, in its recovery window) carry its generation when that is above 0 (projectSettings,
 * src/core/project.ts), so a removed project can be added again.
 *
 * Its memory follows retainData: Retain on stack deletion and on removal of the project, or Delete on both.
 *
 * Where it lives is the stack's layout (props.ts `layout`): 'nested' puts each project in its own CloudFormation
 * nested stack (ProjectNestedStack below), whose parameters are what it uses of the parent (the bucket, the agent
 * image and its repository, the OIDC provider, the GPU queue, image, execution role and log group); 'flat' puts it
 * straight in the parent, as installations before nested stacks were made. The construct and its resources are the
 * same either way, with the same names, IAM and removal policies.
 */
import { CfnOutput, Duration, NestedStack, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib'
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore'
import type * as ecr from 'aws-cdk-lib/aws-ecr'
import * as events from 'aws-cdk-lib/aws-events'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import * as sns from 'aws-cdk-lib/aws-sns'
import { Construct } from 'constructs'
import { projectId, projectPrefix as memoryProjectPrefix } from '../agents/runtime/memory.js'
import { MEMORY_STATE } from '../agents/runtime/memory-state.js'
import {
  PROJECT_TAG, githubSecretName, memoryName, projectDataPrefix, projectJobsPrefix, runnerProjectName, workerRuntimeName,
} from '../core/project.js'
import { integrationsPrefix } from '../core/integrations.js'
import type { GatewayRef } from './gateway.js'
import type { GpuCompute } from './gpu.js'
import { ProjectKnowledgeBase } from './knowledge.js'
import { EVENT_ACTIONS, RECORD_ACTIONS, TraceMemory } from './memory.js'
import { RunnerProject } from './runner.js'
import {
  GPU_JOB_VCPUS, type InfraProps, type ProjectRef, REPOSITORY_OUTPUT, kbEnabled, kbOutputs, knowledgeBaseOf, projectOutputs, projectSettings,
} from './props.js'

/** A project's job-events topic, and its EventBridge rule: `<prefix>-<hash>-batch-events` (src/gpu/batch.ts reads the
 * prefix and hash back from the topic's name to name its wait queues). */

/** A project's records that only people change, through the API (src/infra/stack.ts CHATS_PREFIX, JOURNEY_PREFIX). */
export const PEOPLE_RECORDS = ['journey', 'chats'] as const
/** What a project's agents contribute to its journey (src/core/agent-facts.ts AGENT_FACTS_FOLDER): the worker and the
 * workflows write it with conditional puts only, the API reads it. Not under journey/: PeopleRecordsReadOnly's
 * projects/<slug>/journey/* does not match projects/<slug>/journey-agent/*. */
export const AGENT_FACTS = 'journey-agent'
export const batchEventsTopicName = (prefix: string, hash: string): string => `${prefix}-${hash}-batch-events`
/** The rule sending a project's journey-record writes to that topic (journey.ask's wait, src/tools/journey/tools.ts). */
export const journeyEventsRuleName = (prefix: string, hash: string): string => `${prefix}-${hash}-journey-events`
/** The object the API writes for each change to a project's journey record (src/core/journey-store.ts). */
export const journeyRecordKey = (repository: string): string => `${projectDataPrefix(repository)}/${PEOPLE_RECORDS[0]}/journey.db`

/** The central bucket's prefixes: the shared database, the access store beside it (src/core/access.ts), and the
 * installation's prompt overrides (src/prompts/store.ts). */
export const CENTRAL_PREFIX = 'central'
export const ACCESS_PREFIX = 'access'
export const PROMPTS_PREFIX = 'prompts'

const TELEMETRY_ACTIONS = ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets']

/** Reading the installation's optional integrations (`<prefix>/integrations/*`, src/core/integrations.ts): each
 * worker's role when the library gateway is off, the gateway's Lambda when it is on, never both. */
export function integrationsReadStatement(partition: string, region: string, account: string, prefix: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'IntegrationsRead', actions: ['secretsmanager:GetSecretValue'],
    resources: [`arn:${partition}:secretsmanager:${region}:${account}:secret:${integrationsPrefix(prefix)}*`],
  })
}

/** The Bedrock model access the agents need (also the worker.runner=actions fallback). */
export function modelAccess(account: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetInferenceProfile'],
    resources: ['arn:aws:bedrock:*::foundation-model/anthropic.*', `arn:aws:bedrock:*:${account}:inference-profile/*`],
  })
}

/**
 * S3 on the central bucket by prefix: `read` (Get), `readWrite` (Get, Put, Delete) and `conditional` (Get, and Put
 * only with If-Match or If-None-Match). Listing is allowed only under the prefixes named.
 */
export function grantPrefixes(role: iam.IRole, bucket: s3.IBucket, o: { read?: string[]; readWrite?: string[]; conditional?: string[] }): void {
  const obj = (p: string): string => bucket.arnForObjects(`${p}/*`)
  const all = [...(o.read ?? []), ...(o.readWrite ?? []), ...(o.conditional ?? [])]
  if (!all.length) return
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectAttributes'], resources: all.map(obj),
  }))
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket'], resources: [bucket.bucketArn], conditions: { StringLike: { 's3:prefix': all.map((p) => `${p}/*`) } },
  }))
  if (o.readWrite?.length) {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], resources: o.readWrite.map(obj),
    }))
  }
  // S3 checks the conditional-write headers with the s3:if-match and s3:if-none-match condition keys
  for (const key of ['s3:if-match', 's3:if-none-match']) {
    if (!o.conditional?.length) break
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'], resources: o.conditional.map(obj), conditions: { Null: { [key]: 'false' } },
    }))
  }
}

export interface ProjectProps {
  cfg: InfraProps
  project: ProjectRef
  bucket: s3.IBucket
  /** the agent image: repository (pull) and URI */
  images: ecr.IRepository
  imageUri: string
  /** the GitHub OIDC provider's ARN */
  oidcProviderArn: string
  gpu: GpuCompute | null
  /** the installation's S3 vector bucket (src/infra/knowledge.ts VectorStore): null without knowledge bases */
  vectorBucketArn: string | null
  /** environment every worker gets (region, model, TRACE_HOME; its memory's and observability's are added here and later) */
  environment: Record<string, string>
  /** the installation's library gateway (src/infra/gateway.ts): null without one */
  gateway?: GatewayRef | null
  /** how its runner reaches GitHub: the connection (src/infra/runner.ts GithubConnection), or connectionArn null for the
   * account's CodeBuild GitHub source credential (runners.auth 'token'); null while the connection is not authorized
   * yet (runners.connectionReady false), when the project gets no runner */
  runnerSource: { connectionArn: string | null } | null
}

export class ProjectStack extends Construct {
  readonly runtime: CfnRuntime
  readonly runtimeName: string
  readonly role: iam.Role
  readonly actionsRole: iam.Role
  readonly secret: secrets.Secret
  readonly jobDefinitionName: string | null
  /** its jobs' state-change events (null without the GPU queue) */
  readonly jobEventsTopic: sns.Topic | null = null
  /** its CPU job definition (null without the CPU queue) */
  readonly cpuJobDefinitionName: string | null
  /** its names' generation (projectSettings; 0 normally) */
  readonly generation: number
  /** its AgentCore memory (null when memory.enabled is false) */
  readonly memory: TraceMemory | null
  /** its Bedrock knowledge base (null without one: knowledgeBase.enabled false for it, or the flat layout) */
  readonly knowledgeBase: ProjectKnowledgeBase | null
  /** where its repository's GitHub Actions jobs run (src/infra/runner.ts); null until the connection is authorized */
  readonly runner: RunnerProject | null

  constructor(scope: Construct, id: string, p: ProjectProps) {
    super(scope, id)
    const { cfg, project, bucket } = p
    const { slug, hash, repository } = project
    const { region, account, partition } = Stack.of(this)
    this.runtimeName = workerRuntimeName(cfg.prefix, repository)
    const outputs = projectOutputs(repository)
    const settings = projectSettings(cfg, repository)
    this.generation = settings.generation

    // ------------------------------------------------------------------ the project's GitHub token
    // Its value is written by the installer: the project's own fine-grained token, or a copy of the shared one. It is
    // a copy of a credential, not data, so it goes with the project (removalPolicy DESTROY whatever retainData says).
    this.secret = new secrets.Secret(this, 'GithubToken', {
      secretName: githubSecretName(cfg.prefix, repository, settings.generation),
      description: `The GitHub token ${slug}'s trace agent uses (written by \`trace install\`, never by CloudFormation).`,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------ the worker's execution role
    this.role = new iam.Role(this, 'RuntimeRole', {
      roleName: `${cfg.prefix}-w-${hash}-${region}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock-agentcore:${region}:${account}:*` },
        },
      }),
      description: `Run by ${slug}'s trace worker on Bedrock AgentCore: that project's resources only`,
    })
    const role = this.role
    p.images.grantPull(role)
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }))
    const logs = `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${this.runtimeName}-*`
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], resources: [logs, `${logs}:log-stream:*`],
    }))
    role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [`arn:${partition}:logs:${region}:${account}:log-group:*`] }))
    role.addToPolicy(new iam.PolicyStatement({ actions: TELEMETRY_ACTIONS, resources: ['*'] }))
    role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } }))
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
      resources: [`arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
        `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*`],
    }))
    role.addToPolicy(modelAccess(account))
    this.secret.grantRead(role)
    grantPrefixes(role, bucket, { conditional: [CENTRAL_PREFIX], readWrite: [projectDataPrefix(repository), projectJobsPrefix(repository)] })
    // the installation's prompt overrides (src/prompts/store.ts): read only, so an agent can't change its own prompt
    grantPrefixes(role, bucket, { read: [PROMPTS_PREFIX] })
    // which memory records are inactive (projects/<slug>/memory-state, src/agents/runtime/memory-state.ts): read, never
    // written, by the agent: it has Bash and these credentials, and must not bring back a record people turned off
    const memoryState = new iam.PolicyStatement({
      sid: 'MemoryStateReadOnly', effect: iam.Effect.DENY, actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [bucket.arnForObjects(`${projectDataPrefix(repository)}/${MEMORY_STATE}/*`)],
    })
    role.addToPolicy(memoryState)
    // what people decided and said (projects/<slug>/journey: gate signatures, waivers, answers; projects/<slug>/chats):
    // the agent reads them, never writes them; they change only through the API, after its access check
    const peopleRecords = new iam.PolicyStatement({
      sid: 'PeopleRecordsReadOnly', effect: iam.Effect.DENY, actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: PEOPLE_RECORDS.map((p) => bucket.arnForObjects(`${projectDataPrefix(repository)}/${p}/*`)),
    })
    role.addToPolicy(peopleRecords)
    // what the agents contribute to the journey (projects/<slug>/journey-agent, src/core/agent-facts.ts): written through
    // projects/<slug>/*, but only as its store writes, with a conditional put (If-Match / If-None-Match), and never
    // deleted, so a stray unconditional write from Bash cannot clobber another job's facts
    const agentFacts = new iam.PolicyStatement({
      sid: 'AgentFactsConditional', effect: iam.Effect.DENY, actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects(`${projectDataPrefix(repository)}/${AGENT_FACTS}/*`)],
      conditions: { Null: { 's3:if-match': 'true', 's3:if-none-match': 'true' } },
    })
    const agentFactsKept = new iam.PolicyStatement({
      sid: 'AgentFactsNoDelete', effect: iam.Effect.DENY, actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [bucket.arnForObjects(`${projectDataPrefix(repository)}/${AGENT_FACTS}/*`)],
    })
    role.addToPolicy(agentFacts)
    role.addToPolicy(agentFactsKept)

    // ------------------------------------------------------------------ its memory (src/infra/memory.ts)
    this.memory = cfg.memory.enabled
      ? new TraceMemory(this, 'Memory', {
          name: memoryName(cfg.prefix, repository, settings.generation),
          description: `trace: ${slug}'s agents' memory (actors ${slug}/<agent>)`,
          eventExpiryDays: settings.memoryEventExpiryDays,
          // the 'release' step of the move to nested stacks marks it Delete, so the 'drain' deploy after it frees its name
          removalPolicy: cfg.retainData && cfg.layoutMigration !== 'release' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
          tags: { [PROJECT_TAG]: slug, 'trace:installation': cfg.prefix },
        })
      : null
    const memoryEnv: Record<string, string> = {}
    // its own memory only; the actor and namespace conditions stay as defence in depth (the worker role here, and the
    // OIDC role below for the worker.runner=actions fallback)
    const memoryStatements = (memory: TraceMemory): iam.PolicyStatement[] => [
      new iam.PolicyStatement({
        sid: 'ProjectMemoryEvents', actions: [...EVENT_ACTIONS], resources: [memory.memoryArn],
        conditions: { StringLike: { 'bedrock-agentcore:actorId': `${projectId(repository)}/*` } },
      }),
      new iam.PolicyStatement({
        sid: 'ProjectMemoryRecords', actions: [...RECORD_ACTIONS], resources: [memory.memoryArn],
        conditions: { StringLike: { 'bedrock-agentcore:namespace': `${memoryProjectPrefix(repository)}*` } },
      }),
    ]
    if (this.memory) {
      for (const st of memoryStatements(this.memory)) role.addToPolicy(st)
      memoryEnv.TRACE_MEMORY_ID = this.memory.memoryId
    }

    // ------------------------------------------------------------------ its knowledge base (src/infra/knowledge.ts)
    // nested layout only (props.ts kbEnabled); its documents are written under projects/<slug>/kb/, which this role
    // (and the OIDC role below) already may write through projects/<slug>/*
    this.knowledgeBase = p.vectorBucketArn && kbEnabled(cfg, repository)
      ? new ProjectKnowledgeBase(this, 'Knowledge', {
          prefix: cfg.prefix, repository, slug, hash, generation: settings.generation, settings: knowledgeBaseOf(cfg, repository),
          bucket, vectorBucketArn: p.vectorBucketArn, removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        })
      : null
    const kbEnv: Record<string, string> = {}
    if (this.knowledgeBase) {
      for (const st of this.knowledgeBase.statements()) role.addToPolicy(st)
      Object.assign(kbEnv, { TRACE_KB_ID: this.knowledgeBase.knowledgeBaseId, TRACE_KB_DATA_SOURCE_ID: this.knowledgeBase.dataSourceId })
    }

    // ------------------------------------------------------------------ the library gateway (src/infra/gateway.ts)
    // the shared datasheets and parts tools: this role may call the installation's one gateway, nothing more; what the
    // gateway's Lambda reaches is the central store, which this role reaches already
    const gatewayEnv: Record<string, string> = {}
    if (p.gateway) {
      role.addToPolicy(new iam.PolicyStatement({ sid: 'LibraryGateway', actions: ['bedrock-agentcore:InvokeGateway'], resources: [p.gateway.arn] }))
      gatewayEnv.TRACE_GATEWAY_URL = p.gateway.url
    } else {
      // no gateway: the parts tools run here, so this worker reads the installation's optional integrations itself
      // (the agent can then read them too; with the gateway on, only its Lambda can). README "Optional integrations"
      role.addToPolicy(integrationsReadStatement(partition, region, account, cfg.prefix))
      gatewayEnv.TRACE_INTEGRATIONS_PREFIX = integrationsPrefix(cfg.prefix)
    }

    // ------------------------------------------------------------------ GPU jobs: its own definition and job role
    const gpuEnv: Record<string, string> = {}
    const jobDefinitions: string[] = []
    this.jobDefinitionName = null
    this.cpuJobDefinitionName = null
    if (p.gpu) {
      const job = p.gpu.addProjectJob(this, repository)
      this.jobDefinitionName = job.jobDefinitionName
      const def = `arn:${partition}:batch:${region}:${account}:job-definition/${job.jobDefinitionName}`
      const jobs = `arn:${partition}:batch:${region}:${account}:job/*`
      // the CPU queue (src/infra/gpu.ts): its own definition there, under the same tag conditions as the GPU one. IAM
      // authorizes the queue and the definition of a SubmitJob separately, so this and ProjectGpuSubmit together also
      // let a definition go to the other queue; that only ever runs this project's own job role, and a GPU definition
      // on the CPU queue never finds an instance
      if (job.cpu && p.gpu.cpuQueue) {
        this.cpuJobDefinitionName = job.cpu.jobDefinitionName
        const cdef = `arn:${partition}:batch:${region}:${account}:job-definition/${job.cpu.jobDefinitionName}`
        role.addToPolicy(new iam.PolicyStatement({
          sid: 'ProjectCpuSubmit', actions: ['batch:SubmitJob'], resources: [jobs, p.gpu.cpuQueue.jobQueueArn, cdef, `${cdef}:*`],
          conditions: { StringEquals: { [`aws:RequestTag/${PROJECT_TAG}`]: slug } },
        }))
        Object.assign(gpuEnv, { TRACE_CPU_QUEUE: p.gpu.cpuQueue.jobQueueArn, TRACE_CPU_JOB_DEFINITION: job.cpu.jobDefinitionName, TRACE_CPU_JOB_MAX_VCPUS: String(cfg.cpu.vcpus) })
      }
      // SubmitJob authorizes the job, the queue and the definition; every one must carry this project's tag
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'ProjectGpuSubmit', actions: ['batch:SubmitJob'], resources: [jobs, p.gpu.queue.jobQueueArn, def, `${def}:*`],
        conditions: { StringEquals: { [`aws:RequestTag/${PROJECT_TAG}`]: slug } },
      }))
      // tagging on submit (SubmitJob's dependent action); never re-tags another project's job
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'ProjectGpuTag', actions: ['batch:TagResource'], resources: [jobs],
        conditions: {
          StringEquals: { [`aws:RequestTag/${PROJECT_TAG}`]: slug },
          StringEqualsIfExists: { [`aws:ResourceTag/${PROJECT_TAG}`]: slug },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [PROJECT_TAG, 'trace:job', 'trace:kind'] },
        },
      }))
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'ProjectGpuTerminate', actions: ['batch:TerminateJob'], resources: [jobs],
        conditions: { StringEquals: { [`aws:ResourceTag/${PROJECT_TAG}`]: slug } },
      }))
      // DescribeJobs has no resource-level permissions
      role.addToPolicy(new iam.PolicyStatement({ sid: 'ProjectGpuDescribe', actions: ['batch:DescribeJobs'], resources: ['*'] }))
      // its jobs' state changes go to its events topic (below), nested layout only
      if (cfg.layout === 'nested') jobDefinitions.push(job.jobDefinitionName, ...(job.cpu && p.gpu.cpuQueue ? [job.cpu.jobDefinitionName] : []))
      // the definitions' vCPUs: src/gpu/batch.ts caps a job's `vcpus` hint at them
      Object.assign(gpuEnv, { TRACE_GPU_QUEUE: p.gpu.queue.jobQueueArn, TRACE_GPU_JOB_DEFINITION: job.jobDefinitionName, TRACE_GPU_BUCKET: bucket.bucketName, TRACE_GPU_JOB_MAX_VCPUS: String(GPU_JOB_VCPUS) })
    }

    // ------------------------------------------------------------------ its events topic: jobs' state changes, people's answers
    // nested layout only, like the CPU queue and the knowledge base: a flat stack of about 24 projects has no room
    // for three more resources per project. A flat project's worker waits on a timer (src/gpu/batch.ts, journey.ask)
    const eventsEnv: Record<string, string> = {}
    if (cfg.layout === 'nested') {
      const topic = new sns.Topic(this, 'JobEvents', {
        topicName: batchEventsTopicName(cfg.prefix, hash),
        displayName: `trace: ${slug}'s job state changes and journey record changes`.slice(0, 100),
        enforceSSL: true,
      })
      // a target without CDK's SnsTopic helper, whose publish grant has no condition: each is for its own rule only
      const sendTo = (rule: events.Rule, sid: string): void => {
        rule.addTarget({ bind: () => ({ arn: topic.topicArn }) })
        topic.addToResourcePolicy(new iam.PolicyStatement({
          sid, principals: [new iam.ServicePrincipal('events.amazonaws.com')], actions: ['sns:Publish'], resources: [topic.topicArn],
          conditions: { ArnEquals: { 'aws:SourceArn': rule.ruleArn } },
        }))
      }
      if (p.gpu && jobDefinitions.length) {
        // EventBridge: one rule per project on the default bus (300 per region by default; at most 60 projects, two
        // rules each). It matches its definitions by ARN prefix, revision left out (`<arn>:`): a job submitted by name
        // runs the latest revision, and its event names the revision's ARN
        const rule = new events.Rule(this, 'JobEventsRule', {
          ruleName: batchEventsTopicName(cfg.prefix, hash),
          description: `trace: state changes of ${slug}'s jobs on the trace job queues, to its batch-events topic`.slice(0, 512),
          eventPattern: {
            source: ['aws.batch'],
            detailType: ['Batch Job State Change'],
            detail: {
              jobQueue: p.gpu.jobQueueArns,
              jobDefinition: jobDefinitions.map((d) => ({ prefix: `arn:${partition}:batch:${region}:${account}:job-definition/${d}:` })),
            },
          },
        })
        sendTo(rule, 'BatchJobEventsRule')
      }
      // a person's act on the journey record (an answer, above all): the central bucket's own "Object Created" event
      // for this project's journey.db (the bucket sends its events to EventBridge: src/infra/stack.ts), so a worker
      // waiting in journey.ask is told at once. Only the API writes that object (PeopleRecordsReadOnly)
      const journeyRule = new events.Rule(this, 'JourneyEventsRule', {
        ruleName: journeyEventsRuleName(cfg.prefix, hash),
        description: `trace: ${slug}'s journey record written (a person answered, signed, waived), to its events topic`.slice(0, 512),
        eventPattern: {
          source: ['aws.s3'],
          detailType: ['Object Created'],
          detail: { bucket: { name: [bucket.bucketName] }, object: { key: [journeyRecordKey(repository)] } },
        },
      })
      sendTo(journeyRule, 'JourneyEventsRule')
      Tags.of(topic).add(PROJECT_TAG, slug)
      this.jobEventsTopic = topic
      // waiting on them (src/gpu/batch.ts openWaitQueue): its own short-lived queues, by name prefix, subscribed to its own topic
      const waitPrefix = `${cfg.prefix}-${hash}-wait-`
      const waitQueues = `arn:${partition}:sqs:${region}:${account}:${waitPrefix}*`
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'ProjectGpuWaitQueues',
        actions: ['sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:SetQueueAttributes', 'sqs:TagQueue'],
        resources: [waitQueues],
      }))
      // the sweep of its wait queues left over by a killed process (src/gpu/batch.ts sweepWaitQueues): ListQueues has
      // no resource-level permission, so "*"; it lists names only, and the sweep asks with this project's prefix
      role.addToPolicy(new iam.PolicyStatement({ sid: 'ProjectGpuWaitListQueues', actions: ['sqs:ListQueues'], resources: ['*'] }))
      role.addToPolicy(new iam.PolicyStatement({ sid: 'ProjectGpuWaitListSubscriptions', actions: ['sns:ListSubscriptionsByTopic'], resources: [topic.topicArn] }))
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'ProjectGpuWaitSubscribe', actions: ['sns:Subscribe'], resources: [topic.topicArn],
        conditions: { StringEquals: { 'sns:Protocol': 'sqs' }, StringLike: { 'sns:Endpoint': waitQueues } },
      }))
      // Unsubscribe names the subscription (<topic arn>:<id>): safe on its own topic, whose subscriptions are all its own
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'ProjectGpuWaitUnsubscribe', actions: ['sns:Unsubscribe'], resources: [topic.topicArn, `${topic.topicArn}:*`],
      }))
      // the wait queues' names follow from it: <prefix>-<hash>-batch-events (src/gpu/batch.ts waitQueueName)
      eventsEnv.TRACE_BATCH_EVENTS_TOPIC = topic.topicArn
    }

    // ------------------------------------------------------------------ the worker runtime
    this.runtime = new CfnRuntime(this, 'Runtime', {
      agentRuntimeName: this.runtimeName,
      description: `trace: Claude working on ${slug}`.slice(0, 200),
      agentRuntimeArtifact: { containerConfiguration: { containerUri: p.imageUri } },
      roleArn: role.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: { idleRuntimeSessionTimeout: cfg.idleTimeoutSeconds, maxLifetime: cfg.maxLifetimeSeconds },
      filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }],
      environmentVariables: {
        ...p.environment,
        TRACE_AGENT_MODE: 'worker',
        TRACE_PROJECT: slug,
        TRACE_PROJECT_HOME: `s3://${bucket.bucketName}/${projectDataPrefix(repository)}`,
        TRACE_GITHUB_SECRET_ARN: this.secret.secretArn,
        ...memoryEnv,
        ...kbEnv,
        ...gpuEnv,
        ...eventsEnv,
        ...gatewayEnv,
      },
      tags: { [PROJECT_TAG]: slug, 'trace:installation': cfg.prefix },
    })
    this.runtime.node.addDependency(role)

    // ------------------------------------------------------------------ the repository's GitHub OIDC role
    const issuer = 'token.actions.githubusercontent.com'
    this.actionsRole = new iam.Role(this, 'ActionsRole', {
      roleName: `${cfg.prefix}-gh-${hash}-${region}`,
      maxSessionDuration: Duration.hours(2),
      description: `Assumed by ${slug}'s trace workflows on its default branch (GitHub OIDC)`,
      assumedBy: new iam.WebIdentityPrincipal(p.oidcProviderArn, {
        StringEquals: { [`${issuer}:aud`]: 'sts.amazonaws.com' },
        // Only runs on the repository's default branch: workflow_run, issues, schedule and pushes to it. A branch or a
        // pull request can't assume this role, so it can't reach the agent or the central store with its own code.
        StringLike: { [`${issuer}:sub`]: `repo:${repository}:ref:refs/heads/${project.branch}` },
      }),
    })
    this.actionsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [this.runtime.attrAgentRuntimeArn, `${this.runtime.attrAgentRuntimeArn}/*`],
    }))
    this.actionsRole.addToPolicy(modelAccess(account)) // the in-Actions fallback (worker.runner = actions)
    grantPrefixes(this.actionsRole, bucket, { conditional: [CENTRAL_PREFIX], readWrite: [projectDataPrefix(repository)] })
    grantPrefixes(this.actionsRole, bucket, { read: [PROMPTS_PREFIX] })
    this.actionsRole.addToPolicy(memoryState.copy())
    this.actionsRole.addToPolicy(peopleRecords.copy())
    this.actionsRole.addToPolicy(agentFacts.copy())
    this.actionsRole.addToPolicy(agentFactsKept.copy())
    // the in-Actions fallback remembers as the worker does: its own memory, its own actors and namespaces
    if (this.memory) for (const st of memoryStatements(this.memory)) this.actionsRole.addToPolicy(st)
    // and searches and syncs its own knowledge base (the kb-sync job on a push to the default branch, and the fallback)
    if (this.knowledgeBase) for (const st of this.knowledgeBase.statements()) this.actionsRole.addToPolicy(st)

    // ------------------------------------------------------------------ its CI: the CodeBuild runner project (src/infra/runner.ts)
    // every GitHub Actions job of the repository runs here, in this account; its role gives a job no AWS access (a job
    // assumes the OIDC role above for that, as before). With a connection, only once it is authorized (connectionReady)
    const { computeType, image, privileged } = cfg.runners
    this.runner = p.runnerSource
      ? new RunnerProject(this, 'Runner', {
          name: runnerProjectName(cfg.prefix, repository), repository, connectionArn: p.runnerSource.connectionArn, computeType, image, privileged,
          tags: { [PROJECT_TAG]: slug, 'trace:installation': cfg.prefix },
        })
      : null

    for (const r of [role, this.actionsRole]) Tags.of(r).add(PROJECT_TAG, slug)
    Tags.of(this.secret).add(PROJECT_TAG, slug)

    // ------------------------------------------------------------------ outputs (alphanumeric names: the hash)
    const stack = Stack.of(this)
    new CfnOutput(stack, outputs.runtimeArn, { value: this.runtime.attrAgentRuntimeArn, description: `${slug}: its worker runtime (TRACE_AGENT_RUNTIME_ARN)` })
    new CfnOutput(stack, outputs.roleArn, { value: this.actionsRole.roleArn, description: `${slug}: its GitHub OIDC role (TRACE_AWS_ROLE)` })
    new CfnOutput(stack, outputs.secretArn, { value: this.secret.secretArn, description: `${slug}: its GitHub token secret` })
    if (this.jobDefinitionName) new CfnOutput(stack, outputs.jobDefinition, { value: this.jobDefinitionName, description: `${slug}: its GPU job definition` })
    if (this.runner) new CfnOutput(stack, outputs.runnerProject, { value: this.runner.projectName, description: `${slug}: its CodeBuild runner project (TRACE_CODEBUILD_PROJECT)` })
    if (this.memory) new CfnOutput(stack, outputs.memoryId, { value: this.memory.memoryId, description: `${slug}: its AgentCore memory (its worker's TRACE_MEMORY_ID)` })
    // nested layout only, so these are always its nested stack's outputs, never the parent's
    if (this.knowledgeBase) {
      const kb = kbOutputs(repository)
      new CfnOutput(stack, kb.knowledgeBaseId, { value: this.knowledgeBase.knowledgeBaseId, description: `${slug}: its knowledge base (TRACE_KB_ID)` })
      new CfnOutput(stack, kb.dataSourceId, { value: this.knowledgeBase.dataSourceId, description: `${slug}: its knowledge base's data source (TRACE_KB_DATA_SOURCE_ID)` })
    }
  }
}

/**
 * One project in its own nested stack (layout 'nested'): the ProjectStack construct, under the same construct id as
 * in the flat layout (`Project<hash>`), so its logical ids and output names are the same inside the nested template.
 * CDK turns what it uses of the parent into the nested stack's parameters, and what the parent uses of it (the
 * runtime's id and ARN, the memory's id and ARN) into its outputs. The parent re-exports none of the project's own
 * outputs (Project<hash>RuntimeArn, …): the installer reads them from this nested stack (src/installer/aws.ts).
 */
export class ProjectNestedStack extends NestedStack {
  readonly project: ProjectStack

  constructor(scope: Construct, id: string, p: ProjectProps) {
    super(scope, id, { description: `trace: ${p.project.slug}'s worker runtime, roles, token secret, memory, knowledge base, job definitions and CI runner`.slice(0, 1024) })
    this.project = new ProjectStack(this, `Project${p.project.hash}`, p)
    // whose nested stack this is: the installer reads each project's outputs here (the parent carries none of them)
    new CfnOutput(this, REPOSITORY_OUTPUT, { value: p.project.slug, description: 'The repository this nested stack is the project of' })
  }
}
