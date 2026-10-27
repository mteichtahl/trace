/** The person's menu: who they are, the theme in one click, Preferences, shortcuts and Sign out. */
import { Link, useNavigate } from '@tanstack/react-router'
import { Keyboard, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { signOut, useAuth } from '@/lib/auth'
import { initials } from '@/lib/format'
import { usePrefs, useSetPref } from '@/lib/prefs'
import { shortcutsOpen } from './shortcuts'

export function PersonMenu() {
  const { user } = useAuth()
  const prefs = usePrefs()
  const setPref = useSetPref()
  const navigate = useNavigate()
  if (!user) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Your menu">
          <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">{initials(user.name ?? user.email)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate font-medium">{user.name ?? user.email}</p>
          <p className="truncate text-xs capitalize text-muted-foreground">{user.class ?? 'No access yet'}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={prefs.display.theme} onValueChange={(v) => setPref('display', 'theme', v as 'system' | 'light' | 'dark')}>
          <DropdownMenuRadioItem value="system"><Monitor /> System</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light"><Sun /> Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><Moon /> Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/me"><Settings /> Preferences</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => shortcutsOpen.set(true)}>
          <Keyboard /> Keyboard shortcuts <span className="ml-auto text-xs text-muted-foreground">?</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut().then(() => navigate({ to: '/sign-in' }))}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
