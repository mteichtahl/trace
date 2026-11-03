/**
 * The "More" menu that holds GitHub's own pages (docs/stay-in-trace.md, decision C): nobody needs them, so only admins
 * see the menu at all, as a way through when something unexpected happens on GitHub. Everyone else is never shown a
 * GitHub link. Renders nothing for a person who is not an admin, or when there are no links.
 */
import { ExternalLink, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

export interface AdminLink { label: string; href: string }

/** Only https://github.com/ links: anything else is not GitHub's page and has no business in this menu. */
const github = (l: AdminLink): boolean => /^https:\/\/github\.com\//.test(l.href)

export function MoreForAdmins({ links, className, label = 'More' }: { links: readonly (AdminLink | null | undefined | false)[]; className?: string; label?: string }) {
  const { user } = useAuth()
  const shown = links.filter((l): l is AdminLink => !!l && github(l))
  if (user?.class !== 'admin' || !shown.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn('h-8 gap-1 text-muted-foreground', className)} aria-label={label}>
          <MoreHorizontal aria-hidden /> <span className="sr-only sm:not-sr-only">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">For admins</DropdownMenuLabel>
        {shown.map((l) => (
          <DropdownMenuItem key={l.href} asChild>
            <a href={l.href} target="_blank" rel="noreferrer">
              {l.label} <ExternalLink className="ml-auto size-3.5" aria-hidden />
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
