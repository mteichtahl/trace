/**
 * The knowledge base: what is collected from a tree (globs, KiCad summaries, the BOM's datasheets), the metadata
 * sidecars, the sync's diff against S3 and the ingestion job, the Retrieve request kb.search sends and how its results
 * are cited, and the tools being hidden without a knowledge base.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConflictException, GetIngestionJobCommand, ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent'
import { RetrieveCommand, type RetrieveCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { defaults } from '../../../src/core/config.js'
import { offered } from '../../../src/core/mcp.js'
import { openProject, projectTables } from '../../../src/core/store.js'
import {
  type DatasheetSource, type KbDoc, SIDECAR, collect, dirHash, globRegex, kindOf, repoKey, selected, sidecar, sidecarHash,
} from '../../../src/tools/kb/content.js'
import { type KbS3, kbFromEnv, parseProjectKbs } from '../../../src/tools/kb/env.js'
import { SearchArgs, hitOf, retrievalFilter, retrieveInput, searchKb } from '../../../src/tools/kb/search.js'
import { type IngestClient, plan, syncKb, wanted } from '../../../src/tools/kb/sync.js'
import { allTools } from '../../../src/tools/index.js'

const SENSOR = join(import.meta.dirname, '..', '..', '..', 'examples', 'sensor-node')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'trace-kb-')); dirs.push(d); return d }

// ------------------------------------------------------------------ fakes

/** An S3 bucket in memory: ETags are the hash of the bytes; HeadObject returns the stored trace-sha256. */
class FakeS3 implements KbS3 {
  objects = new Map<string, { body: Uint8Array; sha: string; etag: string }>()
  calls: string[] = []
  private n = 0
  async list(_b: string, prefix: string) { this.calls.push('list'); return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, etag: o.etag })) }
  async head(_b: string, key: string) { this.calls.push(`head ${key}`); const o = this.objects.get(key); if (!o) throw new Error('404'); return { etag: o.etag, sha256: o.sha } }
  async put(_b: string, key: string, body: Uint8Array, _t: string, sha: string) { this.calls.push(`put ${key}`); const etag = `"e${++this.n}"`; this.objects.set(key, { body, sha, etag }); return { etag } }
  async remove(_b: string, keys: readonly string[]) { this.calls.push(`remove ${keys.join(',')}`); for (const k of keys) this.objects.delete(k) }
}

/** Bedrock's ingestion jobs: each start completes on the first GetIngestionJob; `busy` refuses that many starts. */
function fakeIngest(o: { busy?: number } = {}) {
  const jobs: { id: string; status: string }[] = []
  let busy = o.busy ?? 0
  const sent: unknown[] = []
  const client = {
    send: async (c: unknown) => {
      sent.push(c)
      if (c instanceof StartIngestionJobCommand) {
        if (busy > 0) { busy--; throw new ConflictException({ message: 'a job is running', $metadata: {} }) }
        const j = { id: `job${jobs.length + 1}`, status: 'STARTING' }
        jobs.push(j)
        return { ingestionJob: { ingestionJobId: j.id, status: j.status } }
      }
      if (c instanceof GetIngestionJobCommand) {
        const j = jobs.find((x) => x.id === c.input.ingestionJobId)!
        j.status = 'COMPLETE'
        return { ingestionJob: { ingestionJobId: j.id, status: 'COMPLETE', statistics: { numberOfDocumentsScanned: 4, numberOfNewDocumentsIndexed: 2, numberOfModifiedDocumentsIndexed: 1, numberOfDocumentsDeleted: 1, numberOfDocumentsFailed: 0 } } }
      }
      if (c instanceof ListIngestionJobsCommand) {
        const j = jobs.at(-1)
        return { ingestionJobSummaries: j ? [{ ingestionJobId: j.id, status: j.status }] : [] }
      }
      throw new Error('unexpected command')
    },
  } as unknown as IngestClient
  return { client, jobs, sent }
}

const target = { bucket: 'central', prefix: 'projects/acme/board/kb', knowledgeBaseId: 'KB12345678', dataSourceId: 'DS12345678' }
const doc = (key: string, text: string, path = key): KbDoc => ({ key: `repo/${key}`, body: new TextEncoder().encode(text), contentType: 'text/markdown', meta: { source: 'repo', kind: 'markdown', path } })
const projectDb = (): DatabaseSync => openProject(temp())

// ------------------------------------------------------------------ content

describe('what the knowledge base holds', () => {
  it('matches repository globs: ** across folders (none too), * and ? within one, exclude wins', () => {
    expect(globRegex('**/*.md').test('README.md')).toBe(true)
    expect(globRegex('**/*.md').test('docs/power/rails.md')).toBe(true)
    expect(globRegex('docs/*.md').test('docs/power/rails.md')).toBe(false)
    expect(globRegex('firmware/**/*.rs').test('firmware/src/main.rs')).toBe(true)
    expect(globRegex('firmware/**/*.rs').test('firmware/main.rs')).toBe(true)
    expect(globRegex('a?c.txt').test('abc.txt')).toBe(true)
    expect(globRegex('a.b').test('axb')).toBe(false)
    const d = defaults().knowledge
    expect(selected('docs/power.md', d.include, d.exclude)).toBe(true)
    expect(selected('node_modules/x/README.md', d.include, d.exclude)).toBe(false)
    expect(selected('firmware/adc.c', d.include, d.exclude)).toBe(false)
    expect(selected('firmware/adc.c', [...d.include, 'firmware/**/*.c'], d.exclude)).toBe(true)
    expect(repoKey('firmware/adc.c')).toEqual({ key: 'repo/firmware/adc.c.txt', contentType: 'text/plain' })
    expect(repoKey('docs/a.md')).toEqual({ key: 'repo/docs/a.md', contentType: 'text/markdown' })
    expect([kindOf('.trace/rules.md'), kindOf('CLAUDE.md'), kindOf('docs/x.rst'), kindOf('src/a.rs'), kindOf('README.md')]).toEqual(['rules', 'claude', 'doc', 'source', 'markdown'])
  })

  it('collects the docs, the rules, CLAUDE.md and a KiCad summary (never the KiCad files), and the BOM\'s datasheets', async () => {
    const root = temp()
    cpSync(SENSOR, root, { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), '# Notes\nThe 3V3 rail comes from the LDO.\n')
    writeFileSync(join(root, '.trace', 'rules.md'), 'Ask before changing the stackup.\n')
    writeFileSync(join(root, 'docs-empty.md'), '')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'power.md'), '# Power\n')
    writeFileSync(join(root, 'docs', 'huge.md'), 'x'.repeat(600 * 1024))
    writeFileSync(join(root, 'docs', 'blob.txt'), Buffer.from([0x41, 0x00, 0x42]))
    const asked: string[] = []
    const datasheets: DatasheetSource = {
      current: async (mpn) => { asked.push(mpn); return mpn === 'CL10B103KB8NNNC' ? { key: 'CL10B103KB8NNNC', sha256: 'a'.repeat(64) } : null },
      pageTexts: async () => ['Capacitance 10 nF', '', 'X7R, 50 V'],
    }
    const cfg = defaults()
    const c = await collect({ root, cfg, datasheets })
    const once = [...asked]
    const keys = c.docs.map((d) => d.key)
    expect(keys).toContain('repo/README.md')
    expect(keys).toContain('repo/CLAUDE.md')
    expect(keys).toContain('repo/.trace/rules.md')
    expect(keys).toContain('repo/docs/power.md')
    expect(keys).toContain('summary/hardware/sensor-node.kicad_pro.md')
    expect(keys.some((k) => /\.kicad_(sch|pcb|pro)$/.test(k))).toBe(false)
    // firmware only when a glob names it
    expect(keys.some((k) => k.startsWith('repo/firmware/'))).toBe(false)
    expect(c.skipped.map((s) => s.path).sort()).toEqual(['docs-empty.md', 'docs/blob.txt', 'docs/huge.md'])
    expect(c.docs.find((d) => d.key === 'repo/.trace/rules.md')?.meta.kind).toBe('rules')
    // the summary: BOM lines with MPNs, nets; deterministic
    const summary = new TextDecoder().decode(c.docs.find((d) => d.key.startsWith('summary/'))!.body)
    expect(summary).toMatch(/^# KiCad project sensor-node/)
    expect(summary).toContain('## Bill of materials')
    expect(summary).toContain('CL10B103KB8NNNC')
    expect(summary).toMatch(/## (Power nets|Net labels|Board)/)
    expect(new TextDecoder().decode((await collect({ root, cfg, datasheets })).docs.find((d) => d.key.startsWith('summary/'))!.body)).toBe(summary)
    // datasheets: every BOM part number asked once; one object per non-empty page, with its citation
    expect(once).toContain('CL10B103KB8NNNC')
    expect(new Set(once).size).toBe(once.length)
    const pages = c.docs.filter((d) => d.meta.source === 'datasheet')
    expect(pages.map((d) => d.key)).toEqual([`datasheets/CL10B103KB8NNNC/${'a'.repeat(16)}/p0001.txt`, `datasheets/CL10B103KB8NNNC/${'a'.repeat(16)}/p0003.txt`])
    expect(pages[1]?.meta).toEqual({ source: 'datasheet', kind: 'datasheet', path: 'datasheets/CL10B103KB8NNNC', part: 'CL10B103KB8NNNC', mpn: 'CL10B103KB8NNNC', sha256: 'a'.repeat(64), page: 3 })
    expect(c.parts.find((p) => p.mpn === 'CL10B103KB8NNNC')).toMatchObject({ datasheet: 'a'.repeat(64), pages: 2 })
    expect(c.parts.filter((p) => !p.datasheet).every((p) => p.note === 'no datasheet in the shared library')).toBe(true)
    // with firmware included, and datasheets and KiCad summaries off
    const fw = await collect({ root, cfg: { ...cfg, knowledge: { ...cfg.knowledge, include: [...cfg.knowledge.include, 'firmware/**/*.c'], kicad: false, datasheets: false } }, datasheets })
    expect(fw.docs.map((d) => d.key)).toContain('repo/firmware/adc.c.txt')
    expect(fw.docs.some((d) => d.meta.source !== 'repo')).toBe(false)
    expect(fw.docs.find((d) => d.key === 'repo/firmware/adc.c.txt')?.meta.kind).toBe('source')
  }, 60_000)

  it('writes Bedrock\'s metadata sidecar: source, kind, path, commit, folder hashes, a datasheet\'s citation', () => {
    const m = { source: 'datasheet' as const, kind: 'datasheet' as const, path: 'datasheets/LM5069MM-1/NOPB', part: 'LM5069MM-1/NOPB', mpn: 'lm5069mm-1/nopb', sha256: 'b'.repeat(64), page: 7 }
    const j = JSON.parse(new TextDecoder().decode(sidecar(m, 'c'.repeat(40)))) as { metadataAttributes: Record<string, { value: Record<string, unknown>; includeForEmbedding: boolean }> }
    const a = j.metadataAttributes
    expect(Object.keys(a).sort()).toEqual(['commit', 'dir1', 'dir2', 'kind', 'mpn', 'page', 'part', 'path', 'sha256', 'source'])
    expect(a.source?.value).toEqual({ type: 'STRING', stringValue: 'datasheet' })
    expect(a.page?.value).toEqual({ type: 'NUMBER', numberValue: 7 })
    expect(a.commit?.value.stringValue).toBe('c'.repeat(40))
    expect(a.dir1?.value.stringValue).toBe(dirHash('datasheets'))
    expect(a.dir2?.value.stringValue).toBe(dirHash('datasheets/LM5069MM-1'))
    expect(a.path?.includeForEmbedding).toBe(true)
    expect(a.commit?.includeForEmbedding).toBe(false)
    expect(sidecar(m, 'x').length).toBeLessThan(10 * 1024)
    // the commit is not part of what decides whether a sidecar changed
    const d = doc('a.md', 'x')
    expect(wanted([d], 'p', 'c1')[1]?.hash).toBe(wanted([d], 'p', 'c2')[1]?.hash)
    expect(sidecarHash('h', d.meta)).not.toBe(sidecarHash('h', { ...d.meta, kind: 'doc' }))
  })
})

// ------------------------------------------------------------------ sync

describe('syncing', () => {
  it('uploads what changed, keeps what did not, deletes what went away, then ingests', async () => {
    const s3 = new FakeS3()
    const ing = fakeIngest()
    const db = projectDb()
    const sync = (docs: KbDoc[], commit = 'c1', o = {}) => syncKb(target, docs, { s3, ingest: ing.client, db, sleep: async () => undefined }, { commit, waitMs: 60_000, pollMs: 1, ...o })

    const first = await sync([doc('a.md', 'alpha'), doc('b.md', 'beta')])
    expect(first).toMatchObject({ documents: 2, objects: 4, uploaded: 4, unchanged: 0, deleted: 0, ingest: 'changed', waiting: false })
    expect(first.ingestion).toMatchObject({ job_id: 'job1', status: 'COMPLETE' })
    expect(first.ingestion?.statistics.numberOfNewDocumentsIndexed).toBe(2)
    expect([...s3.objects.keys()].sort()).toEqual([
      'projects/acme/board/kb/repo/a.md', `projects/acme/board/kb/repo/a.md${SIDECAR}`, 'projects/acme/board/kb/repo/b.md', `projects/acme/board/kb/repo/b.md${SIDECAR}`])
    expect(Number(db.prepare('SELECT count(*) AS n FROM kb_objects').get()?.n)).toBe(4)

    // unchanged: no upload, no HeadObject (the rows match the listing), no ingestion job
    s3.calls.length = 0
    const same = await sync([doc('a.md', 'alpha'), doc('b.md', 'beta')], 'c2')
    expect(same).toMatchObject({ uploaded: 0, unchanged: 4, deleted: 0, ingest: 'nothing changed' })
    expect(s3.calls).toEqual(['list'])
    expect(ing.jobs).toHaveLength(1)
    // the sidecar keeps the commit it was first synced from
    expect(new TextDecoder().decode(s3.objects.get(`projects/acme/board/kb/repo/a.md${SIDECAR}`)!.body)).toContain('"c1"')

    // b changed, a removed, c added
    s3.calls.length = 0
    const next = await sync([doc('b.md', 'beta 2'), doc('c.md', 'gamma')], 'c3')
    expect(next).toMatchObject({ uploaded: 4, unchanged: 0, deleted: 2, ingest: 'changed' })
    expect(s3.calls.filter((c) => c.startsWith('remove'))).toEqual([`remove projects/acme/board/kb/repo/a.md,projects/acme/board/kb/repo/a.md${SIDECAR}`])
    // b's sidecar changed too: it covers its document's hash
    expect(s3.calls).toContain(`put projects/acme/board/kb/repo/b.md${SIDECAR}`)
    expect(ing.jobs).toHaveLength(2)
    expect(db.prepare('SELECT s3_key FROM kb_objects ORDER BY s3_key').all().map((r) => String(r.s3_key))).toEqual([
      'projects/acme/board/kb/repo/b.md', `projects/acme/board/kb/repo/b.md${SIDECAR}`, 'projects/acme/board/kb/repo/c.md', `projects/acme/board/kb/repo/c.md${SIDECAR}`])
    db.close()
  })

  it('needs no rows: a fresh checkout finds unchanged objects by their stored hash (HeadObject)', async () => {
    const s3 = new FakeS3()
    const ing = fakeIngest()
    await syncKb(target, [doc('a.md', 'alpha')], { s3, ingest: ing.client, db: null }, { commit: 'c1', waitMs: 0 })
    s3.calls.length = 0
    const r = await syncKb(target, [doc('a.md', 'alpha')], { s3, ingest: ing.client, db: projectDb() }, { commit: 'c2', waitMs: 0 })
    expect(r).toMatchObject({ uploaded: 0, unchanged: 2, ingest: 'nothing changed' })
    expect(s3.calls.filter((c) => c.startsWith('head'))).toHaveLength(2)
    // a row whose ETag no longer matches the listing is not trusted
    const rows = new Map([['p/repo/a.md', { s3_key: 'p/repo/a.md', path: 'a.md', hash: 'h', etag: '"old"', uploaded_at: 0 }]])
    const w = [{ key: 'p/repo/a.md', path: 'a.md', hash: 'h', body: new Uint8Array(), contentType: 'text/plain' }]
    const heads: string[] = []
    const p = await plan(w, [{ key: 'p/repo/a.md', etag: '"new"' }, { key: 'p/repo/gone.md', etag: '"x"' }], rows, async (k) => { heads.push(k); return { etag: '"new"', sha256: 'other' } })
    expect({ upload: p.upload.length, unchanged: p.unchanged.length, remove: p.remove, heads }).toEqual({ upload: 1, unchanged: 0, remove: ['p/repo/gone.md'], heads: ['p/repo/a.md'] })
  })

  it('ingests the first time even with nothing to upload, on force, and after waiting out a running job', async () => {
    const s3 = new FakeS3()
    const ing = fakeIngest()
    await syncKb(target, [], { s3, ingest: ing.client, db: null }, { commit: 'c', waitMs: 0 })
    expect(ing.jobs).toHaveLength(1)
    const forced = await syncKb(target, [], { s3, ingest: ing.client, db: null }, { commit: 'c', force: true, waitMs: 0 })
    expect(forced.ingest).toBe('forced')
    expect(forced.waiting).toBe(true)
    const busy = fakeIngest({ busy: 2 })
    let slept = 0
    const r = await syncKb(target, [doc('a.md', 'x')], { s3: new FakeS3(), ingest: busy.client, db: null, sleep: async () => { slept++ } }, { commit: 'c', waitMs: 60_000, pollMs: 1 })
    expect(slept).toBeGreaterThanOrEqual(2)
    expect(r.ingestion?.status).toBe('COMPLETE')
    const start = busy.sent.find((c) => c instanceof StartIngestionJobCommand) as StartIngestionJobCommand
    expect(start.input).toMatchObject({ knowledgeBaseId: 'KB12345678', dataSourceId: 'DS12345678' })
    // nothing to upload, but the last job failed: ingested again
    const failed = fakeIngest()
    const f3 = new FakeS3()
    await syncKb(target, [doc('a.md', 'x')], { s3: f3, ingest: failed.client, db: null }, { commit: 'c', waitMs: 0 })
    failed.jobs[0]!.status = 'FAILED'
    expect((await syncKb(target, [doc('a.md', 'x')], { s3: f3, ingest: failed.client, db: null }, { commit: 'c', waitMs: 0 })).ingest).toBe('retry')
    // a dry run changes nothing
    const d = new FakeS3()
    const dry = await syncKb(target, [doc('a.md', 'x')], { s3: d, ingest: fakeIngest().client, db: null }, { commit: 'c', dryRun: true })
    expect(dry).toMatchObject({ uploaded: 2, ingest: 'dry run' })
    expect(d.objects.size).toBe(0)
  })

  it('registers kb_objects in the project database, merged by key keeping the newer upload', () => {
    const t = projectTables().find((x) => x.table === 'kb_objects')
    expect(t?.sql).toMatch(/s3_key TEXT PRIMARY KEY/)
    expect(t?.merge).toMatch(/excluded\.uploaded_at > kb_objects\.uploaded_at/)
  })
})

// ------------------------------------------------------------------ search

describe('kb.search', () => {
  it('maps source, kind and a folder or file path_prefix to Retrieve filters S3 Vectors supports (no startsWith)', () => {
    expect(retrievalFilter(undefined)).toBeUndefined()
    expect(retrievalFilter({ source: 'datasheet' })).toEqual({ equals: { key: 'source', value: 'datasheet' } })
    expect(retrievalFilter({ source: 'repo', kind: 'rules', path_prefix: 'docs/power/' })).toEqual({
      andAll: [
        { equals: { key: 'source', value: 'repo' } },
        { equals: { key: 'kind', value: 'rules' } },
        { orAll: [{ equals: { key: 'path', value: 'docs/power' } }, { equals: { key: 'dir2', value: dirHash('docs/power') } }] },
      ],
    })
    const deep = retrievalFilter({ path_prefix: 'a/b/c/d/e/f/g' })
    expect(deep).toEqual({ equals: { key: 'dir6', value: dirHash('a/b/c/d/e/f') } })
    expect(JSON.stringify(retrievalFilter({ source: 'repo', kind: 'doc', path_prefix: 'x' }))).not.toMatch(/startsWith|stringContains/)
    const input = retrieveInput('KB12345678', SearchArgs.parse({ query: 'LDO dropout', top_k: 5, filter: { kind: 'kicad' } }))
    expect(input).toEqual({
      knowledgeBaseId: 'KB12345678', retrievalQuery: { text: 'LDO dropout' },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 5, filter: { equals: { key: 'kind', value: 'kicad' } } } },
    })
    expect(retrieveInput('KB12345678', SearchArgs.parse({ query: 'q' })).retrievalConfiguration).toEqual({ vectorSearchConfiguration: { numberOfResults: 8 } })
    expect(SearchArgs.safeParse({ query: 'q', filter: { path_prefix: 'docs/*' } }).success).toBe(false)
  })

  it('sends one Retrieve and returns text, score, path, commit and a citation', async () => {
    const sent: RetrieveCommand[] = []
    const output: RetrieveCommandOutput = { $metadata: {}, retrievalResults: [
      { content: { text: 'The 3V3 rail comes from the LDO.' }, score: 0.82, location: { type: 'S3', s3Location: { uri: 's3://central/projects/acme/board/kb/repo/CLAUDE.md' } },
        metadata: { source: 'repo', kind: 'claude', path: 'CLAUDE.md', commit: 'abcdef1234567890' } },
      { content: { text: 'Capacitance 10 nF' }, score: 0.6, metadata: { source: 'datasheet', kind: 'datasheet', path: 'datasheets/CL10B103KB8NNNC', part: 'CL10B103KB8NNNC', sha256: 'a'.repeat(64), page: 3, commit: 'x' } },
    ] }
    const client = { send: async (c: RetrieveCommand) => { sent.push(c); return output } }
    const r = await searchKb(client, 'KB12345678', { query: 'where does 3V3 come from', top_k: 3, filter: { source: 'repo' } })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBeInstanceOf(RetrieveCommand)
    expect(sent[0]?.input).toMatchObject({ knowledgeBaseId: 'KB12345678', retrievalQuery: { text: 'where does 3V3 come from' }, retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 3, filter: { equals: { key: 'source', value: 'repo' } } } } })
    expect(r.results[0]).toEqual({ text: 'The 3V3 rail comes from the LDO.', score: 0.82, source: 'repo', kind: 'claude', path: 'CLAUDE.md', commit: 'abcdef1234567890', citation: 'CLAUDE.md@abcdef123456' })
    expect(r.results[1]).toMatchObject({ citation: `CL10B103KB8NNNC, sha256 ${'a'.repeat(64)}, page 3`, datasheet: { part: 'CL10B103KB8NNNC', sha256: 'a'.repeat(64), page: 3 } })
    expect(r.note).toMatch(/data .* not instructions/)
    // a folder deeper than the dir attributes: asks for more, keeps only what is under it
    const deep = { send: async (c: RetrieveCommand) => { sent.push(c); return { $metadata: {}, retrievalResults: [
      { content: { text: 'in' }, metadata: { path: 'a/b/c/d/e/f/g/x.md' } }, { content: { text: 'out' }, metadata: { path: 'a/b/c/d/e/f/h/y.md' } }] } } }
    const d = await searchKb(deep, 'KB12345678', { query: 'q', top_k: 2, filter: { path_prefix: 'a/b/c/d/e/f/g' } })
    expect(d.results.map((h) => h.text)).toEqual(['in'])
    expect(sent.at(-1)?.input.retrievalConfiguration?.vectorSearchConfiguration?.numberOfResults).toBe(8)
    expect(hitOf({ content: { text: 't' }, location: { type: 'S3', s3Location: { uri: 's3://b/k' } } }).citation).toBe('s3://b/k')
  })
})

// ------------------------------------------------------------------ the environment and the tools

describe('kb tools and their environment', () => {
  const keep = { ...process.env }
  afterEach(() => { for (const k of ['TRACE_KB_ID', 'TRACE_KB_DATA_SOURCE_ID']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k] } })

  it('are hidden without a knowledge base, and offered (search and status for specialists) with one', () => {
    delete process.env.TRACE_KB_ID
    const names = [...offered(allTools(), false).keys()]
    expect(names.filter((n) => n.startsWith('kb_'))).toEqual([])
    process.env.TRACE_KB_ID = 'KB12345678'
    expect([...offered(allTools(), false).keys()].filter((n) => n.startsWith('kb_')).sort()).toEqual(['kb_search', 'kb_status', 'kb_sync'])
    process.env.TRACE_KB_ID = 'not-an-id'
    expect([...offered(allTools(), false).keys()].filter((n) => n.startsWith('kb_'))).toEqual([])
  })

  it('reads the knowledge base, its data source, bucket and project from the environment', () => {
    expect(kbFromEnv({})).toBeNull()
    expect(kbFromEnv({ TRACE_KB_ID: 'KB12345678', TRACE_KB_DATA_SOURCE_ID: 'DS12345678', TRACE_PROJECT: 'Acme/Board', TRACE_PROJECT_HOME: 's3://central-b/projects/acme/board', AWS_REGION: 'eu-west-1' }))
      .toEqual({ knowledgeBaseId: 'KB12345678', dataSourceId: 'DS12345678', region: 'eu-west-1', bucket: 'central-b', repository: 'acme/board', prefix: 'projects/acme/board/kb' })
    // GitHub Actions: the repository from GITHUB_REPOSITORY, the bucket from TRACE_HOME
    expect(kbFromEnv({ TRACE_KB_ID: 'KB12345678', GITHUB_REPOSITORY: 'acme/board', TRACE_HOME: 's3://c2/central' })).toMatchObject({ bucket: 'c2', prefix: 'projects/acme/board/kb', dataSourceId: null })
    expect(kbFromEnv({ TRACE_KB_ID: 'KB12345678', TRACE_HOME: '/home/me/.trace' })).toMatchObject({ bucket: null, repository: null, prefix: null })
    expect(parseProjectKbs('acme/board=KB12345678 Acme/Other=KB87654321')).toEqual(new Map([['acme/board', 'KB12345678'], ['acme/other', 'KB87654321']]))
    expect(() => parseProjectKbs('acme/board=short')).toThrow(/TRACE_PROJECT_KBS/)
    expect(parseProjectKbs(undefined).size).toBe(0)
  })
})
