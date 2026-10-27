/** The dictation vocabulary: Transcribe's phrase rules, the spoken forms, the table, and making or updating the
 * vocabulary from a design (fakes for Transcribe and S3). */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HEADER, MAX_TABLE_BYTES, numberWords, rowsOf, spokenForms, validPhrase, vocabularyName, vocabularyTable } from '../../../src/tools/voice/vocabulary.js'
import { type VoiceClients, type VocabularyState, designTerms, syncVocabulary, tableKey, vocabularyBase } from '../../../src/tools/voice/tools.js'
import { projectHash } from '../../../src/core/project.js'

const SENSOR = join(import.meta.dirname, '..', '..', '..', 'examples', 'sensor-node')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('Transcribe\'s phrase rules', () => {
  it('accepts hyphenated words and single-letter acronyms, refuses digits, spaces and bad edges', () => {
    for (const ok of ['Los-Angeles', 'C.L.I.', 'Dynamo-D.B.', 'V.X.-zero-two-Q.', 'R.-fourteen']) expect(validPhrase(ok), ok).toBe(true)
    for (const bad of ['R14', 'two words', '-hello', '.test', 'hello-', "world'", 'well--known', 'AB.C', 'A.BCD', '', 'x'.repeat(257)]) expect(validPhrase(bad), bad).toBe(false)
  })
  it('says numbers in words', () => {
    expect(numberWords(4)).toBe('four')
    expect(numberWords(14)).toBe('fourteen')
    expect(numberWords(42)).toBe('forty-two')
    expect(numberWords(105)).toBe('one-hundred-five')
    expect(numberWords(1000)).toBeNull()
  })
})

describe('spoken forms', () => {
  it('"U four" is U4 and "R one four" or "R fourteen" is R14', () => {
    expect(spokenForms('U4', { number: true })).toEqual(['U.-four'])
    expect(spokenForms('R14', { number: true })).toEqual(['R.-one-four', 'R.-fourteen'])
  })
  it('part numbers and nets: letters spelled, words kept, separators as word breaks, + said', () => {
    expect(spokenForms('LM358')).toEqual(['L.M.-three-five-eight'])
    expect(spokenForms('VCC_3V3')).toEqual(['V.C.C.-three-V.-three'])
    expect(spokenForms('Buck_EN')).toEqual(['Buck-E.N.', 'B.U.C.K.-E.N.'])
    expect(spokenForms('V+')).toEqual(['V.-plus'])
    expect(spokenForms('REQ-LAY-001')).toEqual(['R.E.Q.-L.A.Y.-zero-zero-one'])
    expect(spokenForms('///')).toEqual([])
  })
  it('every row of a design keeps the rules, the design\'s spelling shown', () => {
    const rows = rowsOf({ refs: ['R14', 'U4', 'R14'], parts: ['STM32F405RGT6'], nets: ['/Power/VCC_3V3', 'SDA'], requirements: ['REQ-001'] })
    for (const r of rows) expect(validPhrase(r.phrase), r.phrase).toBe(true)
    expect(rows.filter((r) => r.display === 'R14')).toHaveLength(2)
    expect(rows.map((r) => r.display)).toContain('VCC_3V3')
    expect(rows.find((r) => r.display === 'STM32F405RGT6')?.phrase).toBe('S.T.M.-three-two-F.-four-zero-five-R.G.T.-six')
  })
})

describe('the vocabulary table', () => {
  it('four tab-separated columns with a header, SoundsLike and IPA empty, within 50 KB; the rest counted', () => {
    const t = vocabularyTable({ refs: ['U4', 'R14'], parts: [], nets: [], requirements: [] })
    expect(t.text.split('\n')[0]).toBe(HEADER)
    expect(t.text).toContain('U.-four\t\t\tU4\n')
    expect(t.rows).toBe(3)
    expect(t.sha256).toMatch(/^[0-9a-f]{64}$/)
    const many = vocabularyTable({ refs: Array.from({ length: 5000 }, (_, i) => `R${i + 1}`), parts: [], nets: [], requirements: [] })
    expect(Buffer.byteLength(many.text)).toBeLessThanOrEqual(MAX_TABLE_BYTES)
    expect(many.omitted).toBeGreaterThan(0)
  })
  it('names the vocabulary <prefix>-<project hash>-<language>, and reads the base from the environment', () => {
    const h = projectHash('acme/board')
    expect(vocabularyName(`trace-${h}`, 'en-AU')).toBe(`trace-${h}-en-AU`)
    expect(vocabularyBase({ TRACE_VOCABULARY_BASE: `my-trace-${h}` }, 'acme/board')).toBe(`my-trace-${h}`)
    expect(vocabularyBase({ TRACE_VOCABULARY_BASE: 'my-trace-00000000' }, 'acme/board')).toBeNull()
    expect(vocabularyBase({ TRACE_AGENT_RUNTIME_ARN: `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_trace_w_${h}-AbCdE12345` }, 'acme/board')).toBe(`my-trace-${h}`)
    expect(vocabularyBase({ TRACE_AGENT_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/trace_w_00000000-AbCdE12345' }, 'acme/board')).toBeNull()
  })
})

class FakeVoice implements VoiceClients {
  vocabularies = new Map<string, { state: VocabularyState; uri: string; language: string; tags?: Record<string, string> }>()
  objects = new Map<string, { text: string; sha: string }>()
  calls: string[] = []
  /** what a get answers next, per name, before the stored state */
  script = new Map<string, VocabularyState[]>()
  async get(name: string) {
    this.calls.push(`get ${name}`)
    const v = this.vocabularies.get(name)
    if (!v) return null
    const next = this.script.get(name)?.shift()
    if (next) v.state = next
    return { state: v.state }
  }
  async create(i: { name: string; language: string; uri: string; tags: Record<string, string> }) { this.calls.push(`create ${i.name}`); this.vocabularies.set(i.name, { state: 'PENDING', uri: i.uri, language: i.language, tags: i.tags }) }
  async update(i: { name: string; language: string; uri: string }) { this.calls.push(`update ${i.name}`); const v = this.vocabularies.get(i.name)!; v.state = 'PENDING'; v.uri = i.uri }
  async storedSha(_b: string, key: string) { return this.objects.get(key)?.sha ?? null }
  async put(_b: string, key: string, text: string, sha: string) { this.calls.push(`put ${key}`); this.objects.set(key, { text, sha }) }
}

describe('making the vocabulary from a design', () => {
  const sensor = (): string => { const d = mkdtempSync(join(tmpdir(), 'trace-voice-')); dirs.push(d); cpSync(SENSOR, d, { recursive: true }); return d }
  const base = `trace-${projectHash('acme/sensor')}`
  const opts = (root: string, c: FakeVoice, extra: Partial<Parameters<typeof syncVocabulary>[0]> = {}) => ({ root, repository: 'acme/sensor', bucket: 'b', base, languages: ['en-AU'], clients: c, ...extra })

  it('reads the schematic\'s references, part numbers and nets', async () => {
    const d = await designTerms(sensor())
    expect(d.refs.length).toBeGreaterThan(3)
    expect(d.refs.every((r) => /^[A-Z]+\d+/.test(r))).toBe(true)
    expect(d.nets.length).toBeGreaterThan(0)
  })

  it('creates it tagged with the project the first time, updates it only when the table changed or it FAILED', async () => {
    const root = sensor()
    const c = new FakeVoice()
    const first = await syncVocabulary(opts(root, c))
    const name = `${base}-en-AU`
    expect(first.languages).toEqual([expect.objectContaining({ name, action: 'created', state: 'PENDING' })])
    expect(c.vocabularies.get(name)).toMatchObject({ uri: `s3://b/${tableKey('acme/sensor', 'en-AU')}`, tags: { 'trace:project': 'acme/sensor' } })
    expect(c.objects.get(tableKey('acme/sensor', 'en-AU'))?.text.split('\n')[0]).toBe(HEADER)
    c.vocabularies.get(name)!.state = 'READY'
    c.calls = []
    const again = await syncVocabulary(opts(root, c))
    expect(again.languages[0]).toMatchObject({ action: 'unchanged', state: 'READY' })
    expect(c.calls.filter((x) => !x.startsWith('get'))).toEqual([])
    c.vocabularies.get(name)!.state = 'FAILED'
    expect((await syncVocabulary(opts(root, c))).languages[0]).toMatchObject({ action: 'updated' })
  })

  it('waits for READY on the declared timer, saying when it checks next', async () => {
    const c = new FakeVoice()
    const name = `${base}-en-AU`
    c.script.set(name, ['PENDING', 'PENDING', 'READY'])
    let t = 0
    const lines: string[] = []
    const r = await syncVocabulary(opts(sensor(), c, { waitMs: 120_000, now: () => t, sleep: async (ms) => { t += ms }, log: (l) => lines.push(l) }))
    expect(r.languages[0]).toMatchObject({ action: 'created', state: 'READY' })
    expect(lines.join('\n')).toMatch(/next check in/)
  })

  it('a design with nothing to say makes nothing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'trace-voice-empty-')); dirs.push(d)
    const c = new FakeVoice()
    const r = await syncVocabulary(opts(d, c))
    expect(r.languages[0]).toMatchObject({ action: 'skipped', state: 'NONE' })
    expect(c.calls.filter((x) => !x.startsWith('get'))).toEqual([])
  })
})
