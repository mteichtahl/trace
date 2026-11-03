/**
 * The installation's push key pair (docs/push.md): made the first time the app asks for the public key (GET
 * /api/push/key, src/web/push-routes.ts), kept in Secrets Manager as `<prefix>/web/push-keys`, never changed after.
 * The push sender (src/web/push-sender.ts) reads the whole pair to sign; the app only ever gets the public half.
 */
import { webPushSecret } from '../infra/props.js'
import { generateVapidKeys, validVapid } from './web-push.js'

/** Who to contact about this installation's pushes (RFC 8292 `sub`): the software's home, not a person's address. */
export const PUSH_SUBJECT = 'https://github.com/mteichtahl/trace'

/** Secrets Manager, as the push keys need it (tests replace it). */
export interface PushKeysIo {
  read(name: string): Promise<string | null>
  /** false when it is there already (another call made it first) */
  create(name: string, value: string): Promise<boolean>
}

let cached: { key: string | null; at: number } | null = null

/**
 * The installation's push public key, the pair made the first time anyone asks (no installer step: an installation
 * that updates itself has push from its next deploy). Two first calls at once: one creates, the other reads it. A
 * secret there but not whole is left alone (null: an admin looks at it), never overwritten: devices subscribed with it.
 * Kept 10 minutes.
 */
export async function pushPublicKey(prefix: string, io: PushKeysIo): Promise<string | null> {
  if (cached && Date.now() - cached.at < 600_000) return cached.key
  const name = webPushSecret(prefix)
  const parse = (raw: string | null): string | null => {
    try {
      const v: unknown = raw ? JSON.parse(raw) : null
      return validVapid(v) ? v.publicKey : null
    } catch {
      return null
    }
  }
  let raw = await io.read(name)
  if (raw === null) {
    const made = generateVapidKeys(PUSH_SUBJECT)
    if (await io.create(name, JSON.stringify(made))) raw = JSON.stringify(made)
    else raw = await io.read(name)
  }
  const key = parse(raw)
  cached = { key, at: Date.now() }
  return key
}
/** Tests: forget the kept key. */
export const forgetPushKey = (): void => { cached = null }

export function livePushKeysIo(region: string): PushKeysIo {
  const sm = import('@aws-sdk/client-secrets-manager')
  return {
    async read(name) {
      const { GetSecretValueCommand, SecretsManagerClient } = await sm
      try {
        return (await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: name }))).SecretString ?? null
      } catch (e) {
        if ((e as { name?: string }).name === 'ResourceNotFoundException') return null
        throw e
      }
    },
    async create(name, value) {
      const { CreateSecretCommand, SecretsManagerClient } = await sm
      try {
        await new SecretsManagerClient({ region }).send(new CreateSecretCommand({ Name: name, SecretString: value, Description: 'trace: the push notification key pair (made by the web backend on first use)' }))
        return true
      } catch (e) {
        if ((e as { name?: string }).name === 'ResourceExistsException') return false
        throw e
      }
    },
  }
}
