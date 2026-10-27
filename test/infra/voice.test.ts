/** Dictation's project vocabularies in IAM (src/infra/voice.ts): each project's roles may make only vocabularies tagged
 * with their project and change only their own names; the API may only read states; nothing reaches another project. */
import type { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { InfraPropsSchema, projectHash } from '../../src/infra/props.js'
import { RUNNERS, nestedOf, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const base = { account: '123456789012', region: 'us-east-1', repositories: [A, `${B}@develop`], model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', runners: RUNNERS }
type Statement = { Sid?: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> }
const statements = (t: Template, prefix: string): Statement[] => Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith(prefix))
  .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
const actions = (s: Statement): string[] => [s.Action].flat()
const transcribe = (ss: Statement[]): Statement[] => ss.filter((s) => actions(s).some((a) => a.startsWith('transcribe:')))
const arn = (name: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:transcribe:us-east-1:123456789012:vocabulary/${name}`]] })

describe('dictation vocabularies: least privilege', () => {
  for (const layout of ['nested', 'flat'] as const) {
    it(`${layout}: a project's worker and OIDC roles create only tagged with their project, and change only their own names`, () => {
      const s = synth(InfraPropsSchema.parse({ ...base, layout }), `Voice${layout}`)
      for (const repo of [A, B]) {
        const h = projectHash(repo)
        const t = layout === 'nested' ? nestedOf(s, repo) : s.parent
        for (const role of [`Project${h}RuntimeRole`, `Project${h}ActionsRole`]) {
          const ts = transcribe(statements(t, role))
          expect(ts.map((x) => x.Sid).sort(), role).toEqual(['VoiceVocabularyCreate', 'VoiceVocabularyUpdate'])
          const create = ts.find((x) => x.Sid === 'VoiceVocabularyCreate')!
          expect(actions(create).sort()).toEqual(['transcribe:CreateVocabulary', 'transcribe:TagResource'])
          expect(create.Resource).toBe('*')
          expect(create.Condition).toEqual({ StringEquals: { 'aws:RequestTag/trace:project': repo }, 'ForAllValues:StringEquals': { 'aws:TagKeys': ['trace:project'] } })
          const update = ts.find((x) => x.Sid === 'VoiceVocabularyUpdate')!
          expect(actions(update).sort()).toEqual(['transcribe:GetVocabulary', 'transcribe:UpdateVocabulary'])
          expect(update.Resource).toEqual(arn(`trace-${h}-??-??`))
          // nothing that deletes, lists or reaches another project's names
          expect(JSON.stringify(ts)).not.toMatch(/DeleteVocabulary|ListVocabularies|vocabulary\/\*/)
        }
      }
    })
  }

  it('the API reads states only; the worker is told its vocabulary stem, the API its prefix', () => {
    const s = synth(InfraPropsSchema.parse(base), 'VoiceApi')
    const api = transcribe(statements(s.parent, 'ApiRuntimeRole'))
    expect(api).toEqual([{ Sid: 'VoiceVocabularyRead', Effect: 'Allow', Action: 'transcribe:GetVocabulary', Resource: arn('trace-????????-??-??') }])
    const env = (t: Template, type: string) => Object.values(t.findResources(type) as Record<string, { Properties: { EnvironmentVariables?: Record<string, unknown> } }>).map((r) => r.Properties.EnvironmentVariables ?? {})
    expect(env(s.parent, 'AWS::BedrockAgentCore::Runtime').some((e) => e.TRACE_PREFIX === 'trace')).toBe(true)
    expect(env(nestedOf(s, A), 'AWS::BedrockAgentCore::Runtime')[0]?.TRACE_VOCABULARY_BASE).toBe(`trace-${projectHash(A)}`)
    // the web backend gets nothing new: it only names a vocabulary in the URL it signs
    expect(JSON.stringify(s.web?.findResources('AWS::IAM::Policy') ?? {})).not.toMatch(/Vocabulary/)
  })
})
