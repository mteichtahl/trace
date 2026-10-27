/**
 * Each project's knowledge base: an Amazon Bedrock knowledge base over that project's documents in the central bucket,
 * with its vectors in an Amazon S3 Vectors index. Made by its ProjectStack (src/infra/project.ts), in the nested layout
 * only: a flat stack of about 20 projects has no room for five more resources per project.
 *
 *   resource                         name / where
 *   AWS::S3Vectors::VectorBucket     one per installation, in the parent stack (VectorStore below); its name is
 *                                    CloudFormation's, so a retained one never blocks a new installation
 *   AWS::S3Vectors::Index            one per project, in that bucket; named by CloudFormation for the same reason.
 *                                    float32, cosine, the embedding model's dimensions; AMAZON_BEDROCK_TEXT and
 *                                    AMAZON_BEDROCK_METADATA (the chunk text and Bedrock's own metadata) are
 *                                    non-filterable, as S3 Vectors requires for anything over its 2 KB filterable limit
 *   AWS::IAM::Role (+ its policy)    <prefix>-kb-<hash>-<region>: the knowledge base's service role
 *   AWS::Bedrock::KnowledgeBase      <prefix>-kb-<hash> (`-g<n>` at generation n > 0): type VECTOR, storage S3_VECTORS
 *   AWS::Bedrock::DataSource         trace-repository: type S3, inclusion prefix projects/<slug>/kb/, the chunking of
 *                                    the project's knowledgeBase settings
 *
 * The service role (trusted by bedrock.amazonaws.com, from this account and knowledge-base ARNs of this account and
 * region only) may:
 *   S3         list the central bucket under projects/<slug>/kb/ and get objects there, nothing else of it
 *   S3 Vectors PutVectors, GetVectors, DeleteVectors, QueryVectors and GetIndex on its own index only
 *   Bedrock    InvokeModel on the one embedding model
 * Its trust names knowledge-base/* rather than its own knowledge base: the knowledge base needs the role's ARN when it
 * is made, so the role cannot name it without a cycle.
 *
 * Who may use it (granted in project.ts and stack.ts): the project's worker role and GitHub OIDC role bedrock:Retrieve
 * on this knowledge base, and Start/Get/ListIngestionJob (whose only resource type is the knowledge base: the data
 * source is a request parameter); the API role bedrock:Retrieve on every project's knowledge base, used only after
 * its access check. Writing the documents is S3 under projects/<slug>/kb/, which the worker and OIDC roles already
 * have through projects/<slug>/*.
 *
 * Removal follows retainData, like the project's memory: the index (the vectors), the knowledge base and the data
 * source (whose DataDeletionPolicy is then RETAIN too) stay in the account when the project or the stack is removed.
 */
import { RemovalPolicy, Stack } from 'aws-cdk-lib'
import { CfnDataSource, CfnKnowledgeBase } from 'aws-cdk-lib/aws-bedrock'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import { CfnIndex, CfnVectorBucket } from 'aws-cdk-lib/aws-s3vectors'
import { Construct } from 'constructs'
import { KB_DATA_SOURCE_NAME, PROJECT_TAG, knowledgeBaseName, projectKbPrefix } from '../core/project.js'
import type { KnowledgeBaseSettings } from './props.js'

/** What a caller of the knowledge base needs (bedrock-agent-runtime Retrieve). */
export const KB_RETRIEVE_ACTIONS = ['bedrock:Retrieve'] as const
/** What syncing needs besides S3 (bedrock-agent StartIngestionJob, GetIngestionJob, ListIngestionJobs). */
export const KB_INGEST_ACTIONS = ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs'] as const
/** The service role's actions on its index (Bedrock user guide, "Permissions to access your vector store in Amazon S3 Vectors"). */
export const KB_VECTOR_ACTIONS = ['s3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors', 's3vectors:QueryVectors', 's3vectors:GetIndex'] as const
/** Bedrock writes the chunk text and its own metadata under these keys: they must be non-filterable on the index. */
export const BEDROCK_NON_FILTERABLE = ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] as const

/** A knowledge base's ARN from its id (the IAM resource type knowledge-base). */
export const knowledgeBaseArn = (partition: string, region: string, account: string, id: string): string => `arn:${partition}:bedrock:${region}:${account}:knowledge-base/${id}`

/** The installation's one S3 vector bucket (the parent stack's), holding every project's index. */
export class VectorStore extends Construct {
  readonly bucket: CfnVectorBucket

  constructor(scope: Construct, id: string, p: { prefix: string; removalPolicy: RemovalPolicy }) {
    super(scope, id)
    this.bucket = new CfnVectorBucket(this, 'Bucket', { tags: [{ key: 'trace:installation', value: p.prefix }] })
    this.bucket.applyRemovalPolicy(p.removalPolicy)
  }

  get arn(): string { return this.bucket.attrVectorBucketArn }
}

export interface ProjectKnowledgeBaseProps {
  prefix: string
  repository: string
  slug: string
  hash: string
  generation: number
  settings: KnowledgeBaseSettings
  /** the central bucket: its data source reads projects/<slug>/kb/ */
  bucket: s3.IBucket
  vectorBucketArn: string
  removalPolicy: RemovalPolicy
}

/** The data source's chunking configuration from the settings. */
export function chunkingConfiguration(c: KnowledgeBaseSettings['chunking']): CfnDataSource.ChunkingConfigurationProperty {
  switch (c.strategy) {
    case 'fixed':
      return { chunkingStrategy: 'FIXED_SIZE', fixedSizeChunkingConfiguration: { maxTokens: c.maxTokens, overlapPercentage: c.overlapPercentage } }
    case 'semantic':
      return { chunkingStrategy: 'SEMANTIC', semanticChunkingConfiguration: { maxTokens: c.maxTokens, bufferSize: c.bufferSize, breakpointPercentileThreshold: c.breakpointPercentileThreshold } }
    case 'hierarchical':
      return {
        chunkingStrategy: 'HIERARCHICAL',
        hierarchicalChunkingConfiguration: { levelConfigurations: [{ maxTokens: c.parentMaxTokens }, { maxTokens: c.maxTokens }], overlapTokens: c.overlapTokens },
      }
  }
}

export class ProjectKnowledgeBase extends Construct {
  readonly role: iam.Role
  readonly index: CfnIndex
  readonly knowledgeBase: CfnKnowledgeBase
  readonly dataSource: CfnDataSource
  readonly name: string

  constructor(scope: Construct, id: string, p: ProjectKnowledgeBaseProps) {
    super(scope, id)
    const { region, account, partition } = Stack.of(this)
    const prefix = projectKbPrefix(p.repository)
    const tags = { [PROJECT_TAG]: p.slug, 'trace:installation': p.prefix }
    this.name = knowledgeBaseName(p.prefix, p.repository, p.generation)

    // ------------------------------------------------------------------ its vectors
    this.index = new CfnIndex(this, 'Index', {
      vectorBucketArn: p.vectorBucketArn,
      dataType: 'float32',
      dimension: p.settings.dimensions,
      distanceMetric: 'cosine',
      metadataConfiguration: { nonFilterableMetadataKeys: [...BEDROCK_NON_FILTERABLE] },
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    })
    this.index.applyRemovalPolicy(p.removalPolicy)

    // ------------------------------------------------------------------ its service role
    this.role = new iam.Role(this, 'Role', {
      roleName: `${p.prefix}-kb-${p.hash}-${region}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock:${region}:${account}:knowledge-base/*` },
        },
      }),
      description: `${p.slug}'s trace knowledge base: reads ${prefix}/ and its own vector index only`,
    })
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseList', actions: ['s3:ListBucket'], resources: [p.bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${prefix}/*`] }, StringEquals: { 'aws:ResourceAccount': account } },
    }))
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseRead', actions: ['s3:GetObject'], resources: [p.bucket.arnForObjects(`${prefix}/*`)],
      conditions: { StringEquals: { 'aws:ResourceAccount': account } },
    }))
    this.role.addToPolicy(new iam.PolicyStatement({ sid: 'KnowledgeBaseVectors', actions: [...KB_VECTOR_ACTIONS], resources: [this.index.attrIndexArn] }))
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseEmbed', actions: ['bedrock:InvokeModel'], resources: [`arn:${partition}:bedrock:${region}::foundation-model/${p.settings.embeddingModel}`],
    }))

    // ------------------------------------------------------------------ the knowledge base and its data source
    this.knowledgeBase = new CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: this.name,
      description: `trace: ${p.slug}'s documents, KiCad summaries and datasheets (s3://…/${prefix}/)`.slice(0, 200),
      roleArn: this.role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:${partition}:bedrock:${region}::foundation-model/${p.settings.embeddingModel}`,
          embeddingModelConfiguration: { bedrockEmbeddingModelConfiguration: { dimensions: p.settings.dimensions, embeddingDataType: 'FLOAT32' } },
        },
      },
      storageConfiguration: { type: 'S3_VECTORS', s3VectorsConfiguration: { indexArn: this.index.attrIndexArn } },
      tags,
    })
    // Bedrock checks the role when the knowledge base is made: the role and its policy first
    this.knowledgeBase.node.addDependency(this.role)
    this.knowledgeBase.applyRemovalPolicy(p.removalPolicy)

    const retain = p.removalPolicy === RemovalPolicy.RETAIN
    this.dataSource = new CfnDataSource(this, 'DataSource', {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: KB_DATA_SOURCE_NAME,
      description: `${p.slug}'s repository documents, KiCad summaries and datasheets, written by \`tracectl kb sync\``.slice(0, 200),
      // what happens to the vectors when the data source is deleted
      dataDeletionPolicy: retain ? 'RETAIN' : 'DELETE',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: { bucketArn: p.bucket.bucketArn, bucketOwnerAccountId: account, inclusionPrefixes: [`${prefix}/`] },
      },
      vectorIngestionConfiguration: { chunkingConfiguration: chunkingConfiguration(p.settings.chunking) },
    })
    this.dataSource.applyRemovalPolicy(p.removalPolicy)
  }

  get knowledgeBaseId(): string { return this.knowledgeBase.attrKnowledgeBaseId }
  get knowledgeBaseArn(): string { return this.knowledgeBase.attrKnowledgeBaseArn }
  get dataSourceId(): string { return this.dataSource.attrDataSourceId }

  /** Retrieve, and the ingestion jobs of its data source (the worker role, and the OIDC role for worker.runner actions). */
  statements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({ sid: 'ProjectKnowledgeBaseRetrieve', actions: [...KB_RETRIEVE_ACTIONS], resources: [this.knowledgeBaseArn] }),
      new iam.PolicyStatement({ sid: 'ProjectKnowledgeBaseIngest', actions: [...KB_INGEST_ACTIONS], resources: [this.knowledgeBaseArn] }),
    ]
  }
}
