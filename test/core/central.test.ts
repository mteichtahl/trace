import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { backendFor, Central, CentralError, LocalBackend, S3Backend, sha256Hex } from '../../src/core/central.js'
import { FakeS3 } from './fake-s3.js'

const SCHEMA = 'CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v INTEGER NOT NULL);'
const tmp = () => mkdtempSync(join(tmpdir(), 'trace-central-'))

describe('backendFor', () => {
  it('chooses by location', () => {
    expect(backendFor('/tmp/x')).toBeInstanceOf(LocalBackend)
    expect(backendFor('file:///tmp/x')).toBeInstanceOf(LocalBackend)
    const s = backendFor('s3://bucket/some/prefix', new FakeS3())
    expect(s).toBeInstanceOf(S3Backend)
    expect((s as S3Backend).prefix).toBe('some/prefix')
    expect(() => backendFor('gs://x')).toThrow(CentralError)
  })

  it('refuses keys that escape the directory', () => {
    expect(() => new LocalBackend(tmp()).localPath('../x')).toThrow(CentralError)
  })
})

describe('local central store', () => {
  it('updates in a transaction and reads back', async () => {
    const c = new Central({ home: tmp() })
    c.ensureSchema(SCHEMA)
    await c.update((db) => { db.prepare('INSERT INTO t VALUES (?,?)').run('a', 1) })
    expect(await c.query((db) => db.prepare('SELECT v FROM t WHERE k=?').get('a')?.v)).toBe(1)
    await expect(c.update((db) => { db.prepare('INSERT INTO t VALUES (?,?)').run('b', 2); throw new Error('no') })).rejects.toThrow('no')
    expect(await c.query((db) => db.prepare('SELECT count(*) AS n FROM t').get()?.n)).toBe(1)
  })

  it('concurrent writers from separate processes lose nothing', async () => {
    const home = tmp()
    const here = dirname(fileURLToPath(import.meta.url))
    const dir = tmp()
    const src = join(dir, 'writer.ts')
    const script = join(dir, 'writer.mjs')
    writeFileSync(src, `
      import { Central } from ${JSON.stringify(join(here, '..', '..', 'src', 'core', 'central.ts'))}
      const c = new Central({ home: process.argv[2] })
      c.ensureSchema(${JSON.stringify(SCHEMA)})
      for (let i = 0; i < 25; i++) await c.update((db) => { db.prepare('INSERT INTO t VALUES (?,?)').run(process.argv[3] + i, i) })
    `)
    // Bundle it (esbuild resolves the sources' .js imports to .ts) so each writer is a plain Node process.
    const { build } = await import('esbuild')
    await build({ entryPoints: [src], outfile: script, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    const { execFile } = await import('node:child_process')
    const run = (tag: string) => new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ['--no-warnings', script, home, tag], (e, _o, err) => (e ? reject(new Error(err || e.message)) : resolve()))
    })
    await Promise.all([run('x'), run('y'), run('z')])
    const c = new Central({ home })
    c.ensureSchema(SCHEMA)
    expect(await c.query((db) => db.prepare('SELECT count(*) AS n FROM t').get()?.n)).toBe(75)
  })

  it('stores documents once, by content', async () => {
    const home = tmp()
    const c = new Central({ home })
    const body = new TextEncoder().encode('%PDF-1.4 hello')
    const sha = await c.putDoc(body)
    expect(sha).toBe(sha256Hex(body))
    expect(await c.putDoc(body)).toBe(sha)
    expect(await c.docExists(sha)).toBe(true)
    expect(await c.backend.list('docs/')).toEqual([`docs/${sha}.pdf`])
    expect(Buffer.from(await c.getDoc(sha)).toString()).toBe('%PDF-1.4 hello')
  })
})

describe('S3 central store', () => {
  it('creates, then updates with If-Match', async () => {
    const s3 = new FakeS3()
    const c = new Central({ home: 's3://b/trace', s3 })
    c.ensureSchema(SCHEMA)
    await c.update((db) => { db.prepare('INSERT INTO t VALUES (?,?)').run('a', 1) })
    await c.update((db) => { db.prepare('INSERT INTO t VALUES (?,?)').run('b', 2) })
    expect(s3.objects.has('b/trace/central.db')).toBe(true)
    expect(await c.query((db) => db.prepare('SELECT count(*) AS n FROM t').get()?.n)).toBe(2)
  })

  it('re-runs a replayable update after a conflict and keeps the other writer\'s row', async () => {
    const s3 = new FakeS3()
    const mine = new Central({ home: 's3://b/p', s3 })
    const theirs = new Central({ home: 's3://b/p', s3 })
    mine.ensureSchema(SCHEMA)
    await mine.update((db) => { db.prepare('INSERT INTO t VALUES (?,?)').run('counter', 0) })
    let runs = 0
    // Between my download and my upload, another writer increments the counter.
    s3.interleave = () => theirs.update((db) => { db.prepare("UPDATE t SET v=v+1 WHERE k='counter'").run() })
    await mine.update((db) => {
      runs++
      db.prepare("UPDATE t SET v=v+10 WHERE k='counter'").run()
    })
    expect(runs).toBe(2)
    expect(s3.conflicts).toBeGreaterThanOrEqual(1)
    expect(await mine.query((db) => db.prepare("SELECT v FROM t WHERE k='counter'").get()?.v)).toBe(11)
  })

  it('gives up after bounded retries', async () => {
    const s3 = new FakeS3()
    const c = new Central({ home: 's3://b/q', s3, retries: 2 })
    c.ensureSchema(SCHEMA)
    await c.update((db) => { db.prepare('INSERT INTO t VALUES (?,?)').run('a', 1) })
    const original = s3.putObject.bind(s3)
    s3.putObject = async (i) => {
      if (i.Key.endsWith('central.db')) throw Object.assign(new Error('x'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
      return original(i)
    }
    await expect(c.update(() => 1)).rejects.toThrow(/after 3 attempts/)
  })

  it('documents go to docs/<sha256>.pdf and are verified on the way back', async () => {
    const s3 = new FakeS3()
    const c = new Central({ home: 's3://b/d', s3 })
    const sha = await c.putDoc(new TextEncoder().encode('%PDF-1.4 x'))
    expect(s3.objects.has(`b/d/docs/${sha}.pdf`)).toBe(true)
    const other = 'f'.repeat(64)
    s3.objects.set(`b/d/docs/${other}.pdf`, { body: new TextEncoder().encode('tampered'), etag: '"t"' })
    await expect(c.docPath(other)).rejects.toThrow(/does not hash/)
  })
})
