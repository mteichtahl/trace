/**
 * When each connected system last called trace (docs/external-access.md "External API"): one small JSON object per
 * system beside the access store, `<access home>/services-seen/<client_id>.json` = { client_id, at }.
 *
 * Not a column of the access store: the external runtime would otherwise write the shared access database (download,
 * change, conditional put) from every fresh container on the request path, and those writes would race the people's
 * admin changes to the same object, which could then fail. A plain put of a tiny object per system races nothing that
 * matters: the last writer wins, and every writer says "just now". Each container writes a system's object at most
 * once every five minutes, so the admin screen's "last used" is right to within about five minutes.
 *
 * The external runtime's role may put objects under access/services-seen/ and nothing else of access/ (src/infra/api-grants.ts).
 */
import { z } from 'zod'
import { type Backend, backendFor } from './central.js'
import { accessHome } from './access.js'

/** The folder under the access store's home. */
export const SERVICES_SEEN = 'services-seen'
/** A container writes a system's object at most this often. */
export const SEEN_EVERY_MS = 5 * 60_000

const Seen = z.object({ client_id: z.string(), at: z.number() })
const ClientId = /^[A-Za-z0-9_-]{1,128}$/

const backend = (): Backend => backendFor(accessHome())
const keyOf = (clientId: string): string => `${SERVICES_SEEN}/${clientId}.json`

const lastWritten = new Map<string, number>()

/**
 * Note that a connected system called (at most once every five minutes per system per process). Never throws, never
 * waits on the caller's request: a lost write only makes "last used" a little older.
 */
export async function noteServiceSeen(clientId: string, at: number = Date.now(), store: () => Backend = backend): Promise<boolean> {
  if (!ClientId.test(clientId)) return false
  const before = lastWritten.get(clientId)
  if (before !== undefined && at - before < SEEN_EVERY_MS) return false
  lastWritten.set(clientId, at)
  if (lastWritten.size > 10_000) lastWritten.delete(lastWritten.keys().next().value as string)
  try {
    await store().put(keyOf(clientId), new TextEncoder().encode(JSON.stringify({ client_id: clientId, at: at / 1000 })), { contentType: 'application/json' })
    return true
  } catch {
    return false
  }
}

/** When each of these systems last called, as an ISO time, or null when it never has (or it cannot be read). */
export async function servicesSeen(clientIds: readonly string[], store: () => Backend = backend): Promise<Map<string, string | null>> {
  const b = store()
  const out = new Map<string, string | null>()
  await Promise.all(clientIds.map(async (id) => {
    if (!ClientId.test(id)) { out.set(id, null); return }
    try {
      const got = await b.get(keyOf(id))
      const s = got ? Seen.safeParse(JSON.parse(new TextDecoder().decode(got.body))) : null
      out.set(id, s?.success && s.data.client_id === id ? new Date(s.data.at * 1000).toISOString() : null)
    } catch {
      out.set(id, null)
    }
  }))
  return out
}

/** Forget what this process wrote (tests). */
export function resetServicesSeen(): void {
  lastWritten.clear()
}
