/**
 * Keyboard shortcuts: ⌘K search, ⌘J Ask trace, ⌘B the rail, G then H Home (G then P Projects, G then I Inbox),
 * ? lists them. Typing in a field never triggers the letter shortcuts.
 */
import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createStore, useStore } from '@/lib/store'
import { openPanel } from '@/components/chat/chat-state'
import { commandOpen } from './command-menu'

export const shortcutsOpen = createStore(false)

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

export const SHORTCUTS: { keys: string[]; does: string }[] = [
  { keys: [mod, 'K'], does: 'Search or run a command' },
  { keys: [mod, 'J'], does: 'Open or close Ask trace' },
  { keys: [mod, 'B'], does: 'Fold the rail to icons' },
  { keys: [mod, 'Shift', 'Space'], does: 'Dictate a message' },
  { keys: ['G', 'H'], does: 'Go to Home' },
  { keys: ['G', 'P'], does: 'Go to Projects' },
  { keys: ['G', 'I'], does: 'Go to Inbox' },
  { keys: ['↑', '↓'], does: 'Recall messages you sent (in the message box)' },
  { keys: ['Esc'], does: 'Close, or leave Focus mode' },
  { keys: ['?'], does: 'Show these shortcuts' },
]

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

export function useShortcuts() {
  const navigate = useNavigate()
  useEffect(() => {
    let g = 0
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && k === 'k') {
        e.preventDefault()
        commandOpen.set(!commandOpen.get())
        return
      }
      if ((e.metaKey || e.ctrlKey) && k === 'j') {
        e.preventDefault()
        openPanel()
        return
      }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '?') {
        e.preventDefault()
        shortcutsOpen.set(true)
        return
      }
      if (k === 'g') {
        g = Date.now()
        return
      }
      if (Date.now() - g < 1200) {
        g = 0
        const to = k === 'h' ? '/' : k === 'p' ? '/projects' : k === 'i' ? '/inbox' : null
        if (to) {
          e.preventDefault()
          void navigate({ to })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])
}

export function ShortcutsDialog() {
  const open = useStore(shortcutsOpen)
  return (
    <Dialog open={open} onOpenChange={shortcutsOpen.set}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>They work anywhere except while typing in a field.</DialogDescription>
        </DialogHeader>
        <dl className="divide-y text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.does} className="flex items-center justify-between py-2">
              <dt>{s.does}</dt>
              <dd className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
