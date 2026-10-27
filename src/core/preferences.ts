/**
 * A person's own preferences: one JSON document per person, kept in the ACCESS store (table `preferences`, keyed by
 * the person's Cognito sub), so it follows them to every device and nobody else can read it.
 *
 * The web app's Preferences screen and its table views both live here: `display.theme`, `voice.rate`,
 * `views.requirements` (a table's columns, sort and filters). The document is free-form JSON under the person's own
 * keys; the API changes one dotted `key` path at a time (set or unset) and refuses a document over 64 KB, so a
 * runaway client cannot grow the access store. Settings that change a project are not here (they are the project's
 * settings), and neither is anything that decides access.
 *
 * Only the API runtime writes it (the access store is not writable by workers or workflows), always for the person
 * making the request: there is no way to name another person.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { accessStore } from './access.js'

export const MAX_PREFERENCES_BYTES = 64 * 1024

export type PrefValue = null | boolean | number | string | PrefValue[] | { [k: string]: PrefValue }
export type PrefDoc = { [k: string]: PrefValue }

/** A dotted path of plain names: `display.theme`, `views.requirements`. No array indexes, no prototype names. */
export const PrefKey = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'a dotted name such as display.theme')
  .refine((k) => !k.split('.').some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype'), 'not a name preferences can use')

export const PrefValueSchema: z.ZodType<PrefValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(PrefValueSchema), z.record(z.string(), PrefValueSchema),
]))

export class PreferenceError extends Error {
  override name = 'PreferenceError'
}

const isObject = (v: PrefValue | undefined): v is { [k: string]: PrefValue } => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseDoc(text: unknown): PrefDoc {
  if (typeof text !== 'string') return {}
  try {
    const v = JSON.parse(text) as PrefValue
    return isObject(v) ? v : {}
  } catch {
    return {}
  }
}

/** The value at `key`, or undefined. */
export function getPath(doc: PrefDoc, key: string): PrefValue | undefined {
  let cur: PrefValue | undefined = doc
  for (const part of key.split('.')) {
    if (!isObject(cur) || !Object.hasOwn(cur, part)) return undefined
    cur = cur[part]
  }
  return cur
}

/** A copy of `doc` with `key` set to `value` (objects on the way are made; a non-object on the way is replaced). */
export function setPath(doc: PrefDoc, key: string, value: PrefValue): PrefDoc {
  const parts = key.split('.')
  const out: PrefDoc = structuredClone(doc)
  let cur: { [k: string]: PrefValue } = out
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (!isObject(next)) cur[part] = {}
    cur = cur[part] as { [k: string]: PrefValue }
  }
  cur[parts.at(-1) as string] = value
  return out
}

/** A copy of `doc` without `key`; objects left empty on the way are removed too. */
export function unsetPath(doc: PrefDoc, key: string): { doc: PrefDoc; removed: boolean } {
  const parts = key.split('.')
  const out: PrefDoc = structuredClone(doc)
  const trail: { [k: string]: PrefValue }[] = [out]
  for (const part of parts.slice(0, -1)) {
    const next = trail.at(-1)?.[part]
    if (!isObject(next)) return { doc: out, removed: false }
    trail.push(next)
  }
  const last = trail.at(-1) as { [k: string]: PrefValue }
  const name = parts.at(-1) as string
  if (!Object.hasOwn(last, name)) return { doc: out, removed: false }
  delete last[name]
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i] as object).length) break
    delete (trail[i - 1] as { [k: string]: PrefValue })[parts[i - 1] as string]
  }
  return { doc: out, removed: true }
}

const sizeOf = (doc: PrefDoc): number => Buffer.byteLength(JSON.stringify(doc))

function readDoc(db: DatabaseSync, sub: string): { doc: PrefDoc; updated: number | null } {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preferences'").get()
  if (!has) return { doc: {}, updated: null }
  const r = db.prepare('SELECT doc, updated FROM preferences WHERE sub=?').get(sub)
  return r ? { doc: parseDoc(r.doc), updated: Number(r.updated) } : { doc: {}, updated: null }
}

export interface PreferencesView { preferences: PrefDoc; updated: string | null; bytes: number; limit: number }

const view = (doc: PrefDoc, updated: number | null): PreferencesView =>
  ({ preferences: doc, updated: updated === null ? null : new Date(updated * 1000).toISOString(), bytes: sizeOf(doc), limit: MAX_PREFERENCES_BYTES })

/** The person's whole preferences document (empty when they have set nothing). */
export async function getPreferences(sub: string): Promise<PreferencesView> {
  const { doc, updated } = await accessStore().query((db) => readDoc(db, sub))
  return view(doc, updated)
}

/** Set (or unset) one key of the person's document. Refuses a document that would be larger than 64 KB. */
export async function setPreference(sub: string, change: { key: string; value?: PrefValue | undefined; unset?: boolean | undefined }): Promise<PreferencesView & { changed: boolean }> {
  const key = PrefKey.parse(change.key)
  if (!change.unset && change.value === undefined) throw new PreferenceError('give a value, or unset: true')
  const value = change.unset ? undefined : PrefValueSchema.parse(change.value)
  return accessStore().update((db) => {
    const { doc } = readDoc(db, sub)
    let next: PrefDoc
    let changed: boolean
    if (value === undefined) {
      const r = unsetPath(doc, key)
      next = r.doc
      changed = r.removed
    } else {
      next = setPath(doc, key, value)
      changed = JSON.stringify(getPath(doc, key)) !== JSON.stringify(value)
    }
    const bytes = sizeOf(next)
    if (bytes > MAX_PREFERENCES_BYTES) throw new PreferenceError(`Your preferences would be ${Math.ceil(bytes / 1024)} KB; they can be at most 64 KB. Remove some saved views first.`)
    const t = Date.now() / 1000
    if (changed) {
      db.prepare('INSERT INTO preferences (sub, doc, updated) VALUES (?,?,?) ON CONFLICT(sub) DO UPDATE SET doc=excluded.doc, updated=excluded.updated')
        .run(sub, JSON.stringify(next), t)
    }
    return { ...view(next, changed ? t : readDoc(db, sub).updated), changed }
  })
}
