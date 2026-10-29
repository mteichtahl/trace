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
 *
 * The worker's role may invoke this function and no other (src/infra/project.ts ProjectToolsInvoke); TRACE_TOOLS_FUNCTION
 * tells it the name.
 */
import { Duration, RemovalPolicy, Size, Stack } from 'aws-cdk-lib'
import type * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { projectJobsPrefix } from '../core/project.js'
import { grantPrefixes } from './project.js'

/** The function's name: `<prefix>-tools-<hash>` (64 characters at most: the prefix is short). */
export const toolsFunctionName = (prefix: string, hash: string): string => `${prefix}-tools-${hash}`

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
      environment: { TRACE_PROJECT: p.slug },
    })
  }
}
