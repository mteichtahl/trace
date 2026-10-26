/**
 * What a signed-in person can ask the API runtime to do. Each action names the access it needs, and that is checked
 * (access.require_ or admin) BEFORE anything else happens — before GitHub, Cognito, a clone or a job is touched — so
 * a project the person is not assigned to and a project that does not exist get the same answer: "no access".
 *
 *   action        needs                 does
 *   whoami        signed in             who you are: sub, email, groups, class
 *   projects      signed in             your projects and your role on each
 *   status        read                  open PRs, open agent-fix issues, recent trace workflow runs, the last deploy
 *   settings.get  read                  the project's settings (.trace/project.db on the default branch), resolved
 *   runs          read                  the project's run record (newest first; kind, limit)
 *   run           read                  one run: args, result, measurements, artifact list
 *   artifact      read                  one artifact's bytes (base64), at most 8 MB
 *   tools.list    read                  the tools (never the hardware ones), and which of them need write
 *   tool          read | write          run a tool on the project's own worker runtime (src/agents/runtime/tool.ts), on
 *                                       its clone of the default branch; write for WRITE_TOOLS; hardware: never
 *   settings.set  write                 change (or unset) one setting: a commit on trace/settings-<slug>, pushed (the
 *                                       harness opens the PR); never the default branch
 *   task          write                 start a free-form task job (Claude, on a claude/ branch), requestedBy you;
 *                                       agent: verify, impl, ams, emc or render (a specialist), or left out to be
 *                                       routed (src/agents/router.ts). It runs on the project's own worker
 *                                       runtime (src/api/workers.ts), never in this process: the API runs no model
 *   memory.list   read                  the agents' long-term memory of the project (facts, preferences, session
 *                                       summaries), newest first, from that project's own memory; agent narrows
 *                                       it to one agent. A project without a memory here: "no access"
 *   memory.recall read                  the records most relevant to a query, the same scope
 *                                       (both leave out inactive records; memory.list includeInactive shows them,
 *                                       each with active: false, its reason, who and when)
 *   memory.deactivate  write, or read   mark one record inactive (recordId, reason): no agent considers it again.
 *                      for your own     The record is first found in this project's memory, under its prefix, and
 *                      person records   one you may see; any other id gets the same "no access". A guest may mark
 *                                       only records under their own person actor (their preferences)
 *   memory.reactivate  the same         remove the mark: the record is considered again (it was never deleted)
 *   job           read on its project   a job's state and log (the project is named by the job id, and checked
 *                                       before the worker is asked)
 *   users.list    admin                 every person: email, status, class, assigned projects
 *   users.invite  admin                 create the person in Cognito (email, class) → sub
 *   users.class   admin                 change a person's class (their Cognito group: exactly one of the three)
 *   assign        admin                 assign a person (email or sub) to a project
 *   unassign      admin                 remove them from it
 *   assignments   admin                 every assignment, optionally for one project
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AccessDenied, CLASSES, GROUPS, type PersonClass, type Principal, RepoSlug, type Role,
  assign, assignments, classOf, isAdmin, projectsFor, require_, setClass, unassign,
} from '../core/access.js'
import { readSettings, resolve, setValue, unset } from '../core/config.js'
import { type AnyTool, Registry, ToolError } from '../core/registry.js'
import { type AgentMemory, AgentName, type MemoryRecord, type ProjectMemories, STRATEGIES, actorIn, personHash, projectPrefix, within } from '../agents/runtime/memory.js'
import { type InactiveMark, ReasonSchema, RecordIdSchema, memoryState } from '../agents/runtime/memory-state.js'
import { TASK_AGENTS, type ToolJob } from '../agents/runtime/schemas.js'
import { API_HIDDEN_TOOLS, ToolRefused, apiTool, checkPaths } from '../agents/runtime/tool.js'
import { Work } from '../core/store.js'
import type { CognitoAdmin, CognitoUser } from './aws.js'
import type { GitHubApi } from './github.js'

export const PROJECT_DB_PATH = '.trace/project.db'
const MAX_ARTIFACT = 8 * 1024 * 1024

/** Tools that change state outside their scratch clone (the shared datasheet library and parts links): write. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['datasheets.add', 'datasheets.acknowledge', 'parts.fetch_datasheet'])

/** Tools scoped by the session's environment (a job's project and agent), not by the request: never through the API.
 * The API reaches memory through memory.list and memory.recall, scoped to the project the access check passed.
 * The policy (these, hardware tools, paths inside the clone) is src/agents/runtime/tool.ts's, applied on both sides. */
export { API_HIDDEN_TOOLS }

export class ActionError extends Error {
  override name = 'ActionError'
}

/** "no access": the one answer for a project that is not yours, whether or not it exists. */
export const NO_ACCESS = 'no access'

export interface JobsApi {
  /** The project a job id belongs to (read from the id itself), or null for an id that is not one of ours. */
  repositoryOf(jobId: string): string | null
  startJob(payload: { kind: 'task'; repository: string; request: string; requestedBy: string; agent?: (typeof TASK_AGENTS)[number] }): Promise<{ accepted: boolean; jobId: string; reason?: string | undefined }>
  jobStatus(jobId?: string): Promise<readonly JobView[]>
  /** One tool call on the project's own worker runtime (invocation kind `tool`): its result, or throws ActionError.
   * Absent: this installation runs no tools for the API. */
  runTool?(payload: Omit<ToolJob, 'trace'>): Promise<unknown>
}

export interface JobView { id: string; kind: string; repository?: string | undefined; state: string; [k: string]: unknown }

export interface ActionDeps {
  github: () => Promise<GitHubApi>
  cognito: () => CognitoAdmin
  jobs: () => Promise<JobsApi>
  /** The tool registry: what tools.list shows and what `tool` may ask for (the call itself runs on the worker). */
  tools: () => Registry
  /** Where temporary files go. */
  scratch: string
  /** Each project's memory (TRACE_PROJECT_MEMORIES); absent or null: memory.* answer that there is none. */
  memory?: () => ProjectMemories | null
}

export interface Context { principal: Principal; deps: ActionDeps }

type Need = 'signed-in' | 'read' | 'write' | 'admin' | 'tool' | 'job'

interface Action<S extends z.ZodType> {
  need: Need
  args: S
  run: (a: z.output<S>, ctx: Context) => Promise<unknown>
}

const def = <S extends z.ZodType>(need: Need, args: S, run: (a: z.output<S>, ctx: Context) => Promise<unknown>): Action<S> => ({ need, args, run })

const Repo = z.object({ repo: RepoSlug })
const Who = z.string().min(1).max(320)
const Cls = z.enum(CLASSES)

// ------------------------------------------------------------------ helpers

function tempDb(scratch: string, bytes: Uint8Array | null): { root: string; db: string; cleanup(): void } {
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'trace-api-'))
  mkdirSync(join(root, '.trace'))
  // A .git marker makes this folder the project root for config.setValue/unset (store.findRoot), even when the
  // repository has no database yet — never a database somewhere above it.
  mkdirSync(join(root, '.git'))
  const db = join(root, PROJECT_DB_PATH)
  if (bytes) writeFileSync(db, bytes)
  return { root, db, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function withProjectDb<T>(ctx: Context, repo: string, fn: (db: string, root: string) => T | Promise<T>): Promise<T> {
  const gh = await ctx.deps.github()
  const { branch } = await gh.defaultBranch(repo)
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
  try {
    return await fn(t.db, t.root)
  } finally {
    t.cleanup()
  }
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change'

/** Resolve a person (email or sub) in Cognito; an unknown one is reported as such (admins only reach this). */
async function person(ctx: Context, who: string): Promise<CognitoUser> {
  const u = await ctx.deps.cognito().find(who)
  if (!u) throw new ActionError(`no such person: ${who}`)
  return u
}

/**
 * Which of a project's memory a person may see (they passed the read check on `repo`): every agent's, and the
 * person-scoped preferences only when they are their own. An admin sees everyone's.
 */
function memoryInclude(ctx: Context, repo: string): (ns: string) => boolean {
  if (isAdmin(ctx.principal)) return () => true
  const own = new Set([ctx.principal.email, ctx.principal.sub].filter((x): x is string => Boolean(x)).map((w) => `person/${personHash(w)}`))
  return (ns) => { const a = actorIn(ns, repo); return a !== null && (!a.startsWith('person/') || own.has(a)) }
}

/** The hash a person's marks are recorded under (the agents' memory hash: never their email). */
const byHash = (p: Principal): string => personHash(p.email ?? p.sub)

const markView = (m: InactiveMark | undefined, p: Principal): Record<string, unknown> => (m
  ? { active: false, inactive: { reason: m.reason, by: m.by, by_you: m.by === byHash(p), at: new Date(m.at * 1000).toISOString() } }
  : { active: true })

const recordView = (r: MemoryRecord, repo: string, p: Principal): Record<string, unknown> => ({
  id: r.id, strategy: r.strategy, actor: actorIn(r.namespace, repo), text: r.text, score: r.score, created_at: r.createdAt?.toISOString() ?? null,
  ...markView(r.inactive, p),
})

/** The person's own person actors on `repo` (email and sub): `person/<hash>`. */
const ownActors = (p: Principal): Set<string> => new Set([p.email, p.sub].filter((x): x is string => Boolean(x)).map((w) => `person/${personHash(w)}`))

/**
 * May `ctx.principal` mark (or unmark) the record filed under `ns` of `repo`? Write access (a user, an admin), or a
 * record of their own person actor with read access only (a guest's own preferences). The caller has already found
 * the record in this project and checked the person may see it.
 */
async function mayMark(ctx: Context, repo: string, ns: string): Promise<void> {
  if (isAdmin(ctx.principal)) return
  const role = await require_(ctx.principal, repo, 'read')
  if (role === 'write') return
  const a = actorIn(ns, repo)
  if (a !== null && ownActors(ctx.principal).has(a)) return
  throw new AccessDenied(`no write access to ${repo}: only your own preferences can be marked with read access`)
}

const MarkArgs = Repo.extend({ recordId: RecordIdSchema })

const MemoryArgs = Repo.extend({ agent: AgentName.optional() })

/**
 * The project's own memory, after the access check: null when the installation has no memory at all; a project with
 * none here (not one of this installation's) gets the same "no access" as one the person is not assigned to.
 */
function projectMemory(ctx: Context, repo: string): AgentMemory | null {
  const all = ctx.deps.memory?.() ?? null
  if (!all) return null
  const mem = all.forProject(repo)
  if (!mem) throw new AccessDenied(NO_ACCESS)
  return mem
}

const toolNeed = (t: AnyTool): Role => (WRITE_TOOLS.has(t.name) ? 'write' : 'read')

// ------------------------------------------------------------------ the actions

const ToolArgs = z.object({ repo: RepoSlug, name: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/), args: z.record(z.string(), z.unknown()).default({}) })

export const ACTIONS = {
  whoami: def('signed-in', z.object({}), async (_a, { principal: p }) => ({ sub: p.sub, email: p.email, groups: p.groups, class: classOf(p) })),

  projects: def('signed-in', z.object({}), async (_a, { principal }) => projectsFor(principal)),

  status: def('read', Repo, async ({ repo }, ctx) => {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
    let label = 'agent-fix'
    try {
      label = resolve(readSettings(t.db)).config.labels.agent_fix
    } finally {
      t.cleanup()
    }
    const [pulls, issues, runs, deploy] = await Promise.all([gh.openPulls(repo), gh.openIssues(repo, label), gh.workflowRuns(repo, 60), gh.lastDeploy(repo)])
    const trace = runs.filter((r) => /(^|\/)trace-[^/]*\.ya?ml$/.test(r.path) || /^trace\b/i.test(r.name)).slice(0, 20)
    return { repo, default_branch: branch, pulls, agent_fix_issues: issues, runs: trace, last_deploy: deploy }
  }),

  'settings.get': def('read', Repo, async ({ repo }, ctx) => withProjectDb(ctx, repo, (db) => {
    const own = readSettings(db)
    const { config, errors } = resolve(own)
    return { repo, set: own, config, errors }
  })),

  runs: def('read', Repo.extend({ kind: z.string().max(100).optional(), limit: z.number().int().min(1).max(500).default(20) }), async (a, ctx) =>
    withProjectDb(ctx, a.repo, (db) => { const w = new Work(db); try { return w.runs(a.kind, a.limit) } finally { w.close() } })),

  run: def('read', Repo.extend({ id: z.string().min(1).max(64) }), async (a, ctx) => withProjectDb(ctx, a.repo, (db) => {
    const w = new Work(db)
    try {
      const r = w.run(a.id)
      if (!r) throw new ActionError(`no run ${a.id}`)
      return r
    } finally { w.close() }
  })),

  artifact: def('read', Repo.extend({ id: z.string().min(1).max(64), name: z.string().min(1).max(300) }), async (a, ctx) => withProjectDb(ctx, a.repo, (db) => {
    const w = new Work(db)
    try {
      const row = w.db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(a.id, a.name)
      if (!row) throw new ActionError(`no artifact ${a.name} on run ${a.id}`)
      const bytes = row.bytes as Uint8Array
      if (bytes.length > MAX_ARTIFACT) throw new ActionError(`${a.name} is ${bytes.length} bytes; the API returns at most ${MAX_ARTIFACT}`)
      return { id: a.id, name: a.name, mime: row.mime === null ? null : String(row.mime), size: bytes.length, base64: Buffer.from(bytes).toString('base64') }
    } finally { w.close() }
  })),

  'tools.list': def('read', Repo, async (_a, ctx) => ctx.deps.tools().list().filter((t) => !t.hardware && !API_HIDDEN_TOOLS.has(t.name)).map((t) => ({
    name: t.name, description: t.description, needs: toolNeed(t), input: Registry.jsonSchema(t),
  }))),

  // The access check (perform) came first. The call runs on the project's own worker runtime, never here: the API has
  // no GPU or CPU queue and runs nothing heavy. The worker applies the same policy again on its clone.
  tool: def('tool', ToolArgs, async (a, ctx) => {
    if (!apiTool(ctx.deps.tools().get(a.name))) throw new ActionError(`no tool ${a.name}`)
    try {
      checkPaths(a.args, '/repository')
    } catch (e) {
      throw e instanceof ToolRefused ? new ActionError(e.message) : e
    }
    const jobs = await ctx.deps.jobs()
    if (!jobs.runTool) throw new ActionError('tools run on the project\'s worker runtime, and this installation has none for the API')
    return jobs.runTool({ kind: 'tool', repository: a.repo, name: a.name, args: a.args })
  }),

  'settings.set': def('write', Repo.extend({ key: z.string().min(1).max(200), value: z.unknown().optional(), unset: z.boolean().default(false) }), async (a, ctx) => {
    if (!a.unset && a.value === undefined) throw new ActionError('give a value, or unset: true')
    const gh = await ctx.deps.github()
    const { branch: base, sha } = await gh.defaultBranch(a.repo)
    const blob = await gh.fileSha(a.repo, PROJECT_DB_PATH, base)
    const t = tempDb(ctx.deps.scratch, await gh.rawFile(a.repo, PROJECT_DB_PATH, base))
    try {
      const by = ctx.principal.email ?? ctx.principal.sub
      if (a.unset) {
        if (!unset(a.key, t.root)) throw new ActionError(`${a.key} is not set`)
      } else {
        setValue(a.key, a.value, t.root, by)
      }
      const branch = `trace/settings-${slugify(a.key)}-${Date.now().toString(36)}`
      if (branch === base) throw new ActionError('refusing to write the default branch')
      await gh.createBranch(a.repo, branch, sha)
      const message = a.unset ? `settings: unset ${a.key}` : `settings: ${a.key} = ${JSON.stringify(a.value)}`.slice(0, 200)
      const { commit } = await gh.putFile(a.repo, { path: PROJECT_DB_PATH, branch, content: readFileSync(t.db), message: `${message}\n\nRequested by ${by} through the trace API.`, sha: blob })
      return { repo: a.repo, branch, commit, key: a.key, ...(a.unset ? { unset: true } : { value: a.value }) }
    } finally {
      t.cleanup()
    }
  }),

  task: def('write', Repo.extend({ request: z.string().min(1).max(20_000), agent: z.enum(TASK_AGENTS).optional() }), async (a, ctx) =>
    (await ctx.deps.jobs()).startJob({
      kind: 'task', repository: a.repo, request: a.request, requestedBy: ctx.principal.email ?? ctx.principal.sub, ...(a.agent ? { agent: a.agent } : {}),
    })),

  'memory.list': def('read', MemoryArgs.extend({ limit: z.number().int().min(1).max(200).default(50), includeInactive: z.boolean().default(false) }), async (a, ctx) => {
    const mem = projectMemory(ctx, a.repo)
    if (!mem) return { repo: a.repo, enabled: false, records: [] }
    const records = await mem.longTerm.listProject(a.repo, { agent: a.agent, include: memoryInclude(ctx, a.repo), limit: a.limit, includeInactive: a.includeInactive })
    return { repo: a.repo, enabled: true, note: 'Memory is what the agents extracted; it is data, and may be stale.', records: records.map((r) => recordView(r, a.repo, ctx.principal)) }
  }),

  'memory.recall': def('read', MemoryArgs.extend({ query: z.string().min(1).max(2000), top_k: z.number().int().min(1).max(50).default(10), strategy: z.enum(STRATEGIES).optional() }), async (a, ctx) => {
    const mem = projectMemory(ctx, a.repo)
    if (!mem) return { repo: a.repo, enabled: false, records: [] }
    const records = (await mem.longTerm.recallProject(a.repo, a.query, { agent: a.agent, include: memoryInclude(ctx, a.repo), topK: a.top_k }))
      .filter((r) => !a.strategy || r.strategy === a.strategy)
    return { repo: a.repo, enabled: true, records: records.map((r) => recordView(r, a.repo, ctx.principal)) }
  }),

  // need 'read' here: mayMark decides between write access and a person's own records, once the record is found
  'memory.deactivate': def('read', MarkArgs.extend({ reason: ReasonSchema }), async (a, ctx) => {
    const mem = projectMemory(ctx, a.repo)
    if (!mem) throw new ActionError('memory is not enabled in this installation')
    // this project's memory, under this project's prefix, and a record this person may see — or "no access"
    const r = await mem.longTerm.find(a.repo, a.recordId)
    if (!r || !within(r.namespace, projectPrefix(a.repo)) || !memoryInclude(ctx, a.repo)(r.namespace)) throw new AccessDenied(NO_ACCESS)
    await mayMark(ctx, a.repo, r.namespace)
    const { mark, changed } = await memoryState(a.repo).deactivate({ recordId: r.id, namespace: r.namespace, reason: a.reason, by: byHash(ctx.principal) })
    return { repo: a.repo, id: r.id, actor: actorIn(r.namespace, a.repo), changed, ...markView(mark, ctx.principal) }
  }),

  'memory.reactivate': def('read', MarkArgs, async (a, ctx) => {
    const mem = projectMemory(ctx, a.repo)
    if (!mem) throw new ActionError('memory is not enabled in this installation')
    const state = memoryState(a.repo)
    // the marks are this project's own (each was verified against its memory when it was made); an id without one
    // is looked up like memory.deactivate does, so another project's id gets the same "no access"
    const mark = await state.get(a.recordId)
    const ns = mark?.namespace ?? (await mem.longTerm.find(a.repo, a.recordId))?.namespace
    if (ns === undefined || !within(ns, projectPrefix(a.repo)) || !memoryInclude(ctx, a.repo)(ns)) throw new AccessDenied(NO_ACCESS)
    await mayMark(ctx, a.repo, ns)
    if (!mark) return { repo: a.repo, id: a.recordId, actor: actorIn(ns, a.repo), changed: false, active: true }
    const removed = await state.reactivate(a.recordId, byHash(ctx.principal))
    return { repo: a.repo, id: a.recordId, actor: actorIn(ns, a.repo), changed: removed !== null, active: true }
  }),

  job: def('job', z.object({ id: z.string().min(1).max(200) }), async (a, ctx) => {
    const jobs = await ctx.deps.jobs()
    // the access check comes first: the project is read from the id, and only then is its worker asked
    const repo = jobs.repositoryOf(a.id)
    if (!repo) throw new AccessDenied(NO_ACCESS)
    if (!isAdmin(ctx.principal)) await require_(ctx.principal, repo, 'read')
    const j = (await jobs.jobStatus(a.id))[0]
    if (!j || (j.repository !== undefined && j.repository.toLowerCase() !== repo.toLowerCase())) throw new AccessDenied(NO_ACCESS)
    return j
  }),

  'users.list': def('admin', z.object({}), async (_a, ctx) => {
    const cog = ctx.deps.cognito()
    const [users, ...members] = await Promise.all([cog.listUsers(), ...CLASSES.map((c) => cog.usersInGroup(GROUPS[c]))])
    const classes = new Map<string, PersonClass>()
    CLASSES.forEach((c, i) => { for (const u of members[i] ?? []) if (!classes.has(u.sub)) classes.set(u.sub, c) })
    const all = await assignments(ctx.principal)
    return users.map((u) => ({
      email: u.email, sub: u.sub, status: u.status, enabled: u.enabled, class: classes.get(u.sub) ?? null,
      projects: all.filter((x) => x.sub === u.sub).map((x) => x.repo),
    })).sort((x, y) => (x.email ?? x.sub).localeCompare(y.email ?? y.sub))
  }),

  'users.invite': def('admin', z.object({ email: z.string().email(), class: Cls.default('user') }), async (a, ctx) => {
    const cog = ctx.deps.cognito()
    if (await cog.find(a.email)) throw new ActionError(`${a.email} already has an account; use users.class to change their class`)
    const u = await cog.createUser(a.email)
    await cog.addToGroup(u.username, GROUPS[a.class])
    await setClass(ctx.principal, { sub: u.sub, email: a.email }, a.class)
    return { sub: u.sub, email: a.email, class: a.class, note: 'Cognito has emailed them a temporary password; they sign in with `trace login`.' }
  }),

  'users.class': def('admin', z.object({ who: Who, class: Cls }), async (a, ctx) => {
    const cog = ctx.deps.cognito()
    const u = await person(ctx, a.who)
    const now = await cog.groupsFor(u.username)
    const want = GROUPS[a.class]
    if (!now.includes(want)) await cog.addToGroup(u.username, want)
    for (const c of CLASSES) if (GROUPS[c] !== want && now.includes(GROUPS[c])) await cog.removeFromGroup(u.username, GROUPS[c])
    await setClass(ctx.principal, { sub: u.sub, email: u.email }, a.class)
    return { sub: u.sub, email: u.email, class: a.class, note: 'Takes effect when their access token next refreshes (within an hour).' }
  }),

  assign: def('admin', z.object({ who: Who, repo: RepoSlug }), async (a, ctx) => {
    const u = await person(ctx, a.who)
    return assign(ctx.principal, { sub: u.sub, email: u.email }, a.repo)
  }),

  unassign: def('admin', z.object({ who: Who, repo: RepoSlug }), async (a, ctx) => {
    const u = await person(ctx, a.who)
    return { sub: u.sub, email: u.email, repo: a.repo, removed: await unassign(ctx.principal, u.sub, a.repo) }
  }),

  assignments: def('admin', z.object({ repo: RepoSlug.optional() }), async (a, ctx) => assignments(ctx.principal, a.repo ? { repo: a.repo } : {})),
} satisfies Record<string, Action<z.ZodType>>

export type ActionName = keyof typeof ACTIONS
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[]

/** The access an action needs, as published (`tool` depends on the tool). */
export const needOf = (name: ActionName): Need => ACTIONS[name].need

export interface Outcome { ok: true; result: unknown }

/**
 * Parse, authorise, then run. Throws AccessDenied (→ 403 "no access"), ActionError/ToolError/ZodError (→ ok:false).
 */
export async function perform(name: string, raw: Record<string, unknown>, ctx: Context): Promise<{ repo: string | null; result: unknown }> {
  if (!Object.hasOwn(ACTIONS, name)) throw new ActionError(`unknown action ${JSON.stringify(name)}`)
  const action = ACTIONS[name as ActionName] as Action<z.ZodType>
  const parsed = action.args.safeParse(raw)
  if (!parsed.success) throw new ActionError(`${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`)
  const args = parsed.data as Record<string, unknown>
  const repo = typeof args.repo === 'string' ? args.repo : null
  const p = ctx.principal
  switch (action.need) {
    case 'signed-in': case 'job': break
    case 'admin': if (!isAdmin(p)) throw new AccessDenied('admins only'); break
    case 'read': case 'write': await require_(p, repo ?? '', action.need); break
    case 'tool': {
      await require_(p, repo ?? '', 'read')
      const t = ctx.deps.tools().get(String(args.name))
      if (t && toolNeed(t) === 'write') await require_(p, repo ?? '', 'write')
      break
    }
  }
  return { repo, result: await action.run(args, ctx) }
}

export { ToolError }

export const defaultScratch = (): string => process.env.TRACE_WORKSPACE ? join(process.env.TRACE_WORKSPACE, 'api') : join(tmpdir(), 'trace-api')
