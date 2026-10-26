/**
 * The shared datasheet library: one for every project trace is onboarded to.
 *
 * A project never keeps its own copy of a datasheet. It names a document by part number (MPN) and pins the exact
 * version by sha256; the library, in the central store (src/core/central.ts), holds the bytes and their history:
 *
 *   datasheet_parts      one row per part number: manufacturer, title, status (current | retired), the current version
 *   datasheet_versions   every document a part has had, newest first by `at`: sha256, file name, where it came from
 *                        (via url | upload, the source URL), who added it and when, and when it was replaced
 *   datasheet_aliases    other spellings of a part number (packaging and reel variants), each pointing at one part.
 *                        Only ever added on purpose: the library never merges two part numbers on a guess
 *   datasheet_changes    a newer document replacing an older one. It stays open until someone acknowledges it (has
 *                        re-read the figures they took from the old one), so a changed vendor document is never missed
 *   datasheet_documents  one row per distinct document (sha256): size, page count. The bytes are docs/<sha256>.pdf
 *   datasheet_pages      the text of every page, extracted once per document and shared by every part citing it,
 *                        with an FTS5 index (datasheet_pages_fts) for `find`; LIKE when FTS5 is unavailable
 *
 * Removing a part only marks it retired: documents are never deleted, because some project may cite them.
 * Every figure this area returns carries a citation {mpn, sha256, page}.
 */
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { Central, central } from '../core/central.js'
import { ToolError } from '../core/registry.js'
import { downloadPdf, isPdf, MAX_BYTES, type FetchLike, type ResolveHost } from './download.js'
import { mpnKey, packagingBase } from './mpn.js'
import { pdfText } from './text.js'

export const DATASHEET_SCHEMA = `
CREATE TABLE IF NOT EXISTS datasheet_parts (
  key TEXT PRIMARY KEY,               -- mpnKey(mpn)
  mpn TEXT NOT NULL,                  -- as first written
  manufacturer TEXT, title TEXT,
  status TEXT NOT NULL DEFAULT 'current',   -- current | retired
  current_sha TEXT,
  added_at TEXT NOT NULL, added_by TEXT, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasheet_documents (
  sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, pages INTEGER, stored_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasheet_versions (
  part_key TEXT NOT NULL REFERENCES datasheet_parts(key),
  sha256 TEXT NOT NULL REFERENCES datasheet_documents(sha256),
  file TEXT, source_url TEXT, via TEXT NOT NULL, by TEXT, at TEXT NOT NULL, replaced_at TEXT,
  PRIMARY KEY (part_key, sha256)
);
CREATE TABLE IF NOT EXISTS datasheet_aliases (
  alias TEXT PRIMARY KEY, part_key TEXT NOT NULL REFERENCES datasheet_parts(key), added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasheet_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_key TEXT NOT NULL REFERENCES datasheet_parts(key),
  from_sha TEXT NOT NULL, to_sha TEXT NOT NULL, at TEXT NOT NULL,
  acknowledged_at TEXT, acknowledged_by TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS datasheet_changes_open ON datasheet_changes(part_key, acknowledged_at);
CREATE TABLE IF NOT EXISTS datasheet_pages (
  sha256 TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (sha256, page)
);
`

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS datasheet_pages_fts USING fts5(text, sha256 UNINDEXED, page UNINDEXED, tokenize='unicode61');
`

/** What a figure was read from: the part key (mpnKey), the exact document and the page. */
export interface Citation {
  mpn: string
  sha256: string
  page: number
}

export type Via = 'url' | 'upload'

export interface VersionInfo {
  sha256: string
  file: string | null
  bytes: number
  pages: number | null
  source_url: string | null
  via: Via
  by: string | null
  at: string
  replaced_at: string | null
}

export interface ChangeInfo {
  id: number
  from: string
  to: string
  at: string
}

export interface PartEntry {
  key: string
  mpn: string
  manufacturer: string | null
  title: string | null
  status: 'current' | 'retired'
  current: VersionInfo | null
  history: VersionInfo[]
  changed: ChangeInfo | null
  aliases: string[]
}

export interface AddInput {
  mpn: string
  url?: string
  file?: string
  bytes?: Uint8Array
  manufacturer?: string
  title?: string
  by?: string
  aliases?: string[]
}

export interface AddResult {
  entry: PartEntry
  outcome: 'added' | 'new-version' | 'unchanged' | 'restored'
  sha256: string
  note?: string
}

export interface FindHit extends Citation {
  snippet: string
}

const nowIso = (): string => new Date().toISOString()

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

let ftsAvailable: boolean | null = null

function hasFts(db: DatabaseSync): boolean {
  if (ftsAvailable !== null) return ftsAvailable
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_probe USING fts5(x); DROP TABLE temp.fts_probe;')
    ftsAvailable = true
  } catch {
    ftsAvailable = false
  }
  return ftsAvailable
}

export interface LibraryOptions {
  central?: Central
  fetch?: FetchLike
  resolveHost?: ResolveHost
}

export class DatasheetLibrary {
  readonly central: Central
  private readonly fetchImpl: FetchLike | undefined
  private readonly resolveHost: ResolveHost | undefined

  constructor(opts: LibraryOptions = {}) {
    this.central = opts.central ?? central()
    this.central.ensureSchema(DATASHEET_SCHEMA)
    this.fetchImpl = opts.fetch
    this.resolveHost = opts.resolveHost
  }

  // ------------------------------------------------------------------ reading the catalog

  /** The part key a part number (or one of its aliases) resolves to, or null. */
  static resolveKey(db: DatabaseSync, mpn: string): string | null {
    const k = mpnKey(mpn)
    if (db.prepare('SELECT 1 FROM datasheet_parts WHERE key=?').get(k)) return k
    const a = db.prepare('SELECT part_key FROM datasheet_aliases WHERE alias=?').get(k)
    return a ? String(a.part_key) : null
  }

  static versions(db: DatabaseSync, key: string): VersionInfo[] {
    return db.prepare(`SELECT v.sha256, v.file, d.bytes, d.pages, v.source_url, v.via, v.by, v.at, v.replaced_at
      FROM datasheet_versions v JOIN datasheet_documents d USING (sha256) WHERE v.part_key=? ORDER BY v.at DESC, v.rowid DESC`)
      .all(key)
      .map((r) => ({
        sha256: String(r.sha256), file: str(r.file), bytes: Number(r.bytes), pages: num(r.pages), source_url: str(r.source_url),
        via: String(r.via) === 'upload' ? 'upload' : 'url', by: str(r.by), at: String(r.at), replaced_at: str(r.replaced_at),
      }))
  }

  static entry(db: DatabaseSync, key: string): PartEntry | null {
    const p = db.prepare('SELECT * FROM datasheet_parts WHERE key=?').get(key)
    if (!p) return null
    const all = DatasheetLibrary.versions(db, key)
    const cur = str(p.current_sha)
    const ch = db.prepare('SELECT id, from_sha, to_sha, at FROM datasheet_changes WHERE part_key=? AND acknowledged_at IS NULL ORDER BY id DESC LIMIT 1').get(key)
    return {
      key,
      mpn: String(p.mpn),
      manufacturer: str(p.manufacturer),
      title: str(p.title),
      status: String(p.status) === 'retired' ? 'retired' : 'current',
      current: all.find((v) => v.sha256 === cur) ?? null,
      history: all.filter((v) => v.sha256 !== cur),
      changed: ch ? { id: Number(ch.id), from: String(ch.from_sha), to: String(ch.to_sha), at: String(ch.at) } : null,
      aliases: db.prepare('SELECT alias FROM datasheet_aliases WHERE part_key=? ORDER BY alias').all(key).map((r) => String(r.alias)),
    }
  }

  /** One part's entry; a miss says which nearby key exists (a packaging variant), never silently substitutes it. */
  async entry(mpn: string): Promise<PartEntry> {
    return this.central.query((db) => {
      const key = DatasheetLibrary.resolveKey(db, mpn)
      if (key) return DatasheetLibrary.entry(db, key) as PartEntry
      const base = packagingBase(mpnKey(mpn))
      const near = base && DatasheetLibrary.resolveKey(db, base)
      throw new ToolError(`no datasheet for ${mpn} in the library` + (near ? `; ${near} is there (a packaging variant? add ${mpnKey(mpn)} as its alias if it is the same part)` : ''))
    })
  }

  async list(opts: { query?: string; status?: 'current' | 'retired' | 'changed' | 'all'; limit?: number } = {}): Promise<{ total: number; parts: PartEntry[] }> {
    return this.central.query((db) => {
      const where: string[] = []
      const args: string[] = []
      const status = opts.status ?? 'current'
      if (status === 'current' || status === 'retired') {
        where.push('p.status=?')
        args.push(status)
      } else if (status === 'changed') {
        where.push('EXISTS (SELECT 1 FROM datasheet_changes c WHERE c.part_key=p.key AND c.acknowledged_at IS NULL)')
      }
      if (opts.query) {
        const q = `%${opts.query.toLowerCase()}%`
        where.push(`(lower(p.mpn) LIKE ? OR lower(p.key) LIKE ? OR lower(coalesce(p.manufacturer,'')) LIKE ? OR lower(coalesce(p.title,'')) LIKE ?
          OR EXISTS (SELECT 1 FROM datasheet_aliases a WHERE a.part_key=p.key AND lower(a.alias) LIKE ?))`)
        args.push(q, q, q, q, q)
      }
      const sql = `SELECT key FROM datasheet_parts p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY key`
      const keys = db.prepare(sql).all(...args).map((r) => String(r.key))
      const limit = opts.limit ?? 50
      return { total: keys.length, parts: keys.slice(0, limit).map((k) => DatasheetLibrary.entry(db, k) as PartEntry) }
    })
  }

  // ------------------------------------------------------------------ adding

  /** Add a document for a part from a URL, a local file or bytes. The same bytes again change nothing; different
   * bytes become the new current version, the old one goes to history and a change is opened. */
  async add(input: AddInput): Promise<AddResult> {
    const key = mpnKey(input.mpn)
    if (!key) throw new ToolError('an empty part number')
    const sources = [input.url, input.file, input.bytes].filter((x) => x !== undefined).length
    if (sources !== 1) throw new ToolError('give exactly one of url or file')
    let bytes: Uint8Array
    let filename: string
    let via: Via
    let sourceUrl: string | null = null
    if (input.url !== undefined) {
      try {
        const d = await downloadPdf(input.url, { ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}), ...(this.resolveHost ? { resolveHost: this.resolveHost } : {}) })
        bytes = d.bytes
        filename = d.filename
      } catch (e) {
        throw new ToolError(`${input.mpn}: ${(e as Error).message}`)
      }
      via = 'url'
      sourceUrl = input.url
    } else if (input.file !== undefined) {
      try {
        bytes = new Uint8Array(readFileSync(input.file))
      } catch (e) {
        throw new ToolError(`${input.file}: ${(e as Error).message}`)
      }
      filename = input.file.split(/[\\/]/).pop() ?? 'datasheet.pdf'
      via = 'upload'
    } else {
      bytes = input.bytes as Uint8Array
      filename = `${key}.pdf`
      via = 'upload'
    }
    if (!isPdf(bytes)) throw new ToolError(`${filename}: not a PDF (no %PDF- header)`)
    if (bytes.length > MAX_BYTES) throw new ToolError(`${filename}: too large (${bytes.length} bytes)`)

    // The bytes and their text first (content-addressed: doing this twice is harmless) …
    let pages: string[]
    try {
      pages = (await pdfText(bytes)).pages
    } catch (e) {
      throw new ToolError(`${filename}: the PDF could not be read (${(e as Error).message})`)
    }
    const sha = await this.central.putDoc(bytes)
    const at = nowIso()
    const fts = await this.central.query((db) => hasFts(db))
    // … then the catalog, as a replayable change (an S3 store may run it more than once).
    return this.central.update((db) => {
      if (fts) db.exec(FTS_SCHEMA)
      db.prepare('INSERT OR IGNORE INTO datasheet_documents (sha256, bytes, pages, stored_at) VALUES (?,?,?,?)').run(sha, bytes.length, pages.length, at)
      const haveText = db.prepare('SELECT count(*) AS n FROM datasheet_pages WHERE sha256=?').get(sha)
      if (Number(haveText?.n ?? 0) === 0) {
        const ins = db.prepare('INSERT OR IGNORE INTO datasheet_pages (sha256, page, text) VALUES (?,?,?)')
        const insFts = fts ? db.prepare('INSERT INTO datasheet_pages_fts (text, sha256, page) VALUES (?,?,?)') : null
        pages.forEach((t, i) => {
          ins.run(sha, i + 1, t)
          insFts?.run(t, sha, i + 1)
        })
      }
      const existingKey = DatasheetLibrary.resolveKey(db, input.mpn) ?? key
      const p = db.prepare('SELECT current_sha, status FROM datasheet_parts WHERE key=?').get(existingKey)
      let outcome: AddResult['outcome']
      if (!p) {
        db.prepare('INSERT INTO datasheet_parts (key, mpn, manufacturer, title, status, current_sha, added_at, added_by, updated) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(existingKey, input.mpn.trim(), input.manufacturer ?? null, input.title ?? null, 'current', sha, at, input.by ?? null, at)
        outcome = 'added'
      } else {
        const cur = str(p.current_sha)
        const wasRetired = String(p.status) === 'retired'
        if (cur === sha) {
          outcome = wasRetired ? 'restored' : 'unchanged'
        } else {
          outcome = 'new-version'
          if (cur) {
            db.prepare('UPDATE datasheet_versions SET replaced_at=? WHERE part_key=? AND sha256=?').run(at, existingKey, cur)
            db.prepare('INSERT INTO datasheet_changes (part_key, from_sha, to_sha, at) VALUES (?,?,?,?)').run(existingKey, cur, sha, at)
          }
        }
        db.prepare(`UPDATE datasheet_parts SET current_sha=?, status='current', updated=?,
          manufacturer=coalesce(?, manufacturer), title=coalesce(?, title) WHERE key=?`)
          .run(sha, at, input.manufacturer ?? null, input.title ?? null, existingKey)
      }
      if (outcome !== 'unchanged' && outcome !== 'restored') {
        db.prepare(`INSERT INTO datasheet_versions (part_key, sha256, file, source_url, via, by, at, replaced_at) VALUES (?,?,?,?,?,?,?,NULL)
          ON CONFLICT (part_key, sha256) DO UPDATE SET at=excluded.at, replaced_at=NULL, file=excluded.file, source_url=excluded.source_url, via=excluded.via, by=excluded.by`)
          .run(existingKey, sha, filename, sourceUrl, via, input.by ?? null, at)
      }
      for (const a of input.aliases ?? []) {
        const ak = mpnKey(a)
        if (!ak || ak === existingKey) continue
        const other = db.prepare('SELECT part_key FROM datasheet_aliases WHERE alias=?').get(ak)
        if (db.prepare('SELECT 1 FROM datasheet_parts WHERE key=?').get(ak) || (other && String(other.part_key) !== existingKey)) {
          throw new ToolError(`alias ${a} already names another part`)
        }
        db.prepare('INSERT OR IGNORE INTO datasheet_aliases (alias, part_key, added_at) VALUES (?,?,?)').run(ak, existingKey, at)
      }
      const entry = DatasheetLibrary.entry(db, existingKey) as PartEntry
      const note = pages.every((t) => !t.trim()) ? 'the PDF has no text layer (a scan?): find/text/params cannot read it; look at page images' : undefined
      return { entry, outcome, sha256: sha, ...(note ? { note } : {}) }
    })
  }

  // ------------------------------------------------------------------ changes and status

  async acknowledge(mpn: string, by?: string, note?: string): Promise<{ entry: PartEntry; acknowledged: number }> {
    return this.central.update((db) => {
      const key = DatasheetLibrary.resolveKey(db, mpn)
      if (!key) throw new ToolError(`no datasheet for ${mpn} in the library`)
      const r = db.prepare('UPDATE datasheet_changes SET acknowledged_at=?, acknowledged_by=?, note=? WHERE part_key=? AND acknowledged_at IS NULL')
        .run(nowIso(), by ?? null, note ?? null, key)
      return { entry: DatasheetLibrary.entry(db, key) as PartEntry, acknowledged: Number(r.changes) }
    })
  }

  /** Mark a part retired. Its documents stay: a project may still cite them. */
  async retire(mpn: string): Promise<PartEntry> {
    return this.central.update((db) => {
      const key = DatasheetLibrary.resolveKey(db, mpn)
      if (!key) throw new ToolError(`no datasheet for ${mpn} in the library`)
      db.prepare("UPDATE datasheet_parts SET status='retired', updated=? WHERE key=?").run(nowIso(), key)
      return DatasheetLibrary.entry(db, key) as PartEntry
    })
  }

  async addAlias(mpn: string, alias: string): Promise<PartEntry> {
    return this.central.update((db) => {
      const key = DatasheetLibrary.resolveKey(db, mpn)
      if (!key) throw new ToolError(`no datasheet for ${mpn} in the library`)
      const ak = mpnKey(alias)
      if (db.prepare('SELECT 1 FROM datasheet_parts WHERE key=?').get(ak)) throw new ToolError(`${alias} is a part of its own`)
      const other = db.prepare('SELECT part_key FROM datasheet_aliases WHERE alias=?').get(ak)
      if (other && String(other.part_key) !== key) throw new ToolError(`alias ${alias} already names ${String(other.part_key)}`)
      db.prepare('INSERT OR IGNORE INTO datasheet_aliases (alias, part_key, added_at) VALUES (?,?,?)').run(ak, key, nowIso())
      return DatasheetLibrary.entry(db, key) as PartEntry
    })
  }

  // ------------------------------------------------------------------ documents and text

  /** The version a caller means: a pinned sha256 (full, or a prefix of at least 8) or the current one. */
  async version(mpn: string, sha256?: string): Promise<{ entry: PartEntry; version: VersionInfo; pinned: boolean }> {
    const entry = await this.entry(mpn)
    if (sha256) {
      const s = sha256.toLowerCase()
      if (s.length < 8) throw new ToolError('a pinned sha256 needs at least 8 hex digits')
      const all = [entry.current, ...entry.history].filter((v): v is VersionInfo => v !== null)
      const found = all.filter((v) => v.sha256.startsWith(s))
      if (found.length !== 1) throw new ToolError(`${entry.mpn}: ${found.length ? 'ambiguous' : 'no'} version ${s}`)
      return { entry, version: found[0] as VersionInfo, pinned: true }
    }
    if (!entry.current) throw new ToolError(`${entry.mpn}: no document stored`)
    return { entry, version: entry.current, pinned: false }
  }

  async localPath(sha256: string): Promise<string> {
    return this.central.docPath(sha256)
  }

  /** The text of the given pages (1-based), extracted on first need if the document predates its text. */
  async pageTexts(sha256: string): Promise<string[]> {
    const rows = await this.central.query((db) =>
      db.prepare('SELECT page, text FROM datasheet_pages WHERE sha256=? ORDER BY page').all(sha256).map((r) => String(r.text)))
    if (rows.length) return rows
    const pages = (await pdfText(await this.central.getDoc(sha256))).pages
    const fts = await this.central.query((db) => hasFts(db))
    await this.central.update((db) => {
      if (fts) db.exec(FTS_SCHEMA)
      if (Number(db.prepare('SELECT count(*) AS n FROM datasheet_pages WHERE sha256=?').get(sha256)?.n ?? 0) > 0) return
      pages.forEach((t, i) => {
        db.prepare('INSERT OR IGNORE INTO datasheet_pages (sha256, page, text) VALUES (?,?,?)').run(sha256, i + 1, t)
        if (fts) db.prepare('INSERT INTO datasheet_pages_fts (text, sha256, page) VALUES (?,?,?)').run(t, sha256, i + 1)
      })
    })
    return pages
  }

  /** Where `query` appears in one document: page and a snippet. Case-insensitive; `regex` for a regular expression.
   * Plain queries use the FTS5 index to pick candidate pages, then the exact match is found in each page's text. */
  async find(mpn: string, query: string, opts: { regex?: boolean; sha256?: string; limit?: number } = {}): Promise<{ total: number; hits: FindHit[]; sha256: string; mpn: string }> {
    const { entry, version } = await this.version(mpn, opts.sha256)
    if (!query.trim()) throw new ToolError('an empty query')
    let rx: RegExp
    try {
      rx = opts.regex ? new RegExp(query, 'gi') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi')
    } catch (e) {
      throw new ToolError(`bad regex: ${(e as Error).message}`)
    }
    const texts = await this.pageTexts(version.sha256)
    let candidates = texts.map((_, i) => i + 1)
    if (!opts.regex) {
      const words = query.match(/[\p{L}\p{N}]+/gu) ?? []
      if (words.length) {
        const fromIndex = await this.central.query((db) => {
          if (!hasFts(db) || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='datasheet_pages_fts'").get()) return null
          const match = words.map((w) => `"${w}"`).join(' ')
          return db.prepare('SELECT page FROM datasheet_pages_fts WHERE datasheet_pages_fts MATCH ? AND sha256=?').all(match, version.sha256).map((r) => Number(r.page))
        })
        if (fromIndex) candidates = [...new Set(fromIndex)].sort((a, b) => a - b)
      }
    }
    const hits: FindHit[] = []
    let total = 0
    const limit = opts.limit ?? 20
    for (const page of candidates) {
      const t = texts[page - 1] ?? ''
      for (const m of t.matchAll(rx)) {
        if (!m[0]) break
        total++
        if (hits.length < limit) {
          const at = m.index ?? 0
          const s = Math.max(0, at - 80)
          const e = Math.min(t.length, at + m[0].length + 80)
          hits.push({ mpn: entry.key, sha256: version.sha256, page, snippet: `${s > 0 ? '…' : ''}${t.slice(s, e).replace(/\s+/g, ' ')}${e < t.length ? '…' : ''}` })
        }
      }
    }
    return { total, hits, sha256: version.sha256, mpn: entry.key }
  }
}

let shared: DatasheetLibrary | null = null
let sharedHome: string | null = null

/** The library on the session's central store (TRACE_HOME), or on `library` when given. */
export function library(location?: string): DatasheetLibrary {
  if (location) return new DatasheetLibrary({ central: new Central({ home: location }) })
  const c = central()
  if (!shared || sharedHome !== c.home) {
    shared = new DatasheetLibrary({ central: c })
    sharedHome = c.home
  }
  return shared
}
