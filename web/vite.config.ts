import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const origin = env.VITE_API_ORIGIN
  return {
    plugins: [
      tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: origin ? { proxy: { '/api': { target: origin, changeOrigin: true, secure: true } } } : {},
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/scheduler')) return 'react'
            if (id.includes('@tanstack/')) return 'tanstack'
            return undefined
          },
        },
      },
    },
  }
})
