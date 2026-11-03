/**
 * GET /api/push/key: the installation's push public key, which the app subscribes a browser with (docs/push.md). For
 * anyone signed in with an account class; the pair is made the first time it is asked for (src/web/push-keys.ts).
 * `{ publicKey: null }` when it cannot be had (a secret there but not whole: an admin looks at it).
 */
import { type WebDeps, signedIn } from './deps.js'
import { route } from './http.js'
import { type PushKeysIo, livePushKeysIo, pushPublicKey } from './push-keys.js'

export function pushRoutes(deps: WebDeps) {
  return [
    route('GET', '/api/push/key', async (req, ctx) => {
      const { config } = await signedIn(req, ctx, deps)
      const io: PushKeysIo = deps.pushKeys?.(config) ?? livePushKeysIo(config.region)
      return { body: { publicKey: await pushPublicKey(config.prefix, io) } }
    }),
  ]
}
