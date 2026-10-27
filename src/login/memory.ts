/**
 * The memory commands: which long-term records the agents consider, and turning one off or on again.
 *
 *   tracectl remote memory list OWNER/REPO [--all] [--agent A] [--limit N]     through the API (signed in)
 *   tracectl remote memory deactivate OWNER/REPO RECORD_ID --reason "…"
 *   tracectl remote memory reactivate OWNER/REPO RECORD_ID
 *
 *   tracectl memory list [--repo OWNER/REPO] [--all] [--agent A] [--limit N]   a local installation, without the API:
 *   tracectl memory deactivate RECORD_ID --reason "…" [--repo OWNER/REPO]      your own AWS credentials, the memory in
 *   tracectl memory reactivate RECORD_ID [--repo OWNER/REPO]                   TRACE_MEMORY_ID and the marks under
 *                                                                           TRACE_HOME; the project is --repo, else
 *                                                                           TRACE_MEMORY_REPOSITORY, GITHUB_REPOSITORY
 *                                                                           or this clone's origin
 *
 * Inactive records are never deleted: an agent simply does not consider them until they are reactivated.
 */
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { type MemoryRecord, actorIn, agentActor, memoryFromEnv, personHash } from '../agents/runtime/memory.js'
import { ReasonSchema, RecordIdSchema, memoryState } from '../agents/runtime/memory-state.js'
import { invokeApi } from './invoke.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

const Repo = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')

export const REMOTE_MEMORY_USAGE = 'usage: tracectl remote memory list OWNER/REPO [--all] [--agent A] [--limit N] | deactivate OWNER/REPO RECORD_ID --reason "why" | reactivate OWNER/REPO RECORD_ID'
export const MEMORY_USAGE = 'usage: tracectl memory list [--repo OWNER/REPO] [--all] [--agent A] [--limit N] | deactivate RECORD_ID --reason "why" [--repo OWNER/REPO] | reactivate RECORD_ID [--repo OWNER/REPO]'

const Row = z.object({
  id: z.string(), strategy: z.string().nullable(), actor: z.string().nullable(), text: z.string(), created_at: z.string().nullable(),
  active: z.boolean().default(true),
  inactive: z.object({ reason: z.string(), by: z.string(), by_you: z.boolean().optional(), at: z.string() }).loose().optional(),
}).loose()
type Row = z.infer<typeof Row>

function printRows(rows: readonly Row[]): void {
  if (!rows.length) { out('(no records)'); return }
  for (const r of rows) {
    const when = r.created_at ? r.created_at.slice(0, 10) : '          '
    out(`${r.id}  ${when}  ${(r.actor ?? '?').padEnd(14)} ${(r.strategy ?? '').padEnd(11)} ${r.active ? '' : '[inactive] '}${r.text.replace(/\s+/g, ' ').slice(0, 160)}`)
    if (r.inactive) out(`    inactive since ${r.inactive.at.slice(0, 16).replace('T', ' ')} by ${r.inactive.by_you ? 'you' : r.inactive.by}: ${r.inactive.reason}`)
  }
}

/** `tracectl remote memory …` (the caller handles errors and prints usage on 2). */
export async function remoteMemory(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: { all: { type: 'boolean' }, agent: { type: 'string' }, limit: { type: 'string' }, reason: { type: 'string' } },
  })
  const [repo, id] = positionals
  switch (sub) {
    case 'list': {
      if (!repo) break
      const r = z.object({ enabled: z.boolean(), records: z.array(Row) }).loose().parse(await invokeApi('memory.list', {
        repo: Repo.parse(repo), ...(values.all ? { includeInactive: true } : {}), ...(values.agent ? { agent: values.agent } : {}),
        ...(values.limit ? { limit: Number(values.limit) } : {}),
      }))
      if (!r.enabled) { out('This installation has no agent memory.'); return 0 }
      printRows(r.records)
      return 0
    }
    case 'deactivate': {
      if (!repo || !id) break
      if (!values.reason) { err('tracectl remote memory deactivate: give --reason "why"'); return 2 }
      const r = z.object({ id: z.string(), changed: z.boolean() }).loose().parse(await invokeApi('memory.deactivate', { repo: Repo.parse(repo), recordId: RecordIdSchema.parse(id), reason: ReasonSchema.parse(values.reason) }))
      out(r.changed ? `${r.id} is inactive: no agent considers it until it is reactivated.` : `${r.id} was already inactive.`)
      return 0
    }
    case 'reactivate': {
      if (!repo || !id) break
      const r = z.object({ id: z.string(), changed: z.boolean() }).loose().parse(await invokeApi('memory.reactivate', { repo: Repo.parse(repo), recordId: RecordIdSchema.parse(id) }))
      out(r.changed ? `${r.id} is active again.` : `${r.id} was not inactive.`)
      return 0
    }
  }
  err(REMOTE_MEMORY_USAGE)
  return 2
}

// ------------------------------------------------------------------ local

/** This clone's GitHub repository, from its origin (null when there is none). */
export function originRepository(cwd = process.cwd()): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const m = /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/** Who you are locally, for the marks (only its hash is kept): git's user.email, else your login. */
function localPerson(): string {
  try {
    const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (email) return email
  } catch { /* no git identity */ }
  return userInfo().username
}

const rowOf = (r: MemoryRecord, repo: string, me: string): Row => ({
  id: r.id, strategy: r.strategy, actor: actorIn(r.namespace, repo), text: r.text, created_at: r.createdAt?.toISOString() ?? null,
  active: !r.inactive,
  ...(r.inactive ? { inactive: { reason: r.inactive.reason, by: r.inactive.by, by_you: r.inactive.by === me, at: new Date(r.inactive.at * 1000).toISOString() } } : {}),
})

/** `tracectl memory …` on a local installation (your own credentials; no access model beyond them). */
export async function cmdMemory(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const [sub, ...rest] = argv
  let parsed
  try {
    parsed = parseArgs({
      args: rest, allowPositionals: true,
      options: { repo: { type: 'string' }, all: { type: 'boolean' }, agent: { type: 'string' }, limit: { type: 'string' }, reason: { type: 'string' } },
    })
  } catch (e) {
    err(`tracectl memory: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  const { values, positionals } = parsed
  if (sub !== 'list' && sub !== 'deactivate' && sub !== 'reactivate') { err(MEMORY_USAGE); return 2 }
  const mem = memoryFromEnv(env)
  if (!mem) { err('tracectl memory: no memory here (TRACE_MEMORY_ID is not set); through the API use `tracectl remote memory`'); return 1 }
  const raw = values.repo ?? env.TRACE_MEMORY_REPOSITORY ?? env.GITHUB_REPOSITORY ?? originRepository()
  const repo = Repo.safeParse(raw ?? '')
  if (!repo.success) { err('tracectl memory: which project? give --repo OWNER/REPO'); return 2 }
  const slug = repo.data.toLowerCase()
  const me = personHash(localPerson())
  try {
    if (sub === 'list') {
      if (values.agent) agentActor(slug, values.agent)
      const records = await mem.longTerm.listProject(slug, { agent: values.agent, limit: values.limit ? Number(values.limit) : 50, includeInactive: values.all === true })
      printRows(records.map((r) => rowOf(r, slug, me)))
      return 0
    }
    const id = RecordIdSchema.safeParse(positionals[0] ?? '')
    if (!id.success) { err(MEMORY_USAGE); return 2 }
    const state = memoryState(slug)
    if (sub === 'deactivate') {
      const reason = ReasonSchema.safeParse(values.reason ?? '')
      if (!reason.success) { err('tracectl memory deactivate: give --reason "why"'); return 2 }
      const r = await mem.longTerm.find(slug, id.data)
      if (!r) { err(`tracectl memory: no record ${id.data} in ${slug}'s memory`); return 1 }
      const { changed } = await state.deactivate({ recordId: r.id, namespace: r.namespace, reason: reason.data, by: me })
      out(changed ? `${r.id} is inactive: no agent considers it until it is reactivated.` : `${r.id} was already inactive.`)
      return 0
    }
    const removed = await state.reactivate(id.data, me)
    out(removed ? `${id.data} is active again.` : `${id.data} was not inactive.`)
    return 0
  } catch (e) {
    err(`tracectl memory: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
