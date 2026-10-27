import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useDisplayPrefs } from '@/lib/theme'

export interface RouterContext {
  queryClient: QueryClient
}

function Root() {
  useDisplayPrefs()
  return (
    <TooltipProvider delayDuration={300}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Outlet />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: () => (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-lg font-semibold">This page doesn't exist, or isn't shared with you</h1>
      <p className="mt-2 text-sm text-muted-foreground">If you need it, ask an admin on your team to add you to the project.</p>
    </div>
  ),
})
