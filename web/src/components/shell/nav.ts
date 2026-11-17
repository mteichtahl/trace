import { Activity, ArrowRight, Bot, FolderClosed, Library, Shield } from 'lucide-react'

/**
 * The left rail's areas. The first three are what a person does every day; Agents, Operations and Admin sit under one
 * System heading below the pinned projects (docs/ui-simplify.md, "Running work, and System"). Admin shows for admins only.
 */
export const AREAS = [
  { to: '/', label: 'Next', icon: ArrowRight, exact: true, count: true },
  { to: '/projects', label: 'Projects', icon: FolderClosed, also: ['/p/'] },
  { to: '/knowledge', label: 'Knowledge', icon: Library },
  { to: '/agents', label: 'Agents', icon: Bot, system: true },
  { to: '/ops', label: 'Operations', icon: Activity, system: true },
  { to: '/admin/people', label: 'Admin', icon: Shield, admin: true, system: true, also: ['/admin'] },
] as const

export const isActive = (pathname: string, a: (typeof AREAS)[number]): boolean => {
  if ('exact' in a && a.exact) return pathname === a.to
  if (pathname === a.to || pathname.startsWith(`${a.to}/`)) return true
  return 'also' in a && (a.also as readonly string[]).some((p) => pathname.startsWith(p))
}
