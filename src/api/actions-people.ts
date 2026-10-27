/**
 * People, beyond users.list (src/api/actions.ts): a person's history from the assignment log.
 *
 *   users.history  admin   { who } (an email or a sub): every assignment, removal, part change and class change made
 *                          to them, newest first, each in words ("w-admin@example.com added them to acme/web as a
 *                          reviewer."), with when, by whom, the project and the raw detail
 */
import { z } from 'zod'
import { assignmentLog } from '../core/access.js'
import { ActionError, def } from './action-kit.js'

export const PEOPLE_ACTIONS = {
  'users.history': def('admin', z.object({ who: z.string().min(1).max(320), limit: z.number().int().min(1).max(1000).default(200) }), async (a, ctx) => {
    const u = await ctx.deps.cognito().find(a.who)
    if (!u) throw new ActionError(`no such person: ${a.who}`)
    const entries = await assignmentLog(ctx.principal, u.sub, a.limit)
    return { sub: u.sub, email: u.email, entries }
  }),
}
