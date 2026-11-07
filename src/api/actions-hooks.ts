/**
 * What the web backend asks when GitHub says something moved (docs/guided-flow.md "Live updates", src/web/hooks.ts).
 *
 *   hook.members   backend   { repo } → { repo, project, subs }: whether the repository is one of this installation's
 *                            projects (the central registry), and when it is, the Cognito subs of everyone who should
 *                            hear about it: the people assigned to it (any part) and every admin. Subs only, never an
 *                            email, a name or a part: a live event says "look again", and the app asks the API as
 *                            the person, who then sees only what they may
 *
 *   hook.apply     backend   { repo } → { repo, applied }: apply the people's app edits of the project that are ready
 *                            (src/api/apply-edits.ts, docs/stay-in-trace.md "Applying"). The hooks function calls it for
 *                            every accepted delivery of a project, once per debounce window: a check finishing or a pull
 *                            request moving is when an edit may become ready, or need making again. It answers what it
 *                            did, branch and number only
 *
 *   hook.conflicts backend   { repo } → ConflictReport (numbers only): a push to the project's default branch, the moment
 *                            other changes can fall into conflict. Finds them once GitHub has settled, makes trace's
 *                            own edits again and starts the worker for the rest (src/api/conflicts.ts). The hooks
 *                            function tells the people on the project which ones, as a live event
 *
 *   hook.docs      backend   { repo } → what it did: a push to the project's default branch. When the commit changed a record
 *                            a document is written from, Scribe brings the documents up to date (src/api/docs-follow.ts);
 *                            a commit of only the documents, or only Scribe's own runs, starts nothing, and while the
 *                            stage still has design work to land the documents wait for it (`waiting` says what)
 *
 *   hook.projects  backend   {} → { projects }: the projects the nightly drift check goes through (not paused, not
 *                            retired), repository names only
 *
 *   hook.drift     backend   { repo } → what it found: the nightly drift check of one project (src/api/docs-follow.ts
 *                            driftOf): the records changed since the documents were last written, a document the stage
 *                            needs that is missing, and whether Scribe was started on them
 *
 * Only the web backend's own identity reaches it (need 'backend', src/api/backend-auth.ts), and that identity reaches
 * nothing else (perform). The API runtime still decides who is on a project, as it does for project.members; the
 * backend still never reads the access store.
 */
import { GROUPS, RepoSlug, membersOf } from '../core/access.js'
import { projects } from '../core/onboard.js'
import { lifecycleOf } from '../core/lifecycle.js'
import { z } from 'zod'
import { def } from './action-kit.js'
import { applyEdits } from './apply-edits.js'
import { type ConflictReport, resolveConflicts } from './conflicts.js'
import { docsOwed, driftOf, recordNow, recordsOfCommit, startStageScribe } from './docs-follow.js'
import { STAGE_NAMES } from '../core/journey-catalog.js'
import { startFollowOn } from './actions-journey.js'
import { journeyStore } from './action-kit.js'
import { loadJourney } from '../core/journey.js'

export interface HookMembers { repo: string; project: boolean; subs: string[] }

export const HOOK_ACTIONS = {
  'hook.members': def('backend', z.object({ repo: RepoSlug }), async ({ repo }, ctx): Promise<HookMembers> => {
    // not a project: nobody is told, and nothing says who is on anything
    if (!(await projects()).includes(repo) || (await lifecycleOf(repo)).retired) return { repo, project: false, subs: [] }
    const [assigned, admins] = await Promise.all([membersOf(repo), ctx.deps.cognito().usersInGroup(GROUPS.admin)])
    // connected systems are assigned like people (their sub is their client id) but have no screen to tell
    const people = assigned.filter((m) => !(m.email ?? '').startsWith('service:'))
    return { repo, project: true, subs: [...new Set([...admins.map((a) => a.sub), ...people.map((m) => m.sub)])].sort() }
  }),

  'hook.apply': def('backend', z.object({ repo: RepoSlug }), async ({ repo }, ctx) => {
    if (!(await projects()).includes(repo)) return { repo, applied: [] }
    const done = await applyEdits(ctx, repo)
    return { repo, applied: done.filter((a) => a.did !== 'waiting' && a.did !== 'left').map((a) => ({ branch: a.branch, number: a.number, did: a.did })) }
  }),

  'hook.conflicts': def('backend', z.object({ repo: RepoSlug }), async ({ repo }, ctx): Promise<ConflictReport> => {
    if (!(await projects()).includes(repo)) return { repo, conflicts: [], remade: [], record: [], worker: [], left: [], checking: [], started: 'not-needed' }
    return resolveConflicts(ctx, repo)
  }),

  'hook.docs': def('backend', z.object({ repo: RepoSlug }), async ({ repo }, ctx) => {
    if (!(await projects()).includes(repo) || (await lifecycleOf(repo)).paused) return { repo, records: [], started: null }
    // with the agents' facts merged in: their checks meet trace's criteria, which the stage's design work is
    const rec = await recordNow(ctx, repo)
    // before Architect there are no documents to keep
    if (!rec || ['define'].includes(rec.journey.currentStage)) return { repo, records: [], started: null, why: 'no documents before Architect' }
    // the push may have landed what the stage's next design work waits for (the case, once the layout is accepted):
    // it starts now, never behind the documents (FOLLOW_ON)
    const follow = await startFollowOn(ctx, repo, rec).catch((e: unknown) => ({ started: [], jobs: [], errors: [e instanceof Error ? e.message : String(e)] }))
    const design = follow.started.length || follow.errors.length ? { design: { started: follow.started, jobs: follow.jobs, ...(follow.errors.length ? { errors: follow.errors } : {}) } } : {}
    const gh = await ctx.deps.github()
    const { sha } = await gh.defaultBranch(repo)
    const { records } = await recordsOfCommit(ctx, repo, sha)
    if (!records.length) {
      // a push of only runs (a change of checks accepted) can still land what the documents waited for (docsOwed)
      if (!(await docsOwed(ctx, repo, rec))) return { repo, commit: sha, records, started: null, why: 'the push changed no record a document is written from', ...design }
      const r = await startStageScribe(ctx, repo, `The default branch moved to ${sha.slice(0, 12)}, which landed the last of ${STAGE_NAMES[rec.journey.currentStage]}'s design.`, { rec, also: ['journey'] })
      return { repo, commit: sha, records, started: r.started ?? null, ...(r.jobId ? { job: r.jobId } : {}), ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.waiting ? { waiting: r.waiting } : {}), ...(r.jobError ? { error: r.jobError } : {}), ...design }
    }
    // the documents of a stage are written from its design: while some of it is still to land they wait, and the push
    // (or the person's act) that lands the last of it starts Scribe (docsAfterDesign)
    const r = await startStageScribe(ctx, repo, `The default branch moved to ${sha.slice(0, 12)}.`, { rec, records })
    return { repo, commit: sha, records, started: r.started ?? null, ...(r.jobId ? { job: r.jobId } : {}), ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.waiting ? { waiting: r.waiting } : {}), ...(r.jobError ? { error: r.jobError } : {}), ...design }
  }),

  'hook.projects': def('backend', z.object({}), async () => {
    const all = await projects()
    const live: string[] = []
    for (const repo of all) {
      const l = await lifecycleOf(repo)
      if (!l.paused && !l.retired) live.push(repo)
    }
    return { projects: live.sort() }
  }),

  'hook.drift': def('backend', z.object({ repo: RepoSlug }), async ({ repo }, ctx) => {
    if (!(await projects()).includes(repo) || (await lifecycleOf(repo)).paused) return { repo, records: [], missing: [], started: null }
    const rec = (await journeyStore(ctx, repo).read((db) => loadJourney(db))).result
    if (!rec || rec.journey.currentStage === 'define') return { repo, records: [], missing: [], started: null, why: 'no documents before Architect' }
    const d = await driftOf(ctx, repo, rec.journey.currentStage)
    return {
      repo, commit: d.head, records: d.records, missing: d.missing, since: d.since, started: d.started ?? null,
      ...(d.jobId ? { job: d.jobId } : {}), ...(d.skipped ? { skipped: d.skipped } : {}), ...(d.waiting ? { waiting: d.waiting } : {}), ...(d.jobError ? { error: d.jobError } : {}),
    }
  }),
}
