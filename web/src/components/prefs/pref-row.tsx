/**
 * One setting on Preferences: its name, a one-line explanation and its control, with a quiet "Saved" beside the
 * control after a change and a lock with the reason when an admin has fixed it for everyone.
 */
import { Check, Lock, Monitor } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useMe, useSetMe, getPath } from '@/lib/prefs'
import { cn } from '@/lib/utils'
import { SETTINGS } from '@/lib/settings-catalog'
import { createStore, useStore } from '@/lib/store'

/** When each key was last saved (epoch ms), so its row can say "Saved". */
const savedAt = createStore<Record<string, number>>({})

/** Write one preference (a path under prefs) at once; its row says "Saved" when the API confirms it. */
export function useSave() {
  const m = useSetMe()
  return useCallback(
    (key: string, value: unknown, o: { row?: string } = {}) =>
      m.mutate(
        { key: `prefs.${key}`, value },
        { onSuccess: () => savedAt.set((s) => ({ ...s, [o.row ?? key]: Date.now() })) },
      ),
    [m],
  )
}

export const markSaved = (row: string) => savedAt.set((s) => ({ ...s, [row]: Date.now() }))

/** A stored preference by path (prefs.<key>), or the fallback. */
export function usePrefValue<T>(key: string, fallback: T): T {
  const { data } = useMe()
  const v = getPath(data?.prefs, key)
  return (v === undefined || v === null ? fallback : v) as T
}

/** Settings an admin has fixed for everyone: id → reason (assumed: me.get answers them as `locks`). */
export function useLocks(): Record<string, string> {
  const { data } = useMe()
  return ((data as { locks?: Record<string, string> } | undefined)?.locks ?? {}) as Record<string, string>
}

function Saved({ id }: { id: string }) {
  const at = useStore(savedAt)[id]
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!at) return
    setShown(true)
    const t = setTimeout(() => setShown(false), 2500)
    return () => clearTimeout(t)
  }, [at])
  return (
    <span aria-live="polite" className={cn('inline-flex items-center gap-1 text-xs text-verified transition-opacity', shown ? 'opacity-100' : 'opacity-0')}>
      {shown && <><Check className="size-3.5" aria-hidden /> Saved</>}
    </span>
  )
}

export interface PrefRowProps {
  /** the setting's id in lib/settings-catalog.ts: its name and line come from there */
  id: string
  label?: string
  line?: ReactNode
  children: ReactNode
  /** kept on this device only */
  device?: boolean
  /** the reason it is locked (else from me.get's locks) */
  locked?: string | null
  className?: string
}

export function PrefRow({ id, label, line, children, device, locked, className }: PrefRowProps) {
  const s = SETTINGS.find((x) => x.id === id)
  const locks = useLocks()
  const lock = locked ?? locks[id] ?? null
  return (
    <div id={`setting-${id}`} className={cn('grid scroll-mt-24 gap-3 border-b py-5 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:gap-8', className)} data-density-item>
      <div>
        <p className="text-sm font-medium">{label ?? s?.label}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{line ?? s?.line}</p>
        {lock && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden /> <span><span className="sr-only">Locked: </span>{lock}</span>
          </p>
        )}
      </div>
      <div className="min-w-0">
        <div className={cn('flex flex-wrap items-center gap-3', lock && 'pointer-events-none opacity-60')} aria-disabled={!!lock || undefined}>
          {children}
          <Saved id={id} />
        </div>
        {(device ?? s?.device) && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Monitor className="size-3.5" aria-hidden /> Kept on this device</p>
        )}
      </div>
    </div>
  )
}

/** A row of choices as a segmented control (radios underneath). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg bg-muted p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded-md px-3 py-1.5 text-sm text-muted-foreground', value === o.value && 'bg-background font-medium text-foreground shadow-sm')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Device-only settings (the microphone, Bench mode), kept in this browser. */
export function readDevice<T>(name: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`trace.device.${name}`)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
export function writeDevice(name: string, value: unknown): void {
  try {
    localStorage.setItem(`trace.device.${name}`, JSON.stringify(value))
  } catch {
    // private mode: the choice lasts for this page only
  }
}

export { SETTINGS }
