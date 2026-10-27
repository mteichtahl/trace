import { Activity, Bot, FolderClosed, House, Library, Shield } from 'lucide-react'

/** The left rail's areas. Admin shows for admins only. */
export const AREAS = [
  { to: '/', label: 'Home', icon: House, exact: true },
  { to: '/projects', label: 'Projects', icon: FolderClosed, also: ['/p/'] },
  { to: '/knowledge', label: 'Knowledge', icon: Library },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/ops', label: 'Operations', icon: Activity },
  { to: '/admin/people', label: 'Admin', icon: Shield, admin: true, also: ['/admin'] },
] as const

export const isActive = (pathname: string, a: (typeof AREAS)[number]): boolean => {
  if ('exact' in a && a.exact) return pathname === a.to
  if (pathname === a.to || pathname.startsWith(`${a.to}/`)) return true
  return 'also' in a && (a.also as readonly string[]).some((p) => pathname.startsWith(p))
}
