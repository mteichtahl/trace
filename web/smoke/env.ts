/** What the smoke test runs against, read once from the environment (docs/smoke-test.md lists every variable). */

export const target: 'mock' | 'live' = process.env.TRACE_SMOKE_TARGET === 'live' ? 'live' : 'mock'
export const live = target === 'live'

/** The project the screens are checked on: the mock's soil sensor, or the installation's smoke project. */
export const project = process.env.TRACE_SMOKE_PROJECT ?? (live ? '' : 'acme~soil-sensor')
export const projectPath = (sub = '') => `/p/${project}${sub}`

/**
 * Checks that change data (create a project, pause it, accept a change) run against the mock always, and against a
 * live installation only when TRACE_SMOKE_WRITES=1: the smoke project is the only one they touch.
 */
export const writes = !live || process.env.TRACE_SMOKE_WRITES === '1'

/**
 * The admin screens: always against the mock; live only with TRACE_SMOKE_ADMIN=1, because the smoke user the installer
 * makes is an ordinary user and a Reviewer of the smoke project only (src/installer/smoke.ts).
 */
export const admin = !live || process.env.TRACE_SMOKE_ADMIN === '1'

/**
 * Whether the signed-in person is a Reviewer of the smoke project: the installer's smoke user is (it reads, and decides
 * nothing), so a change's review page shows it the sentence saying why, not Accept. The mock's person is a Contributor.
 */
export const reviewer = live && !admin

/** The outside-system credentials for the external API and MCP checks; absent → those checks are skipped. */
export const external = {
  tokenUrl: process.env.TRACE_SMOKE_TOKEN_URL,
  clientId: process.env.TRACE_SMOKE_CLIENT_ID,
  clientSecret: process.env.TRACE_SMOKE_CLIENT_SECRET,
  apiUrl: process.env.TRACE_SMOKE_API_URL,
  mcpUrl: process.env.TRACE_SMOKE_MCP_URL,
}
export const externalReady = live && Object.values(external).every(Boolean)

export function requireLive(): void {
  const missing = ['TRACE_SMOKE_URL', 'TRACE_SMOKE_EMAIL', 'TRACE_SMOKE_PASSWORD', 'TRACE_SMOKE_TOTP_SECRET', 'TRACE_SMOKE_PROJECT'].filter((k) => !process.env[k])
  if (missing.length) throw new Error(`The live smoke test needs ${missing.join(', ')} (docs/smoke-test.md)`)
}
