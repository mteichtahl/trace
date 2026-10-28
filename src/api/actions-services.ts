/**
 * Connected systems (docs/external-access.md "Managing connected systems"): outside systems that call trace with a
 * client-credentials token. Admins only, on the people's API runtime. Each system is a Cognito app client (client
 * credentials only, with a secret, one-hour access tokens, named <prefix>-svc-<name>) and a row in the access store.
 *
 *   services.list           admin   { services, token_url, api_url, mcp_url, resource_server }: every system with its
 *                                   scopes, projects and parts, disabled, created, last used, and its secrets by id
 *                                   and date (never a value; Cognito holds at most two)
 *   services.create         admin   { name, description?, scopes: ['read'] | ['read','write'], projects?: [{ repo, part? }] }
 *                                   → { service, client_id, secret, token_url, api_url, mcp_url }. The secret is here
 *                                   only: trace never stores it, and it is never logged
 *   services.update         admin   { name, description?, scopes?, disabled? } → { service } (a scope change is sent to
 *                                   its app client; down to read only, every part it holds becomes reviewer, logged;
 *                                   disabling stops its tokens within 30 seconds)
 *   services.assign         admin   { name, repo, part? }: a read-only system is always a reviewer
 *   services.unassign       admin   { name, repo } → whether it was on it
 *   services.rotate         admin   { name } → { secret, secret_id, addresses }: shown once; the old secret keeps
 *                                   working until retired
 *   services.retire_secret  admin   { name, secret_id }: removes one secret (never the last)
 *   services.delete         admin   { name }: deletes its app client (already gone: fine), then the system and every
 *                                   assignment, logged
 *   services.history        admin   { name }: its assignment log and its own log, newest first, in words
 *
 * With external access off (no TRACE_EXTERNAL_RUNTIME_ARN), every one but list and history answers that it is off;
 * those two show what the store holds.
 */
import { z } from 'zod'
import {
  AccessDenied, PARTS, PartRefused, SERVICE_SCOPES, type Service, ServiceExists, ServiceName, type ServiceScope, RepoSlug,
  assignService, assignmentLog, assignments, createService, deleteService, listServices, logServiceSecret, serviceByName, serviceLog, unassign, updateService,
} from '../core/access.js'
import { ActionError, type Context, type ExternalAccess, def } from './action-kit.js'
import { CognitoError, serviceClientName } from './aws.js'
import { invocationUrl } from './runtime-url.js'

export const EXTERNAL_OFF = 'External access is off for this installation. Turn it on in the installer (External access).'

/** External access from the API runtime's environment, or null when it is off (no TRACE_EXTERNAL_RUNTIME_ARN). */
export function externalFromEnv(env: Record<string, string | undefined> = process.env): ExternalAccess | null {
  const arn = env.TRACE_EXTERNAL_RUNTIME_ARN?.trim()
  const region = env.AWS_REGION?.trim()
  if (!arn || !region) return null
  const endpoint = env.TRACE_AGENTCORE_ENDPOINT || undefined
  const mcp = env.TRACE_MCP_RUNTIME_ARN?.trim()
  return {
    tokenUrl: env.TRACE_TOKEN_URL?.trim() || null,
    apiUrl: invocationUrl(region, arn, endpoint),
    mcpUrl: mcp ? invocationUrl(region, mcp, endpoint) : null,
    resourceServer: env.TRACE_EXTERNAL_RESOURCE_SERVER?.trim() || 'trace-external',
    prefix: env.TRACE_PREFIX?.trim() || 'trace',
  }
}

const external = (ctx: Context): ExternalAccess => {
  const x = ctx.deps.external
  if (!x) throw new ActionError(EXTERNAL_OFF)
  return x
}

/** The scopes as asked: ['read'] or ['read', 'write'] (write always brings read). */
const Scopes = z.array(z.enum(SERVICE_SCOPES)).min(1).max(2)
  .refine((s) => s.includes('read'), 'scopes are ["read"] or ["read", "write"]')
  .transform((s): ServiceScope[] => (s.includes('write') ? ['read', 'write'] : ['read']))

const Description = z.string().trim().max(500)
const Named = z.object({ name: ServiceName })

/** The app client's configuration for a system: its name, and its scopes on the resource server. */
const clientConfig = (x: ExternalAccess, name: string, scopes: readonly ServiceScope[]) =>
  ({ clientName: serviceClientName(x.prefix, name), scopes: scopes.map((s) => `${x.resourceServer}/${s}`) })

async function system(ctx: Context, name: string): Promise<Service> {
  const s = await serviceByName(ctx.principal, name)
  if (!s) throw new ActionError(`no connected system called ${name}`)
  return s
}

/** Cognito's own refusals in plain words (never the secret: Cognito's messages do not carry it). */
async function cognito<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof CognitoError) {
      if (e.type === 'LimitExceededException') throw new ActionError(`${what}: Cognito's limit is reached (${e.message}). An app client holds at most two secrets: retire the old one first (services.retire_secret).`)
      throw new ActionError(`${what}: ${e.message}`)
    }
    throw e
  }
}

const refusedPart = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof PartRefused ? new ActionError(e.message) : e
  }
}

/** One system with its projects and parts, for the admin screen. */
async function view(ctx: Context, s: Service, all?: Awaited<ReturnType<typeof assignments>>) {
  const mine = (all ?? await assignments(ctx.principal, { sub: s.client_id })).filter((a) => a.sub === s.client_id)
  return { ...s, projects: mine.map((a) => ({ repo: a.repo, part: a.part })) }
}

const Project = z.object({ repo: RepoSlug, part: z.enum(PARTS).optional() })

/** The addresses every answer that can carry them does (the app's snippets). */
const addresses = (x: ExternalAccess | null | undefined) => (x
  ? { token_url: x.tokenUrl, api_url: x.apiUrl, mcp_url: x.mcpUrl, resource_server: x.resourceServer }
  : {})

/** A system's secrets, by id and date (never a value); none when Cognito can't be asked (the list still answers). */
async function secretsOf(ctx: Context, s: Service): Promise<{ id: string; created_at: string }[] | undefined> {
  if (!ctx.deps.external) return undefined
  try {
    return (await ctx.deps.cognito().listClientSecrets(s.client_id)).map((k) => ({ id: k.secretId, created_at: k.createdAt ?? '' }))
  } catch {
    return undefined
  }
}

export const SERVICE_ADMIN_ACTIONS = {
  'services.list': def('admin', z.object({}), async (_a, ctx) => {
    const [list, all] = await Promise.all([listServices(ctx.principal), assignments(ctx.principal)])
    const services = await Promise.all(list.map(async (s) => {
      const secrets = await secretsOf(ctx, s)
      return { ...(await view(ctx, s, all)), ...(secrets ? { secrets } : {}) }
    }))
    return { enabled: Boolean(ctx.deps.external), services, ...addresses(ctx.deps.external) }
  }),

  'services.create': def('admin', Named.extend({ description: Description.optional(), scopes: Scopes, projects: z.array(Project).max(100).default([]) }), async (a, ctx) => {
    const x = external(ctx)
    if (await serviceByName(ctx.principal, a.name)) throw new ActionError(`a connected system called ${a.name} exists already`)
    if (!a.scopes.includes('write') && a.projects.some((p) => p.part === 'contributor')) throw new ActionError('A system with only the read scope can only be a reviewer.')
    const cog = ctx.deps.cognito()
    const made = await cognito('creating its app client', () => cog.createServiceClient(clientConfig(x, a.name, a.scopes)))
    let service: Service
    try {
      service = await createService(ctx.principal, { client_id: made.clientId, name: a.name, description: a.description, scopes: a.scopes })
    } catch (e) {
      // nothing half-made: the app client goes when the record cannot be written
      await cog.deleteServiceClient(made.clientId).catch(() => false)
      if (e instanceof ServiceExists) throw new ActionError(e.message)
      throw e
    }
    for (const p of a.projects) await refusedPart(() => assignService(ctx.principal, service, p.repo, p.part))
    return {
      service: await view(ctx, service), client_id: made.clientId, secret: made.secret,
      ...addresses(x), scope: a.scopes.map((s) => `${x.resourceServer}/${s}`).join(' '),
      note: 'This secret is shown once: trace does not keep it. Get a token at token_url with the client id and secret (client credentials), and reuse it for the hour.',
    }
  }),

  'services.update': def('admin', Named.extend({ description: Description.optional(), scopes: Scopes.optional(), disabled: z.boolean().optional() }), async (a, ctx) => {
    const x = external(ctx)
    const s = await system(ctx, a.name)
    if (a.scopes && a.scopes.join(' ') !== s.scopes.join(' ')) {
      await cognito('changing its app client', () => ctx.deps.cognito().updateServiceClient(s.client_id, clientConfig(x, s.name, a.scopes as ServiceScope[])))
    }
    // losing write makes every part it holds a reviewer's (updateService writes and logs that)
    const updated = await updateService(ctx.principal, s.name, { description: a.description, scopes: a.scopes, disabled: a.disabled })
    return { service: await view(ctx, updated) }
  }),

  'services.assign': def('admin', Named.extend({ repo: RepoSlug, part: z.enum(PARTS).optional() }), async (a, ctx) => {
    external(ctx)
    const s = await system(ctx, a.name)
    const r = await refusedPart(() => assignService(ctx.principal, s, a.repo, a.part))
    return { name: s.name, repo: r.repo, part: r.part, assigned_by: r.assigned_by, assigned_at: r.assigned_at }
  }),

  'services.unassign': def('admin', Named.extend({ repo: RepoSlug }), async (a, ctx) => {
    external(ctx)
    const s = await system(ctx, a.name)
    return { name: s.name, repo: a.repo, removed: await unassign(ctx.principal, s.client_id, a.repo) }
  }),

  'services.rotate': def('admin', Named, async (a, ctx) => {
    const x = external(ctx)
    const s = await system(ctx, a.name)
    const k = await cognito('adding a secret', () => ctx.deps.cognito().addClientSecret(s.client_id))
    await logServiceSecret(ctx.principal, s, 'rotate', k.secretId)
    return {
      name: s.name, client_id: s.client_id, secret_id: k.secretId, secret: k.secret, created_at: k.createdAt, scopes: s.scopes, ...addresses(x),
      note: 'This secret is shown once. The old secret keeps working until you retire it (services.retire_secret).',
    }
  }),

  'services.retire_secret': def('admin', Named.extend({ secret_id: z.string().min(1).max(128) }), async (a, ctx) => {
    external(ctx)
    const s = await system(ctx, a.name)
    const cog = ctx.deps.cognito()
    const secrets = await cognito('listing its secrets', () => cog.listClientSecrets(s.client_id))
    if (!secrets.some((k) => k.secretId === a.secret_id)) throw new ActionError(`${s.name} has no secret ${a.secret_id}`)
    if (secrets.length < 2) throw new ActionError('This is its only secret. Rotate first (services.rotate), then retire the old one.')
    await cognito('removing the secret', () => cog.deleteClientSecret(s.client_id, a.secret_id))
    await logServiceSecret(ctx.principal, s, 'retire_secret', a.secret_id)
    return { name: s.name, secret_id: a.secret_id, removed: true }
  }),

  'services.delete': def('admin', Named, async (a, ctx) => {
    external(ctx)
    const s = await system(ctx, a.name)
    const clientDeleted = await cognito('deleting its app client', () => ctx.deps.cognito().deleteServiceClient(s.client_id))
    const deleted = await deleteService(ctx.principal, s.name)
    return { name: s.name, client_id: s.client_id, deleted, app_client: clientDeleted ? 'deleted' : 'already gone' }
  }),

  'services.history': def('admin', Named.extend({ limit: z.number().int().min(1).max(1000).default(200) }), async (a, ctx) => {
    const s = await serviceByName(ctx.principal, a.name)
    if (!s) return { name: a.name, entries: [] }
    const [assigned, own] = await Promise.all([assignmentLog(ctx.principal, s.client_id, a.limit), serviceLog(ctx.principal, s.client_id, a.limit)])
    const entries = [...assigned.map((e) => ({ at: e.at, by: e.by, action: e.action, repo: e.repo, detail: e.detail, text: e.text })), ...own.map((e) => ({ ...e, repo: null }))]
      .sort((x, y) => y.at.localeCompare(x.at)).slice(0, a.limit)
    return { name: s.name, client_id: s.client_id, entries }
  }),
}

export { AccessDenied }
