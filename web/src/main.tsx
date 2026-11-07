import './index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError, onAnswer } from '@/lib/api'
import { afterWrite } from '@/lib/after-write'
import { listenForNewVersion } from '@/lib/new-version'
import { RouteError } from '@/components/route-error'
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

// whatever a person does, wherever they do it, the screens showing what it changed read it again at once
onAnswer(afterWrite(queryClient))

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  // a page whose code a deploy replaced reloads the tab once; anything else is said in words (components/route-error.tsx)
  defaultErrorComponent: RouteError,
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Vite could not preload a page's code: a deploy replaced it, so the tab reloads once (lib/new-version.ts)
listenForNewVersion()

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
