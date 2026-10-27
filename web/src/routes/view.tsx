/**
 * Pop out: a file on its own, without the shell (no rail, top bar or Ask trace dock), for a second monitor beside
 * KiCad or the bench. Signed in and live like the app; the chat provider is there so Ask about this file still works
 * (it opens Ask trace in the main window's place: here, as a sheet).
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { ChatProvider } from '@/components/chat/chat-provider'
import { requireSignedIn } from '@/lib/guard'
import { useLiveConnection } from './_app'

function Bare() {
  useLiveConnection()
  return (
    <ChatProvider>
      <main id="main" className="min-h-dvh bg-background">
        <Outlet />
      </main>
    </ChatProvider>
  )
}

export const Route = createFileRoute('/view')({
  staticData: { bare: true },
  beforeLoad: ({ location }) => requireSignedIn(location),
  component: Bare,
})
