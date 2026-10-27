/**
 * ⌘K: search projects and run actions by name. Anything it cannot find it offers to ask trace.
 * Screens add their own actions while mounted with `useCommands([...])` ("Sign gate", "Raise a change").
 */
import { useNavigate } from '@tanstack/react-router'
import { FolderClosed, Moon, Sparkles, Sun, Monitor, ArrowRight } from 'lucide-react'
import { useEffect, useId, useState, type ComponentType } from 'react'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'
import { projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSetPref } from '@/lib/prefs'
import { useProjects } from '@/lib/queries'
import { createStore, useStore } from '@/lib/store'
import { openPanel } from '@/components/chat/chat-state'
import { AREAS } from './nav'

export interface CommandAction {
  id: string
  label: string
  group?: string
  keywords?: string[]
  icon?: ComponentType<{ className?: string }>
  shortcut?: string
  run: () => void
}

const registry = createStore<Record<string, CommandAction[]>>({})
export const commandOpen = createStore(false)

/** Offer these actions in ⌘K while the calling screen is mounted. */
export function useCommands(actions: CommandAction[]) {
  const id = useId()
  const json = JSON.stringify(actions.map((a) => a.id + a.label))
  useEffect(() => {
    registry.set((r) => ({ ...r, [id]: actions }))
    return () => registry.set((r) => {
      const { [id]: _gone, ...rest } = r
      return rest
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, json])
}

export function CommandMenu() {
  const open = useStore(commandOpen)
  const extra = Object.values(useStore(registry)).flat()
  const [text, setText] = useState('')
  const navigate = useNavigate()
  const projects = useProjects()
  const { user } = useAuth()
  const setPref = useSetPref()
  const go = (f: () => void) => {
    commandOpen.set(false)
    setText('')
    f()
  }
  return (
    <CommandDialog open={open} onOpenChange={commandOpen.set} title="Search or run a command" description="Projects, screens and actions">
      <CommandInput placeholder="Search or run a command…" value={text} onValueChange={setText} />
      <CommandList>
        <CommandEmpty>
          <button type="button" className="mx-auto flex items-center gap-2 text-sm" onClick={() => go(() => openPanel(true))}>
            <Sparkles className="size-4" /> Ask trace about “{text}”
          </button>
        </CommandEmpty>
        {extra.length > 0 && (
          <CommandGroup heading="On this screen">
            {extra.map((a) => (
              <CommandItem key={a.id} value={`${a.label} ${a.keywords?.join(' ') ?? ''}`} onSelect={() => go(a.run)}>
                {a.icon ? <a.icon /> : <ArrowRight />} {a.label}
                {a.shortcut && <CommandShortcut>{a.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Projects">
          {(projects.data ?? []).map((p) => (
            <CommandItem key={p.repo} value={`project ${projectName(p.repo)} ${p.repo}`} onSelect={() => go(() => void navigate({ to: '/p/$id', params: { id: projectId(p.repo) } }))}>
              <FolderClosed /> {projectName(p.repo)}
              <span className="ml-auto font-mono text-xs text-muted-foreground">{p.repo}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          {AREAS.filter((a) => !('admin' in a && a.admin) || user?.class === 'admin').map((a) => (
            <CommandItem key={a.to} value={`go ${a.label}`} onSelect={() => go(() => void navigate({ to: a.to }))}>
              <a.icon /> {a.label}
            </CommandItem>
          ))}
          <CommandItem value="go inbox notifications" onSelect={() => go(() => void navigate({ to: '/inbox' }))}>
            <ArrowRight /> Inbox
          </CommandItem>
          <CommandItem value="go preferences settings me" onSelect={() => go(() => void navigate({ to: '/me' }))}>
            <ArrowRight /> Preferences
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem value="ask trace chat" onSelect={() => go(() => openPanel(true))}>
            <Sparkles /> Ask trace <CommandShortcut>⌘J</CommandShortcut>
          </CommandItem>
          <CommandItem value="theme light" onSelect={() => go(() => setPref('display', 'theme', 'light'))}>
            <Sun /> Light theme
          </CommandItem>
          <CommandItem value="theme dark" onSelect={() => go(() => setPref('display', 'theme', 'dark'))}>
            <Moon /> Dark theme
          </CommandItem>
          <CommandItem value="theme system" onSelect={() => go(() => setPref('display', 'theme', 'system'))}>
            <Monitor /> Follow the system theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
