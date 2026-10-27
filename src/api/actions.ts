/**
 * What a signed-in person can ask the API runtime to do. Each action names the access it needs, and that is checked
 * (access.require_ or admin) BEFORE anything else happens — before GitHub, Cognito, a clone or a job is touched — so
 * a project the person is not assigned to and a project that does not exist get the same answer: "no access".
 *
 *   action        needs                 does
 *   whoami        signed in             who you are: sub, email, groups, class
 *   projects      signed in             your projects, with your role (read, write) and part (contributor, reviewer)
 *                                       on each: write needs the contributor part (admins are contributors everywhere)
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
 *                                       agent: verify, impl, ams, emc, render or thermal (a specialist), or left out to be
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
 *   kb.search     read                  search the project's knowledge base (Retrieve, from this runtime, on that project's
 *                                       knowledge base only: TRACE_PROJECT_KBS); a project without one here: "no access"
 *   kb.sync       write                 sync the project's default branch into its knowledge base: the tool kb.sync on
 *                                       the project's own worker runtime (its role writes projects/<slug>/kb/ and starts
 *                                       the ingestion job; this runtime's cannot)
 *   job           read on its project   a job's state and log, its `controls` (actions-jobs.ts: the ops job.control can do
 *                                       for it now) (the project is named by the job id, and checked
 *                                       before the worker is asked), with `version` (its worker's change counter)
 *                                       and `waits` (every wait open on its worker, each with `text`: "… next check
 *                                       in 4 minutes"). afterVersion + waitS (≤ 240 s): the worker holds the answer
 *                                       until the job changes after that version, or waitS passes: no polling
 *   job.check_now read on its project   wake one timer wait on the job's worker (waitId from `waits`) for a check
 *                                       now → { ok } (false: no such timer wait is open). It changes nothing
 *   tools.waits   read                  what the project's tool calls are waiting on (kb.sync's ingestion job, a
 *                                       graphics card job): { version, waits }, each wait with `text`. afterVersion +
 *                                       waitS (≤ 240 s): held on the worker until a wait opens, is checked, changes
 *                                       or ends: how a screen shows a tool call's lines while it runs
 *   tools.check_now read                wake one of those timer waits for a check now (waitId) → { ok }
 *   users.list    admin                 every person: email, name (Cognito's), status, class, last seen, assigned projects
 *                                       and their part on each
 *   users.invite  admin                 create the person in Cognito (email, class) → sub
 *   users.class   admin                 change a person's class (their Cognito group: exactly one of the three)
 *   assign        admin                 assign a person (email or sub) to a project, with their part: contributor or
 *                                       reviewer (default: the part they have there, else their class's; a guest can
 *                                       only be a reviewer)
 *   unassign      admin                 remove them from it
 *   assignments   admin                 every assignment, optionally for one project
 *   integrations.list    admin          the optional integrations (Nexar, Mouser, Digi-Key): configured or not, when
 *                                       changed, what each enables (never a value)
 *   integrations.set     admin          store one integration's credentials (checked with the service first; a failed
 *                                       check is reported, never blocks)
 *   integrations.remove  admin          delete one integration's secret
 *
 *   prompts.list     read (repo), or any  the prompt catalog: each id, editable or locked, and the layer its text comes
 *                    class without repo   from (installation, and the project's default branch with repo), and every
 *                                         override that is not used (an unknown or locked id, a bad template)
 *   prompts.get      the same             one id: its default, installation and project text, the effective text
 *                                         and the locked parts that always follow it
 *   prompts.preview  read                 a whole prompt (a specialist kind, a prompt's name, or an id) as the model
 *                                         would get it with the overrides, its parts marked
 *   prompts.set      admin (installation) override one editable id (text, reason). Installation: the prompts store;
 *                    write (project)      project: a commit of .trace/project.db on trace/prompts-<slug>-<ts>, pushed
 *                                         (the harness opens the PR, held for a person: .trace/** is protected)
 *   prompts.reset    the same             back to the layer below (a recorded reset)
 *   prompts.revert   the same             back to an earlier version (a number or a history uid)
 *   prompts.history  admin or user        every change to one id in one layer (installation: a user or an admin;
 *                    (installation),      project: write access). Guests can list, get and preview only
 *                    write (project)
 *
 * The web app's actions are in their own files, each spread into ACTIONS (src/api/action-kit.ts holds what they share):
 *
 *   actions-projects.ts  project.members, projects.create
 *   actions-journey.ts   journey.get, journey.criterion.open, gate.sign, gate.return, question.answer, stuck.dismiss, waiver.add, inbox
 *   actions-chats.ts     chats.list, chats.get, chats.append, chats.reply, chats.rename, chats.recall
 *   actions-me.ts        me.get, me.set
 *   actions-graph.ts     graph.neighbourhood
 *   actions-files.ts     files.list, files.url
 *   actions-jobs.ts      job.control
 *   actions-people.ts    users.history
 *   actions-record.ts    requirements.trace, design.get, build.get, order.record, cost.get
 *   actions-skills.ts    skill.get, skill.draft, skill.drafts, skill.submit
 *   actions-me.ts        also policy.get, policy.set
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AccessDenied, CLASSES, GROUPS, PARTS, PartRefused, type PersonClass, type Principal, RepoSlug, type Role,
  assign, assignments, classOf, isAdmin, lastSeen, projectsFor, require_, setClass, unassign,
} from '../core/access.js'
import { readSettings, resolve, setValue, unset } from '../core/config.js'
import { IntegrationNameSchema, type IntegrationStore, checkIntegration, valuesFor } from '../core/integrations.js'
import { type AnyTool, Registry, ToolError } from '../core/registry.js'
import { AgentName, type MemoryRecord, STRATEGIES, actorIn, projectPrefix, within } from '../agents/runtime/memory.js'
import { type InactiveMark, ReasonSchema, RecordIdSchema, memoryState } from '../agents/runtime/memory-state.js'
import { TASK_AGENTS } from '../agents/runtime/schemas.js'
import { API_HIDDEN_TOOLS, ToolRefused, apiTool, checkPaths } from '../agents/runtime/tool.js'
import { Work } from '../core/store.js'
import { personHash as telemetryHash } from '../core/telemetry.js'
import { PROMPT_ID, entry } from '../prompts/catalog.js'
import type { Layers } from '../prompts/resolve.js'
import { InstallationPrompts, PromptError, type PromptWrite, ReasonSchema as PromptReason, projectHistory, projectOverrides, writeProject } from '../prompts/store.js'
import { MAX_PROMPT_CHARS, TemplateError } from '../prompts/template.js'
import { PreviewJob, PreviewTarget, getView, listView, preview } from '../prompts/views.js'
import { parseProjectKbs } from '../tools/kb/env.js'
import { FilterSchema, searchKb } from '../tools/kb/search.js'
import {
  type Action, ActionError, type Context, type JobView, type JobsApi, MAX_ARTIFACT, type Need, NO_ACCESS, PROJECT_DB_PATH, Repo, def, hashOf, hashesOf, memoryInclude, projectMemory, slugify, tempDb, withProjectDb,
} from './action-kit.js'
import { CHAT_ACTIONS } from './actions-chats.js'
import { FILE_ACTIONS } from './actions-files.js'
import { GRAPH_ACTIONS } from './actions-graph.js'
import { JOURNEY_ACTIONS } from './actions-journey.js'
import { JOB_ACTIONS, withControls } from './actions-jobs.js'
import { ME_ACTIONS } from './actions-me.js'
import { PEOPLE_ACTIONS } from './actions-people.js'
import { RECORD_ACTIONS } from './actions-record.js'
import { SKILL_ACTIONS } from './actions-skills.js'
import { PROJECT_ACTIONS } from './actions-projects.js'
import type { CognitoUser } from './aws.js'

export {
  ActionError, NO_ACCESS, PROJECT_DB_PATH, type ActionDeps, type Context, type JobView, type JobsApi, type OnboardRequest, type WaitView,
} from './action-kit.js'

/** Tools that change state outside their scratch clone (the shared datasheet library and parts links): write. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['datasheets.add', 'datasheets.acknowledge', 'parts.fetch_datasheet', 'kb.sync'])

/** Tools scoped by the session's environment (a job's project and agent), not by the request: never through the API.
 * The API reaches memory through memory.list and memory.recall, scoped to the project the access check passed.
 * The policy (these, hardware tools, paths inside the clone) is src/agents/runtime/tool.ts's, applied on both sides. */
export { API_HIDDEN_TOOLS }

async function integrationStore(ctx: Context): Promise<IntegrationStore> {
  if (!ctx.deps.integrations) throw new ActionError('this installation does not manage integrations through the API (TRACE_INTEGRATIONS_PREFIX is not set)')
  return ctx.deps.integrations()
}

/** The installation's knowledge bases from the API runtime's environment (TRACE_PROJECT_KBS). */
export const projectKbsFromEnv = (env: Record<string, string | undefined> = process.env): ReadonlyMap<string, string> => parseProjectKbs(env.TRACE_PROJECT_KBS)

const Who = z.string().min(1).max(320)
const Cls = z.enum(CLASSES)

// ------------------------------------------------------------------ helpers

const JobId = z.object({ id: z.string().min(1).max(200) })

/** need 'job': the project is read from the job id and checked (read) before its worker is asked anything. */
async function jobAccess(id: string, ctx: Context): Promise<JobsApi> {
  const jobs = await ctx.deps.jobs()
  const repo = jobs.repositoryOf(id)
  if (!repo) throw new AccessDenied(NO_ACCESS)
  if (!isAdmin(ctx.principal)) await require_(ctx.principal, repo, 'read')
  return jobs
}

/** The job, if it is the id's project's: otherwise the same "no access" as a stranger's. */
function ownJob(j: JobView | undefined, id: string, jobs: JobsApi): JobView {
  const repo = jobs.repositoryOf(id) ?? ''
  if (!j || (j.repository !== undefined && j.repository.toLowerCase() !== repo.toLowerCase())) throw new AccessDenied(NO_ACCESS)
  return j
}

/** Resolve a person (email or sub) in Cognito; an unknown one is reported as such (admins only reach this). */
async function person(ctx: Context, who: string): Promise<CognitoUser> {
  const u = await ctx.deps.cognito().find(who)
  if (!u) throw new ActionError(`no such person: ${who}`)
  return u
}

/** End every session of a person (AdminUserGlobalSignOut). A failure is reported in the answer, never thrown: the
 * change itself has been made. */
async function signOutQuietly(ctx: Context, u: CognitoUser): Promise<boolean> {
  try {
    await ctx.deps.cognito().signOut(u.username)
    return true
  } catch {
    return false
  }
}

/** The hash a person's marks are recorded under (the agents' memory hash of their sub: never their email). */
const byHash = (p: Principal): string => hashOf(p)

const markView = (m: InactiveMark | undefined, p: Principal): Record<string, unknown> => (m
  ? { active: false, inactive: { reason: m.reason, by: m.by, by_you: hashesOf(p).includes(m.by), at: new Date(m.at * 1000).toISOString() } }
  : { active: true })

const recordView = (r: MemoryRecord, repo: string, p: Principal): Record<string, unknown> => ({
  id: r.id, strategy: r.strategy, actor: actorIn(r.namespace, repo), text: r.text, score: r.score, created_at: r.createdAt?.toISOString() ?? null,
  ...markView(r.inactive, p),
})

/** The person's own person actors on `repo` (the sub's hash, and the email's for records made before): `person/<hash>`. */
const ownActors = (p: Principal): Set<string> => new Set(hashesOf(p).map((h) => `person/${h}`))

/**
 * May `ctx.principal` mark (or unmark) the record filed under `ns` of `repo`? Write access (a user, an admin), or a
 * record of their own person actor with read access only (a guest's own preferences). The caller has already found
 * the record in this project and checked the person may see it.
 */
async function mayMark(ctx: Context, repo: string, ns: string): Promise<void> {
  if (isAdmin(ctx.principal)) return
  const role = await require_(ctx.principal, repo, 'read')
  if (role === 'write') return
  // Read access only (a guest): their own preferences and nothing else, not even other records of their own actor.
  const a = actorIn(ns, repo)
  const preference = a !== null && ns.slice(ns.indexOf(`/${a}/`) + a.length + 2).startsWith('preferences/')
  if (a !== null && ownActors(ctx.principal).has(a) && preference) return
  throw new AccessDenied(`no write access to ${repo}: only your own preferences can be marked with read access`)
}

const MarkArgs = Repo.extend({ recordId: RecordIdSchema })

const MemoryArgs = Repo.extend({ agent: AgentName.optional() })

/**
 * The project's knowledge base id, after the access check: null when the installation has none at all; a project with
 * none here (not one of this installation's, or one with its knowledge base off) gets the same "no access" as one
 * the person is not assigned to.
 */
function projectKb(ctx: Context, repo: string): string | null {
  const all = ctx.deps.kbs?.() ?? new Map<string, string>()
  if (!all.size) return null
  const id = all.get(repo.toLowerCase())
  if (!id) throw new AccessDenied(NO_ACCESS)
  return id
}

/** A person's class as Cognito has it now (their groups decide, not what was last recorded). */
export async function classNow(ctx: Context, u: CognitoUser): Promise<PersonClass | null> {
  const groups = await ctx.deps.cognito().groupsFor(u.username)
  return CLASSES.find((c) => groups.includes(GROUPS[c])) ?? null
}

const toolNeed = (t: AnyTool): Role => (WRITE_TOOLS.has(t.name) ? 'write' : 'read')

// ------------------------------------------------------------------ prompts

const PromptId = z.string().regex(PROMPT_ID, 'a prompt id such as specialist.verify.workflow')
const Scope = z.enum(['installation', 'project'])
const PromptRepo = z.object({ repo: RepoSlug.optional() })
const Scoped = z.object({ id: PromptId, scope: Scope, repo: RepoSlug.optional() })

/** Anyone in a class (guests too) may read the catalog and the installation's overrides; a repo needs read on it. */
async function mayReadPrompts(a: { repo?: string | undefined }, p: Principal): Promise<void> {
  if (a.repo) { await require_(p, a.repo, 'read'); return }
  if (classOf(p) === null) throw new AccessDenied(NO_ACCESS)
}

/** Installation scope: admins. Project scope: write on the repo (users assigned to it, and admins). */
async function mayWritePrompts(a: { scope: 'installation' | 'project'; repo?: string | undefined }, p: Principal): Promise<void> {
  if (a.scope === 'installation') { if (!isAdmin(p)) throw new AccessDenied('admins only: installation prompts'); return }
  if (!a.repo) throw new ActionError('scope project needs repo')
  await require_(p, a.repo, 'write')
}

/** History: no guests. Installation: a user or an admin; project: write on the repo. */
async function mayReadHistory(a: { scope: 'installation' | 'project'; repo?: string | undefined }, p: Principal): Promise<void> {
  if (a.scope === 'project') return mayWritePrompts(a, p)
  const cls = classOf(p)
  if (cls !== 'admin' && cls !== 'user') throw new AccessDenied(NO_ACCESS)
}

const installationPrompts = (ctx: Context): InstallationPrompts => ctx.deps.prompts?.() ?? new InstallationPrompts()

/** The overrides in force: the installation's, and with a repo its default branch's project.db. */
async function promptLayers(ctx: Context, repo: string | undefined): Promise<Layers> {
  const unavailable: { layer: 'installation' | 'project'; reason: string }[] = []
  const installation = await installationPrompts(ctx).overrides().catch((e: unknown) => { unavailable.push({ layer: 'installation', reason: errMsg(e) }); return undefined })
  const project = repo ? await withProjectDb(ctx, repo, (db) => projectOverrides(db)) : undefined
  return { ...(installation ? { installation } : {}), ...(project ? { project } : {}), ...(unavailable.length ? { unavailable } : {}) }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** The hash a person's prompt changes are recorded under (never their email). */
const promptBy = (p: Principal): string => telemetryHash(p.sub)

/** A checked write, as an ActionError when the text, the id or the reason is refused (it names the bad variable). */
function checked<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof TemplateError || e instanceof PromptError) throw new ActionError(e.message)
    if (e instanceof z.ZodError) throw new ActionError(e.issues.map((i) => i.message).join('; '))
    throw e
  }
}

/** One write to one layer: the installation's store, or a commit of the project's database on a branch of its own. */
async function writePrompt(ctx: Context, scope: 'installation' | 'project', repo: string | undefined, w: PromptWrite) {
  if (scope === 'installation') {
    try {
      const h = await installationPrompts(ctx).write(w)
      return { scope, id: w.id, version: h.version, uid: h.uid, action: h.action }
    } catch (e) {
      return checked(() => { throw e })
    }
  }
  const r = repo as string
  const gh = await ctx.deps.github()
  const { branch: base, sha } = await gh.defaultBranch(r)
  const blob = await gh.fileSha(r, PROJECT_DB_PATH, base)
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(r, PROJECT_DB_PATH, base))
  try {
    const h = checked(() => writeProject(w, t.root))
    const branch = `trace/prompts-${slugify(w.id)}-${Date.now().toString(36)}`
    if (branch === base) throw new ActionError('refusing to write the default branch')
    await gh.createBranch(r, branch, sha)
    const message = `prompts: ${w.op} ${w.id} (v${h.version})\n\n${h.reason ?? ''}\n\nRequested by ${ctx.principal.email ?? ctx.principal.sub} through the trace API.`
    const { commit } = await gh.putFile(r, { path: PROJECT_DB_PATH, branch, content: readFileSync(t.db), message, sha: blob })
    return { scope, repo: r, id: w.id, version: h.version, uid: h.uid, action: h.action, branch, commit, note: '.trace/** is a protected path: the pull request waits for a person to merge it.' }
  } finally {
    t.cleanup()
  }
}

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
      kind: 'task', repository: a.repo, request: a.request, requestedBy: ctx.principal.email ?? ctx.principal.sub, requestedBySub: ctx.principal.sub, ...(a.agent ? { agent: a.agent } : {}),
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

  'kb.search': def('read', Repo.extend({
    query: z.string().min(1).max(1000), top_k: z.number().int().min(1).max(50).default(8), filter: FilterSchema.optional(),
  }), async (a, ctx) => {
    const id = projectKb(ctx, a.repo)
    if (!id) return { repo: a.repo, enabled: false, results: [] }
    if (!ctx.deps.retrieve) throw new ActionError('this installation does not search knowledge bases from the API')
    const r = await searchKb(await ctx.deps.retrieve(), id, { query: a.query, top_k: a.top_k, ...(a.filter ? { filter: a.filter } : {}) })
    return { repo: a.repo, enabled: true, ...r }
  }),

  // the project's own worker runtime does it, on its clone of the default branch, with its own role
  // the wait is short: the API waits for the worker's answer in one InvokeAgentRuntime call, and the ingestion job
  // carries on after it (its status is in the answer, and in kb.status)
  'kb.sync': def('write', Repo.extend({ force: z.boolean().default(false), wait_minutes: z.number().min(0).max(10).default(5) }), async (a, ctx) => {
    if (!projectKb(ctx, a.repo)) throw new ActionError('this installation has no knowledge bases')
    const jobs = await ctx.deps.jobs()
    if (!jobs.runTool) throw new ActionError('the knowledge base syncs on the project\'s worker runtime, and this installation has none for the API')
    return jobs.runTool({ kind: 'tool', repository: a.repo, name: 'kb.sync', args: { force: a.force, wait_minutes: a.wait_minutes } })
  }),

  job: def('job', JobId.extend({ afterVersion: z.number().int().min(0).optional(), waitS: z.number().min(0).max(240).optional() }), async (a, ctx) => {
    const jobs = await jobAccess(a.id, ctx)
    if (!jobs.watchJob) return withControls(ownJob((await jobs.jobStatus(a.id))[0], a.id, jobs), jobs)
    const w = await jobs.watchJob(a.id, { afterVersion: a.afterVersion, waitS: a.waitS, signal: ctx.signal })
    return { ...withControls(ownJob(w.jobs[0], a.id, jobs), jobs), version: w.version, waits: w.waits }
  }),

  'job.check_now': def('job', JobId.extend({ waitId: z.string().min(1).max(64) }), async (a, ctx) => {
    const jobs = await jobAccess(a.id, ctx)
    return { ok: jobs.checkNow ? await jobs.checkNow(a.id, a.waitId) : false }
  }),

  'tools.waits': def('read', Repo.extend({ afterVersion: z.number().int().min(0).optional(), waitS: z.number().min(0).max(240).optional() }), async (a, ctx) => {
    const jobs = await ctx.deps.jobs()
    if (!jobs.watchTools) return { repo: a.repo, version: null, waits: [] }
    return { repo: a.repo, ...(await jobs.watchTools(a.repo, { afterVersion: a.afterVersion, waitS: a.waitS, signal: ctx.signal })) }
  }),

  'tools.check_now': def('read', Repo.extend({ waitId: z.string().min(1).max(64) }), async (a, ctx) => {
    const jobs = await ctx.deps.jobs()
    return { ok: jobs.checkToolWait ? await jobs.checkToolWait(a.repo, a.waitId) : false }
  }),

  'users.list': def('admin', z.object({}), async (_a, ctx) => {
    const cog = ctx.deps.cognito()
    const [users, ...members] = await Promise.all([cog.listUsers(), ...CLASSES.map((c) => cog.usersInGroup(GROUPS[c]))])
    const classes = new Map<string, PersonClass>()
    CLASSES.forEach((c, i) => { for (const u of members[i] ?? []) if (!classes.has(u.sub)) classes.set(u.sub, c) })
    const [all, seen] = await Promise.all([assignments(ctx.principal), lastSeen(ctx.principal)])
    return users.map((u) => {
      const cls = classes.get(u.sub) ?? null
      const mine = all.filter((x) => x.sub === u.sub)
      return {
        email: u.email, sub: u.sub, status: u.status, enabled: u.enabled, class: cls,
        // when they last used trace (the access store), and their name when Cognito has one
        last_seen: seen.get(u.sub) ?? null, ...(u.name ? { name: u.name } : {}),
        projects: mine.map((x) => x.repo),
        // each project with the person's part there; a guest is a reviewer whatever was stored (their class caps it)
        parts: mine.map((x) => ({ repo: x.repo, part: cls === 'guest' ? 'reviewer' as const : x.part })),
      }
    }).sort((x, y) => (x.email ?? x.sub).localeCompare(y.email ?? y.sub))
  }),

  'users.invite': def('admin', z.object({ email: z.string().email(), class: Cls.default('user') }), async (a, ctx) => {
    const cog = ctx.deps.cognito()
    if (await cog.find(a.email)) throw new ActionError(`${a.email} already has an account; use users.class to change their class`)
    const u = await cog.createUser(a.email)
    await cog.addToGroup(u.username, GROUPS[a.class])
    await setClass(ctx.principal, { sub: u.sub, email: a.email }, a.class)
    return { sub: u.sub, email: a.email, class: a.class, note: 'Cognito has emailed them a temporary password (valid 7 days); they accept at the web app\'s /invite page, or with `trace login`.' }
  }),

  'users.class': def('admin', z.object({ who: Who, class: Cls }), async (a, ctx) => {
    const cog = ctx.deps.cognito()
    const u = await person(ctx, a.who)
    const now = await cog.groupsFor(u.username)
    const want = GROUPS[a.class]
    if (!now.includes(want)) await cog.addToGroup(u.username, want)
    for (const c of CLASSES) if (GROUPS[c] !== want && now.includes(GROUPS[c])) await cog.removeFromGroup(u.username, GROUPS[c])
    await setClass(ctx.principal, { sub: u.sub, email: u.email }, a.class)
    // a changed class must not ride on a session that carries the old one: their refresh tokens go
    const changed = !(now.length === 1 && now[0] === want)
    const signedOut = changed ? await signOutQuietly(ctx, u) : false
    return { sub: u.sub, email: u.email, class: a.class, signed_out: signedOut, note: signedOut ? 'They were signed out everywhere; the new class applies when they sign in again (an access token already issued lasts at most an hour).' : 'Takes effect when their access token next refreshes (within an hour).' }
  }),

  assign: def('admin', z.object({ who: Who, repo: RepoSlug, part: z.enum(PARTS).optional() }), async (a, ctx) => {
    const u = await person(ctx, a.who)
    const cls = await classNow(ctx, u)
    try {
      return await assign(ctx.principal, { sub: u.sub, email: u.email }, a.repo, { part: a.part, class: cls })
    } catch (e) {
      throw e instanceof PartRefused ? new ActionError(e.message) : e
    }
  }),

  unassign: def('admin', z.object({ who: Who, repo: RepoSlug }), async (a, ctx) => {
    const u = await person(ctx, a.who)
    const removed = await unassign(ctx.principal, u.sub, a.repo)
    // removed from their last project (and not an admin): nothing is left to sign in for, so their sessions end
    const left = removed ? (await assignments(ctx.principal, { sub: u.sub })).length : 1
    const signedOut = removed && left === 0 && (await classNow(ctx, u)) !== 'admin' ? await signOutQuietly(ctx, u) : false
    return { sub: u.sub, email: u.email, repo: a.repo, removed, signed_out: signedOut }
  }),

  assignments: def('admin', z.object({ repo: RepoSlug.optional() }), async (a, ctx) => assignments(ctx.principal, a.repo ? { repo: a.repo } : {})),

  // the installation's optional integrations (src/core/integrations.ts): admins set and remove them; their values are
  // never read back through the API (this runtime's role may write them, not read them)
  'integrations.list': def('admin', z.object({}), async (_a, ctx) => (await integrationStore(ctx)).list()),
  'integrations.set': def('admin', z.object({ name: IntegrationNameSchema, values: z.record(z.string(), z.string().max(4096)) }), async (a, ctx) => {
    const values = valuesFor(a.name, a.values)
    const check = await (ctx.deps.checkIntegration ?? checkIntegration)(a.name, values)
    const secret = await (await integrationStore(ctx)).set(a.name, values)
    return { name: a.name, secret, check, note: 'Workers read it when they next start (a new session); the library gateway on its next cold start.' }
  }),
  'integrations.remove': def('admin', z.object({ name: IntegrationNameSchema }), async (a, ctx) => ({ name: a.name, removed: await (await integrationStore(ctx)).remove(a.name) })),

  'prompts.list': def('prompts', PromptRepo, async (a, ctx) => ({ ...(a.repo ? { repo: a.repo } : {}), ...listView(await promptLayers(ctx, a.repo)) }), mayReadPrompts),

  'prompts.get': def('prompts', PromptRepo.extend({ id: PromptId }), async (a, ctx) => {
    checked(() => entry(a.id))
    return { ...(a.repo ? { repo: a.repo } : {}), ...getView(a.id, await promptLayers(ctx, a.repo)) }
  }, mayReadPrompts),

  'prompts.preview': def('read', Repo.extend({ target: PreviewTarget, job: PreviewJob.optional() }), async (a, ctx) => {
    const layers = await promptLayers(ctx, a.repo)
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(a.repo)
    const rulesBytes = await gh.rawFile(a.repo, '.trace/rules.md', branch)
    const cfg = await withProjectDb(ctx, a.repo, (db) => resolve(readSettings(db)).config)
    const p = checked(() => preview({ target: a.target, cfg, repository: a.repo, rules: rulesBytes ? Buffer.from(rulesBytes).toString('utf8') : null, layers, job: a.job }))
    return {
      repo: a.repo, prompt: p.prompt, ...(p.kind ? { kind: p.kind } : {}), text: p.composed.text, marked: p.marked,
      parts: p.composed.parts.map(({ text: _t, ...x }) => x), unavailable: layers.unavailable,
    }
  }),

  'prompts.set': def('prompts', Scoped.extend({ text: z.string().min(1).max(MAX_PROMPT_CHARS), reason: PromptReason }), async (a, ctx) =>
    writePrompt(ctx, a.scope, a.repo, { op: 'set', id: a.id, text: a.text, reason: a.reason, by: promptBy(ctx.principal) }), mayWritePrompts),

  'prompts.reset': def('prompts', Scoped.extend({ reason: PromptReason.default('reset to the layer below') }), async (a, ctx) =>
    writePrompt(ctx, a.scope, a.repo, { op: 'reset', id: a.id, reason: a.reason, by: promptBy(ctx.principal) }), mayWritePrompts),

  'prompts.revert': def('prompts', Scoped.extend({ version: z.union([z.number().int().positive(), z.string().min(1).max(40)]), reason: PromptReason.optional() }), async (a, ctx) =>
    writePrompt(ctx, a.scope, a.repo, { op: 'revert', id: a.id, to: a.version, reason: a.reason, by: promptBy(ctx.principal) }), mayWritePrompts),

  'prompts.history': def('prompts', Scoped, async (a, ctx) => {
    const history = a.scope === 'installation'
      ? await installationPrompts(ctx).history(a.id)
      : await withProjectDb(ctx, a.repo as string, (db) => projectHistory(db, a.id))
    return { id: a.id, scope: a.scope, ...(a.repo && a.scope === 'project' ? { repo: a.repo } : {}), history: history.map((h) => ({ ...h, at: new Date(h.at * 1000).toISOString() })) }
  }, mayReadHistory),

  ...PROJECT_ACTIONS,
  ...JOURNEY_ACTIONS,
  ...CHAT_ACTIONS,
  ...ME_ACTIONS,
  ...GRAPH_ACTIONS,
  ...FILE_ACTIONS,
  ...JOB_ACTIONS,
  ...PEOPLE_ACTIONS,
  ...RECORD_ACTIONS,
  ...SKILL_ACTIONS,
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
    case 'prompts': if (!action.authorize) throw new AccessDenied(NO_ACCESS); await action.authorize(args, p); break
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
