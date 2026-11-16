/**
 * Moving a project between GitHub and trace's GitLab, from the web app (docs/gitlab-projects.md "Moving a project";
 * the record: src/core/forge-move-record.ts).
 *
 *   project.move          admin   ask for the move: to `github` or `gitlab`, `when` idle (once running work finishes)
 *                                 or now (running tasks are asked to pause first). The project is paused, so nothing
 *                                 starts while it moves, the request is recorded for the installation's update, and
 *                                 the update is started (as projects.create starts it). Refused when the project is
 *                                 there already, when another move of it is going, and when this installation has no
 *                                 GitLab
 *   project.move_status   read    the latest move of the project (any state), or null; the page's progress view polls
 *                                 it, and the bucket's write of the record is a live event too. Looking also moves the
 *                                 move on: a move waiting for the project to be idle is marked idle once nothing of it
 *                                 runs (and the update is started again for it), and a project paused for a move that
 *                                 is done is resumed
 *   project.move_cancel   admin   take back a move the update has not started, or set aside one that failed (its old
 *                                 home is as it was); the project is resumed when it was paused for the move
 */
import { z } from 'zod'
import { Conflict } from '../core/central.js'
import { type ForgeName, FORGES, type MoveRecord, MoveRecordSchema, forgeLabel, inFlight, isMovePause, moveKey, movePauseReason } from '../core/forge-move-record.js'
import { listJobs } from './actions-jobs.js'
import { LifecycleError, changeLifecycle, lifecycleOf } from '../core/lifecycle.js'
import { ActionError, type Context, Repo, def, label, storeAt } from './action-kit.js'
import { PENDING_PREFIX, startUpdate } from './actions-projects.js'
import { pauseRunning, recordLifecycle } from './actions-lifecycle.js'
import { gitlabRepos } from './forge.js'

/** Where the project lives now, by this runtime's settings (TRACE_GITLAB_REPOS: the projects on trace's GitLab). */
export const forgeOf = (repo: string, env: NodeJS.ProcessEnv = process.env): ForgeName => (gitlabRepos(env.TRACE_GITLAB_REPOS).has(repo.toLowerCase()) ? 'gitlab' : 'github')

/** Whether this installation has trace's GitLab (its address is set once it is deployed). */
export const hasGitlab = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.TRACE_GITLAB_URL?.trim())

async function readMove(ctx: Context, repo: string): Promise<{ record: MoveRecord; etag: string } | null> {
  const got = await storeAt(ctx, PENDING_PREFIX).get(moveKey(repo))
  if (!got) return null
  const ok = MoveRecordSchema.safeParse(JSON.parse(new TextDecoder().decode(got.body)) as unknown)
  return ok.success ? { record: ok.data, etag: got.etag } : null
}

async function writeMove(ctx: Context, record: MoveRecord, etag: string | null): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(record, null, 2))
  try {
    await storeAt(ctx, PENDING_PREFIX).put(moveKey(record.repo), bytes, { ...(etag === null ? { ifNoneMatch: true } : { ifMatch: etag }), contentType: 'application/json' })
  } catch (e) {
    if (e instanceof Conflict) throw new ActionError('The move was changed by someone else at the same moment: look again and retry.')
    throw e
  }
}

/** Whether any work of the project is running (a move `when: idle` waits for none); unknown counts as running. */
async function running(ctx: Context, repo: string): Promise<boolean> {
  try { return (await listJobs(ctx, repo)).jobs.some((j) => j.state === 'running') } catch { return true }
}

/** Resume the project when it was paused for the move and is still paused for it. */
async function resumeAfter(ctx: Context, r: MoveRecord, by: string): Promise<boolean> {
  if (!r.paused_for_move) return false
  const l = await lifecycleOf(r.repo)
  if (!l.paused || l.paused.reason !== movePauseReason(r.to)) return false
  await changeLifecycle(r.repo, 'resumed', by)
  await recordLifecycle(ctx, r.repo, 'resumed', by, null)
  return true
}

/**
 * The projects a person lists, with any held only by a move that is done resumed first: a move ends in the installation's
 * update, which cannot change the project's lifecycle, so the project is resumed the next time anyone's app lists its
 * projects or looks at the move (project.move_status), not only when the page that asked for it is open. Only projects
 * paused for a move are read; anything that cannot be read is left as it is.
 */
export async function settleMoves<P extends { repo: string; paused?: { reason: string | null } | null | undefined }>(ctx: Context, projects: P[]): Promise<P[]> {
  const held = projects.filter((p) => isMovePause(p.paused?.reason))
  if (!held.length) return projects
  const resumed = new Set<string>()
  for (const p of held) {
    try {
      const had = await readMove(ctx, p.repo)
      if (had?.record.status === 'moved' && await resumeAfter(ctx, had.record, 'trace')) resumed.add(p.repo)
    } catch { /* looked at again next time */ }
  }
  return resumed.size ? projects.map((p) => (resumed.has(p.repo) ? (({ paused: _p, ...rest }) => rest as P)(p) : p)) : projects
}

const Move = Repo.extend({ to: z.enum(FORGES), when: z.enum(['idle', 'now']).default('idle') })

export const MOVE_ACTIONS = {
  'project.move': def('admin', Move, async ({ repo, to, when }, ctx) => {
    const slug = repo.toLowerCase()
    if (!hasGitlab()) throw new ActionError("This installation has no GitLab yet: an admin turns it on in the installer (Optional › trace's GitLab).")
    const from = forgeOf(slug)
    if (from === to) throw new ActionError(`It is on ${forgeLabel(to)} already.`)
    const had = await readMove(ctx, slug)
    if (had && inFlight(had.record)) throw new ActionError(`A move to ${forgeLabel(had.record.to)} is ${had.record.status === 'moving' ? 'under way' : 'waiting'} already.`)
    const by = label(ctx.principal)
    const l = await lifecycleOf(slug)
    if (l.retired) throw new ActionError('It is retired: restore it before moving it.')
    // paused already by someone: it stays as they left it, and the move does not resume it
    const pausedForMove = !l.paused
    let work = { asked: 0, running: 0 }
    if (pausedForMove) {
      try { await changeLifecycle(slug, 'paused', by, movePauseReason(to)) } catch (e) { if (!(e instanceof LifecycleError)) throw e }
      await recordLifecycle(ctx, slug, 'paused', by, movePauseReason(to), { move: { from, to, when } })
    }
    if (when === 'now') work = await pauseRunning(ctx, slug, by)
    const idle = when === 'idle' && !(await running(ctx, slug))
    const record: MoveRecord = MoveRecordSchema.parse({
      repo: slug, from, to, when, requested_by: by, requested_at: new Date().toISOString(), status: 'waiting', paused_for_move: pausedForMove,
      ...(idle ? { idle_at: new Date().toISOString() } : {}),
    })
    await writeMove(ctx, record, had?.etag ?? null)
    const update = await startUpdate(await ctx.deps.github())
    const first = when === 'now'
      ? (work.running ? `Running work was asked to pause (${work.asked} of ${work.running}). ` : '')
      : idle ? '' : 'It starts once the work running now has finished. '
    return {
      move: record,
      started: update.started,
      summary: `Moving to ${forgeLabel(to)}. The project is paused meanwhile. ${first}${update.started ? 'trace is updating itself to make the move; this page shows each step.' : update.text}`,
    }
  }),

  'project.move_status': def('read', Repo, async ({ repo }, ctx) => {
    const slug = repo.toLowerCase()
    let had = await readMove(ctx, slug)
    let resumed = false
    if (had && had.record.status === 'waiting' && had.record.when === 'idle' && !had.record.idle_at && !(await running(ctx, slug))) {
      // nothing of it runs any more: the update may take it now
      const record: MoveRecord = { ...had.record, idle_at: new Date().toISOString() }
      try {
        await writeMove(ctx, record, had.etag)
        had = { record, etag: had.etag }
        await startUpdate(await ctx.deps.github())
      } catch { /* someone else marked it at the same moment */ }
    }
    if (had && had.record.status === 'moved') resumed = await resumeAfter(ctx, had.record, 'trace').catch(() => false)
    return { move: had?.record ?? null, forge: forgeOf(slug), gitlab: hasGitlab(), resumed }
  }),

  'project.move_cancel': def('admin', Repo, async ({ repo }, ctx) => {
    const had = await readMove(ctx, repo.toLowerCase())
    if (!had || (had.record.status !== 'waiting' && had.record.status !== 'failed')) {
      throw new ActionError(had?.record.status === 'moving' ? 'The move is under way: it cannot be taken back now. Once it is done, it can be moved back.' : 'There is no move to cancel.')
    }
    const by = label(ctx.principal)
    const record: MoveRecord = { ...had.record, status: 'cancelled', finished_at: new Date().toISOString() }
    await writeMove(ctx, record, had.etag)
    const resumed = await resumeAfter(ctx, had.record, by)
    return { move: record, summary: `The move was ${had.record.status === 'failed' ? 'set aside' : 'cancelled'}: the project stays on ${forgeLabel(had.record.from)}.${resumed ? ' It is resumed.' : ''}` }
  }),
}
