/**
 * The installation's policy: settings an admin has fixed for everyone (docs/ui-design.md "Preferences": "A setting an
 * admin has fixed for everyone shows locked, with the reason"). One document in the ACCESS store (table `policy`), so
 * only the API runtime's role and the installing admin can write it, like who has access.
 *
 *   locks   { <setting>: <reason> }   a setting is a Preferences id (display.theme, security.passkeys, …): the app shows
 *                                     it locked with the reason, and me.set refuses to change it (prefs.<setting>, and
 *                                     anything under it)
 */
import { z } from 'zod'
import { accessStore } from './access.js'
import { ensureSchema } from './central.js'

ensureSchema(`
CREATE TABLE IF NOT EXISTS policy (
  id TEXT PRIMARY KEY CHECK (id = 'installation'),
  doc TEXT NOT NULL,              -- JSON: { locks: { setting: reason } }
  updated REAL NOT NULL,
  by TEXT
);`)

export const LockKey = z.string().regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/, 'a setting such as display.theme').max(120)
export const LockReason = z.string().trim().min(3).max(300)
const PolicyDoc = z.object({ locks: z.record(z.string(), z.string()).default({}) }).loose()
export type Policy = z.output<typeof PolicyDoc>

export interface PolicyView { locks: Record<string, string>; updated: string | null; by: string | null }

const parse = (text: unknown): Policy => {
  try { return PolicyDoc.parse(typeof text === 'string' ? JSON.parse(text) : {}) } catch { return { locks: {} } }
}

/** The installation's policy (no locks when none was ever set). */
export async function getPolicy(): Promise<PolicyView> {
  return accessStore().query((db) => {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='policy'").get()
    const r = has ? db.prepare("SELECT doc, updated, by FROM policy WHERE id='installation'").get() as Record<string, unknown> | undefined : undefined
    return r ? { locks: parse(r.doc).locks, updated: new Date(Number(r.updated) * 1000).toISOString(), by: r.by === null ? null : String(r.by) } : { locks: {}, updated: null, by: null }
  })
}

/** Lock one setting with a reason, or unlock it (reason null). The caller checked that `by` is an admin. */
export async function setLock(key: string, reason: string | null, by: string): Promise<PolicyView & { changed: boolean }> {
  const k = LockKey.parse(key)
  const why = reason === null ? null : LockReason.parse(reason)
  return accessStore().update((db) => {
    const r = db.prepare("SELECT doc FROM policy WHERE id='installation'").get() as Record<string, unknown> | undefined
    const doc = parse(r?.doc)
    const before = doc.locks[k] ?? null
    if (why === null) delete doc.locks[k]
    else doc.locks[k] = why
    const changed = before !== why
    const t = Date.now() / 1000
    if (changed) db.prepare("INSERT INTO policy (id, doc, updated, by) VALUES ('installation', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc, updated=excluded.updated, by=excluded.by").run(JSON.stringify(doc), t, by)
    return { locks: doc.locks, updated: new Date(t * 1000).toISOString(), by, changed }
  })
}

/** The lock that covers a preferences key (prefs.display.theme, or a bare display.theme), or null. */
export function lockFor(locks: Readonly<Record<string, string>>, key: string): { setting: string; reason: string } | null {
  const bare = key.startsWith('prefs.') ? key.slice('prefs.'.length) : key
  for (const [setting, reason] of Object.entries(locks)) {
    if (bare === setting || bare.startsWith(`${setting}.`) || setting.startsWith(`${bare}.`)) return { setting, reason }
  }
  return null
}
