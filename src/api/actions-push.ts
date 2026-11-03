/**
 * Push notifications on the person's own devices (docs/push.md). Always the asker's own devices. The installation's
 * public key, which a browser subscribes with, comes from the web backend (GET /api/push/key, src/web/push-routes.ts).
 *
 *   push.subscribe    signed in   add or refresh this device ({ subscription, tz, label }); answers { devices }
 *   push.unsubscribe  signed in   remove one of the person's devices by its endpoint
 *   push.devices      signed in   the person's devices: label, time zone and since when (never their keys)
 *
 * Turning push on for kinds is a preference (me.set notifications.kinds.<kind>.push): subscribing a device does not
 * change what is pushed, and the sender reads both (src/web/push-sender.ts).
 */
import { z } from 'zod'
import { AccessDenied, classOf } from '../core/access.js'
import { PushSubscriptionSchema, devices, subscribe, unsubscribe } from '../core/push-subscriptions.js'
import { type Context, NO_ACCESS, def } from './action-kit.js'

const someone = (ctx: Context): string => {
  if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
  return ctx.principal.sub
}

export const PUSH_ACTIONS = {
  'push.subscribe': def('signed-in', z.object({ subscription: PushSubscriptionSchema, tz: z.string().max(64).nullable().optional(), label: z.string().max(80).nullable().optional() }), async (a, ctx) => {
    const n = await subscribe(someone(ctx), a.subscription, { tz: a.tz ?? null, label: a.label ?? null })
    return { subscribed: true, devices: n }
  }),

  'push.unsubscribe': def('signed-in', z.object({ endpoint: z.string().url().max(1024) }), async (a, ctx) =>
    ({ removed: await unsubscribe(someone(ctx), a.endpoint) })),

  'push.devices': def('signed-in', z.object({}), async (_a, ctx) => ({ devices: await devices(someone(ctx)) })),
}
