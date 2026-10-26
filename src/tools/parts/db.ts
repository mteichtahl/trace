/**
 * The parts database, in the central store: every part any project has looked up, so every project sees the same
 * parts knowledge, and providers' rate limits are spent once.
 *
 *   parts         one row per part number (mpnKey): manufacturer, description, package, lifecycle, attributes, the
 *                 datasheet URL a provider gave, and the sha256 of the datasheet in the shared library once fetched
 *   part_offers   one row per (part, provider, seller, provider part number): stock, MOQ, price breaks, URL, and
 *                 fetched_at — a lookup newer than the TTL (6 h) is answered from here instead of the provider
 *   part_lookups  when each provider was last asked about a part, and what it said (ok, or the error), so a part a
 *                 provider does not carry is not asked again until the TTL passes either
 */
import type { DatabaseSync } from 'node:sqlite'
import { Central, central } from '../../core/central.js'
import { dec, enc } from '../../core/store.js'
import { mpnKey } from '../datasheets/mpn.js'
import type { PartOffer, ProviderName } from './types.js'

export const TTL_SECONDS = 6 * 3600

export const PARTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS parts (
  key TEXT PRIMARY KEY, mpn TEXT NOT NULL, manufacturer TEXT, description TEXT, package TEXT, lifecycle TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',   -- JSON text
  datasheet_url TEXT, datasheet_sha256 TEXT, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS part_offers (
  part_key TEXT NOT NULL REFERENCES parts(key), provider TEXT NOT NULL, seller TEXT NOT NULL, provider_part TEXT NOT NULL,
  mpn TEXT NOT NULL, stock INTEGER, moq INTEGER,
  price_breaks TEXT NOT NULL DEFAULT '[]', -- JSON text: [{qty, price, currency}]
  url TEXT, offer TEXT NOT NULL,           -- JSON text: the whole normalised offer
  fetched_at REAL NOT NULL,
  PRIMARY KEY (part_key, provider, seller, provider_part)
);
CREATE TABLE IF NOT EXISTS part_lookups (
  part_key TEXT NOT NULL, provider TEXT NOT NULL, fetched_at REAL NOT NULL, ok INTEGER NOT NULL, error TEXT,
  PRIMARY KEY (part_key, provider)
);
`

const now = (): number => Date.now() / 1000

export class PartsDb {
  constructor(readonly central: Central = defaultCentral()) {
    this.central.ensureSchema(PARTS_SCHEMA)
  }

  /** The cached answer of `provider` for a part, when it is fresher than the TTL; undefined when it must be asked. */
  async cached(mpn: string, provider: ProviderName, ttl = TTL_SECONDS): Promise<PartOffer[] | undefined> {
    const key = mpnKey(mpn)
    return this.central.query((db) => {
      const l = db.prepare('SELECT fetched_at, ok FROM part_lookups WHERE part_key=? AND provider=?').get(key, provider)
      if (!l || Number(l.ok) !== 1 || Number(l.fetched_at) < now() - ttl) return undefined
      return db.prepare('SELECT offer FROM part_offers WHERE part_key=? AND provider=? ORDER BY seller, provider_part').all(key, provider)
        .map((r) => dec<PartOffer>(r.offer))
    })
  }

  /** Record a provider's answer for a part: replaces that provider's offers for it, merges what it says about the part. */
  async record(mpn: string, provider: ProviderName, offers: PartOffer[]): Promise<void> {
    const key = mpnKey(mpn)
    const t = now()
    await this.central.update((db) => {
      db.prepare('DELETE FROM part_offers WHERE part_key=? AND provider=?').run(key, provider)
      if (offers.length) upsertPart(db, key, mpn, offers, t)
      for (const o of offers) {
        db.prepare(`INSERT OR REPLACE INTO part_offers (part_key, provider, seller, provider_part, mpn, stock, moq, price_breaks, url, offer, fetched_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(key, provider, o.seller, o.provider_part ?? '', o.mpn, o.stock, o.moq, enc(o.price_breaks), o.url, enc(o), t)
      }
      db.prepare('INSERT OR REPLACE INTO part_lookups (part_key, provider, fetched_at, ok, error) VALUES (?,?,?,1,NULL)').run(key, provider, t)
    })
  }

  async recordFailure(mpn: string, provider: ProviderName, error: string): Promise<void> {
    await this.central.update((db) => {
      db.prepare('INSERT OR REPLACE INTO part_lookups (part_key, provider, fetched_at, ok, error) VALUES (?,?,?,0,?)').run(mpnKey(mpn), provider, now(), error.slice(0, 500))
    })
  }

  async linkDatasheet(mpn: string, sha256: string): Promise<void> {
    await this.central.update((db) => {
      const key = mpnKey(mpn)
      if (!db.prepare('SELECT 1 FROM parts WHERE key=?').get(key)) {
        db.prepare("INSERT INTO parts (key, mpn, attributes, updated) VALUES (?,?,'{}',?)").run(key, mpn.trim(), now())
      }
      db.prepare('UPDATE parts SET datasheet_sha256=?, updated=? WHERE key=?').run(sha256, now(), key)
    })
  }

  async part(mpn: string): Promise<{ key: string; mpn: string; datasheet_url: string | null; datasheet_sha256: string | null } | null> {
    return this.central.query((db) => {
      const r = db.prepare('SELECT key, mpn, datasheet_url, datasheet_sha256 FROM parts WHERE key=?').get(mpnKey(mpn))
      return r ? { key: String(r.key), mpn: String(r.mpn), datasheet_url: r.datasheet_url === null ? null : String(r.datasheet_url), datasheet_sha256: r.datasheet_sha256 === null ? null : String(r.datasheet_sha256) } : null
    })
  }
}

function defaultCentral(): Central {
  return central()
}

/** The facts about the part, preferring what is already known, filled from the offers that match it exactly. */
function upsertPart(db: DatabaseSync, key: string, mpn: string, offers: PartOffer[], t: number): void {
  const pick = <K extends 'manufacturer' | 'description' | 'package' | 'lifecycle' | 'datasheet_url'>(k: K): string | null => {
    for (const o of offers) if (o[k]) return o[k]
    return null
  }
  const attrs: Record<string, string> = {}
  for (const o of offers) for (const [k, v] of Object.entries(o.attributes)) if (!(k in attrs) && !k.startsWith('JLC ') && k !== 'Packaging' && k !== 'Authorized') attrs[k] = v
  const row = db.prepare('SELECT attributes FROM parts WHERE key=?').get(key)
  if (!row) {
    db.prepare(`INSERT INTO parts (key, mpn, manufacturer, description, package, lifecycle, attributes, datasheet_url, updated) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(key, mpn.trim(), pick('manufacturer'), pick('description'), pick('package'), pick('lifecycle'), enc(attrs), pick('datasheet_url'), t)
    return
  }
  const merged = { ...attrs, ...dec<Record<string, string>>(row.attributes) }
  db.prepare(`UPDATE parts SET manufacturer=coalesce(manufacturer, ?), description=coalesce(description, ?), package=coalesce(package, ?),
    lifecycle=coalesce(?, lifecycle), attributes=?, datasheet_url=coalesce(datasheet_url, ?), updated=? WHERE key=?`)
    .run(pick('manufacturer'), pick('description'), pick('package'), pick('lifecycle'), enc(merged), pick('datasheet_url'), t, key)
}

