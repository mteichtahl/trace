import { availableParallelism } from 'node:os'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // at most 8 workers, however many cores the machine reports (as the root vitest.config.ts): on a large build
    // machine a worker per core starved the render tests past Testing Library's one-second waits (check-sheet.test.tsx)
    maxWorkers: Math.min(8, availableParallelism()),
    // CopilotKit's v2 entry imports its own stylesheet
    server: { deps: { inline: [/@copilotkit\//] } },
  },
})
