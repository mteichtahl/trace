/**
 * "Want a tap on the shoulder?" (the phone redesign, "Turn on notifications"): offered once per device, right after
 * the person answers something in one tap (Home or Next), when push is not on here yet. It lists the four kinds, all
 * ticked, and turns push on for this device and the ticked kinds (lib/push.ts turnOn, then me.set). On an iPhone in
 * Safari it says how to add trace to the Home Screen first. "Not now" does not ask again on this device; Preferences,
 * Notifications, has the same switches.
 */
import { Bell, Loader2, Share } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { PUSH_WORDS } from '@/components/prefs/groups'
import { useSetMe } from '@/lib/prefs'
import { type PushState, pushState, turnOn } from '@/lib/push'
import { NOTIFY_KINDS, type NotifyKind } from '@/lib/settings-catalog'
import { createStore, useStore } from '@/lib/store'

const ASKED = 'trace.push.asked'
const prompt = createStore<{ open: boolean; state: PushState | null }>({ open: false, state: null })

const askedHere = (): boolean => { try { return localStorage.getItem(ASKED) === '1' } catch { return true } }
const markAsked = (): void => { try { localStorage.setItem(ASKED, '1') } catch { /* private mode: it may ask again */ } }

/** After a one-tap answer: offer push, once per device, when it could be turned on here and is not on yet. */
export async function offerPush(): Promise<void> {
  if (askedHere()) return
  const state = await pushState().catch(() => 'unsupported' as const)
  if (state === 'on' || state === 'denied' || state === 'unsupported') return
  // after the answer's toast has been read, which then makes way: it would sit over the prompt's buttons
  setTimeout(() => { toast.dismiss(); prompt.set({ open: true, state }) }, 1800)
}

/** Mounted once in the shell. */
export function PushPrompt() {
  const p = useStore(prompt)
  const setMe = useSetMe()
  const [kinds, setKinds] = useState<Set<NotifyKind>>(() => new Set(NOTIFY_KINDS.map((k) => k.id)))
  const [busy, setBusy] = useState(false)
  const homeScreen = p.state === 'needs-home-screen'
  const close = () => { markAsked(); prompt.set({ open: false, state: null }) }

  const go = async () => {
    setBusy(true)
    try {
      const state = await turnOn()
      if (state !== 'on') {
        toast(PUSH_WORDS[state])
        if (state === 'needs-home-screen') return
        close()
        return
      }
      await Promise.all([...kinds].map((k) => setMe.mutateAsync({ key: `prefs.notifications.kinds.${k}.push`, value: true })))
      toast('Notifications are on for this device.', { description: 'Change which ones in Preferences, Notifications.' })
      close()
    } catch (e) {
      toast.error(`Push could not be turned on: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer open={p.open} onOpenChange={(o) => !o && close()}>
      <DrawerContent className="mx-auto max-w-md">
        <DrawerHeader className="items-start text-left md:text-left">
          <span className="mb-2 flex size-12 items-center justify-center rounded-xl bg-primary-soft text-primary" aria-hidden>
            <Bell className="size-6" />
          </span>
          <DrawerTitle className="text-left text-xl">Done in a tap.</DrawerTitle>
          <DrawerDescription className="text-left text-[15px] leading-relaxed text-foreground/80">
            Want trace to tap you on the shoulder next time? Each notification opens straight on its card, so you can answer from your lock screen.
          </DrawerDescription>
        </DrawerHeader>
        <div className="space-y-4 px-4 pb-6">
          {homeScreen ? (
            <ol className="space-y-2 rounded-xl border p-4 text-sm">
              <li className="flex items-center gap-2">1. Tap <Share className="size-4" aria-label="Share" /> in Safari's toolbar</li>
              <li>2. Choose <span className="font-medium">Add to Home Screen</span></li>
              <li>3. Open trace from your Home Screen, and turn notifications on there</li>
            </ol>
          ) : (
            <fieldset className="divide-y rounded-xl border">
              <legend className="sr-only">What to tell you about</legend>
              {NOTIFY_KINDS.map((k) => (
                <label key={k.id} className="flex min-h-12 items-center gap-3 px-4 text-[15px]">
                  <span className="flex-1">{k.label}</span>
                  <Checkbox
                    checked={kinds.has(k.id)}
                    onCheckedChange={(v) => setKinds((s) => { const n = new Set(s); if (v) n.add(k.id); else n.delete(k.id); return n })}
                    aria-label={k.label}
                  />
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-sm text-muted-foreground">Quiet hours and per-project choices are in Preferences, Notifications.</p>
          <div className="space-y-1">
            {homeScreen ? (
              <Button className="h-12 w-full text-base" onClick={close}>Got it</Button>
            ) : (
              <Button className="h-12 w-full text-base" onClick={() => void go()} disabled={busy || kinds.size === 0}>
                {busy && <Loader2 className="animate-spin" aria-hidden />} Turn on notifications
              </Button>
            )}
            {!homeScreen && <Button variant="ghost" className="h-11 w-full text-muted-foreground" onClick={close}>Not now</Button>}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
