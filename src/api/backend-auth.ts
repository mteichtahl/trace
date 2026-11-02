/**
 * The web backend's own identity at the API runtime (docs/guided-flow.md "Live updates"): how GitHub's webhook, which
 * arrives with no person behind it, learns who is on a project without the backend reading the access store.
 *
 * The backend holds a Cognito app client of its own, `<prefix>-web-hooks` (src/infra/web.ts addHooksClient): client
 * credentials, a secret, and one scope, `trace-internal/members`. It swaps them for an access token at the pool's
 * /oauth2/token (src/web/hooks.ts, kept for the token's hour) and calls the people's API runtime with it, which lists
 * that client beside the CLI's and the web app's (TRACE_COGNITO_HOOKS_CLIENT_ID). A token is the backend's only when
 * all of these hold:
 *
 *   1. signature, issuer, time and token_use 'access' (src/api/jwt.ts verifySigned)
 *   2. its client_id is TRACE_COGNITO_HOOKS_CLIENT_ID, it has no `username` (a person's token always has one), and its
 *      `scope` names <rs>/members (rs: trace-internal)
 *
 * The principal is { kind: 'backend', sub: <client id>, groups: [] }: no class (classOf answers null, so it is never an
 * admin and is on no project), and perform lets it call `hook.members` and nothing else, which in turn refuses
 * everyone else (need 'backend'). So the client's secret, if it leaked, tells who is on which project by their Cognito
 * subs and nothing more: no emails, no names, no project content, no writes.
 */
import type { Principal } from '../core/access.js'
import { type AccessClaims, AuthError } from './jwt.js'

export const BACKEND_RESOURCE_SERVER = 'trace-internal'
export const BACKEND_SCOPE = 'members'
/** The scope the backend's token carries, as Cognito writes it. */
export const BACKEND_SCOPE_FULL = `${BACKEND_RESOURCE_SERVER}/${BACKEND_SCOPE}`
/** Its name in logs and records: backend:web-hooks. */
export const BACKEND_NAME = 'web-hooks'

/** The client a token names, read without verifying it: only to choose which check verifies it. */
export function peekClient(token: string): string | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { client_id?: unknown }
    return typeof c.client_id === 'string' ? c.client_id : null
  } catch {
    return null
  }
}

/** The backend's principal from verified claims (Verifier.verifySigned); throws AuthError otherwise. */
export function backendPrincipal(c: AccessClaims, clientId: string): Principal {
  if (!clientId || c.client_id !== clientId) throw new AuthError('wrong client')
  if (c.username !== undefined) throw new AuthError('a person\'s token is not the web backend\'s')
  const scopes = new Set((c.scope ?? '').split(/\s+/).filter(Boolean))
  if (!scopes.has(BACKEND_SCOPE_FULL)) throw new AuthError(`the token has no ${BACKEND_SCOPE_FULL} scope`)
  return { sub: clientId, email: null, groups: [], kind: 'backend', name: BACKEND_NAME }
}
