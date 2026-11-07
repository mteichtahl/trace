/**
 * Focus mode's layout: signed in, live and CopilotKit, but no shell (the rail and tabs fold away). Guided skills
 * and gates live under routes/_focus/ and draw <FocusLayout/> themselves.
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { ChatProvider } from '@/components/chat/chat-provider'
import { requireSignedIn } from '@/lib/guard'
import { useLiveConnection } from './_app'
import { PageSkeleton } from '@/components/shell/shell-skeleton'

function FocusRoot() {
  useLiveConnection()
  return (
    <ChatProvider>
      <Outlet />
    </ChatProvider>
  )
}

export const Route = createFileRoute('/_focus')({
  beforeLoad: ({ location }) => requireSignedIn(location),
  component: FocusRoot,
  // asking who is signed in can take seconds on a cold API: the page's outline meanwhile (test-esp32 #15)
  pendingComponent: PageSkeleton,
  pendingMs: 0,
  pendingMinMs: 0,
})
