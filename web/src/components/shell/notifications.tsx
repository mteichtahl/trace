/** The bell: the latest ten from `inbox`, each the same item that sits on Home, with View all. */
import { Link } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Rich } from '@/components/rich'
import { waited } from '@/lib/format'
import { useInbox } from '@/lib/queries'

export function NotificationsBell() {
  const inbox = useInbox()
  const items = inbox.data ?? []
  const unread = items.filter((i) => !i.read).length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="relative" aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}>
          <Bell />
          {unread > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-semibold">Needs you</p>
          <Link to="/inbox" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <ul className="max-h-[420px] divide-y overflow-y-auto">
          {inbox.isLoading && <li className="px-4 py-3 text-sm text-muted-foreground">Loading…</li>}
          {!inbox.isLoading && items.length === 0 && <li className="px-4 py-6 text-sm text-muted-foreground">Nothing needs you. trace will tell you when something does.</li>}
          {items.slice(0, 10).map((i) => (
            <li key={i.id} className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{[i.project, i.stage, waited(i.createdAt)].filter(Boolean).join(' · ')}</p>
              <p className="mt-0.5 line-clamp-2 text-sm">
                <Rich text={i.summary} terms={false} />
              </p>
              <Button asChild size="sm" variant="link" className="h-auto px-0">
                <Link to={i.action.to ?? '/inbox'}>{i.action.label}</Link>
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
