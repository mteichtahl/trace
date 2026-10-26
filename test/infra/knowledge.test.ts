/**
 * Each project's knowledge base in the template: one per project, inside its nested stack; each project's roles reach
 * only their own; the API may Retrieve on each; removal follows retainData; none in the flat layout or when disabled.
 */
import type { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { chunkingConfiguration } from '../../src/infra/knowledge.js'
import { InfraPropsSchema, kbOutputs, knowledgeBaseOf, projectHash } from '../../src/infra/props.js'
import { kbListLength } from '../../src/infra/stack.js'
import { RUNNERS, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const HA = projectHash(A)
const HB = projectHash(B)
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, `${B}@develop`], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> }
type Res = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string }
const resources = (t: Template, type: string): [string, Res][] => Object.entries(t.findResources(type) as Record<string, Res>)
const statements = (t: Template, prefix: string): Statement[] => resources(t, 'AWS::IAM::Policy').filter(([id]) => id.startsWith(prefix))
  .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])
const ids = (v: unknown): string[] => JSON.stringify(v).match(/Project[0-9a-f]{8}[A-Za-z0-9]*/g) ?? []

describe('the knowledge bases', () => {
  it('gives each project one, in its own nested stack, over its own prefix, with its vectors in an S3 Vectors index', () => {
    const s = synth(InfraPropsSchema.parse(base), 'Kb')
    // the parent holds the one vector bucket and none of a project's knowledge base
    expect(resources(s.parent, 'AWS::S3Vectors::VectorBucket')).toHaveLength(1)
    for (const t of ['AWS::Bedrock::KnowledgeBase', 'AWS::Bedrock::DataSource', 'AWS::S3Vectors::Index']) s.parent.resourceCountIs(t, 0)
    for (const [repo, h] of [[A, HA], [B, HB]] as const) {
      const n = nestedOf(s, repo)
      const [[, kb]] = resources(n, 'AWS::Bedrock::KnowledgeBase') as [[string, Res]]
      expect(resources(n, 'AWS::Bedrock::KnowledgeBase')).toHaveLength(1)
      expect(kb.Properties.Name).toBe(`trace-kb-${h}`)
      expect(kb.Properties.KnowledgeBaseConfiguration).toMatchObject({
        Type: 'VECTOR',
        VectorKnowledgeBaseConfiguration: {
          EmbeddingModelArn: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0']] },
          EmbeddingModelConfiguration: { BedrockEmbeddingModelConfiguration: { Dimensions: 1024, EmbeddingDataType: 'FLOAT32' } },
        },
      })
      expect((kb.Properties.StorageConfiguration as { Type: string }).Type).toBe('S3_VECTORS')
      expect(ids((kb.Properties.StorageConfiguration as { S3VectorsConfiguration: unknown }).S3VectorsConfiguration)[0]).toMatch(new RegExp(`^Project${h}KnowledgeIndex`))
      expect(kb.Properties.Tags).toEqual({ 'trace:project': repo, 'trace:installation': 'trace' })
      const [[, index]] = resources(n, 'AWS::S3Vectors::Index') as [[string, Res]]
      expect(index.Properties).toMatchObject({ DataType: 'float32', Dimension: 1024, DistanceMetric: 'cosine', MetadataConfiguration: { NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] } })
      expect(index.Properties.IndexName).toBeUndefined()
      const [[, ds]] = resources(n, 'AWS::Bedrock::DataSource') as [[string, Res]]
      expect(ds.Properties.DataSourceConfiguration).toMatchObject({ Type: 'S3', S3Configuration: { InclusionPrefixes: [`projects/${repo}/kb/`], BucketOwnerAccountId: '123456789012' } })
      expect(ds.Properties.VectorIngestionConfiguration).toEqual({ ChunkingConfiguration: { ChunkingStrategy: 'FIXED_SIZE', FixedSizeChunkingConfiguration: { MaxTokens: 300, OverlapPercentage: 20 } } })
      // the worker is told its own; the outputs are the nested stack's, never the parent's
      const [[, runtime]] = resources(n, 'AWS::BedrockAgentCore::Runtime') as [[string, Res]]
      const env = runtime.Properties.EnvironmentVariables as Record<string, unknown>
      expect(ids(env.TRACE_KB_ID)[0]).toMatch(new RegExp(`^Project${h}Knowledge`))
      expect(ids(env.TRACE_KB_DATA_SOURCE_ID)[0]).toMatch(new RegExp(`^Project${h}Knowledge`))
      const outputs = Object.keys((n.toJSON() as { Outputs: Record<string, unknown> }).Outputs)
      for (const o of Object.values(kbOutputs(repo))) expect(outputs).toContain(o)
    }
    const parentOutputs = Object.keys((s.parent.toJSON() as { Outputs: Record<string, unknown> }).Outputs)
    for (const repo of [A, B]) for (const o of Object.values(kbOutputs(repo))) expect(parentOutputs).not.toContain(o)
    expect(parentOutputs.filter((o) => /^Project/.test(o))).toEqual([])
  }, 300_000)

  it("lets each project's worker and OIDC role Retrieve and ingest on its own knowledge base only, and its service role read only its prefix and index", () => {
    const s = synth(InfraPropsSchema.parse(base), 'KbIam')
    for (const [repo, h, oh] of [[A, HA, HB], [B, HB, HA]] as const) {
      const n = nestedOf(s, repo)
      const kbId = resources(n, 'AWS::Bedrock::KnowledgeBase')[0]?.[0] ?? ''
      for (const role of ['RuntimeRole', 'ActionsRole']) {
        const st = statements(n, `Project${h}${role}`)
        const retrieve = st.filter((x) => actions(x).includes('bedrock:Retrieve'))
        expect(retrieve.map((x) => x.Sid), role).toEqual(['ProjectKnowledgeBaseRetrieve'])
        const ingest = st.find((x) => x.Sid === 'ProjectKnowledgeBaseIngest')
        expect(actions(ingest!).sort()).toEqual(['bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs', 'bedrock:StartIngestionJob'])
        for (const x of [...retrieve, ingest!]) {
          expect(JSON.stringify(x.Resource)).toContain(kbId)
          expect(JSON.stringify(x.Resource)).not.toMatch(/knowledge-base\/\*/)
        }
        // nothing of another project, and no vector access of its own (Bedrock queries with the service role)
        expect(JSON.stringify(st)).not.toContain(oh)
        expect(st.some((x) => actions(x).some((a) => a.startsWith('s3vectors:')))).toBe(false)
      }
      // the knowledge base's service role
      const kbRole = resources(n, 'AWS::IAM::Role').find(([, r]) => String(r.Properties.RoleName).startsWith('trace-kb-'))?.[1]
      expect(kbRole?.Properties.RoleName).toBe(`trace-kb-${h}-us-east-1`)
      expect(JSON.stringify(kbRole?.Properties.AssumeRolePolicyDocument)).toContain('bedrock.amazonaws.com')
      expect(JSON.stringify(kbRole?.Properties.AssumeRolePolicyDocument)).toContain(':knowledge-base/*')
      const ks = statements(n, `Project${h}Knowledge`)
      expect(ks.map((x) => x.Sid).sort()).toEqual(['KnowledgeBaseEmbed', 'KnowledgeBaseList', 'KnowledgeBaseRead', 'KnowledgeBaseVectors'])
      expect(ks.find((x) => x.Sid === 'KnowledgeBaseList')?.Condition?.StringLike).toEqual({ 's3:prefix': [`projects/${repo}/kb/*`] })
      expect(JSON.stringify(ks.find((x) => x.Sid === 'KnowledgeBaseRead')?.Resource)).toContain(`/projects/${repo}/kb/*`)
      expect(JSON.stringify(ks)).not.toMatch(/"s3:PutObject"|"s3:DeleteObject"/)
      expect(ids(ks.find((x) => x.Sid === 'KnowledgeBaseVectors')?.Resource)[0]).toMatch(new RegExp(`^Project${h}KnowledgeIndex`))
      expect(actions(ks.find((x) => x.Sid === 'KnowledgeBaseVectors')!).sort()).toEqual(['s3vectors:DeleteVectors', 's3vectors:GetIndex', 's3vectors:GetVectors', 's3vectors:PutVectors', 's3vectors:QueryVectors'])
      expect(JSON.stringify(ks.find((x) => x.Sid === 'KnowledgeBaseEmbed')?.Resource)).toContain('foundation-model/amazon.titan-embed-text-v2:0')
    }
    // the API: Retrieve on each project's knowledge base by its id (from its nested stack), and nothing else of them
    const api = statements(s.parent, 'ApiRuntimeRole')
    const r = api.filter((x) => actions(x).some((a) => a.startsWith('bedrock:') && a !== 'bedrock:InvokeModel'))
    expect(r.map((x) => x.Sid)).toEqual(['RetrieveProjectKnowledgeBases'])
    expect(actions(r[0]!)).toEqual(['bedrock:Retrieve'])
    expect(r[0]?.Resource).toHaveLength(2)
    expect(JSON.stringify(r[0]?.Resource)).toContain(':knowledge-base/')
    const apiRuntime = resources(s.parent, 'AWS::BedrockAgentCore::Runtime').find(([, x]) => x.Properties.AgentRuntimeName === 'trace_api')?.[1]
    const kbs = JSON.stringify((apiRuntime?.Properties.EnvironmentVariables as Record<string, unknown>).TRACE_PROJECT_KBS)
    expect(kbs).toContain(A)
    expect(kbs).toContain(B)
  }, 300_000)

  for (const retainData of [true, false]) {
    it(`follows retainData (${retainData}): index, knowledge base and data source, and the data source's own policy`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, retainData }), `KbRetain${retainData}`)
      const want = retainData ? 'Retain' : 'Delete'
      for (const [, b] of resources(s.parent, 'AWS::S3Vectors::VectorBucket')) expect(b.DeletionPolicy).toBe(want)
      for (const repo of [A, B]) {
        const n = nestedOf(s, repo)
        for (const t of ['AWS::S3Vectors::Index', 'AWS::Bedrock::KnowledgeBase', 'AWS::Bedrock::DataSource']) {
          for (const [, r] of resources(n, t)) expect(r.DeletionPolicy, t).toBe(want)
        }
        expect(resources(n, 'AWS::Bedrock::DataSource')[0]?.[1].Properties.DataDeletionPolicy).toBe(retainData ? 'RETAIN' : 'DELETE')
      }
    }, 300_000)
  }

  it('exists only in the nested layout, and not for a project or an installation that turned it off', () => {
    const flat = synth(InfraPropsSchema.parse({ ...base, layout: 'flat' }), 'KbFlat')
    for (const t of ['AWS::Bedrock::KnowledgeBase', 'AWS::Bedrock::DataSource', 'AWS::S3Vectors::Index', 'AWS::S3Vectors::VectorBucket']) flat.parent.resourceCountIs(t, 0)
    expect(JSON.stringify(flat.parent.toJSON())).not.toMatch(/TRACE_KB_ID|TRACE_PROJECT_KBS|bedrock:Retrieve/)
    const off = synth(InfraPropsSchema.parse({ ...base, knowledgeBase: { enabled: false } }), 'KbOff')
    expect(JSON.stringify(off.all.toJSON())).not.toMatch(/AWS::Bedrock::KnowledgeBase|AWS::S3Vectors|TRACE_KB_ID|TRACE_PROJECT_KBS|bedrock:Retrieve/)
    // one project off, the other with its own chunking and a later generation
    const one = synth(InfraPropsSchema.parse({ ...base, projectSettings: { [A]: { knowledgeBase: { enabled: false } }, [B]: { generation: 2, knowledgeBase: { chunking: { strategy: 'hierarchical' } } } } }), 'KbOne')
    nestedOf(one, A).resourceCountIs('AWS::Bedrock::KnowledgeBase', 0)
    const b = nestedOf(one, B)
    expect(resources(b, 'AWS::Bedrock::KnowledgeBase')[0]?.[1].Properties.Name).toBe(`trace-kb-${HB}-g2`)
    expect(resources(b, 'AWS::Bedrock::DataSource')[0]?.[1].Properties.VectorIngestionConfiguration).toEqual({ ChunkingConfiguration: {
      ChunkingStrategy: 'HIERARCHICAL', HierarchicalChunkingConfiguration: { LevelConfigurations: [{ MaxTokens: 1500 }, { MaxTokens: 300 }], OverlapTokens: 60 } } })
    const api = statements(one.parent, 'ApiRuntimeRole').find((x) => x.Sid === 'RetrieveProjectKnowledgeBases')
    expect(JSON.stringify(api?.Resource).match(/:knowledge-base\//g)).toHaveLength(1)
  }, 300_000)

  it('checks its settings: Titan V2\'s dimensions, the chunking, per-project overrides', () => {
    expect(() => InfraPropsSchema.parse({ ...base, knowledgeBase: { dimensions: 768 } })).toThrow(/makes 256, 512, 1024 dimensions, not 768/)
    expect(() => InfraPropsSchema.parse({ ...base, projectSettings: { [A]: { knowledgeBase: { dimensions: 300 } } } })).toThrow(/not 300/)
    expect(() => InfraPropsSchema.parse({ ...base, knowledgeBase: { embeddingModel: 'cohere.embed-english-v3', dimensions: 1024 } })).not.toThrow()
    const p = InfraPropsSchema.parse({ ...base, knowledgeBase: { chunking: { maxTokens: 500 } }, projectSettings: { [B.toUpperCase()]: { knowledgeBase: { dimensions: 512, chunking: { strategy: 'semantic' } } } } })
    expect(knowledgeBaseOf(p, A)).toMatchObject({ enabled: true, dimensions: 1024, chunking: { strategy: 'fixed', maxTokens: 500 } })
    expect(knowledgeBaseOf(p, B)).toMatchObject({ dimensions: 512, chunking: { strategy: 'semantic', maxTokens: 500 } })
    expect(chunkingConfiguration(knowledgeBaseOf(p, B).chunking)).toEqual({ chunkingStrategy: 'SEMANTIC', semanticChunkingConfiguration: { maxTokens: 500, bufferSize: 0, breakpointPercentileThreshold: 95 } })
    // the API's list of knowledge bases: `slug=<10>` separated by spaces, checked against 5000 characters when built
    expect(kbListLength(['a/b', 'cc/dd'])).toBe('a/b=KB12345678 cc/dd=KB12345678'.length)
    expect(kbListLength(Array.from({ length: 60 }, (_, i) => `owner-${i}/repository-${i}`))).toBeLessThanOrEqual(5000)
  })
})
