/**
 * The person's own preferences (src/core/preferences.ts), and their saved table views, which are preferences too
 * (`views.<table>`). Always the asker's own: there is no argument naming anyone else.
 *
 *   me.get      signed in   { preferences, updated, bytes, limit, locks }; with `key`, also that key's value. `locks`:
 *                           the settings an admin fixed for everyone ({ setting: reason }, src/core/policy.ts)
 *   me.set      signed in   set one dotted key (`value`), or remove it (`unset: true`); at most 64 KB in all. A key a
 *                           lock covers (prefs.<setting>, or under it) is refused with the lock's reason
 *   policy.get  signed in   the installation's locks, with when and by whom they were last changed
 *   policy.set  admin       lock one setting with a reason, or unlock it (`reason: null`)
 */
import { z } from 'zod'
import { AccessDenied, classOf } from '../core/access.js'
import { LockKey, LockReason, getPolicy, lockFor, setLock } from '../core/policy.js'
import { PrefKey, PrefValueSchema, getPath, getPreferences, setPreference } from '../core/preferences.js'
import { ActionError, type Context, NO_ACCESS, def, label, plainly } from './action-kit.js'

/** Anyone in a class; a person in none has no account here to keep preferences for. */
const someone = (ctx: Context): string => {
  if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
  return ctx.principal.sub
}

export const ME_ACTIONS = {
  'me.get': def('signed-in', z.object({ key: PrefKey.optional() }), async (a, ctx) => {
    const [v, policy] = await Promise.all([getPreferences(someone(ctx)), getPolicy()])
    const out = { ...v, locks: policy.locks }
    return a.key ? { ...out, key: a.key, value: getPath(v.preferences, a.key) ?? null } : out
  }),

  'me.set': def('signed-in', z.object({ key: PrefKey, value: PrefValueSchema.optional(), unset: z.boolean().default(false) }), async (a, ctx) => {
    const sub = someone(ctx)
    const lock = lockFor((await getPolicy()).locks, a.key)
    if (lock) throw new ActionError(`An admin has fixed ${lock.setting} for everyone: ${lock.reason}`)
    return plainly(() => setPreference(sub, { key: a.key, value: a.value, unset: a.unset }))
  }),

  'policy.get': def('signed-in', z.object({}), async (_a, ctx) => { someone(ctx); return getPolicy() }),

  'policy.set': def('admin', z.object({ key: LockKey, reason: LockReason.nullable() }), async (a, ctx) =>
    setLock(a.key, a.reason, label(ctx.principal))),
}
