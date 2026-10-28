/**
 * `tracectl services`: connected systems, the other systems and AI agents that call trace with their own keys
 * (docs/external-access.md, "Managing connected systems"). Admins only, through the API as the signed-in person.
 *
 *   tracectl services list                                   every connected system: what it may do, projects, last used
 *   tracectl services show NAME                              one system: projects and parts, secrets (ids and dates only)
 *   tracectl services create NAME --scope read|write [--description TEXT] [--project OWNER/REPO[:reviewer|:contributor]]...
 *                                                            prints the client id and the secret (shown once) and the
 *                                                            token, API and MCP addresses
 *   tracectl services disable NAME | enable NAME             stop it at once (within 30 seconds), or let it in again
 *   tracectl services scopes NAME read|write                 what it may do: read, or read and change
 *   tracectl services assign NAME OWNER/REPO [--part reviewer|contributor] | unassign NAME OWNER/REPO
 *   tracectl services rotate NAME                            a second secret (shown once); the old one keeps working
 *   tracectl services retire-secret NAME SECRET_ID           remove an old secret once the system uses the new one
 *   tracectl services delete NAME [--yes]                    delete it and its keys (asks first)
 *   tracectl services history NAME                           its assignment log, in words
 *
 * `--json` prints the API's answer as it came. The secret is printed to the terminal only: never to a file or a log.
 */
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { installation } from '../core/client.js'
import { ApiError, invokeApi } from './invoke.js'
import { LoginError } from './oauth.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

export const SERVICES_USAGE = [
  'usage: tracectl services list | show NAME',
  '         | create NAME --scope read|write [--description TEXT] [--project OWNER/REPO[:reviewer|:contributor]]...',
  '         | disable NAME | enable NAME | scopes NAME read|write',
  '         | assign NAME OWNER/REPO [--part reviewer|contributor] | unassign NAME OWNER/REPO',
  '         | rotate NAME | retire-secret NAME SECRET_ID | delete NAME [--yes] | history NAME',
  '       (add --json for the API\'s answer as it came)',
].join('\n')

/** What the API says when the installation has not turned external access on (src/api; docs/external-access.md). */
export const OFF = /external access is off/i

export const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/
const Name = z.string().regex(NAME_RE, 'a name of 2 to 40 characters: lower-case letters, digits and dashes, starting with a letter')
const Repo = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')
const PartSchema = z.enum(['contributor', 'reviewer'])
export type Part = z.infer<typeof PartSchema>
type Scope = 'read' | 'write'

const ServiceSchema = z.object({
  client_id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  scopes: z.array(z.enum(['read', 'write'])),
  disabled: z.boolean(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
  last_used: z.string().nullish(),
  projects: z.array(z.object({ repo: z.string(), part: PartSchema }).loose()).default([]),
  secrets: z.array(z.object({ id: z.string(), created_at: z.string().nullish() }).loose()).optional(),
}).loose()
export type ServiceRow = z.infer<typeof ServiceSchema>

const Addresses = z.object({
  token_url: z.string().optional(), api_url: z.string().optional(), mcp_url: z.string().optional(), resource_server: z.string().optional(),
}).loose()

/** `--scope read|write` → the scopes the API takes (write always includes read). */
export const scopesFor = (s: Scope): Scope[] => (s === 'write' ? ['read', 'write'] : ['read'])
const canWords = (scopes: readonly string[]): string => (scopes.includes('write') ? 'read and change' : 'read only')

/**
 * `OWNER/REPO[:reviewer|:contributor]`. A read-only system is always a reviewer; a read-and-change one is a
 * contributor unless it says otherwise.
 */
export function parseProject(text: string, scope: Scope): { repo: string; part: Part } {
  const i = text.lastIndexOf(':')
  const repo = Repo.parse(i > 0 ? text.slice(0, i) : text)
  const given = i > 0 ? PartSchema.parse(text.slice(i + 1)) : undefined
  if (scope === 'read' && given === 'contributor') throw new UsageError(`${repo}: a read-only system can only be a reviewer (give it --scope write to make it a contributor)`)
  return { repo, part: given ?? (scope === 'write' ? 'contributor' : 'reviewer') }
}

class UsageError extends Error {}

/** "3 minutes ago", "2 days ago", "never". */
export function since(at: string | null | undefined, now = Date.now()): string {
  if (!at) return 'never'
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  if (s < 60) return 'just now'
  const [n, unit] = s < 3600 ? [Math.round(s / 60), 'minute'] : s < 86_400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86_400), 'day']
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

/** The token address when the API does not give one: the installation's Cognito domain. */
function tokenUrlFallback(): string {
  const d = installation()?.cognitoDomain
  return d ? `${d.replace(/\/+$/, '')}/oauth2/token` : '<token address>'
}

/** The lines `create` and `rotate` print: the keys, the addresses, and a ready curl line to get a token. */
export function keysText(o: { name: string; client_id: string; secret: string; scopes: readonly string[]; token_url?: string; api_url?: string; mcp_url?: string; resource_server?: string }): string {
  const rs = o.resource_server ?? 'trace-external'
  const scope = o.scopes.includes('write') ? `${rs}/read ${rs}/write` : `${rs}/read`
  const token = o.token_url ?? '<token address>'
  const lines = [
    `  Client id:  ${o.client_id}`,
    `  Secret:     ${o.secret}`,
    '',
    '  This secret is shown once — store it now (in your password manager or the other system\'s secret store).',
    '  trace does not keep it; if it is lost, rotate it: tracectl services rotate ' + o.name,
    '',
    `  Token address:  ${token}`,
    `  API address:    ${o.api_url ?? '(not given: the installation has no external API address yet)'}`,
    `  MCP address:    ${o.mcp_url ?? '(not given: the installation has no MCP address yet)'}`,
    '',
    'Get a sign-in token (it lasts an hour: reuse it until it nears expiry), with the secret in TRACE_CLIENT_SECRET:',
    '',
    `  curl -s -u "${o.client_id}:$TRACE_CLIENT_SECRET" -d grant_type=client_credentials --data-urlencode "scope=${scope}" ${token}`,
  ]
  if (o.api_url) {
    lines.push('', 'Then call the API with the access_token it returns:', '',
      `  curl -s -X POST ${o.api_url} -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"action":"projects"}'`)
  }
  return lines.join('\n')
}

function listLine(s: ServiceRow, now = Date.now()): string {
  return `${s.name.padEnd(24)} ${canWords(s.scopes).padEnd(15)} ${(s.disabled ? 'disabled' : 'active').padEnd(9)} ${String(s.projects.length).padStart(2)} project${s.projects.length === 1 ? ' ' : 's'}  last used ${since(s.last_used, now)}`
}

async function confirmDelete(name: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((r) => rl.question(`Deleting ${name} removes its keys and its projects; anything using it stops at once.\nType ${name} to delete it: `, r))
  rl.close()
  return answer.trim() === name
}

export interface ServicesDeps {
  invoke?: (action: string, args?: Record<string, unknown>) => Promise<unknown>
  confirm?: (name: string) => Promise<boolean>
  now?: () => number
}

/** `tracectl services …`; returns the exit code. */
export async function cmdServices(argv: string[], deps: ServicesDeps = {}): Promise<number> {
  const invoke = deps.invoke ?? ((a: string, args?: Record<string, unknown>) => invokeApi(a, args ?? {}))
  const now = deps.now?.() ?? Date.now()
  const [sub, ...rest] = argv
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      json: { type: 'boolean' }, description: { type: 'string' }, scope: { type: 'string' }, project: { type: 'string', multiple: true },
      part: { type: 'string' }, yes: { type: 'boolean', short: 'y' },
    } })
    const json = (v: unknown): void => out(JSON.stringify(v, null, 2))
    const [a, b] = positionals
    const name = (): string => Name.parse(a)
    switch (sub) {
      case 'list': {
        const r = await invoke('services.list', {})
        if (values.json) { json(r); return 0 }
        const list = z.object({ services: z.array(ServiceSchema) }).loose().parse(r).services
        if (!list.length) out('No connected systems yet. Connect one: tracectl services create NAME --scope read --project OWNER/REPO')
        for (const s of [...list].sort((x, y) => x.name.localeCompare(y.name))) out(listLine(s, now))
        return 0
      }
      case 'show': {
        if (!a) break
        const n = name()
        const r = await invoke('services.list', {})
        const s = z.object({ services: z.array(ServiceSchema) }).loose().parse(r).services.find((x) => x.name === n)
        if (!s) { err(`trace: no connected system called ${n} (tracectl services list)`); return 1 }
        if (values.json) { json(s); return 0 }
        out(`${s.name}  ${s.disabled ? 'disabled: its keys are refused' : 'active'}`)
        if (s.description) out(`  ${s.description}`)
        out(`  Can:        ${canWords(s.scopes)}`)
        out(`  Client id:  ${s.client_id}`)
        out(`  Last used:  ${since(s.last_used, now)}`)
        if (s.created_at) out(`  Created:    ${s.created_at.slice(0, 16).replace('T', ' ')}${s.created_by ? ` by ${s.created_by}` : ''}`)
        out(s.projects.length ? '  Projects:' : '  Projects:   none yet: it sees nothing until you put it on one (tracectl services assign)')
        for (const p of s.projects) out(`    ${p.repo.padEnd(40)} ${p.part}`)
        if (s.secrets) {
          out(`  Secrets:    ${s.secrets.length} (ids and dates only; values are never shown again)`)
          for (const x of s.secrets) out(`    ${x.id}  created ${x.created_at?.slice(0, 16).replace('T', ' ') ?? 'unknown'}`)
          if (s.secrets.length > 1) out(`  Once the system uses the newest secret, retire the older one: tracectl services retire-secret ${s.name} SECRET_ID`)
        }
        return 0
      }
      case 'create': {
        if (!a) break
        const n = name()
        const scope = z.enum(['read', 'write'], { message: '--scope read or --scope write' }).parse(values.scope)
        const projects = (values.project ?? []).map((p) => parseProject(p, scope))
        const r = await invoke('services.create', { name: n, ...(values.description ? { description: values.description } : {}), scopes: scopesFor(scope), ...(projects.length ? { projects } : {}) })
        if (values.json) { json(r); return 0 }
        const c = z.object({ client_id: z.string(), secret: z.string() }).and(Addresses).parse(r)
        out(`Connected system ${n} created: it can ${canWords(scopesFor(scope))}${projects.length ? ` on ${projects.map((p) => `${p.repo} (${p.part})`).join(', ')}` : ', on no projects yet'}.\n`)
        out(keysText({ name: n, scopes: scopesFor(scope), ...c, token_url: c.token_url ?? tokenUrlFallback() }))
        out('\nCost: Amazon Cognito charges a small amount per system and per sign-in; systems should reuse their sign-in for the hour.')
        return 0
      }
      case 'disable': case 'enable': {
        if (!a) break
        const n = name()
        const r = await invoke('services.update', { name: n, disabled: sub === 'disable' })
        if (values.json) { json(r); return 0 }
        out(sub === 'disable' ? `${n} is disabled: its keys stop working within 30 seconds. tracectl services enable ${n} lets it in again.` : `${n} is enabled: its keys work again.`)
        return 0
      }
      case 'scopes': {
        if (!a || !b) break
        const n = name()
        const scope = z.enum(['read', 'write'], { message: 'read or write' }).parse(b)
        const r = await invoke('services.update', { name: n, scopes: scopesFor(scope) })
        if (values.json) { json(r); return 0 }
        out(scope === 'write' ? `${n} can now read and change, on projects where it is a contributor.` : `${n} can now only read; it is a reviewer on every project it is on, and its tokens that could change things stop working at once.`)
        return 0
      }
      case 'assign': {
        if (!a || !b) break
        const n = name()
        const part = values.part ? PartSchema.parse(values.part) : undefined
        const r = await invoke('services.assign', { name: n, repo: Repo.parse(b), ...(part ? { part } : {}) })
        if (values.json) { json(r); return 0 }
        const got = z.object({ part: z.string() }).loose().safeParse(r).data?.part ?? part
        out(`${n} is on ${b.toLowerCase()}${got ? ` as a ${got}` : ''}.${part === 'contributor' && got === 'reviewer' ? ' (A read-only system is always a reviewer.)' : ''}`)
        return 0
      }
      case 'unassign': {
        if (!a || !b) break
        const n = name()
        const r = await invoke('services.unassign', { name: n, repo: Repo.parse(b) })
        if (values.json) { json(r); return 0 }
        out(z.object({ removed: z.boolean() }).loose().parse(r).removed ? `${n} is no longer on ${b.toLowerCase()}.` : `${n} was not on ${b.toLowerCase()}.`)
        return 0
      }
      case 'rotate': {
        if (!a) break
        const n = name()
        const r = await invoke('services.rotate', { name: n })
        if (values.json) { json(r); return 0 }
        const c = z.object({ secret: z.string(), secret_id: z.string(), client_id: z.string().optional(), scopes: z.array(z.string()).optional() }).and(Addresses).parse(r)
        let clientId = c.client_id
        let scopes = c.scopes
        if (!clientId || !scopes) {
          const s = z.object({ services: z.array(ServiceSchema) }).loose().safeParse(await invoke('services.list', {})).data?.services.find((x) => x.name === n)
          clientId ??= s?.client_id ?? '<client id>'
          scopes ??= s?.scopes ?? ['read']
        }
        out(`A new secret for ${n} (id ${c.secret_id}). The old one keeps working until you retire it.\n`)
        out(keysText({ name: n, client_id: clientId, scopes, ...c, token_url: c.token_url ?? tokenUrlFallback() }))
        out(`\nOnce ${n} uses the new secret, retire the old one: tracectl services show ${n} lists the ids, then tracectl services retire-secret ${n} OLD_ID`)
        return 0
      }
      case 'retire-secret': {
        if (!a || !b) break
        const n = name()
        const r = await invoke('services.retire_secret', { name: n, secret_id: b })
        if (values.json) { json(r); return 0 }
        out(z.object({ removed: z.boolean() }).loose().parse(r).removed ? `Secret ${b} of ${n} is retired: it no longer gets a token.` : `${n} has no secret ${b} (tracectl services show ${n}).`)
        return 0
      }
      case 'delete': {
        if (!a) break
        const n = name()
        if (!values.yes && !(await (deps.confirm ?? confirmDelete)(n))) { err(`${n} was not deleted. (Pass --yes to delete without asking.)`); return 1 }
        const r = await invoke('services.delete', { name: n })
        if (values.json) { json(r); return 0 }
        out(`${n} is deleted: its keys no longer work and it is off every project.`)
        return 0
      }
      case 'history': {
        if (!a) break
        const n = name()
        const r = await invoke('services.history', { name: n })
        if (values.json) { json(r); return 0 }
        const entries = z.object({ entries: z.array(z.object({ at: z.string(), text: z.string() }).loose()) }).loose().parse(r).entries
        if (!entries.length) out(`Nothing recorded for ${n} yet.`)
        for (const e of entries) out(`${e.at.slice(0, 16).replace('T', ' ')}  ${e.text}`)
        return 0
      }
    }
    err(SERVICES_USAGE)
    return 2
  } catch (e) {
    if (e instanceof ApiError || e instanceof LoginError) {
      // includes "External access is off for this installation. Turn it on in the installer (External access)."
      err(`trace: ${e.message}`)
      return 1
    }
    if (e instanceof UsageError) { err(`trace: ${e.message}`); return 2 }
    if (e instanceof z.ZodError) { err(`trace: ${e.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`); return 2 }
    if (e instanceof TypeError && /Unknown option|ERR_PARSE_ARGS|Unexpected argument/.test(`${e.message} ${(e as { code?: string }).code ?? ''}`)) { err(`trace: ${e.message}\n${SERVICES_USAGE}`); return 2 }
    throw e
  }
}
