/**
 * Where a project's journey record lives: one SQLite database per project in the central bucket, beside its chats and
 * memory state, holding only the journey's tables (src/core/journey.ts).
 *
 *   where   projects/<slug>/journey/journey.db   (s3://<bucket>/projects/… in AWS; <TRACE_HOME's parent>/projects/…
 *           locally, through the same Backend as the central store)
 *   how     read: the object is fetched and opened as a temporary copy. Write: fetched with its ETag, changed in a
 *           temporary copy, and put back with If-Match (If-None-Match for the first write). When another writer got
 *           in first the put is refused (412/409) and the whole change runs again on a fresh copy, with backoff, a
 *           few times: one writer wins each round, as with the central store and chats. So a change must be
 *           replayable: it reads what it needs from the database it is given
 *   version every write that changes something adds one to the database's user_version; actions answer it as
 *           `version`, so a screen can tell whether what it shows is current
 *
 * A project onboarded before the record moved here may have its journey in the repository's .trace/project.db (the
 * same tables). The first read or write of a project with no journey here imports it (`legacy`: the caller fetches
 * the repository's database), once: the import is itself a conditional write. A project with neither is remembered
 * for a few minutes, so a busy inbox does not ask GitHub again and again.
 *
 * The repository gets a copy of the record when a release is cut (journey.snapshot, src/api/actions-journey.ts), so a
 * released revision carries the record that approved it; the bucket stays the live record.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { type Backend, Conflict } from './central.js'
import { applyJourneySchema, copyJourneyTables } from './journey.js'
import { projectSlug } from './project.js'
import { open } from './store.js'

export const JOURNEY_FOLDER = 'journey'
export const JOURNEY_DB = 'journey.db'

export class JourneyStoreError extends Error {
  override name = 'JourneyStoreError'
}

/** Projects found to have no journey anywhere, and when: asked again only after NO_JOURNEY_MS. */
const NO_JOURNEY_MS = 5 * 60 * 1000
const none = new Map<string, number>()
/** Forget what was learned about projects without a journey (tests, and after a project is created). */
export const forgetNoJourney = (repo?: string): void => { if (repo) none.delete(projectSlug(repo)); else none.clear() }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface JourneyStoreOptions {
  /** Where temporary copies go (default: the system's temporary folder). */
  scratch?: string
  /** The repository's .trace/project.db, for a project whose journey is still there (null: none). */
  legacy?: () => Promise<Uint8Array | null>
  retries?: number
}

/**
 * One SQLite database in the central bucket, read and written with conditional puts (see the module comment): the
 * journey store below and the agents' facts store (src/core/agent-facts.ts) are both this, with their own key and
 * tables.
 */
export class BucketDb {
  readonly slug: string
  readonly key: string
  protected readonly retries: number

  constructor(protected readonly store: Backend, repo: string, protected readonly where: { folder: string; file: string; schema: (db: DatabaseSync) => void; key?: string },
    protected readonly o: Omit<JourneyStoreOptions, 'legacy'> = {}) {
    this.slug = where.key ? '' : projectSlug(repo)
    // `key`: one database of the installation's (not a project's) at a fixed key of `store` (src/core/cost.ts)
    this.key = where.key ?? `${this.slug}/${where.folder}/${where.file}`
    this.retries = o.retries ?? 5
  }

  protected temp(bytes: Uint8Array | null): { path: string; cleanup(): void } {
    const dir = mkdtempSync(join(this.o.scratch ?? tmpdir(), 'trace-journey-'))
    const path = join(dir, this.where.file)
    if (bytes) writeFileSync(path, bytes)
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  protected openAt(path: string): DatabaseSync {
    const db = open(path, { wal: false })
    this.where.schema(db)
    return db
  }

  private static version(db: DatabaseSync): number {
    return Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0)
  }

  /** The store's bytes and ETag (null: none yet). */
  protected async fetch(): Promise<{ body: Uint8Array; etag: string } | null> {
    return this.store.get(this.key)
  }

  /** After a write: forget anything remembered about the object being absent. */
  protected written(): void { /* nothing remembered here */ }

  /** Run fn on the database as it is now (read only), with its version (0: there is nothing yet). */
  async read<T>(fn: (db: DatabaseSync) => T): Promise<{ result: T; version: number }> {
    const got = await this.fetch()
    const t = this.temp(got?.body ?? null)
    try {
      const db = this.openAt(t.path)
      try {
        return { result: fn(db), version: BucketDb.version(db) }
      } finally {
        db.close()
      }
    } finally {
      t.cleanup()
    }
  }

  /** The database's bytes as they are now, or null when there is none (the release copy reads it). */
  async bytes(): Promise<Uint8Array | null> {
    return (await this.fetch())?.body ?? null
  }

  /**
   * Change the database: fn runs on a fresh copy (it opens its own transactions), and the copy is put back with a
   * condition; a lost race runs fn again on a fresh copy. `changed: false` (nothing to do): nothing is written.
   */
  async update<T>(fn: (db: DatabaseSync) => { result: T; changed?: boolean }): Promise<{ result: T; version: number; changed: boolean }> {
    let last: unknown = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const got = await this.fetch()
      const t = this.temp(got?.body ?? null)
      try {
        const db = this.openAt(t.path)
        let out: { result: T; changed?: boolean }
        let version: number
        try {
          out = fn(db)
          version = BucketDb.version(db)
          if (out.changed !== false) db.exec(`PRAGMA user_version = ${++version}`)
        } finally {
          db.close()
        }
        if (out.changed === false) return { result: out.result, version, changed: false }
        try {
          await this.store.put(this.key, new Uint8Array(readFileSync(t.path)), {
            ...(got ? { ifMatch: got.etag } : { ifNoneMatch: true }), contentType: 'application/vnd.sqlite3',
          })
          this.written()
          return { result: out.result, version, changed: true }
        } catch (e) {
          if (!(e instanceof Conflict)) throw e
          last = e
          await sleep(Math.min(2000, 40 * 2 ** attempt) * (0.5 + Math.random()))
        }
      } finally {
        t.cleanup()
      }
    }
    throw new JourneyStoreError(`The ${this.where.folder === JOURNEY_FOLDER ? 'journey record' : 'record'} kept changing while this was being saved; try again. (${last instanceof Error ? last.message : String(last)})`)
  }
}

/** One project's journey store, in `store` (the central bucket at its `projects` prefix). */
export class JourneyStore extends BucketDb {
  constructor(store: Backend, repo: string, private readonly legacyOf: JourneyStoreOptions = {}) {
    super(store, repo, { folder: JOURNEY_FOLDER, file: JOURNEY_DB, schema: (db) => applyJourneySchema(db, { store: true }) }, legacyOf)
  }

  protected override written(): void { none.delete(this.slug) }

  /** The store's bytes and ETag, importing an older repository's journey the first time (see the module comment). */
  protected override async fetch(): Promise<{ body: Uint8Array; etag: string } | null> {
    const got = await this.store.get(this.key)
    if (got || !this.legacyOf.legacy) return got
    const seen = none.get(this.slug)
    if (seen !== undefined && Date.now() - seen < NO_JOURNEY_MS) return null
    const legacy = await this.legacyOf.legacy()
    if (!legacy) { none.set(this.slug, Date.now()); return null }
    const src = this.temp(legacy)
    const dst = this.temp(null)
    try {
      const db = this.openAt(dst.path)
      let had: boolean
      try {
        had = copyJourneyTables(db, src.path)
        if (had) db.exec('PRAGMA user_version = 1')
      } finally {
        db.close()
      }
      if (!had) { none.set(this.slug, Date.now()); return null }
      const body = new Uint8Array(readFileSync(dst.path))
      try {
        await this.store.put(this.key, body, { ifNoneMatch: true, contentType: 'application/vnd.sqlite3' })
      } catch (e) {
        if (!(e instanceof Conflict)) throw e // someone else wrote (or imported) it first: theirs stands
      }
      return this.store.get(this.key)
    } finally {
      src.cleanup()
      dst.cleanup()
    }
  }
}
