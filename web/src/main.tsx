import './index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from '@/lib/api'
import { routeTree } from './routeTree.gen'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // events, not polling: the live connection invalidates what changed (lib/live.ts)
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // never retry a 429: trace's firewall counts every request, so a retry only keeps it shut longer
      retry: (n, e) => !(e instanceof ApiError && (e.noAccess || e.status === 401 || e.status === 429)) && n < 2,
    },
  },
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

async function start() {
  // mock mode: development only, never in a production build (the branch is removed at build time)
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
    const { installMock } = await import('./mock/handlers')
    installMock()
  }
  // a tapped notification, when the open window could not be moved to its card by the service worker itself
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
      if (e.data?.type !== 'trace.open' || !e.data.url) return
      const u = new URL(e.data.url, location.origin)
      if (u.origin === location.origin) void router.navigate({ href: u.pathname + u.search })
    })
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
}

void start()
