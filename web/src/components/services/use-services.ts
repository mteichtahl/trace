import { useQuery } from '@tanstack/react-query'
import { ago } from '@/lib/format'
import { q } from '@/lib/queries'
import { type Service, canWords, isExternalOff } from '@/lib/services'

/** services.list, without retrying when external access is off (that answer will not change on a retry). */
export const useServices = () => useQuery({ ...q('services.list', {}), retry: (n, e) => !isExternalOff(e) && n < 2 })

export interface ServiceRow extends Service {
  can: string
  projectCount: number
  usedAt: number
  used: string
  status: 'Active' | 'Disabled'
}

/** The table's rows: what it can do in words, how many projects, last used relative, status. */
export function toRows(list: Service[], now = Date.now()): ServiceRow[] {
  return list.map((s) => ({
    ...s, can: canWords(s.scopes), projectCount: s.projects.length, usedAt: s.last_used ? Date.parse(s.last_used) : 0,
    used: s.last_used ? ago(s.last_used, now) : 'Never', status: s.disabled ? 'Disabled' : 'Active',
  }))
}
