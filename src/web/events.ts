/**
 * Live events: publishing to AppSync Events over its HTTP endpoint, signed with SigV4 by the Lambda's role
 * (service `appsync`). The endpoint is `https://<events.http>/event`, the body `{ channel, events: [<JSON text>] }`
 * with at most five events per request; one channel per person, `/trace/users/<sub>`.
 *
 * Which actions change something people may be looking at, and what (`record.changed`'s `what`), lives here, next to
 * the publish, so /api/call and the chat agent's tools share one list. Payloads never carry project content: the app
 * treats an event as "refetch these queries".
 */
import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { WebConfig } from './config.js'
import type { Credentials } from './ports.js'

export type What = 'journey' | 'settings' | 'memory' | 'chats' | 'people' | 'prompts' | 'kb' | 'jobs' | 'integrations' | 'projects' | 'preferences'

/** Every action whose ok answer is published, and what it changed. Prefix entries end with `.`. */
const MUTATING: ReadonlyArray<readonly [string, What]> = [
  ['settings.set', 'settings'],
  ['task', 'jobs'],
  ['memory.deactivate', 'memory'],
  ['memory.reactivate', 'memory'],
  ['kb.sync', 'kb'],
  ['assign', 'people'],
  ['unassign', 'people'],
  ['users.', 'people'],
  ['prompts.set', 'prompts'],
  ['prompts.reset', 'prompts'],
  ['prompts.revert', 'prompts'],
  ['integrations.', 'integrations'],
  ['projects.create', 'projects'],
  ['gate.', 'journey'],
  ['question.answer', 'journey'],
  ['stuck.dismiss', 'journey'],
  ['waiver.add', 'journey'],
  ['journey.criterion.open', 'journey'],
  ['chats.append', 'chats'],
  ['chats.reply', 'chats'],
  ['chats.rename', 'chats'],
  ['me.set', 'preferences'],
  // the record's build side and the guided skills (skill.draft is not here: it is saved on every keystroke)
  ['order.record', 'journey'],
  ['order.update', 'journey'],
  ['board.record', 'journey'],
  ['board.check', 'journey'],
  ['skill.submit', 'journey'],
  ['design.decide', 'journey'],
  // a job id names no project here, and policy.set is installation-wide: both reach the caller's own screens only
  // (publishChange publishes to the project's members only when the arguments carry a repo)
  ['job.control', 'jobs'],
  ['policy.set', 'preferences'],
]

/** Read-only actions under a mutating prefix. */
const READ_ONLY = new Set(['users.list', 'integrations.list'])

/** What a mutating action changed, or null for one that changes nothing. */
export function changeOf(action: string): What | null {
  if (READ_ONLY.has(action)) return null
  for (const [a, what] of MUTATING) if (a.endsWith('.') ? action.startsWith(a) : action === a) return what
  return null
}

export const userChannel = (sub: string): string => `/trace/users/${sub}`

export interface LiveEvent { type: 'record.changed' | 'job.updated' | 'notification'; repo?: string; at: string; [k: string]: unknown }

export interface Publisher {
  publish(channel: string, events: readonly LiveEvent[]): Promise<void>
}

const MAX_PER_REQUEST = 5

/** The AppSync Events HTTP publisher (SigV4, service appsync). */
export function appsyncPublisher(c: Pick<WebConfig, 'region'> & { events: Pick<WebConfig['events'], 'http'> }, credentials: Credentials, f: typeof fetch): Publisher {
  const signer = new SignatureV4({ service: 'appsync', region: c.region, credentials, sha256: Sha256 })
  const host = c.events.http.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return {
    async publish(channel, events) {
      for (let i = 0; i < events.length; i += MAX_PER_REQUEST) {
        const body = JSON.stringify({ channel, events: events.slice(i, i + MAX_PER_REQUEST).map((e) => JSON.stringify(e)) })
        const req = new HttpRequest({ method: 'POST', protocol: 'https:', hostname: host, path: '/event', headers: { host, 'content-type': 'application/json' }, body })
        const signed = await signer.sign(req)
        const r = await f(`https://${host}/event`, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(5000) })
        if (!r.ok) throw new Error(`AppSync Events answered ${r.status}`)
        const out = await r.json().catch(() => null) as { failed?: unknown[] } | null
        if (out?.failed?.length) throw new Error(`AppSync Events refused ${out.failed.length} event(s)`)
      }
    },
  }
}
