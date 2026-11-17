import { availableParallelism } from 'node:os'
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
    // one temporary folder per run, removed at its end (test/global-tmp.ts)
    globalSetup: ['test/global-tmp.ts'],
    pool: 'forks',
    // at most 8 forks, however many cores the machine reports: the suites are heavy on disk (a SQLite store and git
    // per project), and with a fork per core on a large build machine they starve each other until their own timeouts
    // and rate windows fail (job-queue's 3 s waits, memory.remember's burst, a local server's connection reset)
    maxWorkers: Math.min(8, availableParallelism()),
  },
})
