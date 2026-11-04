/**
 * Pausing and retiring a project (src/core/lifecycle.ts), and the one check every action passes through
 * (`lifecycleGate`, called by perform in src/api/actions.ts).
 *
 *   project.lifecycle   read     whether it is paused (and, for admins, retired), with its recent history
 *   project.pause       write    hold it as it is: nothing changes and no work starts until someone resumes it
 *   project.resume      write    let it carry on
 *   project.retire      admin    "delete" it: it leaves every list and view, and only an admin can bring it back
 *   project.restore     admin    bring a retired project back, as it was (paused again if it was paused)
 *   projects.retired    admin    the retired projects, newest first, with their names
 *
 * Each change also goes into the project's decisions log, so it shows on its Decisions timeline (and its journey
 * record changes, which wakes any queued job to look again).
 */
import { z } from 'zod'
import { AccessDenied, type Principal, isAdmin } from '../core/access.js'
import { decide, loadJourney } from '../core/journey.js'
import { type Lifecycle, type LifecycleChange, LifecycleError, changeLifecycle, held, lifecycleHistory, lifecycleOf, retiredProjects } from '../core/lifecycle.js'
import { ActionError, type Context, NO_ACCESS, type Need, Repo, def, label, toolNeed, withJourneyDb, writeJourney } from './action-kit.js'
import { listJobs } from './actions-jobs.js'
import { heldWords } from './held.js'

export { assertNotHeld, heldWords } from './held.js'

const Reason = z.object({ reason: z.string().trim().max(300).optional() })

/** The actions that manage the lifecycle itself: always allowed through the gate (their own rules apply). */
export const LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set(['project.lifecycle', 'project.pause', 'project.resume', 'project.retire', 'project.restore'])

/**
 * Actions that change a project or start work on it although their need is not 'write' (reads that save, admin
 * actions on one project, the web backend's merges and conflict fixes, and waking a wait). With every 'write' action
 * and every tool that changes things, these are refused while a project is paused or retired.
 */
export const CHANGES_THOUGH_NOT_WRITE: ReadonlySet<string> = new Set([
  'journey.criterion.open', 'memory.deactivate', 'memory.reactivate', 'order.check_now', 'tools.check_now', 'job.check_now',
  'gate.sign', 'journey.snapshot', 'project.update', 'repo.rules.fix', 'prompts.set', 'prompts.reset', 'prompts.revert',
  'hook.apply', 'hook.conflicts', 'hook.docs',
])

/** Whether the action, with these arguments, changes the project or starts work on it. */
export function changesProject(name: string, need: Need, args: Record<string, unknown>, ctx: Context): boolean {
  if (LIFECYCLE_ACTIONS.has(name)) return false
  if (need === 'write') return true
  if (CHANGES_THOUGH_NOT_WRITE.has(name)) return true
  if (need === 'tool') {
    const t = ctx.deps.tools().get(String(args.name))
    return !t || toolNeed(t) === 'write'
  }
  return false
}

/**
 * The lifecycle check, after the access check: a retired project is "no access" to anyone but an admin; a paused or
 * retired one refuses whatever would change it or start work on it. Reads, chats and the lifecycle actions pass.
 */
export async function lifecycleGate(name: string, need: Need, args: Record<string, unknown>, ctx: Context, repo: string | null): Promise<void> {
  if (!repo) return
  const l = await lifecycleOf(repo)
  if (!held(l)) return
  if (l.retired && !isAdmin(ctx.principal) && need !== 'backend') throw new AccessDenied(NO_ACCESS)
  if (changesProject(name, need, args, ctx)) throw new ActionError(heldWords(l))
}

const WORDS: Record<LifecycleChange, string> = { paused: 'paused the project', resumed: 'resumed the project', retired: 'retired the project', restored: 'restored the project' }

/** The change in the project's decisions log; a project with no journey yet has none, and that is fine. */
async function record(ctx: Context, repo: string, change: LifecycleChange, by: string, reason: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await writeJourney(ctx, repo, (db) => {
      if (!loadJourney(db)) return { result: null, changed: false }
      const s = `${by} ${WORDS[change]}${reason ? `: ${reason}` : ''}.`
      decide(db, { kind: `project.${change}`, stage: null, ref: null, by, summary: s.charAt(0).toUpperCase() + s.slice(1), detail: { reason, ...detail } })
      return { result: null }
    })
  } catch (e) {
    ctx.deps.log?.({ at: new Date().toISOString(), lifecycle: change, repo, record: 'not written', error: e instanceof Error ? e.message : String(e) })
  }
}

/** Ask the project's running tasks to stop at their next safe point (they can be resumed one by one later). */
async function pauseRunning(ctx: Context, repo: string, by: string): Promise<{ asked: number; running: number }> {
  try {
    const jobs = await ctx.deps.jobs()
    const { jobs: views } = await listJobs(ctx, repo)
    const running = views.filter((j) => j.state === 'running')
    if (!jobs.pause) return { asked: 0, running: running.length }
    let asked = 0
    for (const j of running.filter((v) => v.kind === 'task')) {
      const r = await jobs.pause(j.id, by).catch(() => null)
      if (r?.ok) asked++
    }
    return { asked, running: running.length }
  } catch {
    return { asked: 0, running: 0 }
  }
}

const plain = async (fn: () => Promise<Lifecycle>): Promise<Lifecycle> => {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof LifecycleError) throw new ActionError(e.message)
    throw e
  }
}

/** What a person sees of a project's lifecycle (retired only for admins: anyone else cannot reach a retired one). */
const view = (repo: string, l: Lifecycle, p: Principal) => ({ repo, paused: l.paused, retired: isAdmin(p) ? l.retired : null })

const workWords = (w: { asked: number; running: number }): string =>
  w.running === 0 ? 'Nothing was running.'
    : w.asked === w.running ? `${w.asked === 1 ? 'The running task was' : `${w.asked} running tasks were`} asked to pause at their next safe point.`
      : `${w.running} ${w.running === 1 ? 'job was' : 'jobs were'} running: ${w.asked ? `${w.asked} asked to pause; ` : ''}the rest finish the step they are on and nothing new starts.`

export const LIFECYCLE_ACTIONS_DEFS = {
  'project.lifecycle': def('read', Repo, async ({ repo }, ctx) => {
    const l = await lifecycleOf(repo)
    return { ...view(repo, l, ctx.principal), history: await lifecycleHistory(repo, 20) }
  }),

  'project.pause': def('write', Repo.merge(Reason), async ({ repo, reason }, ctx) => {
    const by = label(ctx.principal)
    const l = await plain(() => changeLifecycle(repo, 'paused', by, reason ?? null))
    const work = await pauseRunning(ctx, repo, by)
    await record(ctx, repo, 'paused', by, reason ?? null, { work })
    return { ...view(repo, l, ctx.principal), work, summary: `Paused. ${workWords(work)}` }
  }),

  'project.resume': def('write', Repo, async ({ repo }, ctx) => {
    const by = label(ctx.principal)
    const l = await plain(() => changeLifecycle(repo, 'resumed', by))
    await record(ctx, repo, 'resumed', by, null)
    return { ...view(repo, l, ctx.principal), summary: l.retired ? 'Resumed, but it is still retired: it does no work until an admin restores it.' : 'Resumed: queued work starts at its turn. Paused tasks stay paused until someone resumes each one.' }
  }),

  'project.retire': def('admin', Repo.merge(Reason), async ({ repo, reason }, ctx) => {
    const by = label(ctx.principal)
    const l = await plain(() => changeLifecycle(repo, 'retired', by, reason ?? null))
    const work = await pauseRunning(ctx, repo, by)
    await record(ctx, repo, 'retired', by, reason ?? null, { work })
    return { ...view(repo, l, ctx.principal), work, summary: `Retired: it is hidden from everyone, and kept, so an admin can restore it. ${workWords(work)}` }
  }),

  'project.restore': def('admin', Repo, async ({ repo }, ctx) => {
    const by = label(ctx.principal)
    const l = await plain(() => changeLifecycle(repo, 'restored', by))
    await record(ctx, repo, 'restored', by, null)
    return { ...view(repo, l, ctx.principal), summary: l.paused ? `Restored. It is still paused (by ${l.paused.by}): resume it when it should carry on.` : 'Restored: it is back in everyone\'s lists, as it was.' }
  }),

  'projects.retired': def('admin', z.object({}), async (_a, ctx) => {
    const list = await retiredProjects()
    const named = await Promise.all(list.map(async (r) => {
      const j = await withJourneyDb(ctx, r.repo, (db) => loadJourney(db)?.journey ?? null).catch(() => null)
      return { ...r, name: j?.name ?? null, icon: j?.icon ?? null, description: j?.description ?? null }
    }))
    return { projects: named }
  }),
}
