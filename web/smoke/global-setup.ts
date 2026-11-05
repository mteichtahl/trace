/**
 * Before any check runs.
 *
 * Live: sign the smoke user in once, through the app's own sign-in API (password, then an authenticator code), inside a
 * browser so the HTTP-only refresh cookie lands on the app's origin, then save it for every check. The authenticator
 * code is worked out here, so the secret never reaches the page.
 *
 * Mock: visit every screen once, one after another, so the dev server has compiled them all before checks run in
 * parallel; otherwise the first check on a heavy screen (the 3D board, a new project) can time out while it compiles.
 */
import { chromium, type FullConfig, type Page } from '@playwright/test'
import { live, projectPath, requireLive } from './env'
import { totp } from './totp'

interface Answer { session?: string; next?: string; signedIn?: boolean }

const post = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      // CloudFront signs the request for the API's function URL and needs the body's SHA-256 (as src/lib/http.ts sends it)
      const json = JSON.stringify(body)
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
      const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-amz-content-sha256': hash }, body: json })
      const text = await r.text()
      if (!r.ok) throw new Error(`${path} answered ${r.status}: ${text.slice(0, 200)}`)
      return JSON.parse(text) as Answer
    },
    { path, body },
  )

const WARM = ['/', '/next', '/projects', '/projects/new', '/me', '/admin/people', '/admin/prompts', '/admin/installation', '/admin/usage', '/ops', '/agents', '/knowledge', '/knowledge/graph']
const WARM_PROJECT = ['', '/requirements', '/design', '/changes', '/evidence', '/decisions', '/files', '/settings', '/cost', '/memory']

export default async function globalSetup(config: FullConfig) {
  const { baseURL, storageState } = config.projects[0]!.use
  const browser = await chromium.launch()
  const page = await browser.newPage({ baseURL })
  try {
    if (!live) {
      for (const path of [...WARM, ...WARM_PROJECT.map((p) => projectPath(p))]) {
        await page.goto(path, { waitUntil: 'networkidle', timeout: 120_000 })
      }
      await page.goto(projectPath('/design'))
      await page.getByRole('tab', { name: 'Board' }).click()
      await page.locator('canvas[aria-label^="The board in 3D"]').waitFor({ timeout: 120_000 })
      return
    }
    requireLive()
    const email = process.env.TRACE_SMOKE_EMAIL!
    await page.goto('/sign-in')
    const start = await post(page, '/api/auth/start', { email })
    let r = await post(page, '/api/auth/respond', { email, session: start.session, kind: 'password', answer: process.env.TRACE_SMOKE_PASSWORD })
    if (r.next === 'totp') r = await post(page, '/api/auth/respond', { email, session: r.session, kind: 'totp', answer: totp(process.env.TRACE_SMOKE_TOTP_SECRET!) })
    if (!r.signedIn) throw new Error(`The smoke user's sign-in stopped at "${r.next}": it must use a password and an authenticator app`)
    await page.goto('/')
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30_000 })
    await page.context().storageState({ path: storageState as string })
  } finally {
    await browser.close()
  }
}
