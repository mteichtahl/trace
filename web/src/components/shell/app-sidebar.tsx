/** The left rail (shadcn Sidebar, collapsible to icons): the areas, the person's pinned projects with badges, and the person. */
import { Link, useRouterState } from '@tanstack/react-router'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { firstName, initials } from '@/lib/format'
import { usePrefs } from '@/lib/prefs'
import { useInbox, useProjects } from '@/lib/queries'
import { AREAS, isActive } from './nav'

export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-6 items-center justify-center rounded-md bg-foreground font-mono text-[13px] font-semibold text-background">t</span>
      <span className="text-[15px] font-semibold group-data-[collapsible=icon]:hidden">trace</span>
    </span>
  )
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user } = useAuth()
  const projects = useProjects()
  const inbox = useInbox()
  const prefs = usePrefs()
  const admin = user?.class === 'admin'
  const pinned = prefs.work.pinned.length ? prefs.work.pinned : (projects.data ?? []).slice(0, 5).map((p) => p.repo)
  const waiting = (repo: string) => (inbox.data ?? []).filter((i) => i.repo === repo).length

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 pb-3 pt-4">
        <Link to="/" aria-label="trace: Home" className="px-2">
          <Wordmark />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {AREAS.filter((a) => !('admin' in a && a.admin) || admin).map((a) => (
              <SidebarMenuItem key={a.to}>
                <SidebarMenuButton asChild isActive={isActive(pathname, a)} tooltip={a.label} className="h-9 data-[active=true]:font-medium">
                  <Link to={a.to}>
                    <a.icon />
                    <span>{a.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {pinned.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Pinned</SidebarGroupLabel>
            <SidebarMenu>
              {pinned.map((repo) => {
                const n = waiting(repo)
                const to = `/p/${projectId(repo)}`
                return (
                  <SidebarMenuItem key={repo}>
                    <SidebarMenuButton asChild isActive={pathname.startsWith(to)} tooltip={projectName(repo)} className="h-9">
                      <Link to="/p/$id" params={{ id: projectId(repo) }}>
                        <span className="hidden size-4 items-center justify-center text-[10px] font-semibold text-muted-foreground group-data-[collapsible=icon]:flex">{projectName(repo)[0]}</span>
                        <span>{projectName(repo)}</span>
                      </Link>
                    </SidebarMenuButton>
                    {n > 0 && (
                      <SidebarMenuBadge className="rounded-full bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground" aria-label={`${n} waiting on you`}>
                        {n}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="p-3">
        {user && (
          <Link to="/me" className="flex items-center gap-2.5 rounded-md p-1.5 hover:bg-sidebar-accent">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{initials(user.name ?? user.email)}</span>
            <span className="min-w-0 group-data-[collapsible=icon]:hidden">
              <span className="block truncate text-sm font-medium">{user.name ?? firstName(user.email)}</span>
              <span className="block text-xs capitalize text-muted-foreground">{user.class ?? 'No access'}</span>
            </span>
          </Link>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
