/**
 * A project's tools function: an AWS Lambda function running the tools image (agent/Dockerfile.tools), where the
 * project's worker sends the jobs whose programs AgentCore's 2 GB image limit keeps out of the agent image (KiCad,
 * Blender, the FPGA and verification tools, CalculiX, ffmpeg: src/gpu/jobs.ts FUNCTION_KINDS). One invocation is one
 * job, over the same S3 protocol as the Batch jobs (src/gpu/protocol.ts): the worker stages it under jobs/<slug>/,
 * invokes the function with the spec's address and waits for the answer (src/gpu/function.ts); the function runs it
 * (src/gpu/lambda.ts, src/gpu/runner.ts) and writes the outputs, log and exit code back beside it.
 *
 *   function   <prefix>-tools-<hash>, arm64, the tools image at the content of this deploy's source; 15 minutes (a job
 *              gets at most 840 s of them: src/gpu/jobs.ts FUNCTION_MAX_SECONDS), tools.memoryMb and tools.ephemeralMb
 *   role       assumed by Lambda for this account only; reads and writes jobs/<slug>/* of the central bucket (the
 *              project's job files, as its Batch job role) and writes its own log group, nothing else: the programs
 *              it runs (a KiCad project's, a testbench's) see only those credentials
 *   log group  /aws/lambda/<function>, a month, removed with it
 *   telemetry  (observability.enabled) the job's span (`trace.gpu.run <kind>`, src/gpu/runner.ts) to X-Ray over OTLP,
 *              as the Batch jobs send theirs, continuing the worker's trace (the event's traceparent), flushed before
 *              the function takes its next call; service `<prefix>-tools`
 *
 * The worker's role may invoke this function and no other (src/infra/project.ts ProjectToolsInvoke); TRACE_TOOLS_FUNCTION
 * tells it the name.
 *
 * Where they are: in the nested layout each project's in its own nested stack, the tools image's build in the parent.
 * In the flat layout, whose stack has no room for four resources more per project, all of them and the image's build
 * are in one nested stack of their own (FlatToolsStack), one resource of the parent's, made only when the parent has
 * room for that one (flatToolsFit); each worker may invoke its function there by the function's own policy, naming
 * the worker's role (so nothing is added to the role's policy, which CDK would split into more resources).
 */
import { CfnResource, CustomResource, Duration, Fn, NestedStack, RemovalPolicy, Size, Stack } from 'aws-cdk-lib'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type { Asset } from 'aws-cdk-lib/aws-s3-assets'
import { Construct, type IConstruct } from 'constructs'
import { projectJobsPrefix } from '../core/project.js'
import { imageBuildSpec } from './images.js'
import { gpuTelemetryEnv } from './observability.js'
import { type ProjectStack, grantPrefixes } from './project.js'
import { type InfraProps, type ProjectRef, STACK_RESOURCES_MAX } from './props.js'

/** The function's name: `<prefix>-tools-<hash>` (64 characters at most: the prefix is short). */
export const toolsFunctionName = (prefix: string, hash: string): string => `${prefix}-tools-${hash}`
/** The tools image's CodeBuild project, `<prefix>-tools-image`, by ARN (the image-build provider is granted it by name). */
export const toolsImageProjectArn = (scope: IConstruct, prefix: string): string => {
  const { partition, region, account } = Stack.of(scope)
  return `arn:${partition}:codebuild:${region}:${account}:project/${prefix}-tools-image`
}

export interface ToolsImage { images: ecr.IRepository; tag: string; uri: string }

/**
 * The tools image: its repository `<prefix>-tools` and its CodeBuild build (agent/Dockerfile.tools on arm64, the
 * published image copied when there is one: src/infra/images.ts), waited for by its custom resource like the agent
 * image (a function can't be made before its image is in the repository). `tag` is read from that resource, so every
 * function made from it waits for the build.
 */
export function buildToolsImage(scope: Construct, o: {
  prefix: string; keep: RemovalPolicy; retainData: boolean; source: Asset; buildLogs: logs.ILogGroup; serviceToken: string
  environment: Record<string, codebuild.BuildEnvironmentVariable>
  /** what the build's start must wait for besides its project (the image-build provider's functions, whose policies
   * gain this project in the same deploy) */
  dependsOn?: IConstruct[]
}): ToolsImage {
  const repo = new ecr.Repository(scope, 'ToolsImages', {
    repositoryName: `${o.prefix}-tools`, imageScanOnPush: true, removalPolicy: o.keep, emptyOnDelete: !o.retainData, lifecycleRules: [{ maxImageCount: 5 }],
  })
  const build = new codebuild.Project(scope, 'ToolsImageBuild', {
    projectName: `${o.prefix}-tools-image`,
    description: 'Builds the trace tools image (agent/Dockerfile.tools: KiCad, Blender, FPGA and verification tools, CalculiX, ffmpeg) for the projects\' tools functions, on arm64',
    source: codebuild.Source.s3({ bucket: o.source.bucket, path: o.source.s3ObjectKey }),
    environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.LARGE, privileged: true },
    environmentVariables: { REPOSITORY_URI: { value: repo.repositoryUri }, IMAGE_TAG: { value: 'latest' }, ...o.environment },
    timeout: Duration.minutes(90),
    logging: { cloudWatch: { logGroup: o.buildLogs } },
    buildSpec: codebuild.BuildSpec.fromObject(imageBuildSpec({ dockerfile: 'agent/Dockerfile.tools', platform: 'linux/arm64' })),
    cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
  })
  repo.grantPullPush(build)
  o.source.grantRead(build)
  const image = new CustomResource(scope, 'ToolsImage', {
    serviceToken: o.serviceToken,
    properties: { ProjectName: build.projectName, ImageUri: `${repo.repositoryUri}:${o.source.assetHash}`, SourceHash: o.source.assetHash },
  })
  // the build starts only once its project's role may write its logs and push (the role's policy is a resource of its
  // own, which CloudFormation would otherwise make alongside: "Service role … does not allow AWS CodeBuild to create
  // Amazon CloudWatch Logs log streams", the build failed in QUEUED), and once the provider may start it
  image.node.addDependency(build, ...(o.dependsOn ?? []))
  // repository URI ':' tag (the URI has no other ':')
  return { images: repo, tag: Fn.select(1, Fn.split(':', image.getAttString('ImageUri'))), uri: image.getAttString('ImageUri') }
}

/** What the flat tools stack may leave the parent for the role policies CDK splits off later (the API role's: four
 * at most, at 60 projects), counted on top of what is there when it is decided. */
export const FLAT_TOOLS_ALLOWANCE = 4
/** Whether the parent (a flat stack) has room for FlatToolsStack: one resource, and the allowance. */
export function flatToolsFit(parent: Stack): boolean {
  const n = parent.node.findAll().filter((c: IConstruct) => Stack.of(c) === parent && c instanceof CfnResource).length
  return n + 1 + FLAT_TOOLS_ALLOWANCE <= STACK_RESOURCES_MAX
}

export interface ToolsFunctionProps {
  prefix: string
  repository: string
  slug: string
  hash: string
  bucket: s3.IBucket
  /** the tools image: its repository and the tag this deploy built (the custom resource's, so it exists first) */
  images: ecr.IRepository
  tag: string
  memoryMb: number
  ephemeralMb: number
  /** the OTLP settings of src/infra/observability.ts gpuTelemetryEnv ({}: none) */
  telemetry: Record<string, string>
}

export class ToolsFunction extends Construct {
  readonly function: lambda.DockerImageFunction
  readonly role: iam.Role
  readonly functionName: string

  constructor(scope: Construct, id: string, p: ToolsFunctionProps) {
    super(scope, id)
    const { account } = Stack.of(this)
    this.functionName = toolsFunctionName(p.prefix, p.hash)
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/${this.functionName}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY,
    })
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': account } } }),
      description: `Run by ${p.slug}'s trace tools function: its job files (jobs/${p.slug}/) and its log group only`.slice(0, 1000),
    })
    grantPrefixes(this.role, p.bucket, { readWrite: [projectJobsPrefix(p.repository)] })
    // its spans (X-Ray's OTLP endpoint takes them as PutTraceSegments; none of these has a resource-level permission)
    if (Object.keys(p.telemetry).length) {
      this.role.addToPolicy(new iam.PolicyStatement({ sid: 'ToolsSpans', actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'], resources: ['*'] }))
    }
    this.role.addToPolicy(new iam.PolicyStatement({ sid: 'ToolsLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }))
    this.function = new lambda.DockerImageFunction(this, 'Function', {
      functionName: this.functionName,
      description: `trace: ${p.slug}'s jobs for KiCad, Blender, the FPGA and verification tools, CalculiX and ffmpeg (agent/Dockerfile.tools)`.slice(0, 256),
      code: lambda.DockerImageCode.fromEcr(p.images, { tagOrDigest: p.tag }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: p.memoryMb,
      ephemeralStorageSize: Size.mebibytes(p.ephemeralMb),
      timeout: Duration.minutes(15),
      role: this.role,
      logGroup,
      // no retryAttempts: only a synchronous call (src/gpu/function.ts) invokes it, which Lambda never retries, and an
      // EventInvokeConfig would be one more resource per project
      environment: { TRACE_PROJECT: p.slug, ...p.telemetry },
    })
  }
}

/**
 * The flat layout's tools functions (the header): one nested stack with the tools image's build and every project's
 * function, role, policy and log group, and the function's permission for that project's worker role. Each worker is
 * told its function's name (TRACE_TOOLS_FUNCTION and the rest) on its runtime, which is the parent's.
 */
export class FlatToolsStack extends NestedStack {
  readonly functions: ToolsFunction[]

  constructor(scope: Construct, id: string, p: { cfg: InfraProps; bucket: s3.IBucket; build: (scope: Construct) => ToolsImage; projects: { ref: ProjectRef; project: ProjectStack }[] }) {
    super(scope, id, { description: 'trace: the projects\' tools functions (the flat layout) and the tools image they run' })
    const { cfg } = p
    const image = p.build(this)
    const otel = gpuTelemetryEnv(cfg)
    this.functions = p.projects.map(({ ref, project }) => {
      const fn = new ToolsFunction(this, `Project${ref.hash}Tools`, {
        prefix: cfg.prefix, repository: ref.repository, slug: ref.slug, hash: ref.hash, bucket: p.bucket, images: image.images, tag: image.tag,
        memoryMb: cfg.tools.memoryMb, ephemeralMb: cfg.tools.ephemeralMb,
        telemetry: Object.keys(otel).length ? { ...otel, OTEL_SERVICE_NAME: `${cfg.prefix}-tools` } : {},
      })
      // its worker, and only its worker, may invoke it: the function's own policy names the worker's role
      fn.function.addPermission('Worker', { principal: new iam.ArnPrincipal(project.role.roleArn), action: 'lambda:InvokeFunction' })
      for (const [k, v] of Object.entries({
        TRACE_TOOLS_FUNCTION: fn.functionName, TRACE_GPU_BUCKET: p.bucket.bucketName,
        TRACE_TOOLS_FUNCTION_MEMORY_MB: String(cfg.tools.memoryMb), TRACE_TOOLS_FUNCTION_STORAGE_MB: String(cfg.tools.ephemeralMb),
      })) project.runtime.addPropertyOverride(`EnvironmentVariables.${k}`, v)
      return fn
    })
  }
}
