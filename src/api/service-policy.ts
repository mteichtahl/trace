/**
 * What a connected system may do at all (docs/external-access.md "What a system may do"), before the access check that
 * applies to everyone (its part on the project).
 *
 * An allow-list, so it fails closed: an action added to the API later is refused to every system until it is named
 * here. Each entry names the scope it needs; `tool` depends on the tool (read for the read-only tools, write for
 * WRITE_TOOLS, as for a person). The scope is checked first, then the project part (perform's own check), so a system
 * with the write scope that is a reviewer on a project still only reads there.
 *
 * Never, whatever the scope: anything that needs an admin; signing or returning gates; answering questions; waivers;
 * design decisions; orders; chats; preferences and me.*; memory; prompts; skills; people and assignments; voice; the
 * inbox. These are a person's (docs/user-journey.md: gates are signed by a person; trace prepares orders and a person
 * submits them).
 *
 * job.control is a system's own jobs only: the job's recorded requester must be the system (its sub), and it needs
 * write on the job's project. Refusals are AccessDenied, answered "no access" like a project that isn't yours.
 *
 * task: a system has at most MAX_SYSTEM_TASKS tasks queued or running on one project (taskCap, after the access check),
 * so one system cannot fill a project's queue and keep the people's work waiting.
 *
 * tool: the tools of the shared datasheet library and the parts search (SHARED_TOOL_PREFIXES: parts.*, datasheets.*)
 * are a person's, never a system's: they read and write the library every project shares, and the parts search spends
 * the installation's paid distributor quota. tools.list leaves them out for a system, and the MCP endpoint never
 * offers them.
 */
import { AccessDenied, type Principal, type ServiceScope, isService, require_ } from '../core/access.js'
import { isLive, loadJobs } from '../core/job-index.js'
import { ActionError, type Context, NO_ACCESS, toolNeed } from './action-kit.js'
import { jobIndex, listJobs } from './actions-jobs.js'

/** The tools a system never runs (see the module comment): the shared library's and the paid parts search. */
export const SHARED_TOOL_PREFIXES = ['parts.', 'datasheets.'] as const
/** Whether a connected system may run this tool at all. */
export const toolOpenToSystems = (name: string): boolean => !SHARED_TOOL_PREFIXES.some((p) => name.startsWith(p))

/** The most tasks one system may have queued or running on one project. */
export const MAX_SYSTEM_TASKS = 3

/** The actions a connected system may call, with the scope each needs ('tool': by the tool). */
export const SERVICE_ACTIONS: Readonly<Record<string, ServiceScope | 'tool'>> = {
  whoami: 'read',
  projects: 'read',
  'installation.layout': 'read',
  status: 'read',
  'settings.get': 'read',
  runs: 'read',
  run: 'read',
  artifact: 'read',
  'jobs.list': 'read',
  job: 'read',
  'journey.get': 'read',
  'requirements.trace': 'read',
  'design.get': 'read',
  'build.get': 'read',
  'cost.get': 'read',
  'files.list': 'read',
  'files.url': 'read',
  'graph.neighbourhood': 'read',
  'kb.search': 'read',
  'tools.list': 'read',
  'tools.waits': 'read',
  tool: 'tool',
  task: 'write',
  'job.control': 'write',
  'settings.set': 'write',
  'kb.sync': 'write',
}

/** The scope `action` needs from a system with these arguments, or null when no system may call it. */
export function serviceNeed(action: string, args: Record<string, unknown>, ctx: Pick<Context, 'deps'>): ServiceScope | null {
  if (!Object.hasOwn(SERVICE_ACTIONS, action)) return null
  const need = SERVICE_ACTIONS[action]
  if (need !== 'tool') return need ?? null
  if (!toolOpenToSystems(String(args.name))) return null
  const t = ctx.deps.tools().get(String(args.name))
  return t ? toolNeed(t) : 'read'
}

/** Whether a system holding these scopes is offered `action` at all (the MCP endpoint's list; `tool` needs read). */
export function offeredTo(action: string, scopes: readonly ServiceScope[]): boolean {
  const need = SERVICE_ACTIONS[action]
  if (need === undefined) return false
  return scopes.includes(need === 'tool' ? 'read' : need)
}

/**
 * Throws AccessDenied unless the connected system `p` may call `action` with these (parsed) arguments. A person passes
 * through untouched. Runs in perform after the arguments parse and before its own access check.
 */
export async function checkService(p: Principal, action: string, args: Record<string, unknown>, ctx: Context): Promise<void> {
  if (!isService(p)) return
  const need = serviceNeed(action, args, ctx)
  if (need === null) throw new AccessDenied(action === 'tool' ? `the tool ${String(args.name)} is not open to connected systems` : `${action} is not open to connected systems`)
  if (!(p.scopes ?? []).includes(need)) throw new AccessDenied(`${action} needs the ${need} scope`)
  if (action === 'job.control') await ownJob(p, String(args.id), ctx)
}

/** job.control by a system: write on the job's project, and the job must be one the system started. */
async function ownJob(p: Principal, id: string, ctx: Context): Promise<void> {
  const jobs = await ctx.deps.jobs()
  const repo = jobs.repositoryOf(id)
  if (!repo) throw new AccessDenied(NO_ACCESS)
  await require_(p, repo, 'write')
  const { jobs: views } = await listJobs(ctx, repo)
  const view = views.find((j) => j.id === id || j.workerJobId === id.split('.').at(-1))
  if (!view?.yours) throw new AccessDenied('a connected system controls only the jobs it started')
}

/**
 * task by a system: refused (an ActionError, in words) when it already has MAX_SYSTEM_TASKS tasks queued or running on
 * `repo`, by the project's job index. A running job whose heartbeat stopped (its microVM ended without a word) is not
 * counted, so a lost job never blocks a system for good. Runs after the access check, so a project the system is not
 * on still answers "no access".
 */
export async function taskCap(p: Principal, repo: string, ctx: Context, at: number = Date.now() / 1000): Promise<void> {
  if (!isService(p)) return
  const { result: rows } = await jobIndex(ctx, repo).read((db) => loadJobs(db))
  const mine = rows.filter((j) => j.kind === 'task' && j.requestedBySub === p.sub && (j.state === 'queued' || isLive(j, at)))
  if (mine.length >= MAX_SYSTEM_TASKS) {
    throw new ActionError(`This system already has ${mine.length} tasks running on ${repo}. Wait for one to finish.`)
  }
}
