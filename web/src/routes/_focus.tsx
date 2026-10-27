/**
 * Focus mode's layout: signed in, live and CopilotKit, but no shell (the rail and tabs fold away). Guided skills
 * and gates live under routes/_focus/ and draw <FocusLayout/> themselves.
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { ChatProvider } from '@/components/chat/chat-provider'
import { requireSignedIn } from '@/lib/guard'
import { useLiveConnection } from './_app'

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
})
