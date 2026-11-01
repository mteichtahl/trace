/**
 * What the web backend asks when GitHub says something moved (docs/guided-flow.md "Live updates", src/web/hooks.ts).
 *
 *   hook.members   backend   { repo } → { repo, project, subs }: whether the repository is one of this installation's
 *                            projects (the central registry), and when it is, the Cognito subs of everyone who should
 *                            hear about it: the people assigned to it (any part) and every admin. Subs only, never an
 *                            email, a name or a part: a live event says "look again", and the app asks the API as
 *                            the person, who then sees only what they may
 *
 * Only the web backend's own identity reaches it (need 'backend', src/api/backend-auth.ts), and that identity reaches
 * nothing else (perform). The API runtime still decides who is on a project, as it does for project.members; the
 * backend still never reads the access store.
 */
import { GROUPS, RepoSlug, membersOf } from '../core/access.js'
import { projects } from '../core/onboard.js'
import { z } from 'zod'
import { def } from './action-kit.js'

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
}
