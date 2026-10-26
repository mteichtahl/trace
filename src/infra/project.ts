/**
 * One onboarded project (one entry of `repositories`): its own worker runtime, the roles around it, its GitHub token
 * secret, its AgentCore memory and its GPU job definition. The stack makes one per repository, so adding or removing a repository (running
 * the installer again) adds or removes exactly these resources.
 *
 * The worker runtime runs Claude with Bash, so whatever its execution role allows, the agent can do directly with
 * the role's credentials. That role is therefore the line between projects, and it allows only:
 *
 *   S3        read central/* (the datasheets and parts database every project shares, by design) and write it
 *             only with a conditional put (If-Match / If-None-Match: the central store always writes that way, see
 *             src/core/central.ts), never delete it; read/write projects/<slug>/* and jobs/<slug>/*; list only those
 *             prefixes; nothing of access/*, nor of any other project. projects/<slug>/memory-state/* (which memory
 *             records people marked inactive) is read only: writes there are denied. prompts/* (the installation's
 *             prompt overrides) is read only too: nothing grants a write there
 *   memory    its own memory only (<prefix>_m_<hash>), and on it still only events of actors `<owner>/<repo>/*` and
 *             records under `/trace/<owner>/<repo>/*` (the encodings of src/agents/runtime/memory.ts), as defence in depth
 *   secret    <prefix>/github-token/<slug> only
 *   Batch     SubmitJob only with its own job definitions (GPU, and CPU when there is the CPU queue), on the shared
 *             queues, and only tagged trace:project=<slug>; TerminateJob only on jobs tagged with its slug;
 *             DescribeJobs (no resource-level permissions exist)
 *   telemetry its own runtime's log group, X-Ray, PutMetricData in the bedrock-agentcore namespace
 *   model     Bedrock InvokeModel on Anthropic models and the account's inference profiles
 *   knowledge bedrock:Retrieve and Start/Get/ListIngestionJob on its own knowledge base only (nested layout,
 *             src/infra/knowledge.ts); its documents are S3 under projects/<slug>/kb/, inside its own prefix
 *
 * Its GitHub OIDC role (assumed by that repository's default-branch workflows only) may invoke only this runtime,
 * read the central store and write it the same conditional way (the worker.runner=actions fallback is the worker
 * in GitHub Actions), read/write projects/<slug>/*, and use its own project's memory exactly as the worker role may
 * (the same actions, actor and namespace conditions: the fallback is the worker, and remembers as it does; the
 * installer sets the repository variable TRACE_MEMORY_ID). Its job role (GPU and CPU jobs) may read/write
 * jobs/<slug>/* only.
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
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import { projectId, projectPrefix as memoryProjectPrefix } from '../agents/runtime/memory.js'
import { MEMORY_STATE } from '../agents/runtime/memory-state.js'
import {
  PROJECT_TAG, githubSecretName, memoryName, projectDataPrefix, projectJobsPrefix, workerRuntimeName,
} from '../core/project.js'
import type { GpuCompute } from './gpu.js'
import { ProjectKnowledgeBase } from './knowledge.js'
import { EVENT_ACTIONS, RECORD_ACTIONS, TraceMemory } from './memory.js'
import {
  GPU_JOB_VCPUS, type InfraProps, type ProjectRef, REPOSITORY_OUTPUT, kbEnabled, kbOutputs, knowledgeBaseOf, projectOutputs, projectSettings,
} from './props.js'

/** The central bucket's prefixes: the shared database, the access store beside it (src/core/access.ts), and the
 * installation's prompt overrides (src/prompts/store.ts). */
export const CENTRAL_PREFIX = 'central'
export const ACCESS_PREFIX = 'access'
export const PROMPTS_PREFIX = 'prompts'

const TELEMETRY_ACTIONS = ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets']

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
}

export class ProjectStack extends Construct {
  readonly runtime: CfnRuntime
  readonly runtimeName: string
  readonly role: iam.Role
  readonly actionsRole: iam.Role
  readonly secret: secrets.Secret
  readonly jobDefinitionName: string | null
  /** its CPU job definition (null without the CPU queue) */
  readonly cpuJobDefinitionName: string | null
  /** its names' generation (projectSettings; 0 normally) */
  readonly generation: number
  /** its AgentCore memory (null when memory.enabled is false) */
  readonly memory: TraceMemory | null
  /** its Bedrock knowledge base (null without one: knowledgeBase.enabled false for it, or the flat layout) */
  readonly knowledgeBase: ProjectKnowledgeBase | null

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

    // ------------------------------------------------------------------ GPU jobs: its own definition and job role
    const gpuEnv: Record<string, string> = {}
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
      // the definitions' vCPUs: src/gpu/batch.ts caps a job's `vcpus` hint at them
      Object.assign(gpuEnv, { TRACE_GPU_QUEUE: p.gpu.queue.jobQueueArn, TRACE_GPU_JOB_DEFINITION: job.jobDefinitionName, TRACE_GPU_BUCKET: bucket.bucketName, TRACE_GPU_JOB_MAX_VCPUS: String(GPU_JOB_VCPUS) })
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
    // the in-Actions fallback remembers as the worker does: its own memory, its own actors and namespaces
    if (this.memory) for (const st of memoryStatements(this.memory)) this.actionsRole.addToPolicy(st)
    // and searches and syncs its own knowledge base (the kb-sync job on a push to the default branch, and the fallback)
    if (this.knowledgeBase) for (const st of this.knowledgeBase.statements()) this.actionsRole.addToPolicy(st)

    for (const r of [role, this.actionsRole]) Tags.of(r).add(PROJECT_TAG, slug)
    Tags.of(this.secret).add(PROJECT_TAG, slug)

    // ------------------------------------------------------------------ outputs (alphanumeric names: the hash)
    const stack = Stack.of(this)
    new CfnOutput(stack, outputs.runtimeArn, { value: this.runtime.attrAgentRuntimeArn, description: `${slug}: its worker runtime (TRACE_AGENT_RUNTIME_ARN)` })
    new CfnOutput(stack, outputs.roleArn, { value: this.actionsRole.roleArn, description: `${slug}: its GitHub OIDC role (TRACE_AWS_ROLE)` })
    new CfnOutput(stack, outputs.secretArn, { value: this.secret.secretArn, description: `${slug}: its GitHub token secret` })
    if (this.jobDefinitionName) new CfnOutput(stack, outputs.jobDefinition, { value: this.jobDefinitionName, description: `${slug}: its GPU job definition` })
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
    super(scope, id, { description: `trace: ${p.project.slug}'s worker runtime, roles, token secret, memory, knowledge base and job definitions`.slice(0, 1024) })
    this.project = new ProjectStack(this, `Project${p.project.hash}`, p)
    // whose nested stack this is: the installer reads each project's outputs here (the parent carries none of them)
    new CfnOutput(this, REPOSITORY_OUTPUT, { value: p.project.slug, description: 'The repository this nested stack is the project of' })
  }
}
