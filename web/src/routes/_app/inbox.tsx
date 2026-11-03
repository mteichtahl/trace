/** The old Inbox address: it is now Next. Links and bookmarks to /inbox keep working. */
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/inbox')({
  beforeLoad: () => {
    throw redirect({ to: '/next', replace: true })
  },
})
