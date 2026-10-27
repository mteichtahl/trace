/**
 * Dictation's project vocabulary (src/tools/voice): whether a project's Amazon Transcribe custom vocabulary is ready
 * for a language, and making it again on demand.
 *
 *   voice.vocabulary        read    { repo, language } → { name, state, usable, note }: the web backend asks this when
 *                                   the microphone opens (src/web/voice.ts) and names the vocabulary in the signed
 *                                   streaming URL only when usable (READY). state NONE: none made yet (the next push to
 *                                   the default branch makes it, or voice.vocabulary.sync). A language the vocabulary is
 *                                   never made for (not English) is NONE with a note saying why
 *   voice.vocabulary.sync   write   the voice.vocabulary tool on the project's own worker runtime (its role may make and
 *                                   update only that project's vocabularies), as kb.sync runs
 *
 * The name is `<prefix>-<project hash>-<language>` (TRACE_PREFIX). The API's role may only GetVocabulary on
 * `<prefix>-????????-*` names that carry this installation's tag (src/infra/voice.ts). The access check comes first, so
 * a project the person is not on and one that does not exist get the same "no access".
 */
import { z } from 'zod'
import { VOICE_LANGUAGES } from '../core/config.js'
import { projectHash } from '../core/project.js'
import { isEnglish, vocabularyName } from '../tools/voice/vocabulary.js'
import { ActionError, type Context, Repo, def } from './action-kit.js'

export type VocabularyState = 'READY' | 'PENDING' | 'FAILED' | 'NONE'

/** What the API reads of Transcribe: one vocabulary's state (null: there is none). */
export interface VocabularyReader { get(name: string): Promise<{ state: Exclude<VocabularyState, 'NONE'>; failure?: string | undefined } | null> }

const Language = z.string().regex(/^[a-z]{2,3}-[A-Z]{2}$/, 'a language code such as en-AU')

const prefixOf = (ctx: Context): string => {
  const p = ctx.deps.installationPrefix ?? process.env.TRACE_PREFIX
  if (!p) throw new ActionError('this installation does not say its prefix (TRACE_PREFIX): dictation vocabularies are not available')
  return p
}

const NOTES: Record<VocabularyState, string> = {
  READY: 'Dictation uses this project\'s words (reference designators, part numbers, net names, requirement ids).',
  PENDING: 'Transcribe is preparing this project\'s words; dictation uses them once ready, usually within a few minutes.',
  FAILED: 'Transcribe could not use this project\'s word list; dictation works without it. The next push to the default branch tries again.',
  NONE: 'This project has no dictation word list yet: the next push to the default branch makes it.',
}

export const VOICE_ACTIONS = {
  'voice.vocabulary': def('read', Repo.extend({ language: Language }), async (a, ctx) => {
    const name = vocabularyName(`${prefixOf(ctx)}-${projectHash(a.repo)}`, a.language)
    if (!isEnglish(a.language)) {
      return { repo: a.repo, language: a.language, name: null, state: 'NONE' as const, usable: false, note: `Project words are made for English dictation only (${VOICE_LANGUAGES.join(', ')}): the spoken forms use English number words.` }
    }
    const reader = await ctx.deps.vocabularies?.()
    if (!reader) return { repo: a.repo, language: a.language, name, state: 'NONE' as const, usable: false, note: 'This installation cannot read dictation vocabularies.' }
    const v = await reader.get(name)
    const state: VocabularyState = v?.state ?? 'NONE'
    return { repo: a.repo, language: a.language, name, state, usable: state === 'READY', note: NOTES[state], ...(v?.failure ? { failure: v.failure.slice(0, 300) } : {}) }
  }),

  'voice.vocabulary.sync': def('write', Repo.extend({ wait_minutes: z.number().min(0).max(10).default(3) }), async (a, ctx) => {
    const jobs = await ctx.deps.jobs()
    if (!jobs.runTool) throw new ActionError('the vocabulary is made on the project\'s worker runtime, and this installation has none for the API')
    return jobs.runTool({ kind: 'tool', repository: a.repo, name: 'voice.vocabulary', args: { wait_minutes: a.wait_minutes } })
  }),
}

/** Transcribe's GetVocabulary as a VocabularyReader (the SDK loaded on first use). */
export async function awsVocabularies(region?: string): Promise<VocabularyReader> {
  const t = await import('@aws-sdk/client-transcribe')
  const client = new t.TranscribeClient(region ? { region } : {})
  return {
    async get(name) {
      try {
        const r = await client.send(new t.GetVocabularyCommand({ VocabularyName: name }))
        const state = r.VocabularyState === 'READY' || r.VocabularyState === 'FAILED' ? r.VocabularyState : 'PENDING'
        return { state, ...(r.FailureReason ? { failure: r.FailureReason } : {}) }
      } catch (e) {
        // none yet (NotFound / BadRequest "not found"), or not ours to read (AccessDenied: no installation tag)
        if (e instanceof Error && /NotFound|AccessDenied/.test(e.name)) return null
        if (e instanceof Error && e.name === 'BadRequestException' && /not found|couldn't find|doesn't exist/i.test(e.message)) return null
        throw e
      }
    },
  }
}
