/**
 * Admin (docs/ui-design.md, "Admin"): plain screens for admins only — People and access, Connected systems, Agent
 * instructions, Installation, Usage and cost — under one row of tabs. Anyone else gets the same "doesn't exist, or isn't shared
 * with you" answer as any page they cannot see.
 */
import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { NotShared } from '@/components/states'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/admin')({
  staticData: { crumb: 'Admin' },
  component: AdminLayout,
})

/** Each admin screen, with the one line that says what it is for (the tab's tooltip). */
export const ADMIN_TABS = [
  { to: '/admin/people', label: 'People', line: 'Who can sign in, their class, and their part on each project.' },
  { to: '/admin/systems', label: 'Connected systems', line: 'Other systems and AI agents that call trace with their own keys.' },
  { to: '/admin/prompts', label: 'Agent instructions', line: 'Every instruction and system prompt the agents receive.' },
  { to: '/admin/installation', label: 'Installation', line: "The installation's health and optional keys." },
  { to: '/admin/usage', label: 'Usage and cost', line: 'Spend across projects this month.' },
] as const

function AdminLayout() {
  const { user } = useAuth()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  if (user?.class !== 'admin') return <NotShared />
  return (
    <>
      <nav aria-label="Admin" className="mx-auto w-full max-w-[1200px] px-4 pt-4 md:px-6">
        <div className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
          {ADMIN_TABS.map((t) => {
            const active = pathname.startsWith(t.to)
            return (
              <Link key={t.to} to={t.to} title={t.line} aria-current={active ? 'page' : undefined} className={cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-2 text-sm', active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                {t.label}
              </Link>
            )
          })}
        </div>
      </nav>
      <Outlet />
    </>
  )
}
