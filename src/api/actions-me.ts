/**
 * The person's own preferences (src/core/preferences.ts), and their saved table views, which are preferences too
 * (`views.<table>`). Always the asker's own: there is no argument naming anyone else.
 *
 *   me.get   signed in   { preferences, updated, bytes, limit }; with `key`, also that key's value
 *   me.set   signed in   set one dotted key (`value`), or remove it (`unset: true`); at most 64 KB in all
 */
import { z } from 'zod'
import { AccessDenied, classOf } from '../core/access.js'
import { PrefKey, PrefValueSchema, getPath, getPreferences, setPreference } from '../core/preferences.js'
import { type Context, NO_ACCESS, def, plainly } from './action-kit.js'

/** Anyone in a class; a person in none has no account here to keep preferences for. */
const someone = (ctx: Context): string => {
  if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
  return ctx.principal.sub
}

export const ME_ACTIONS = {
  'me.get': def('signed-in', z.object({ key: PrefKey.optional() }), async (a, ctx) => {
    const v = await getPreferences(someone(ctx))
    return a.key ? { ...v, key: a.key, value: getPath(v.preferences, a.key) ?? null } : v
  }),

  'me.set': def('signed-in', z.object({ key: PrefKey, value: PrefValueSchema.optional(), unset: z.boolean().default(false) }), async (a, ctx) =>
    plainly(() => setPreference(someone(ctx), { key: a.key, value: a.value, unset: a.unset }))),
}
