/**
 * Preferences (docs/ui-design.md, "Preferences"): everything a person can set for themselves, in nine groups, stored
 * with the person (me.get / me.set) so it follows them to every device. Groups on the left (a Select on phones),
 * the group's settings on the right; changes apply at once with a quiet "Saved"; each group has Reset to defaults;
 * settings an admin fixed show locked with the reason; search finds any setting, and so does ⌘K
 * (/me?setting=<id> opens it).
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Lock, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { z } from 'zod'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChatGroup, DataGroup, DisplayGroup, FormatsGroup, NotificationsGroup, ProfileGroup, SecurityGroup, ThemeChooser, VoiceGroup, WorkGroup, useResetGroup } from '@/components/prefs/groups'
import { useLocks } from '@/components/prefs/pref-row'
import { useCommands } from '@/components/shell/command-menu'
import { Loading, QueryError, SkeletonRows } from '@/components/states'
import { useTraceContext } from '@/components/chat/context'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useMe } from '@/lib/prefs'
import { GROUPS, type GroupId, SETTINGS, searchSettings } from '@/lib/settings-catalog'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/me')({
  staticData: { crumb: 'Preferences' },
  validateSearch: z.object({ group: z.string().optional(), setting: z.string().optional() }),
  component: Preferences,
})

const BODY: Record<GroupId, ComponentType> = {
  profile: ProfileGroup, security: SecurityGroup, notifications: NotificationsGroup, voice: VoiceGroup, chat: ChatGroup,
  display: DisplayGroup, formats: FormatsGroup, work: WorkGroup, data: DataGroup,
}
/** Groups whose values live under prefs.<group> and so reset in one write. */
const RESETTABLE: GroupId[] = ['profile', 'notifications', 'voice', 'chat', 'display', 'formats', 'work', 'data']

/** The group a search names, from ?setting= first, then ?group=, else Profile. */
export function groupFrom(search: { group?: string; setting?: string }): GroupId {
  const g = SETTINGS.find((s) => s.id === search.setting)?.group ?? search.group
  return GROUPS.some((x) => x.id === g) ? (g as GroupId) : 'profile'
}

function Preferences() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const me = useMe()
  const locks = useLocks()
  const phone = useMediaQuery('(max-width: 767px)')
  const group = groupFrom(search)
  const [text, setText] = useState('')
  const [resetting, setResetting] = useState<GroupId | null>(null)
  const reset = useResetGroup()
  const found = useMemo(() => (text.trim() ? searchSettings(text) : []), [text])
  const go = (g: GroupId, setting?: string) => void navigate({ to: '/me', search: { group: g, ...(setting ? { setting } : {}) }, replace: true })

  // bring the setting ⌘K or search picked into view
  useEffect(() => {
    if (!search.setting || !me.isSuccess) return
    const t = setTimeout(() => {
      const el = document.getElementById(`setting-${search.setting}`)
      el?.scrollIntoView({ block: 'center' })
      el?.classList.add('bg-primary/5')
      setTimeout(() => el?.classList.remove('bg-primary/5'), 1600)
    }, 120)
    return () => clearTimeout(t)
  }, [search.setting, group, me.isSuccess])

  const g = GROUPS.find((x) => x.id === group)!
  const Body = BODY[group]
  const lockEntries = Object.entries(locks)

  useTraceContext({ label: `Preferences · ${g.label}`, description: 'The screen the person is on: their own preferences', value: { group: g.label } }, 'screen')
  useCommands([
    ...GROUPS.map((x) => ({ id: `prefs-group-${x.id}`, label: `Preferences: ${x.label}`, group: 'Preferences', icon: SlidersHorizontal, run: () => go(x.id) })),
    ...(RESETTABLE.includes(group) ? [{ id: 'prefs-reset', label: `Reset ${g.label} to defaults`, group: 'Preferences', run: () => setResetting(group) }] : []),
  ])

  const nav = phone ? (
    <Select value={group} onValueChange={(v) => go(v as GroupId)}>
      <SelectTrigger className="w-full" aria-label="Group"><SelectValue /></SelectTrigger>
      <SelectContent>{GROUPS.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>)}</SelectContent>
    </Select>
  ) : (
    <nav aria-label="Groups">
      <ul className="space-y-0.5">
        {GROUPS.map((x) => (
          <li key={x.id}>
            <button type="button" onClick={() => go(x.id)} aria-current={x.id === group ? 'page' : undefined} className={cn('w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent', x.id === group && 'bg-accent font-medium')}>
              {x.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-10">
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10">
        <aside className="space-y-4 md:sticky md:top-20 md:self-start">
          <h1 className="text-2xl font-semibold tracking-tight">Preferences</h1>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Find a setting" className="pl-8" aria-label="Find a setting" />
          </div>
          {text.trim() ? (
            <ul className="space-y-0.5" aria-label="Settings found">
              {found.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No setting matches.</li>}
              {found.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => { setText(''); go(s.group, s.id) }} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent">
                    {s.label}
                    <span className="block text-xs text-muted-foreground">{GROUPS.find((x) => x.id === s.group)?.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            nav
          )}
        </aside>

        <main className="min-w-0">
          {(group !== 'display' || lockEntries.length > 0) && (
            <div className="mb-6 grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              {group !== 'display' && (
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-sm font-medium">Theme</p>
                  <p className="mb-3 text-xs text-muted-foreground">System follows your device.</p>
                  <ThemeChooser />
                </div>
              )}
              {lockEntries.slice(0, 1).map(([id, reason]) => (
                <div key={id} className="self-start rounded-xl border bg-muted/50 p-4">
                  <p className="flex items-center gap-2 text-sm font-medium"><Lock className="size-4" aria-hidden /> {reason.split(/[,.]/)[0]}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{GROUPS.find((x) => x.id === SETTINGS.find((s) => s.id === id)?.group)?.label} · set by an admin, so you can't change it here.</p>
                </div>
              ))}
            </div>
          )}

          <section aria-labelledby="group-title">
            <div className="flex items-start justify-between gap-3 border-b pb-3">
              <div>
                <h2 id="group-title" className="section-label">{g.label}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{g.line}</p>
              </div>
              {RESETTABLE.includes(group) && <Button variant="ghost" size="sm" onClick={() => setResetting(group)}>Reset to defaults</Button>}
            </div>
            {me.isError ? (
              <div className="mt-4"><QueryError error={me.error} what="your preferences" onRetry={() => void me.refetch()} /></div>
            ) : me.isLoading ? (
              <Loading><SkeletonRows rows={4} className="mt-4" /></Loading>
            ) : (
              <Body />
            )}
          </section>
          <p className="mt-8 text-xs text-muted-foreground">
            Everything here is stored with you, so it follows you to every device, except the microphone and Bench mode, which are kept on this device. Anything that changes a project lives in that project's Settings.
          </p>
        </main>
      </div>

      <AlertDialog open={!!resetting} onOpenChange={(o) => !o && setResetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset {GROUPS.find((x) => x.id === resetting)?.label} to defaults?</AlertDialogTitle>
            <AlertDialogDescription>Every setting in this group goes back to trace's default, on every device. Other groups stay as they are.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => resetting && reset(resetting)}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
