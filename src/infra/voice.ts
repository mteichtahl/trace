/**
 * IAM for dictation's project vocabularies (src/tools/voice, src/api/actions-voice.ts). Each project's vocabulary is
 * `<prefix>-<project hash>-<language>` (a language is always `ll-CC`, so the name has a fixed length after the prefix
 * and `?` wildcards match exactly that shape: no other installation's or project's name fits).
 *
 *   the project's worker role and GitHub OIDC role (the voice.vocabulary tool runs in either)
 *     VoiceVocabularyCreate   transcribe:CreateVocabulary and transcribe:TagResource (tagging on create), on "*": the
 *                             Service Authorization Reference lists no resource type for either, so the request must
 *                             carry exactly the tag trace:project=<its slug> (aws:RequestTag, aws:TagKeys)
 *     VoiceVocabularyUpdate   transcribe:UpdateVocabulary and transcribe:GetVocabulary on its own names only
 *     (the table)             Transcribe reads the table with the caller's own access (s3:GetObject is
 *                             CreateVocabulary's dependent action): projects/<slug>/voice/<language>.txt is inside the
 *                             project's prefix, which both roles already read and write. Nothing more is granted
 *   the API role
 *     VoiceVocabularyRead     transcribe:GetVocabulary on `<prefix>-<8>-<ll-CC>` names only: the state, for
 *                             voice.vocabulary (after its access check). It makes and changes none
 *   the web backend role      nothing new: it names a vocabulary in the streaming URL it signs, and
 *                             StartStreamTranscriptionWebSocket has no resource type (its `Transcription` statement)
 */
import * as iam from 'aws-cdk-lib/aws-iam'
import { PROJECT_TAG } from '../core/project.js'

/** `<prefix>-<project hash>`: the stem of a project's vocabulary names (TRACE_VOCABULARY_BASE on its worker). */
export const vocabularyBase = (prefix: string, hash: string): string => `${prefix}-${hash}`

const arn = (o: { partition: string; region: string; account: string }, name: string): string => `arn:${o.partition}:transcribe:${o.region}:${o.account}:vocabulary/${name}`

/** What a project's roles may do with its own vocabularies. */
export function projectVocabularyStatements(o: { partition: string; region: string; account: string; prefix: string; hash: string; slug: string }): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'VoiceVocabularyCreate', actions: ['transcribe:CreateVocabulary', 'transcribe:TagResource'], resources: ['*'],
      conditions: { StringEquals: { [`aws:RequestTag/${PROJECT_TAG}`]: o.slug }, 'ForAllValues:StringEquals': { 'aws:TagKeys': [PROJECT_TAG] } },
    }),
    new iam.PolicyStatement({
      sid: 'VoiceVocabularyUpdate', actions: ['transcribe:UpdateVocabulary', 'transcribe:GetVocabulary'],
      resources: [arn(o, `${vocabularyBase(o.prefix, o.hash)}-??-??`)],
    }),
  ]
}

/** The API's read of every project's vocabulary state (no project's data: a state and a name). */
export function apiVocabularyStatement(o: { partition: string; region: string; account: string; prefix: string }): iam.PolicyStatement {
  return new iam.PolicyStatement({ sid: 'VoiceVocabularyRead', actions: ['transcribe:GetVocabulary'], resources: [arn(o, `${o.prefix}-????????-??-??`)] })
}
