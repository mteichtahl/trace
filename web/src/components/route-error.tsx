/**
 * The page shown when a route fails to load or draw (the router's default error page, main.tsx), in place of the
 * router's bare "Something went wrong!". A page whose code is gone after a deploy (test-esp32 #216) reloads the tab once
 * (lib/new-version.ts); when that already happened, it says a new version is ready, with Reload. Anything else is said
 * as an error, with Try again and the detail folded.
 */
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ErrorState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { NEW_VERSION, isChunkLoadError, reloadOnce } from '@/lib/new-version'

export function RouteError({ error, reset }: Pick<ErrorComponentProps, 'error' | 'reset'>) {
  const router = useRouter()
  const chunk = isChunkLoadError(error)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (chunk && !reloadOnce()) setReady(true)
  }, [chunk])
  const msg = error instanceof Error ? error.message : String(error)
  if (chunk && !ready) {
    return <p role="status" className="p-6 text-sm text-muted-foreground">Loading the new version of trace…</p>
  }
  if (chunk) {
    return (
      <div className="p-6">
        <ErrorState
          title={NEW_VERSION}
          kept="Nothing you did is lost."
          action={<Button size="sm" variant="outline" onClick={() => window.location.reload()}><RefreshCw /> Reload</Button>}
          detail={msg}
        />
      </div>
    )
  }
  return (
    <div className="p-6">
      <ErrorState
        title="This page could not be shown."
        onRetry={() => { reset(); void router.invalidate() }}
        detail={msg}
      />
    </div>
  )
}
