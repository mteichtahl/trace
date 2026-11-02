/** The web firewall's limits per address (src/infra/edge.ts), shared by the stack's settings and the web backend's. */

/** The 5-minute limits' defaults before they became 10-minute ones. */
const OLD_DEFAULTS = { api: 1000, auth: 100 }

/**
 * web.waf as saved before its limits were per 10 minutes: apiRequestsPer5Minutes and authRequestsPer5Minutes become
 * their 10-minute equivalents (twice as many), unless the new keys are there already. The old defaults (1,000 and 100)
 * were never a choice anyone made, so they take the new defaults instead.
 */
export function wafPer10Minutes(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  const { apiRequestsPer5Minutes: oldApi, authRequestsPer5Minutes: oldAuth, ...rest } = v as Record<string, unknown>
  const api = oldApi === OLD_DEFAULTS.api ? undefined : oldApi
  const auth = oldAuth === OLD_DEFAULTS.auth ? undefined : oldAuth
  return {
    ...rest,
    ...(typeof api === 'number' && rest.apiRequestsPer10Minutes === undefined ? { apiRequestsPer10Minutes: api * 2 } : {}),
    ...(typeof auth === 'number' && rest.authRequestsPer10Minutes === undefined ? { authRequestsPer10Minutes: auth * 2 } : {}),
  }
}
