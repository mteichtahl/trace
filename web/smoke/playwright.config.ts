/**
 * trace's screen smoke test (Tier 1, docs/smoke-test.md): every screen loads, shows real data and does one thing.
 *
 * Two targets, chosen by TRACE_SMOKE_TARGET:
 * - `mock` (the default): the web app in mock mode, started here; runs in CI on every pull request.
 * - `live`: an installation's web app at TRACE_SMOKE_URL, signed in as the smoke user; runs after each self-update.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { target } from './env'

const live = target === 'live'
const WEB = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.TRACE_SMOKE_PORT ?? 5179)

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.smoke.ts',
  outputDir: `${WEB}test-results/smoke`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: live ? 1 : 0,
  workers: live ? 2 : 3,
  timeout: live ? 60_000 : 45_000,
  expect: { timeout: 15_000 },
  // live: no HTML report, traces or screenshots of passing checks. trace's repository is public, and a trace or report
  // from a live run would hold the signed-in session and the installation's data; the CI job keeps results.json only
  reporter: live
    ? [['list'], ['json', { outputFile: `${WEB}smoke-report/results.json` }]]
    : [['list'], ['html', { outputFolder: `${WEB}smoke-report`, open: 'never' }], ['json', { outputFile: `${WEB}smoke-report/results.json` }]],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: live ? process.env.TRACE_SMOKE_URL : `http://localhost:${PORT}`,
    storageState: live ? `${WEB}test-results/smoke-auth.json` : undefined,
    screenshot: live ? 'off' : 'on',
    trace: live ? 'off' : 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } }, grepInvert: /@phone-only|@3d/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/, grepInvert: /@3d/ },
    // the 3D board screens, one at a time (smoke/board3d.smoke.ts): without a GPU two at once starve each other
    { name: '3d', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } }, grep: /@3d/, workers: 1 },
  ],
  webServer: live
    ? undefined
    : { command: `npm run dev:mock -- --port ${PORT} --strictPort`, cwd: WEB, url: `http://localhost:${PORT}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
})
