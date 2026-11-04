/**
 * The printed copies of a project's documents (src/docs/printed.ts; docs/scribe.md "Publishing"): kept by their
 * content, once; each revision's release copies written once per document and never replaced; and when the nightly
 * drift check next runs.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { backendFor } from '../../src/core/central.js'
import { DRIFT_HOUR_UTC, latestOf, nextDriftCheck, printedKey, readPrinted, recordLatest, recordRelease, releaseKey, releasesOf, storePrinted } from '../../src/docs/printed.js'

const dir = mkdtempSync(join(tmpdir(), 'trace-printed-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const store = backendFor(dir)
const REPO = 'acme/printed'
const pdf = (s: string): Uint8Array => Buffer.from(`%PDF-1.7 ${s}`)

describe('printed copies', () => {
  it('are kept by their content under the project, once', async () => {
    const a = await storePrinted(store, REPO, pdf('one'))
    expect(a.key).toBe(printedKey(REPO, a.sha256))
    expect(a.key).toMatch(/^acme\/printed\/journey-agent\/documents\/printed\/[0-9a-f]{64}\.pdf$/)
    // the same bytes again: the same key, no error
    expect(await storePrinted(store, REPO, pdf('one'))).toEqual(a)
    expect(Buffer.from((await readPrinted(store, REPO, a.sha256))!).toString()).toBe('%PDF-1.7 one')
    expect(await readPrinted(store, REPO, '../x')).toBeNull()
    expect(await readPrinted(store, 'acme/other', a.sha256)).toBeNull()
  })

  it('a revision\'s release copies are written once per document, never replaced', async () => {
    const hld = await storePrinted(store, REPO, pdf('hld A'))
    const first = await recordRelease(store, REPO, 'A', [{ kind: 'hld', sha256: hld.sha256, bytes: 12, commit: 'abc', run: 'r-1', at: 1 }])
    expect(first).toEqual({ added: ['hld'], kept: [] })
    const lld = await storePrinted(store, REPO, pdf('lld A'))
    const again = await storePrinted(store, REPO, pdf('hld A, printed again'))
    const second = await recordRelease(store, REPO, 'A', [
      { kind: 'lld', sha256: lld.sha256, bytes: 12, commit: 'abc', run: 'r-2', at: 2 },
      { kind: 'hld', sha256: again.sha256, bytes: 20, commit: 'def', run: 'r-3', at: 3 },
    ])
    expect(second).toEqual({ added: ['lld'], kept: ['hld'] })
    const [a] = await releasesOf(store, REPO)
    expect(a!.revision).toBe('A')
    expect(a!.documents.map((d) => [d.kind, d.run])).toEqual([['hld', 'r-1'], ['lld', 'r-2']])
    expect(await store.get(releaseKey(REPO, 'A'))).not.toBeNull()
    await expect(recordRelease(store, REPO, 'a1', [])).rejects.toThrow(/not a revision/)
  })

  it('each document\'s newest print replaces the one before it, the others stay', async () => {
    expect(await latestOf(store, 'acme/none')).toEqual({})
    const e = (kind: 'hld' | 'lld', run: string) => ({ kind, sha256: 'a'.repeat(64), bytes: 1, commit: 'c', run, at: 0 })
    await recordLatest(store, REPO, [e('hld', 'r-1'), e('lld', 'r-2')])
    await recordLatest(store, REPO, [e('hld', 'r-3')])
    const l = await latestOf(store, REPO)
    expect([l.hld?.run, l.lld?.run]).toEqual(['r-3', 'r-2'])
  })

  it('lists revisions in order: A, B, … Z, AA', async () => {
    for (const r of ['AA', 'B', 'Z']) await recordRelease(store, REPO, r, [{ kind: 'guide', sha256: 'f'.repeat(64), bytes: 1, commit: null, run: `r-${r}`, at: 0 }])
    expect((await releasesOf(store, REPO)).map((m) => m.revision)).toEqual(['A', 'B', 'Z', 'AA'])
  })

  it('the nightly drift check runs at the same hour every day', () => {
    const before = new Date(Date.UTC(2026, 10, 5, DRIFT_HOUR_UTC - 1, 30))
    expect(nextDriftCheck(before).toISOString()).toBe(new Date(Date.UTC(2026, 10, 5, DRIFT_HOUR_UTC)).toISOString())
    const at = new Date(Date.UTC(2026, 10, 5, DRIFT_HOUR_UTC))
    expect(nextDriftCheck(at).toISOString()).toBe(new Date(Date.UTC(2026, 10, 6, DRIFT_HOUR_UTC)).toISOString())
    // the end of a month
    expect(nextDriftCheck(new Date(Date.UTC(2026, 10, 30, 23))).toISOString()).toBe(new Date(Date.UTC(2026, 11, 1, DRIFT_HOUR_UTC)).toISOString())
  })
})
