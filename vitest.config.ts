import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['web/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 60_000,
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
  },
})
