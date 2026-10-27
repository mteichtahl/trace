/** Dictation with the project's words: /api/voice/listen asks the API (voice.vocabulary, as the person) and names the
 * vocabulary in the signed URL only when it is READY. */
import { describe, expect, it } from 'vitest'
import { VOCABULARY_CACHE_MS } from '../../src/web/voice.js'
import { accessToken } from '../api/fixtures.js'
import { NOW, bearerOf, world } from './fakes.js'

const tok = accessToken('sub-ada', ['trace-users'])
const listen = (repo?: string, language = 'en-AU') => ({ method: 'POST', path: '/api/voice/listen', headers: bearerOf(tok), body: JSON.stringify({ language, ...(repo ? { repo } : {}) }) })
const answer = (state: string, usable = state === 'READY') => ({ body: { ok: true, result: { repo: 'acme/board', language: 'en-AU', name: 'trace-0123abcd-en-AU', state, usable, note: `the note for ${state}` } } })

describe('dictation with the project\'s own words', () => {
  it('names a READY vocabulary in the signed URL, asked as the person, and kept 5 minutes', async () => {
    let now = NOW
    const w = world()
    w.deps.now = () => now
    w.runtime.answers.set('voice.vocabulary', () => answer('READY'))
    const r = await w.serve(listen('acme/board'))
    expect(r.status).toBe(200)
    const body = r.json() as { url: string; vocabulary: { state: string; used: boolean } }
    expect(new URL(body.url).searchParams.get('vocabulary-name')).toBe('trace-0123abcd-en-AU')
    expect(body.vocabulary).toMatchObject({ state: 'READY', used: true })
    expect(w.runtime.calls).toEqual([expect.objectContaining({ action: 'voice.vocabulary', args: { repo: 'acme/board', language: 'en-AU' } })])
    expect(w.runtime.calls[0]?.headers.authorization).toBe(`Bearer ${tok}`)
    await w.serve(listen('acme/board'))
    expect(w.runtime.calls).toHaveLength(1)
    now += VOCABULARY_CACHE_MS + 1
    await w.serve(listen('acme/board'))
    expect(w.runtime.calls).toHaveLength(2)
  })

  it('PENDING, FAILED or none: no vocabulary in the URL, the reason in the answer, asked again next time', async () => {
    for (const state of ['PENDING', 'FAILED', 'NONE']) {
      const w = world()
      w.runtime.answers.set('voice.vocabulary', () => answer(state))
      const body = (await w.serve(listen('acme/board'))).json() as { url: string; vocabulary: { state: string; used: boolean; note: string } }
      expect(new URL(body.url).searchParams.has('vocabulary-name')).toBe(false)
      expect(body.vocabulary).toEqual({ state, used: false, note: `the note for ${state}` })
      await w.serve(listen('acme/board'))
      expect(w.runtime.calls).toHaveLength(2)
    }
  })

  it('a project the person is not on: "no access", and no URL', async () => {
    const w = world()
    w.runtime.answers.set('voice.vocabulary', () => ({ status: 403, body: { ok: false, error: 'no access' } }))
    const r = await w.serve(listen('acme/secret'))
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('wss://')
  })

  it('the API not answering: dictation without the words, said so', async () => {
    const w = world()
    w.runtime.answers.set('voice.vocabulary', () => ({ status: 500, body: { ok: false, error: 'boom' } }))
    const body = (await w.serve(listen('acme/board'))).json() as { url: string; vocabulary: { used: boolean; note: string } }
    expect(new URL(body.url).searchParams.has('vocabulary-name')).toBe(false)
    expect(body.vocabulary.note).toMatch(/could not be checked just now/)
  })

  it('without a repo nothing is asked; a malformed repo is refused', async () => {
    const w = world()
    const body = (await w.serve(listen())).json() as Record<string, unknown>
    expect(body.vocabulary).toBeUndefined()
    expect(w.runtime.calls).toEqual([])
    expect((await w.serve(listen('../etc'))).status).toBe(400)
  })
})
