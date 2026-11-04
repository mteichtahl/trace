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
  reporter: [['list'], ['html', { outputFolder: `${WEB}smoke-report`, open: 'never' }], ['json', { outputFile: `${WEB}smoke-report/results.json` }]],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: live ? process.env.TRACE_SMOKE_URL : `http://localhost:${PORT}`,
    storageState: live ? `${WEB}test-results/smoke-auth.json` : undefined,
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } }, grepInvert: /@phone-only/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
  ],
  webServer: live
    ? undefined
    : { command: `npm run dev:mock -- --port ${PORT} --strictPort`, cwd: WEB, url: `http://localhost:${PORT}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
})
