/**
 * Verifies a connected system's token (docs/external-access.md "The principal") for the external runtime
 * (TRACE_AGENT_MODE=external), and makes it a Principal. Accepted only when all of these hold:
 *
 *   1. signature, issuer and time, as for a person (src/api/jwt.ts), and token_use 'access'
 *   2. no `username` claim (a person's token always has one), and `scope` names <rs>/read or <rs>/write, where rs is
 *      TRACE_EXTERNAL_RESOURCE_SERVER (default trace-external)
 *   3. its client_id is a connected system in the access store, and it is not disabled (looked up at most every 30 s
 *      per system, so a disabled system is shut out within 30 seconds, not when its token expires)
 *   4. its scopes, as used, are what the token carries AND what the system has now: an admin who removed write is
 *      obeyed at the next lookup
 *
 * The principal: { sub: client_id, email: null, groups: [trace-users] with write, else [trace-guests], kind: 'service',
 * name, scopes }. Never an admin. A person's token is refused here (rule 2), and a system's is refused by the people's
 * verifier (its client is not one of theirs), so neither door lets the other in.
 */
import { GROUPS, type Principal, type Service, type ServiceScope, getService } from '../core/access.js'
import { AuthError, type Verifier } from './jwt.js'

export const DEFAULT_RESOURCE_SERVER = 'trace-external'
const CACHE_MS = 30_000

export interface ServiceVerifierOptions {
  /** checks signature, issuer and time (Verifier.verifySigned) */
  verifier: Pick<Verifier, 'verifySigned'>
  resourceServer?: string | undefined
  /** the access store's lookup; tests replace it */
  lookup?: (clientId: string) => Promise<Service | null>
  now?: () => number
}

/** The resource-server scopes a token carries (its `scope` claim, space separated). */
export function tokenScopes(scope: string | undefined, resourceServer: string = DEFAULT_RESOURCE_SERVER): ServiceScope[] {
  const words = new Set((scope ?? '').split(/\s+/).filter(Boolean))
  return (['read', 'write'] as const).filter((s) => words.has(`${resourceServer}/${s}`))
}

export class ServiceVerifier {
  private readonly rs: string
  private readonly lookup: (clientId: string) => Promise<Service | null>
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; service: Service | null }>()

  constructor(private readonly o: ServiceVerifierOptions) {
    this.rs = o.resourceServer || DEFAULT_RESOURCE_SERVER
    this.lookup = o.lookup ?? getService
    this.now = o.now ?? Date.now
  }

  private async service(clientId: string): Promise<Service | null> {
    const hit = this.cache.get(clientId)
    if (hit && this.now() - hit.at < CACHE_MS) return hit.service
    const service = await this.lookup(clientId)
    this.cache.set(clientId, { at: this.now(), service })
    return service
  }

  /** The connected system's principal for a token; throws AuthError otherwise. */
  async principal(token: string): Promise<Principal> {
    const c = await this.o.verifier.verifySigned(token)
    if (c.username !== undefined) throw new AuthError('a person\'s token: people use the people\'s API')
    const granted = tokenScopes(c.scope, this.rs)
    if (!granted.length) throw new AuthError(`the token has no ${this.rs} scope`)
    if (!c.client_id) throw new AuthError('the token names no client')
    const s = await this.service(c.client_id)
    if (!s) throw new AuthError('not a connected system')
    if (s.disabled) throw new AuthError('this connected system is disabled')
    const scopes = granted.filter((g) => s.scopes.includes(g))
    if (!scopes.length) throw new AuthError('the token\'s scopes were removed from this connected system')
    return { sub: s.client_id, email: null, groups: [scopes.includes('write') ? GROUPS.user : GROUPS.guest], kind: 'service', name: s.name, scopes }
  }
}
