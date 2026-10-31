import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['web/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 60_000,
    // setup (beforeAll: a seeded project, an API server) as long as a test may take: on a busy machine, with a fork
    // per core, a suite's setup outran the 10-second default (test/api/gaps.test.ts, web.test.ts)
    hookTimeout: 60_000,
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
  },
})
