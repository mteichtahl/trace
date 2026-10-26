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
 *   queue, job       one job queue, and a job definition asking for 1 GPU, 4 vCPUs and 14 GiB, whose role may read and
 *                    write only the central bucket's jobs/ prefix
 *   image            ECR repository <prefix>-gpu, built from this repository by CodeBuild through the same
 *                    custom-resource provider as the agent image, tagged with the source hash
 */
import { CustomResource, Duration, RemovalPolicy, Size, Stack } from 'aws-cdk-lib'
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

export const JOBS_PREFIX = 'jobs'

export interface GpuComputeProps {
  prefix: string
  instanceTypes: readonly string[]
  maxVcpus: number
  spot: boolean
  /** the central bucket: jobs are staged under jobs/ */
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
}

export class GpuCompute extends Construct {
  readonly vpc: ec2.Vpc
  readonly repository: ecr.Repository
  readonly imageUri: string
  readonly computeEnvironment: batch.ManagedEc2EcsComputeEnvironment
  readonly queue: batch.JobQueue
  readonly jobDefinition: batch.EcsJobDefinition
  /** the job definition's name: SubmitJob with it uses the latest active revision */
  readonly jobDefinitionName: string
  readonly jobRole: iam.Role
  readonly logGroup: logs.LogGroup

  constructor(scope: Construct, id: string, p: GpuComputeProps) {
    super(scope, id)
    const { region, account } = Stack.of(this)
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
    const image = new CustomResource(this, 'Image', {
      serviceToken: p.buildProvider.serviceToken,
      properties: { ProjectName: build.projectName, ImageUri: this.imageUri, SourceHash: p.source.assetHash },
    })

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

    this.jobRole = new iam.Role(this, 'JobRole', {
      roleName: `${p.prefix}-gpu-job-${region}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': account } } }),
      description: 'Run by trace GPU jobs on AWS Batch: reads inputs from and writes results to the central bucket\'s jobs/ prefix only',
    })
    p.bucket.grantReadWrite(this.jobRole, `${JOBS_PREFIX}/*`)
    this.logGroup = new logs.LogGroup(this, 'JobLogs', { logGroupName: `/trace/${p.prefix}/gpu-jobs`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })

    this.jobDefinitionName = `${p.prefix}-gpu`
    this.jobDefinition = new batch.EcsJobDefinition(this, 'Job', {
      jobDefinitionName: this.jobDefinitionName,
      timeout: Duration.hours(8),
      retryAttempts: 1,
      container: new batch.EcsEc2ContainerDefinition(this, 'Container', {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, p.source.assetHash),
        cpu: 4,
        memory: Size.gibibytes(14),
        gpu: 1,
        jobRole: this.jobRole,
        command: ['node', '/app/dist/gpu/runner.js'],
        environment: { AWS_REGION: region, TRACE_GPU: '1', NVIDIA_DRIVER_CAPABILITIES: 'all', ...p.environment },
        logging: ecs.LogDriver.awsLogs({ logGroup: this.logGroup, streamPrefix: 'job' }),
      }),
    })
    this.jobDefinition.node.addDependency(image)
  }

  /** Let a role submit, watch and stop this queue's jobs, and stage their files under jobs/. */
  grantSubmit(role: iam.IRole, bucket: s3.IBucket): void {
    const { region, account } = Stack.of(this)
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['batch:SubmitJob'],
      resources: [this.queue.jobQueueArn, `arn:aws:batch:${region}:${account}:job-definition/${this.jobDefinitionName}`,
        `arn:aws:batch:${region}:${account}:job-definition/${this.jobDefinitionName}:*`],
    }))
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['batch:TerminateJob', 'batch:TagResource'], resources: [`arn:aws:batch:${region}:${account}:job/*`] }))
    // DescribeJobs has no resource-level permissions
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['batch:DescribeJobs'], resources: ['*'] }))
    bucket.grantReadWrite(role, `${JOBS_PREFIX}/*`)
  }
}
