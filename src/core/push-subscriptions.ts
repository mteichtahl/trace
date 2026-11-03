/**
 * The devices that asked for push notifications (docs/push.md): one row per browser subscription, in the access store
 * beside people's preferences (src/core/access.ts), keyed by the push service's endpoint. A person may have several
 * (a phone and a laptop). The API runtime writes them (push.subscribe and push.unsubscribe, src/api/actions-push.ts);
 * the push sender (src/web/push-sender.ts) reads them.
 *
 *   endpoint   the push service's URL for this browser (only https, at most 1 KB)
 *   p256dh     the browser's public key, and `auth` its secret, both base64url: what the payload is encrypted to
 *   tz         the device's time zone (IANA), for quiet hours; `label` a short name ("iPhone · Safari")
 *
 * An endpoint belongs to one person: subscribing an endpoint another person had moves it (the browser was signed in
 * as someone else). A person keeps at most MAX_DEVICES; the oldest goes first.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { accessStore } from './access.js'
import { ensureSchema } from './central.js'

export const MAX_DEVICES = 10

ensureSchema(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  sub TEXT NOT NULL,              -- Cognito sub
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  tz TEXT,
  label TEXT,
  created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_sub ON push_subscriptions(sub);
`)

const B64URL = /^[A-Za-z0-9_-]+$/

/** A browser's PushSubscription.toJSON(), as the app sends it. */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1024).refine((u) => u.startsWith('https://'), 'a push endpoint is https'),
  keys: z.object({
    p256dh: z.string().min(80).max(100).regex(B64URL),
    auth: z.string().min(16).max(32).regex(B64URL),
  }),
})
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionSchema>

export interface Device { endpoint: string; sub: string; p256dh: string; auth: string; tz: string | null; label: string | null; created: number }

const has = (db: DatabaseSync): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_subscriptions'").get())

const row = (r: Record<string, unknown>): Device => ({
  endpoint: String(r.endpoint), sub: String(r.sub), p256dh: String(r.p256dh), auth: String(r.auth),
  tz: r.tz === null || r.tz === undefined ? null : String(r.tz), label: r.label === null || r.label === undefined ? null : String(r.label), created: Number(r.created),
})

/** A time zone the runtime knows, or null. */
export function validZone(tz: string | null | undefined): string | null {
  if (!tz || tz.length > 64) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

/** Add or refresh a device for `sub` (in a store update). Returns how many devices the person has now. */
export function addDevice(db: DatabaseSync, sub: string, s: PushSubscriptionJson, o: { tz?: string | null | undefined; label?: string | null | undefined; at: number }): number {
  db.prepare(`INSERT INTO push_subscriptions (endpoint, sub, p256dh, auth, tz, label, created) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub, p256dh=excluded.p256dh, auth=excluded.auth, tz=excluded.tz, label=excluded.label`)
    .run(s.endpoint, sub, s.keys.p256dh, s.keys.auth, validZone(o.tz), o.label?.slice(0, 80) ?? null, o.at)
  // the oldest beyond MAX_DEVICES go
  db.prepare(`DELETE FROM push_subscriptions WHERE sub=? AND endpoint NOT IN (SELECT endpoint FROM push_subscriptions WHERE sub=? ORDER BY created DESC LIMIT ?)`).run(sub, sub, MAX_DEVICES)
  return Number((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE sub=?').get(sub) as { n: number }).n)
}

/** Remove one of the person's devices (only their own). True when one was removed. */
export function removeDevice(db: DatabaseSync, sub: string, endpoint: string): boolean {
  return Number(db.prepare('DELETE FROM push_subscriptions WHERE sub=? AND endpoint=?').run(sub, endpoint).changes) > 0
}

/** The devices of these people (none when the table is not there yet: a read copy from before push). */
export function devicesOf(db: DatabaseSync, subs: readonly string[]): Device[] {
  if (!subs.length || !has(db)) return []
  const out: Device[] = []
  // in slices: SQLite's limit on bound values
  for (let i = 0; i < subs.length; i += 200) {
    const part = subs.slice(i, i + 200)
    out.push(...(db.prepare(`SELECT * FROM push_subscriptions WHERE sub IN (${part.map(() => '?').join(',')})`).all(...part) as Record<string, unknown>[]).map(row))
  }
  return out
}

/** What the person sees of their devices: never the keys. */
export function deviceList(db: DatabaseSync, sub: string): { endpoint: string; label: string | null; tz: string | null; since: string }[] {
  if (!has(db)) return []
  return (db.prepare('SELECT * FROM push_subscriptions WHERE sub=? ORDER BY created DESC').all(sub) as Record<string, unknown>[]).map(row)
    .map((d) => ({ endpoint: d.endpoint, label: d.label, tz: d.tz, since: new Date(d.created * 1000).toISOString() }))
}

export const subscribe = (sub: string, s: PushSubscriptionJson, o: { tz?: string | null; label?: string | null }) =>
  accessStore().update((db) => addDevice(db, sub, s, { ...o, at: Date.now() / 1000 }))
export const unsubscribe = (sub: string, endpoint: string) => accessStore().update((db) => removeDevice(db, sub, endpoint))
export const devices = (sub: string) => accessStore().query((db) => deviceList(db, sub))
