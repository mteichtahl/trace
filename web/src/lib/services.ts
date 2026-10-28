/**
 * Connected systems (docs/external-access.md): other systems and AI agents that call trace with their own keys. The
 * shapes the services.* actions answer, and the words and ready-made snippets the Admin › Connected systems screens
 * show. Pure: no React, so the CLI's wording and these stay easy to compare and test.
 */
import type { Part } from './types'

export type Scope = 'read' | 'write'

export interface Service {
  client_id: string
  name: string
  description: string
  scopes: Scope[]
  disabled: boolean
  created_by: string
  created_at: string
  last_used: string | null
  projects: { repo: string; part: Part }[]
  /** ids and dates only; a secret's value is shown once, when it is made, and never again */
  secrets?: { id: string; created_at: string }[]
}

/** Where a connected system signs in and calls trace (services.create answers them; assumed optional elsewhere). */
export interface ServiceAddresses {
  token_url?: string
  api_url?: string
  mcp_url?: string
  resource_server?: string
}

export interface ServiceList extends ServiceAddresses {
  services: Service[]
}

export interface ServiceCreated extends ServiceAddresses {
  service: Service
  client_id: string
  secret: string
}

export interface ServiceHistoryEntry {
  at: string
  by: string
  repo: string | null
  action: string
  detail: string | null
  text: string
}

/** What the Keys panel shows once: after creating a system, or after a new secret. */
export interface ShownKeys extends ServiceAddresses {
  name: string
  client_id: string
  secret: string
  scopes: Scope[]
  /** set after a rotation: the new secret's id, and the old one keeps working */
  secret_id?: string
}

export const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/

/** Why a name is not usable, in words; null when it is. */
export function nameProblem(name: string, taken: readonly string[] = []): string | null {
  if (!name) return null
  if (taken.includes(name)) return `There is already a connected system called ${name}.`
  if (name.length < 2 || name.length > 40) return 'Between 2 and 40 characters.'
  if (!/^[a-z]/.test(name)) return 'Start with a lower-case letter.'
  if (!NAME_RE.test(name)) return 'Only lower-case letters, digits and dashes.'
  return null
}

export const SCOPE_WORDS: Record<Scope, { label: string; line: string }> = {
  read: { label: 'Read only', line: 'Safest: it can look but not change anything.' },
  write: { label: 'Read and change', line: "Lets it start work and change settings on projects where it's a contributor." },
}

/** The scope a system has, from its scopes (write always comes with read). */
export const scopeOf = (scopes: readonly string[]): Scope => (scopes.includes('write') ? 'write' : 'read')
export const scopesFor = (s: Scope): Scope[] => (s === 'write' ? ['read', 'write'] : ['read'])
export const canWords = (scopes: readonly string[]): string => SCOPE_WORDS[scopeOf(scopes)].label

/** A read-only system is always a reviewer; one that may change things can be either. */
export const partsFor = (s: Scope): Part[] => (s === 'write' ? ['contributor', 'reviewer'] : ['reviewer'])
export const partFor = (s: Scope, wanted: Part): Part => (s === 'read' ? 'reviewer' : wanted)

/** What the API answers when the installation has not turned external access on. */
export const isExternalOff = (e: unknown): boolean => /external access is off/i.test(e instanceof Error ? e.message : String(e ?? ''))

/** The sign-in scopes a system asks for, as Cognito spells them. */
export function scopeString(scopes: readonly string[], resourceServer = 'trace-external'): string {
  return scopeOf(scopes) === 'write' ? `${resourceServer}/read ${resourceServer}/write` : `${resourceServer}/read`
}

const or = (v: string | undefined, placeholder: string): string => v || placeholder

/** The three ready-made snippets: get a sign-in token, call the API, connect an AI agent over MCP. */
export function snippets(k: Pick<ShownKeys, 'client_id' | 'scopes' | 'token_url' | 'api_url' | 'mcp_url' | 'resource_server'>): { token: string; api: string; mcp: string } {
  const token = [
    '# The secret, from where you stored it',
    "export TRACE_CLIENT_SECRET='<the secret>'",
    '',
    '# A sign-in token, good for an hour: reuse it until it nears expiry',
    `TOKEN=$(curl -s -u "${k.client_id}:$TRACE_CLIENT_SECRET" \\`,
    '  -d grant_type=client_credentials \\',
    `  --data-urlencode "scope=${scopeString(k.scopes, k.resource_server)}" \\`,
    `  ${or(k.token_url, '<sign-in address>')} | jq -r .access_token)`,
  ].join('\n')
  const api = [
    `curl -s -X POST ${or(k.api_url, '<API address>')} \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    "  -H 'content-type: application/json' \\",
    `  -d '{"action":"projects"}'`,
  ].join('\n')
  const mcp = JSON.stringify({ type: 'http', url: or(k.mcp_url, '<MCP address>'), headers: { Authorization: 'Bearer <token>' } }, null, 2)
  return { token, api, mcp }
}

/** Shown under Connect a system (docs/external-access.md, "Cost"). */
export const COST_NOTE = "Each system's keys are checked with Amazon Cognito, which charges a small amount per system and per sign-in; systems should reuse their sign-in for the hour."
export const EXPLAINER = 'Other systems and AI agents connect with their own keys. Each one sees only the projects you put it on.'
