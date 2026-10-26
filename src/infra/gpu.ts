/**
 * GPU compute for the jobs AgentCore cannot run itself (it has no GPU): Blender renders and the PCB autorouters.
 * src/gpu/batch.ts submits them here; the GPU image (agent/Dockerfile.gpu, built for linux/amd64 by CodeBuild) runs
 * src/gpu/runner.ts as each job's command.
 *
 *   network          a small VPC of public subnets (no NAT gateway, nothing to pay for idle): instances get public
 *                    IPs and reach S3, ECR and CloudWatch directly; nothing listens on them
 *   compute          an AWS Batch managed EC2 environment of GPU instances (g6/g5/g4dn .xlarge by default) on the
 *                    ECS Amazon Linux 2023 NVIDIA AMI, scaling from 0 vCPUs (no cost when idle) to maxVcpus;
 *                    on-demand, or Spot when asked
 *   queue            one job queue on that compute environment, shared by every project
 *   CPU compute      (cpu.enabled) a second managed EC2 environment of x86 CPU instances (c7i/c6i/m7i families by
 *                    default) on the plain ECS Amazon Linux 2023 AMI, 0 to cpu.maxVcpus, and its own queue
 *                    (<prefix>-cpu), for the CPU-heavy jobs sent remote (openEMS, Verilator, formal, nextpnr). It
 *                    runs the same image: a CUDA runtime base image starts and runs CPU programs without a GPU (the
 *                    CUDA libraries are only loaded by the programs that use them, which these jobs do not)
 *   job definitions  per project (addProjectJob, called by src/infra/project.ts): a GPU one asking for 1 GPU, 4 vCPUs
 *                    and 14 GiB, and (CPU queue) a CPU one asking for cpu.vcpus and cpu.memoryMiB, both with the
 *                    project's one job role that may read and write only that project's jobs/<slug>/ prefix.
 *                    SubmitJob cannot override a definition's job role, so a project's runtime, allowed to submit
 *                    only with its own definitions, can never run a job as another project
 *   image            ECR repository <prefix>-gpu, built from this repository by CodeBuild through the same
 *                    custom-resource provider as the agent image, tagged with the source hash. The deploy starts the
 *                    build and does not wait for it (Wait: 'false'): CloudFormation cannot isolate a failure inside one
 *                    stack (a failed resource, nested stacks included, rolls back the whole update), so a broken GPU
 *                    image must not be a resource the deploy waits on. The job definitions name the tag, which Batch
 *                    resolves only when a job starts; the installer waits for the build after the deploy and starts
 *                    it again if it failed (src/installer/aws.ts ensureGpuImage)
 */
import { CustomResource, Duration, RemovalPolicy, Size, Stack, Tags } from 'aws-cdk-lib'
import * as batch from 'aws-cdk-lib/aws-batch'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type { Asset } from 'aws-cdk-lib/aws-s3-assets'
import type { Provider } from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'
import { cpuJobDefinitionName, gpuJobDefinitionName, PROJECT_TAG, projectHash, projectJobsPrefix, projectSlug } from '../core/project.js'
import { grantPrefixes } from './project.js'

export { JOBS_PREFIX } from '../core/project.js'

export interface GpuComputeProps {
  prefix: string
  instanceTypes: readonly string[]
  maxVcpus: number
  spot: boolean
  /** the central bucket: each project's jobs are staged under jobs/<slug>/ */
  bucket: s3.IBucket
  /** the repository source the agent image is also built from */
  source: Asset
  /** the image-build custom resource provider (src/infra/lambda/image-build.ts) */
  buildProvider: Provider
  /** let the provider's functions start and poll this build project */
  allowBuild: (projectArn: string) => void
  retainData: boolean
  /** more environment for each job (the OpenTelemetry exporter's, src/infra/observability.ts) */
  environment?: Record<string, string>
  /** the CPU compute environment and queue (null: none) */
  cpu?: { instanceTypes: readonly string[]; maxVcpus: number; spot: boolean; vcpus: number; memoryMiB: number } | null
}

export class GpuCompute extends Construct {
  readonly vpc: ec2.Vpc
  readonly repository: ecr.Repository
  readonly imageUri: string
  readonly computeEnvironment: batch.ManagedEc2EcsComputeEnvironment
  readonly queue: batch.JobQueue
  /** the CPU compute environment and its queue (cpu.enabled), or null */
  readonly cpuComputeEnvironment: batch.ManagedEc2EcsComputeEnvironment | null = null
  readonly cpuQueue: batch.JobQueue | null = null
  /** the GPU image build the deploy started (its CodeBuild build id) */
  readonly imageBuildId: string
  readonly logGroup: logs.LogGroup
  /** every project's job role (observability lets them write spans) */
  readonly jobRoles: iam.Role[] = []
  private readonly image: CustomResource
  private readonly executionRole: iam.Role

  constructor(scope: Construct, id: string, private readonly p: GpuComputeProps) {
    super(scope, id)
    const { account } = Stack.of(this)
    const keep = p.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/20'),
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: true }],
      restrictDefaultSecurityGroup: false,
    })
    const sg = new ec2.SecurityGroup(this, 'Instances', { vpc: this.vpc, allowAllOutbound: true, description: 'trace GPU job instances: outbound only' })

    // ------------------------------------------------------------------ the GPU image (CodeBuild, amd64)
    this.repository = new ecr.Repository(this, 'Images', {
      repositoryName: `${p.prefix}-gpu`, imageScanOnPush: true, removalPolicy: keep, emptyOnDelete: !p.retainData, lifecycleRules: [{ maxImageCount: 5 }],
    })
    const build = new codebuild.Project(this, 'ImageBuild', {
      projectName: `${p.prefix}-gpu-image`,
      description: 'Builds the trace GPU job image (agent/Dockerfile.gpu: CUDA, Blender, Freerouting, OrthoRoute, KiCad) for AWS Batch, on amd64',
      source: codebuild.Source.s3({ bucket: p.source.bucket, path: p.source.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.LARGE, privileged: true },
      environmentVariables: { REPOSITORY_URI: { value: this.repository.repositoryUri }, IMAGE_TAG: { value: 'latest' } },
      timeout: Duration.minutes(120),
      logging: { cloudWatch: { logGroup: new logs.LogGroup(this, 'ImageBuildLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }) } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: { commands: ['aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPOSITORY_URI%%/*}"'] },
          build: { commands: ['docker build --platform linux/amd64 -f agent/Dockerfile.gpu -t "$REPOSITORY_URI:$IMAGE_TAG" .'] },
          post_build: { commands: ['docker push "$REPOSITORY_URI:$IMAGE_TAG"'] },
        },
      }),
    })
    this.repository.grantPullPush(build)
    p.source.grantRead(build)
    p.allowBuild(build.projectArn)
    this.imageUri = `${this.repository.repositoryUri}:${p.source.assetHash}`
    this.image = new CustomResource(this, 'Image', {
      serviceToken: p.buildProvider.serviceToken,
      properties: { ProjectName: build.projectName, ImageUri: this.imageUri, SourceHash: p.source.assetHash, Wait: 'false' },
    })
    this.imageBuildId = this.image.getAttString('BuildId')

    // ------------------------------------------------------------------ compute, queue, job definition
    this.computeEnvironment = new batch.ManagedEc2EcsComputeEnvironment(this, 'Compute', {
      computeEnvironmentName: `${p.prefix}-gpu`,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [sg],
      instanceTypes: p.instanceTypes.map((t) => new ec2.InstanceType(t)),
      useOptimalInstanceClasses: false,
      images: [{ imageType: batch.EcsMachineImageType.ECS_AL2023_NVIDIA }],
      minvCpus: 0,
      maxvCpus: p.maxVcpus,
      spot: p.spot,
      ...(p.spot ? { allocationStrategy: batch.AllocationStrategy.SPOT_PRICE_CAPACITY_OPTIMIZED } : { allocationStrategy: batch.AllocationStrategy.BEST_FIT_PROGRESSIVE }),
      updateToLatestImageVersion: true,
      replaceComputeEnvironment: false,
    })
    this.queue = new batch.JobQueue(this, 'Queue', {
      jobQueueName: `${p.prefix}-gpu`,
      computeEnvironments: [{ computeEnvironment: this.computeEnvironment, order: 1 }],
      priority: 1,
    })
    if (p.cpu) {
      this.cpuComputeEnvironment = new batch.ManagedEc2EcsComputeEnvironment(this, 'CpuCompute', {
        computeEnvironmentName: `${p.prefix}-cpu`,
        vpc: this.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [sg],
        // a family (c7i) is an instance class to Batch; a type (c7i.4xlarge) an instance type
        instanceTypes: p.cpu.instanceTypes.filter((t) => t.includes('.')).map((t) => new ec2.InstanceType(t)),
        instanceClasses: p.cpu.instanceTypes.filter((t) => !t.includes('.')).map((t) => t as ec2.InstanceClass),
        useOptimalInstanceClasses: false,
        images: [{ imageType: batch.EcsMachineImageType.ECS_AL2023 }],
        // the GPU environment's instance role (ECS agent only): one role for both
        ...(this.computeEnvironment.instanceRole ? { instanceRole: this.computeEnvironment.instanceRole } : {}),
        minvCpus: 0,
        maxvCpus: p.cpu.maxVcpus,
        spot: p.cpu.spot,
        allocationStrategy: p.cpu.spot ? batch.AllocationStrategy.SPOT_PRICE_CAPACITY_OPTIMIZED : batch.AllocationStrategy.BEST_FIT_PROGRESSIVE,
        updateToLatestImageVersion: true,
        replaceComputeEnvironment: false,
      })
      this.cpuQueue = new batch.JobQueue(this, 'CpuQueue', {
        jobQueueName: `${p.prefix}-cpu`,
        computeEnvironments: [{ computeEnvironment: this.cpuComputeEnvironment, order: 1 }],
        priority: 1,
      })
    }

    this.logGroup = new logs.LogGroup(this, 'JobLogs', { logGroupName: `/trace/${p.prefix}/gpu-jobs`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    // pulls the image and writes the job's logs, for every project's jobs; the job's own AWS access is its job role's
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': account } } }),
      description: 'Starts trace GPU job containers on AWS Batch: pulls the GPU image, writes the job logs',
    })
  }

  /**
   * One project's job definitions (GPU, and CPU when there is the CPU queue) and its job role, in `scope` (the
   * project's construct): the role may read and write only jobs/<slug>/ of the central bucket. Returns the
   * definitions' names (SubmitJob with one uses its latest active revision).
   */
  addProjectJob(scope: Construct, repository: string): {
    jobDefinitionName: string; jobDefinition: batch.EcsJobDefinition; jobRole: iam.Role
    cpu: { jobDefinitionName: string; jobDefinition: batch.EcsJobDefinition } | null
  } {
    const { region, account } = Stack.of(this)
    const p = this.p
    const hash = projectHash(repository)
    const slug = projectSlug(repository)
    const jobRole = new iam.Role(scope, 'GpuJobRole', {
      roleName: `${p.prefix}-gpu-${hash}-${region}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': account } } }),
      description: `Run by ${slug}'s GPU jobs on AWS Batch: reads inputs from and writes results to ${projectJobsPrefix(repository)}/ only`,
    })
    grantPrefixes(jobRole, p.bucket, { readWrite: [projectJobsPrefix(repository)] })
    this.jobRoles.push(jobRole)
    const jobDefinitionName = gpuJobDefinitionName(p.prefix, repository)
    const jobDefinition = new batch.EcsJobDefinition(scope, 'GpuJob', {
      jobDefinitionName,
      timeout: Duration.hours(8),
      retryAttempts: 1,
      container: new batch.EcsEc2ContainerDefinition(scope, 'GpuContainer', {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, p.source.assetHash),
        cpu: 4,
        memory: Size.gibibytes(14),
        gpu: 1,
        jobRole,
        executionRole: this.executionRole,
        command: ['node', '/app/dist/gpu/runner.js'],
        environment: { AWS_REGION: region, TRACE_GPU: '1', TRACE_PROJECT: slug, NVIDIA_DRIVER_CAPABILITIES: 'all', ...p.environment },
        logging: ecs.LogDriver.awsLogs({ logGroup: this.logGroup, streamPrefix: `job-${hash}` }),
      }),
    })
    Tags.of(jobDefinition).add(PROJECT_TAG, slug)
    // no dependency on the image build: the deploy does not wait for it (see the header)
    let cpu: { jobDefinitionName: string; jobDefinition: batch.EcsJobDefinition } | null = null
    if (p.cpu && this.cpuQueue) {
      const name = cpuJobDefinitionName(p.prefix, repository)
      const def = new batch.EcsJobDefinition(scope, 'CpuJob', {
        jobDefinitionName: name,
        timeout: Duration.hours(8),
        retryAttempts: 1,
        container: new batch.EcsEc2ContainerDefinition(scope, 'CpuContainer', {
          image: ecs.ContainerImage.fromEcrRepository(this.repository, p.source.assetHash),
          cpu: p.cpu.vcpus,
          memory: Size.mebibytes(p.cpu.memoryMiB),
          jobRole,
          executionRole: this.executionRole,
          command: ['node', '/app/dist/gpu/runner.js'],
          // TRACE_GPU=0: no GPU here (the image sets 1); no queue in a job's environment, so it never ships itself again
          environment: { AWS_REGION: region, TRACE_GPU: '0', TRACE_PROJECT: slug, ...p.environment },
          logging: ecs.LogDriver.awsLogs({ logGroup: this.logGroup, streamPrefix: `cpu-${hash}` }),
        }),
      })
      Tags.of(def).add(PROJECT_TAG, slug)
      cpu = { jobDefinitionName: name, jobDefinition: def }
    }
    return { jobDefinitionName, jobDefinition, jobRole, cpu }
  }
}
