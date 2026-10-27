/**
 * The central store: what every project trace is onboarded to shares — one SQLite database and its documents.
 *
 *   <TRACE_HOME>/central.db           the datasheet library's catalog and page text (src/tools/datasheets), the parts
 *                                      database (src/tools/parts), the registry of projects
 *   <TRACE_HOME>/docs/<sha256>.pdf    datasheets, named by their content: one copy however many parts and projects
 *                                      cite it
 *
 * TRACE_HOME (store.traceHome()) is a directory, a file:// URL or s3://bucket/prefix. It is meant to be one org-wide
 * variable, so every project and every CI job reads and writes the same store; it defaults to ~/.trace.
 *
 * Writes stay safe with many writers:
 *
 *   local  central.db is opened in place (WAL, busy timeout) and `update(fn)` runs fn inside BEGIN IMMEDIATE: writers
 *          queue and SQLite does the locking. Documents are written to a temporary file and renamed into place.
 *   S3     S3 cannot lock, so `update(fn)` downloads the database, runs fn on the copy in a transaction and uploads it
 *          with a conditional write (If-Match on the ETag it downloaded, If-None-Match when there was none). When
 *          another writer got in first S3 answers 412 (or 409), and the update is re-run on a fresh download. So fn
 *          must be replayable: it reads what it needs from the database it is given and writes from that, never from
 *          state captured before the call. Retries are bounded, with backoff; then the conflict is reported.
 *
 * `read()` gives a read-only connection: the database itself (local) or an up-to-date local copy (S3, downloaded
 * again only when its ETag moved). Other areas add their tables with `ensureSchema(sql)` — idempotent
 * CREATE … IF NOT EXISTS statements — which every later read and update applies.
 *
 * The Backend interface (get / head / put with conditions / list) is all a new kind of store has to provide.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { open, traceHome, transaction } from './store.js'

export const CENTRAL_DB = 'central.db'

export class CentralError extends Error {
  override name = 'CentralError'
}

/** A conditional put was refused: someone else wrote the object since it was read. */
export class Conflict extends CentralError {
  override name = 'Conflict'
}

export interface PutOptions {
  /** Write only if the object's ETag is still this one. */
  readonly ifMatch?: string
  /** Write only if there is no such object yet. */
  readonly ifNoneMatch?: boolean
  readonly contentType?: string
}

/** Bytes under '/'-separated keys relative to the store's root. */
export interface Backend {
  readonly url: string
  /** The object and its ETag, or null when there is none. */
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>
  head(key: string): Promise<string | null>
  /** Write and return the new ETag; throws Conflict when a condition fails. */
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<string>
  list(prefix?: string): Promise<string[]>
  /** A path on this machine, when the store is a local directory. */
  localPath(key: string): string | null
}

const md5Etag = (b: Uint8Array): string => `"${createHash('md5').update(b).digest('hex')}"`
export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

// ------------------------------------------------------------------ local directory

export class LocalBackend implements Backend {
  readonly root: string
  readonly url: string

  constructor(root: string) {
    this.root = resolve(root.startsWith('~') ? join(homedir(), root.slice(1)) : root)
    this.url = this.root
  }

  private path(key: string): string {
    const p = resolve(this.root, key)
    const rel = relative(this.root, p)
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new CentralError(`key ${JSON.stringify(key)} escapes the store`)
    return p
  }

  localPath(key: string): string {
    const p = this.path(key)
    mkdirSync(dirname(p), { recursive: true })
    return p
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const p = this.path(key)
    if (!existsSync(p)) return null
    const body = new Uint8Array(readFileSync(p))
    return { body, etag: md5Etag(body) }
  }

  async head(key: string): Promise<string | null> {
    return (await this.get(key))?.etag ?? null
  }

  /** Atomic (a temporary file renamed into place). Conditions are checked just before the rename: good enough for
   * content-addressed documents, the only thing written here; central.db itself is never put locally (SQLite locks it). */
  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<string> {
    const p = this.localPath(key)
    if (opts.ifNoneMatch && existsSync(p)) throw new Conflict(`${key} already exists`)
    if (opts.ifMatch !== undefined && (await this.head(key)) !== opts.ifMatch) throw new Conflict(`${key} changed since it was read`)
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, p)
    return md5Etag(body)
  }

  async list(prefix = ''): Promise<string[]> {
    const { readdirSync } = await import('node:fs')
    const out: string[] = []
    const walk = (d: string): void => {
      if (!existsSync(d)) return
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (!e.name.endsWith('.tmp')) out.push(relative(this.root, full).split(sep).join('/'))
      }
    }
    walk(this.root)
    return out.filter((k) => k.startsWith(prefix)).sort()
  }
}

// ------------------------------------------------------------------ S3

/** The four S3 calls the store needs, in the AWS SDK's own shapes, so a test can hand in a fake. */
export interface S3Api {
  getObject(i: { Bucket: string; Key: string }): Promise<{ Body: Uint8Array; ETag?: string | undefined }>
  headObject(i: { Bucket: string; Key: string }): Promise<{ ETag?: string | undefined }>
  putObject(i: { Bucket: string; Key: string; Body: Uint8Array; ContentType?: string; IfMatch?: string; IfNoneMatch?: string }): Promise<{ ETag?: string | undefined }>
  listObjectsV2(i: { Bucket: string; Prefix: string; ContinuationToken?: string }): Promise<{
    Contents?: { Key?: string | undefined }[] | undefined
    IsTruncated?: boolean | undefined
    NextContinuationToken?: string | undefined
  }>
}

/** An AWS SDK error's name and HTTP status, whatever shape it came in. */
function awsError(e: unknown): { name: string; status: number } {
  if (typeof e !== 'object' || e === null) return { name: '', status: 0 }
  const o = e as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } }
  const name = typeof o.name === 'string' ? o.name : typeof o.Code === 'string' ? o.Code : ''
  const status = typeof o.$metadata?.httpStatusCode === 'number' ? o.$metadata.httpStatusCode : 0
  return { name, status }
}

const isMissing = (e: unknown): boolean => {
  const { name, status } = awsError(e)
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404
}

/** The real client (@aws-sdk/client-s3), loaded on first use. */
async function awsS3(): Promise<S3Api> {
  const s3 = await import('@aws-sdk/client-s3')
  const client = new s3.S3Client({})
  return {
    async getObject(i) {
      const r = await client.send(new s3.GetObjectCommand(i))
      if (!r.Body) throw new CentralError(`s3://${i.Bucket}/${i.Key}: no body`)
      return { Body: await r.Body.transformToByteArray(), ETag: r.ETag }
    },
    async headObject(i) {
      const r = await client.send(new s3.HeadObjectCommand(i))
      return { ETag: r.ETag }
    },
    async putObject(i) {
      const r = await client.send(new s3.PutObjectCommand(i))
      return { ETag: r.ETag }
    },
    async listObjectsV2(i) {
      const r = await client.send(new s3.ListObjectsV2Command(i))
      return { Contents: r.Contents?.map((c) => ({ Key: c.Key })), IsTruncated: r.IsTruncated, NextContinuationToken: r.NextContinuationToken }
    },
  }
}

export class S3Backend implements Backend {
  readonly url: string
  readonly prefix: string
  private client: S3Api | null

  constructor(readonly bucket: string, prefix = '', client?: S3Api) {
    this.prefix = prefix.replace(/^\/+|\/+$/g, '')
    this.url = `s3://${bucket}${this.prefix ? `/${this.prefix}` : ''}`
    this.client = client ?? null
  }

  private async s3(): Promise<S3Api> {
    this.client ??= await awsS3()
    return this.client
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}/${k}` : k
  }

  localPath(): null {
    return null
  }

  /**
   * S3 answers 403, not 404, for a missing object unless the caller may list the bucket unconditionally; the roles
   * may list only their own prefixes. So a 403 is taken for "missing" only when listing that very key (allowed under
   * those prefixes) shows it is not there; when the listing is refused too, the 403 stands.
   */
  private async missing(e: unknown, key: string): Promise<boolean> {
    if (isMissing(e)) return true
    const { name, status } = awsError(e)
    if (name !== 'AccessDenied' && status !== 403) return false
    try {
      return !(await this.list(key)).includes(key)
    } catch {
      return false
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    try {
      const r = await (await this.s3()).getObject({ Bucket: this.bucket, Key: this.key(key) })
      return { body: r.Body, etag: r.ETag ?? '' }
    } catch (e) {
      if (await this.missing(e, key)) return null
      throw e
    }
  }

  async head(key: string): Promise<string | null> {
    try {
      return (await (await this.s3()).headObject({ Bucket: this.bucket, Key: this.key(key) })).ETag ?? ''
    } catch (e) {
      if (await this.missing(e, key)) return null
      throw e
    }
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<string> {
    const req = {
      Bucket: this.bucket, Key: this.key(key), Body: body, ContentType: opts.contentType ?? 'application/octet-stream',
      ...(opts.ifMatch !== undefined ? { IfMatch: opts.ifMatch } : opts.ifNoneMatch ? { IfNoneMatch: '*' } : {}),
    }
    try {
      return (await (await this.s3()).putObject(req)).ETag ?? ''
    } catch (e) {
      const { name, status } = awsError(e)
      if (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412 || status === 409) {
        throw new Conflict(`${this.url}/${key}: ${name || status}`)
      }
      throw e
    }
  }

  async list(prefix = ''): Promise<string[]> {
    const out: string[] = []
    let token: string | undefined
    for (;;) {
      const r = await (await this.s3()).listObjectsV2({ Bucket: this.bucket, Prefix: this.key(prefix), ...(token ? { ContinuationToken: token } : {}) })
      for (const o of r.Contents ?? []) if (o.Key) out.push(this.prefix ? o.Key.slice(this.prefix.length + 1) : o.Key)
      if (!r.IsTruncated || !r.NextContinuationToken) return out
      token = r.NextContinuationToken
    }
  }
}

export function backendFor(location: string, s3?: S3Api): Backend {
  if (location.startsWith('s3://')) {
    const u = new URL(location)
    if (!u.hostname) throw new CentralError(`${location}: no bucket`)
    return new S3Backend(u.hostname, decodeURIComponent(u.pathname), s3)
  }
  if (location.startsWith('file://')) return new LocalBackend(fileURLToPath(location))
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) {
    throw new CentralError(`${location}: not a store trace can use (a directory, file://… or s3://bucket/prefix)`)
  }
  return new LocalBackend(location)
}

// ------------------------------------------------------------------ the central database

/** A migration a statement cannot express (a column added to an existing table): it checks before it changes, so it
 * can run on every read and update. */
export type SchemaFn = (db: DatabaseSync) => void

const SCHEMAS: (string | SchemaFn)[] = []

/** Register tables for the central database (CREATE … IF NOT EXISTS), or a migration function that checks before it
 * changes anything. Applied, in registration order, by every read and update after it. */
export function ensureSchema(sql: string | SchemaFn): void {
  if (!SCHEMAS.includes(sql)) SCHEMAS.push(sql)
}

export function cacheDir(...parts: string[]): string {
  const d = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tracekit', ...parts)
  mkdirSync(d, { recursive: true })
  return d
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A function an update runs: synchronous (the transaction is), and replayable (see the module comment). */
export type UpdateFn<T> = (db: DatabaseSync) => T

export interface CentralOptions {
  /** Where the store is; default TRACE_HOME. */
  readonly home?: string
  /** An S3 client to use instead of the AWS SDK's (tests). */
  readonly s3?: S3Api
  /** How many times an S3 update is re-run after a conflict. */
  readonly retries?: number
}

export class Central {
  readonly home: string
  readonly backend: Backend
  readonly retries: number
  private applied = -1

  constructor(opts: CentralOptions = {}) {
    this.home = opts.home ?? traceHome()
    this.backend = backendFor(this.home, opts.s3)
    this.retries = opts.retries ?? 5
  }

  get remote(): boolean {
    return this.backend.localPath(CENTRAL_DB) === null
  }

  get location(): string {
    return this.backend.url
  }

  /** Add tables now (and for every later read and update). */
  ensureSchema(sql: string | SchemaFn): void {
    ensureSchema(sql)
    this.applied = -1
  }

  private applySchemas(db: DatabaseSync): void {
    for (const sql of SCHEMAS) {
      if (typeof sql === 'string') db.exec(sql)
      else sql(db)
    }
  }

  // -- the S3 read copy

  private copyPaths(): { db: string; etag: string } {
    const d = cacheDir('central', createHash('sha1').update(this.backend.url).digest('hex').slice(0, 16))
    return { db: join(d, CENTRAL_DB), etag: join(d, 'etag') }
  }

  private async refreshCopy(): Promise<string> {
    const c = this.copyPaths()
    const etag = await this.backend.head(CENTRAL_DB)
    const have = existsSync(c.etag) && existsSync(c.db) ? readFileSync(c.etag, 'utf8') : null
    if (etag === null) {
      if (have !== null || !existsSync(c.db)) {
        rmSync(c.db, { force: true })
        rmSync(c.etag, { force: true })
      }
    } else if (etag !== have) {
      const got = await this.backend.get(CENTRAL_DB)
      if (got) {
        writeFileSync(`${c.db}.tmp`, got.body)
        renameSync(`${c.db}.tmp`, c.db)
        writeFileSync(c.etag, got.etag)
      }
    }
    const db = open(c.db, { wal: false })
    try {
      this.applySchemas(db)
    } finally {
      db.close()
    }
    return c.db
  }

  // -- reading and writing

  /** A read-only connection to the central database as it is now. The caller closes it (or use `query`). */
  async read(): Promise<DatabaseSync> {
    if (this.remote) return open(await this.refreshCopy(), { readonly: true })
    const p = this.backend.localPath(CENTRAL_DB) as string
    if (!existsSync(p) || this.applied !== SCHEMAS.length) {
      const db = open(p)
      try {
        transaction(db, () => this.applySchemas(db))
      } finally {
        db.close()
      }
      this.applied = SCHEMAS.length
    }
    return open(p, { readonly: true })
  }

  /** Run fn on a read-only connection and close it. */
  async query<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    const db = await this.read()
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  /** Run fn(db) in a write transaction and return its result. On S3 it is re-run on a fresh copy after a conflict,
   * so fn must be replayable. */
  async update<T>(fn: UpdateFn<T>, opts: { retries?: number } = {}): Promise<T> {
    if (!this.remote) {
      const db = open(this.backend.localPath(CENTRAL_DB) as string)
      try {
        // The schema inside the same IMMEDIATE transaction: first writers racing to create tables queue too.
        const out = transaction(db, () => {
          this.applySchemas(db)
          return fn(db)
        })
        this.applied = SCHEMAS.length
        return out
      } finally {
        db.close()
      }
    }
    const tries = opts.retries ?? this.retries
    let last: unknown = null
    for (let attempt = 0; attempt <= tries; attempt++) {
      const got = await this.backend.get(CENTRAL_DB)
      const dir = mkdtempSync(join(tmpdir(), 'trace-central-'))
      const path = join(dir, CENTRAL_DB)
      try {
        if (got) writeFileSync(path, got.body)
        const db = open(path, { wal: false })
        let out: T
        try {
          this.applySchemas(db)
          out = transaction(db, () => fn(db))
        } finally {
          db.close()
        }
        const body = new Uint8Array(readFileSync(path))
        let etag: string
        try {
          etag = await this.backend.put(CENTRAL_DB, body, {
            ...(got ? { ifMatch: got.etag } : { ifNoneMatch: true }), contentType: 'application/vnd.sqlite3',
          })
        } catch (e) {
          if (!(e instanceof Conflict)) throw e
          last = e
          await sleep(Math.min(2000, 50 * 2 ** attempt) * (0.5 + Math.random()))
          continue
        }
        const c = this.copyPaths()
        writeFileSync(c.db, body)
        writeFileSync(c.etag, etag)
        return out
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    throw new CentralError(`${this.location}/${CENTRAL_DB}: still changing under us after ${tries + 1} attempts (${String(last)})`)
  }

  // -- documents

  static docKey(sha256: string): string {
    return `docs/${sha256.toLowerCase()}.pdf`
  }

  private cachedDoc(sha256: string): string {
    return join(cacheDir('datasheets'), `${sha256.toLowerCase()}.pdf`)
  }

  /** Store a document under its sha256 (once); returns the sha256. */
  async putDoc(body: Uint8Array): Promise<string> {
    const sha = sha256Hex(body)
    const key = Central.docKey(sha)
    if ((await this.backend.head(key)) === null) {
      try {
        await this.backend.put(key, body, { ifNoneMatch: true, contentType: 'application/pdf' })
      } catch (e) {
        if (!(e instanceof Conflict)) throw e // someone stored the same bytes first: same name, same content
      }
    }
    const cached = this.cachedDoc(sha)
    if (!existsSync(cached)) {
      writeFileSync(`${cached}.tmp`, body)
      renameSync(`${cached}.tmp`, cached)
    }
    return sha
  }

  async docExists(sha256: string): Promise<boolean> {
    return (await this.backend.head(Central.docKey(sha256))) !== null
  }

  /** A local copy of the document (~/.cache/tracekit/datasheets/<sha256>.pdf), its content checked against its name. */
  async docPath(sha256: string): Promise<string> {
    const sha = sha256.toLowerCase()
    const p = this.cachedDoc(sha)
    if (existsSync(p) && sha256Hex(readFileSync(p)) === sha) return p
    const got = await this.backend.get(Central.docKey(sha))
    if (!got) throw new CentralError(`no document ${sha.slice(0, 16)}… in ${this.location}/docs`)
    if (sha256Hex(got.body) !== sha) throw new CentralError(`${this.location}/${Central.docKey(sha)} does not hash to its name: refused`)
    writeFileSync(`${p}.tmp`, got.body)
    renameSync(`${p}.tmp`, p)
    return p
  }

  async getDoc(sha256: string): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(await this.docPath(sha256)))
  }
}

const instances = new Map<string, Central>()

/** The Central for `home` (default TRACE_HOME), one per location per process. */
export function central(home?: string): Central {
  const h = home ?? traceHome()
  let c = instances.get(h)
  if (!c) {
    c = new Central({ home: h })
    instances.set(h, c)
  }
  return c
}

/** Forget the per-process instances (tests that change TRACE_HOME). */
export function resetCentral(): void {
  instances.clear()
}

// ------------------------------------------------------------------ the module API other areas use

/** A read-only connection to the central database (TRACE_HOME); the caller closes it. On S3, an up-to-date local copy. */
export async function read(): Promise<DatabaseSync> {
  return central().read()
}

/** Run fn in a write transaction on the central database (TRACE_HOME). Replayable: on S3 it may run more than once. */
export async function update<T>(fn: (db: DatabaseSync) => T): Promise<T> {
  return central().update(fn)
}

/** The resolved central store location (TRACE_HOME: a directory, or s3://bucket/prefix). */
export function location(): string {
  return central().location
}

/** Store a document in the central store under its sha256; returns the sha256. */
export async function putDoc(body: Uint8Array): Promise<string> {
  return central().putDoc(body)
}

/** A verified local copy of a stored document. */
export async function docPath(sha256: string): Promise<string> {
  return central().docPath(sha256)
}

export async function docExists(sha256: string): Promise<boolean> {
  return central().docExists(sha256)
}
