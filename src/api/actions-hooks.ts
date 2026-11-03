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
 * Only the web backend's own identity reaches it (need 'backend', src/api/backend-auth.ts), and that identity reaches
 * nothing else (perform). The API runtime still decides who is on a project, as it does for project.members; the
 * backend still never reads the access store.
 */
import { GROUPS, RepoSlug, membersOf } from '../core/access.js'
import { projects } from '../core/onboard.js'
import { z } from 'zod'
import { def } from './action-kit.js'
import { applyEdits } from './apply-edits.js'
import { type ConflictReport, resolveConflicts } from './conflicts.js'

export interface HookMembers { repo: string; project: boolean; subs: string[] }

export const HOOK_ACTIONS = {
  'hook.members': def('backend', z.object({ repo: RepoSlug }), async ({ repo }, ctx): Promise<HookMembers> => {
    // not a project: nobody is told, and nothing says who is on anything
    if (!(await projects()).includes(repo)) return { repo, project: false, subs: [] }
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
    if (!(await projects()).includes(repo)) return { repo, conflicts: [], remade: [], worker: [], left: [], checking: [], started: 'not-needed' }
    return resolveConflicts(ctx, repo)
  }),
}
