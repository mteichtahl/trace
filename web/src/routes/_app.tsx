/**
 * The signed-in shell: guard, the one live connection, CopilotKit, and the shell itself. Every screen with the left
 * rail is a child of this route (files under routes/_app/).
 */
import { Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { AfterAccept } from '@/components/changes/after-accept'
import { ChatProvider } from '@/components/chat/chat-provider'
import { AppShell } from '@/components/shell/app-shell'
import { loadConfig } from '@/lib/config'
import { requireSignedIn } from '@/lib/guard'
import { liveStatus, startLive } from '@/lib/live'
import { keepFresh } from '@/lib/push'
import { rememberPage } from '@/lib/return-to'

export function useLiveConnection() {
  const qc = useQueryClient()
  useEffect(() => {
    let stop: (() => void) | undefined
    let live = true
    void loadConfig()
      .then((cfg) => {
        if (!live) return
        if (!cfg.events.realtime) {
          // no live endpoint configured (mock mode, a local backend): say so honestly
          liveStatus.set({ state: import.meta.env.VITE_MOCK === '1' ? 'live' : 'offline', lastUpdate: Date.now(), liveSince: Date.now() })
          return
        }
        stop = startLive(qc, cfg.events)
      })
      .catch(() => liveStatus.set((s) => ({ ...s, state: 'offline' })))
    return () => {
      live = false
      stop?.()
    }
  }, [qc])
}

/** Push on this device: the service worker, and a subscription the browser dropped made again (lib/push.ts). */
function usePushFresh() {
  useEffect(() => {
    void keepFresh()
  }, [])
}

/** The page shown, remembered: a guided skill opened from it returns to it once submitted (lib/return-to.ts). */
function useRememberPage() {
  const href = useLocation({ select: (l) => l.href })
  useEffect(() => rememberPage(href), [href])
}

function AppLayout() {
  useLiveConnection()
  usePushFresh()
  useRememberPage()
  return (
    <ChatProvider>
      <AppShell>
        <Outlet />
        <AfterAccept />
      </AppShell>
    </ChatProvider>
  )
}

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ location }) => requireSignedIn(location),
  component: AppLayout,
})
