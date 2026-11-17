/**
 * The bell: a shortcut to Next, which is Home and the only list of what needs a person (docs/ui-simplify.md, "One
 * queue"). It shows a dot while anything there is unread; it lists nothing itself.
 */
import { Link } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { inboxItems } from '@/components/next-queue'
import { useInbox } from '@/lib/queries'

export function NotificationsBell() {
  const inbox = useInbox()
  const items = inboxItems(inbox.data)
  const unread = items.filter((i) => !i.read).length
  return (
    <Button asChild variant="outline" size="icon" className="relative">
      <Link to="/" aria-label={items.length ? `Next: ${items.length} for you${unread ? `, ${unread} new` : ''}` : 'Next: nothing needs you'}>
        <Bell />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden />}
      </Link>
    </Button>
  )
}
