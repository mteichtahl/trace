/**
 * The live events' authorizer (AppSync Events, AWS_LAMBDA authorization for connect and subscribe): the app sends its
 * Cognito id token as the authorization token, as it would for user-pool authorization. Lambda authorization keeps the
 * events API from naming the pool, so it can live in the web app's own nested stack and the content security policy
 * can name its exact hosts (src/infra/web.ts) without a dependency cycle.
 *
 *   connect     a valid id token of the web app's client (signature, issuer, expiry, audience)
 *   subscribe   the same, and the channel is /trace/users/<that token's sub> exactly
 *   publish     never through here (IAM: the web backend's role)
 *
 * The answer carries the sub as handlerContext.sub, which the namespace's onSubscribe handler checks again. A refusal
 * is cached for no time; an answer for at most a minute (the token's expiry is checked each time it is not cached).
 * The pool and client come from the web app's settings parameter (TRACE_WEB_CONFIG_PARAM), read once per container.
 */
import { AuthError, Verifier } from '../api/jwt.js'
import { type WebConfig, configLoader, issuerOf, ssmReader } from './config.js'

export interface AuthorizerEvent {
  authorizationToken?: string
  requestContext?: { operation?: string; channel?: string | null; channelNamespaceName?: string | null }
}
export interface AuthorizerAnswer { isAuthorized: boolean; handlerContext?: Record<string, string>; ttlOverride?: number }

export const EVENTS_NAMESPACE = 'trace'
const NO = { isAuthorized: false, ttlOverride: 0 } as const

/** The decision for one request, given a verifier of the web client's id tokens. */
export async function authorize(e: AuthorizerEvent, verify: (token: string) => Promise<{ sub: string; exp: number }>, now: () => number = Date.now): Promise<AuthorizerAnswer> {
  const token = (e.authorizationToken ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return NO
  let id: { sub: string; exp: number }
  try {
    id = await verify(token)
  } catch (err) {
    if (err instanceof AuthError) return NO
    throw err
  }
  const op = e.requestContext?.operation
  if (op === 'EVENT_SUBSCRIBE') {
    if (e.requestContext?.channel !== `/${EVENTS_NAMESPACE}/users/${id.sub}`) return NO
  } else if (op !== 'EVENT_CONNECT') {
    return NO
  }
  const left = Math.floor(id.exp - now() / 1000)
  return { isAuthorized: true, handlerContext: { sub: id.sub }, ttlOverride: Math.max(0, Math.min(60, left)) }
}

let verifier: { config: Promise<WebConfig>; v: Verifier | null } | null = null

/** The Lambda handler (bundled beside the backend as authorizer.mjs). */
export async function handler(e: AuthorizerEvent): Promise<AuthorizerAnswer> {
  const param = process.env.TRACE_WEB_CONFIG_PARAM
  if (!param) throw new Error('TRACE_WEB_CONFIG_PARAM is not set')
  verifier ??= { config: configLoader(ssmReader(process.env.AWS_REGION), param)(), v: null }
  const c = await verifier.config.catch((err: unknown) => { verifier = null; throw err })
  const v = (verifier.v ??= new Verifier({ issuer: issuerOf(c), clientId: c.clientId }))
  return authorize(e, (t) => v.verifyId(t))
}
