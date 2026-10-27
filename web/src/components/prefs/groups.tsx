/**
 * Preferences' nine groups (docs/ui-design.md, "Preferences"), each a list of PrefRows. Every change applies at once
 * through me.set (prefs.<group>.<key>) with a quiet "Saved"; Display drives the app's theme hooks live (lib/theme.ts
 * reads the same preferences). Sign-in and security uses /api/auth/passkeys* and /api/auth/totp/*; Your data
 * assembles Download my data in the browser from me.get and chats.list / chats.get.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, KeyRound, Loader2, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { shortcutsOpen, SHORTCUTS } from '@/components/shell/shortcuts'
import { Loading, QueryError, SkeletonRows } from '@/components/states'
import { listVoices, previewVoice, stopSpeaking, useSpeech } from '@/components/chat/voice/speech'
import { api, call, projectName } from '@/lib/api'
import type { Passkey } from '@/lib/admin-types'
import { useAuth } from '@/lib/auth'
import { ago, initials } from '@/lib/format'
import { ME_KEY, usePrefs, useSetMe } from '@/lib/prefs'
import { CHANNELS, NOTIFY_KINDS, notifyLock, notifyPrefs } from '@/lib/settings-catalog'
import { useProjects } from '@/lib/queries'
import type { MeDoc, Prefs } from '@/lib/types'
import { createCredential, passkeysSupported } from '@/lib/webauthn'
import type { PublicKeyCredentialCreationOptionsJSONish } from '@/lib/types'
import { cn } from '@/lib/utils'
import { PrefRow, Segmented, markSaved, readDevice, usePrefValue, useSave, writeDevice } from './pref-row'

// ------------------------------------------------------------------ Profile

const LANGUAGES = [{ value: 'en', label: 'English' }]
const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

export function ProfileGroup() {
  const { user } = useAuth()
  const p = usePrefs().profile
  const save = useSave()
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [name, setName] = useState(p.name ?? user?.name ?? '')
  useEffect(() => setName(p.name ?? user?.name ?? ''), [p.name, user?.name])
  const list = zones()
  return (
    <>
      <PrefRow id="profile.name" line="How you appear to others on your projects. Your photo comes from your initials until photos can be uploaded.">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden>{initials(name || user?.email || '?')}</span>
        <Input aria-label="Your name" className="w-60" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() !== (p.name ?? '') && save('profile.name', name.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </PrefRow>
      <PrefRow id="profile.timeZone" line={`Times on screen and in emails use it. Your browser says ${browserZone}.`}>
        <Select value={p.timeZone ?? 'browser'} onValueChange={(v) => save('profile.timeZone', v === 'browser' ? null : v)}>
          <SelectTrigger className="w-64" aria-label="Time zone"><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="browser">The browser's ({browserZone})</SelectItem>
            {list.map((z) => <SelectItem key={z} value={z}>{z.replace(/_/g, ' ')}</SelectItem>)}
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow id="profile.language" line="English first; others appear here as they are translated.">
        <Select value={p.language ?? 'en'} onValueChange={(v) => save('profile.language', v)}>
          <SelectTrigger className="w-48" aria-label="Language of the app"><SelectValue /></SelectTrigger>
          <SelectContent>{LANGUAGES.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
        </Select>
      </PrefRow>
    </>
  )
}

// ------------------------------------------------------------------ Sign-in and security

function Qr({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    void import('qrcode').then((q) => q.toDataURL(uri, { margin: 1, width: 176 })).then(setSrc).catch(() => setSrc(null))
  }, [uri])
  return src ? <img src={src} alt="QR code for your authenticator app" className="size-44 rounded-md border bg-white p-1" /> : <div className="size-44 rounded-md border bg-muted" />
}

export function SecurityGroup() {
  const qc = useQueryClient()
  const keys = useQuery({ queryKey: ['auth.passkeys'], queryFn: () => api<{ passkeys: Passkey[] }>('/api/auth/passkeys'), retry: false })
  const locks = (qc.getQueryData<MeDoc & { locks?: Record<string, string> }>(ME_KEY))?.locks ?? {}
  const required = locks['security.passkeys']
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Passkey | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const names = usePrefValue<Record<string, string>>('security.passkeyNames', {})
  const save = useSave()
  const list = keys.data?.passkeys ?? []
  const nameOf = (k: Passkey) => names[k.id] ?? k.name ?? (k.attachment === 'platform' ? 'This device' : 'Security key')

  const add = async () => {
    setAdding(true)
    try {
      const { options } = await api<{ options: PublicKeyCredentialCreationOptionsJSONish }>('/api/auth/passkeys/start', { method: 'POST', body: {} })
      const credential = await createCredential(options)
      await api('/api/auth/passkeys/finish', { method: 'POST', body: { credential } })
      toast('Passkey added. You can sign in with it now.')
      await qc.invalidateQueries({ queryKey: ['auth.passkeys'] })
      markSaved('security.passkeys')
    } catch (e) {
      toast.error(`No passkey was added: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <PrefRow id="security.passkeys" locked={null}>
        <div className="w-full space-y-2">
          {keys.isError ? (
            <QueryError error={keys.error} what="your passkeys" onRetry={() => void keys.refetch()} />
          ) : keys.isLoading ? (
            <Loading><SkeletonRows rows={1} /></Loading>
          ) : (
            <ul className="divide-y rounded-lg border">
              {list.length === 0 && <li className="px-3 py-2.5 text-sm text-muted-foreground">No passkeys yet.</li>}
              {list.map((k) => {
                const last = list.length === 1 && !!required
                return (
                  <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                    {renaming === k.id ? (
                      <Input
                        autoFocus
                        defaultValue={nameOf(k)}
                        aria-label="Passkey name"
                        className="h-8 w-48"
                        onBlur={(e) => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== nameOf(k)) save('security.passkeyNames', { ...names, [k.id]: v }, { row: 'security.passkeys' }) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }}
                      />
                    ) : (
                      <span className="font-medium">{nameOf(k)}</span>
                    )}
                    <span className="text-xs text-muted-foreground">{k.createdAt ? `added ${ago(k.createdAt)}` : ''}</span>
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setRenaming(k.id)}>Rename</Button>
                      <Button size="sm" variant="ghost" disabled={last} title={last ? required : undefined} onClick={() => setRemoving(k)} aria-label={`Remove ${nameOf(k)}`}><Trash2 /> Remove</Button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <Button variant="outline" size="sm" disabled={adding || !passkeysSupported()} onClick={() => void add()}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />} Add a passkey
          </Button>
          {!passkeysSupported() && <p className="text-xs text-muted-foreground">This browser cannot make passkeys.</p>}
          {required && <p className="text-xs text-muted-foreground">{required}</p>}
          <p className="text-xs text-muted-foreground">Names are kept with your preferences; Cognito keeps the name the device gave.</p>
        </div>
      </PrefRow>
      <TotpRow />
      <PrefRow id="security.sessions">
        <p className="text-sm text-muted-foreground">
          This browser is signed in now. trace cannot list your other sessions yet (the sign-in service has no read for them); signing out here ends this browser's session, and changing your password ends the others.
        </p>
      </PrefRow>
      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing ? nameOf(removing) : ''}?</AlertDialogTitle>
            <AlertDialogDescription>You will no longer be able to sign in with it. Your other ways to sign in stay as they are.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!removing) return
                try {
                  await api(`/api/auth/passkeys/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
                  toast('Passkey removed.')
                  await qc.invalidateQueries({ queryKey: ['auth.passkeys'] })
                  markSaved('security.passkeys')
                } catch (e) {
                  toast.error(`Could not remove it: ${e instanceof Error ? e.message : String(e)}`)
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TotpRow() {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    try {
      setSetup(await api<{ secret: string; uri: string }>('/api/auth/totp/start', { method: 'POST', body: {} }))
    } catch (e) {
      toast.error(`Could not start: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const verify = async (value: string) => {
    setBusy(true)
    try {
      const r = await api<{ ok: boolean }>('/api/auth/totp/verify', { method: 'POST', body: { code: value } })
      if (!r.ok) throw new Error('that code did not match; try the next one')
      toast('Authenticator app set up. trace asks for a code when you sign in with your password.')
      setSetup(null)
      setCode('')
      markSaved('security.password')
    } catch (e) {
      toast.error(`Not set up: ${e instanceof Error ? e.message : String(e)}`)
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <PrefRow id="security.password">
      {setup ? (
        <div className="space-y-3">
          <p className="text-sm">Scan this with your authenticator app, then enter the six-digit code it shows.</p>
          <Qr uri={setup.uri} />
          <p className="text-xs text-muted-foreground">Can't scan? Enter this key: <code className="font-mono">{setup.secret}</code></p>
          <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={(v) => void verify(v)} inputMode="numeric" aria-label="Six-digit code" disabled={busy}>
            <InputOTPGroup>{Array.from({ length: 6 }, (_, i) => <InputOTPSlot key={i} index={i} />)}</InputOTPGroup>
          </InputOTP>
          <Button size="sm" variant="ghost" onClick={() => setSetup(null)}>Cancel</Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void start()}>{busy && <Loader2 className="animate-spin" />} Set up an authenticator app</Button>
          <p className="text-xs text-muted-foreground">
            Setting it up again replaces the app you used before. To change or reset your password, use <a href="/sign-in/reset" className="text-primary hover:underline">Forgot password</a>; removing the password altogether needs the sign-in service to support it, which it does not yet.
          </p>
        </div>
      )}
    </PrefRow>
  )
}

// ------------------------------------------------------------------ Notifications

export function NotificationsGroup() {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const stored = usePrefValue<unknown>('notifications', {})
  const n = notifyPrefs(stored)
  const save = useSave()
  const projects = useProjects()
  const [pushAsk, setPushAsk] = useState(false)
  const setChannel = async (kind: string, ch: string, on: boolean) => {
    if (ch === 'push' && on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      setPushAsk(true)
      const p = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission)
      setPushAsk(false)
      if (p !== 'granted') {
        toast('Push stays off: this browser was not allowed to show notifications. You can allow it in the browser\'s site settings.')
        return
      }
    }
    save(`notifications.kinds.${kind}.${ch}`, on, { row: 'notifications.kinds' })
  }
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  return (
    <>
      <PrefRow id="notifications.kinds">
        <table className="w-full max-w-md text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="pb-2 text-left font-normal"><span className="sr-only">Kind</span></th>
              {CHANNELS.map((c) => <th key={c.id} className="pb-2 font-normal">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {NOTIFY_KINDS.map((k) => (
              <tr key={k.id}>
                <td className="py-1.5 pr-2">{k.label}</td>
                {CHANNELS.map((c) => {
                  const lock = notifyLock(k.id, c.id, admin)
                  return (
                    <td key={c.id} className="py-1.5 text-center">
                      <Switch
                        checked={lock ? true : n.kinds[k.id][c.id]}
                        disabled={!!lock || (c.id === 'push' && pushAsk)}
                        title={lock ?? undefined}
                        onCheckedChange={(v) => void setChannel(k.id, c.id, v)}
                        aria-label={`${k.label}: ${c.label}`}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {admin && <p className="w-full text-xs text-muted-foreground">Spend notifications cannot be turned off in the app for admins: you approve spend.</p>}
      </PrefRow>
      <PrefRow id="notifications.emailAfter">
        <Select value={n.emailAfter} onValueChange={(v) => save('notifications.emailAfter', v)}>
          <SelectTrigger className="w-48" aria-label="Email when unanswered for"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[['never', 'Never'], ['15m', '15 minutes'], ['1h', '1 hour'], ['4h', '4 hours'], ['morning', 'The next morning']].map(([v, l]) => <SelectItem key={v} value={v!}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow id="notifications.quiet">
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><Switch checked={n.quiet.on} onCheckedChange={(v) => save('notifications.quiet', { ...n.quiet, on: v })} aria-label="Quiet hours" /> {n.quiet.on ? 'On' : 'Off'}</label>
          {n.quiet.on && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                From <Input type="time" className="w-32" value={n.quiet.from} onChange={(e) => save('notifications.quiet', { ...n.quiet, from: e.target.value })} aria-label="Quiet from" />
                to <Input type="time" className="w-32" value={n.quiet.to} onChange={(e) => save('notifications.quiet', { ...n.quiet, to: e.target.value })} aria-label="Quiet until" />
              </div>
              <div className="flex gap-1" role="group" aria-label="Days">
                {DAYS.map((d, i) => {
                  const on = n.quiet.days.includes(i)
                  return (
                    <button key={i} type="button" aria-pressed={on} aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]} onClick={() => save('notifications.quiet', { ...n.quiet, days: on ? n.quiet.days.filter((x) => x !== i) : [...n.quiet.days, i].sort() })} className={cn('size-8 rounded-md border text-xs', on && 'border-primary bg-primary/10 font-medium text-primary')}>{d}</button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </PrefRow>
      <PrefRow id="notifications.projects">
        <ul className="w-full max-w-md space-y-2">
          {(projects.data ?? []).map((p) => (
            <li key={p.repo} className="flex items-center gap-3 text-sm">
              <span className="flex-1">{projectName(p.repo)}</span>
              <Select value={n.projects[p.repo] ?? 'normal'} onValueChange={(v) => save('notifications.projects', { ...n.projects, [p.repo]: v }, { row: 'notifications.projects' })}>
                <SelectTrigger size="sm" className="w-44" aria-label={`Notifications for ${projectName(p.repo)}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="gates-spend">Only gates and spend</SelectItem>
                </SelectContent>
              </Select>
            </li>
          ))}
          {!projects.data?.length && <li className="text-sm text-muted-foreground">You are not on a project yet.</li>}
        </ul>
      </PrefRow>
    </>
  )
}

// ------------------------------------------------------------------ Voice

const DICTATION = [['en-AU', 'English (Australia)'], ['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['en-IN', 'English (India)'], ['nl-NL', 'Dutch'], ['fr-FR', 'French'], ['de-DE', 'German'], ['es-ES', 'Spanish'], ['ja-JP', 'Japanese']]

export function VoiceGroup() {
  const v = usePrefs().voice
  const save = useSave()
  const speaking = useSpeech()
  const voices = useQuery({ queryKey: ['voice.voices', v.language], queryFn: () => listVoices(v.language), staleTime: 3600_000, retry: false })
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [mic, setMic] = useState<string>(() => readDevice('mic', 'default'))
  const current = v.voice ?? voices.data?.voices[0]?.id
  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices?.().then((d) => setMics(d.filter((x) => x.kind === 'audioinput'))).catch(() => undefined)
  }, [])
  return (
    <>
      <PrefRow id="voice.voice">
        {voices.isError ? (
          <p className="text-sm text-muted-foreground">Voices could not be loaded: reading aloud may be turned off for this installation.</p>
        ) : voices.isLoading ? (
          <Loading><SkeletonRows rows={2} className="w-full" /></Loading>
        ) : (
          <RadioGroup value={current} onValueChange={(id) => save('voice.voice', id)} className="w-full gap-0 overflow-hidden rounded-lg border">
            {(voices.data?.voices ?? []).map((x) => {
              const playing = speaking.playing && speaking.messageId === `preview-${x.id}`
              return (
                <div key={x.id} className={cn('flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0', current === x.id && 'bg-primary/5')}>
                  <RadioGroupItem id={`voice-${x.id}`} value={x.id} />
                  <Label htmlFor={`voice-${x.id}`} className="flex-1 cursor-pointer font-normal">
                    <span className="font-medium">{x.name}</span> <span className="text-xs text-muted-foreground">{x.engines.join(', ')} · {x.gender}</span>
                  </Label>
                  <Button size="icon" variant="outline" className="size-8" aria-label={playing ? `Stop ${x.name}` : `Preview ${x.name}`} onClick={() => (playing ? stopSpeaking() : void previewVoice(x.id).catch((e) => toast.error(`Could not play: ${e instanceof Error ? e.message : String(e)}`)))}>
                    {playing ? <Pause /> : <Play />}
                  </Button>
                </div>
              )
            })}
          </RadioGroup>
        )}
      </PrefRow>
      <PrefRow id="voice.rate">
        <span className="text-xs text-muted-foreground">0.75×</span>
        <Slider className="w-48" min={0.75} max={1.5} step={0.05} value={[v.rate]} onValueChange={([r]) => save('voice.rate', Math.round(r! * 100) / 100)} aria-label="Speaking speed" />
        <span className="text-xs text-muted-foreground">1.5×</span>
        <span className="w-12 text-sm tabular-nums">{v.rate}×</span>
      </PrefRow>
      <PrefRow id="voice.readAloud">
        <Segmented label="Read replies aloud" value={v.readAloud} onChange={(x) => save('voice.readAloud', x)} options={[{ value: 'off', label: 'Off' }, { value: 'summary', label: 'Summary only' }, { value: 'all', label: 'Whole reply' }]} />
      </PrefRow>
      <PrefRow id="voice.language">
        <Select value={v.language} onValueChange={(x) => save('voice.language', x)}>
          <SelectTrigger className="w-56" aria-label="Dictation language"><SelectValue /></SelectTrigger>
          <SelectContent>{DICTATION.map(([value, label]) => <SelectItem key={value} value={value!}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </PrefRow>
      <PrefRow id="voice.mic" device>
        <div className="space-y-2">
          <Segmented label="How dictation starts" value={v.mic} onChange={(x) => save('voice.mic', x)} options={[{ value: 'hold', label: 'Hold to talk' }, { value: 'tap', label: 'Tap to start and stop' }]} />
          <Select value={mic} onValueChange={(x) => { setMic(x); writeDevice('mic', x); markSaved('voice.mic') }}>
            <SelectTrigger className="w-64" aria-label="Which microphone"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">The system's microphone</SelectItem>
              {mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, i) => <SelectItem key={m.deviceId} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">The browser asks once for the microphone. To take that back, use the site settings beside the address bar.</p>
        </div>
      </PrefRow>
      <PrefRow id="voice.sendOnStop"><Switch checked={v.sendOnStop} onCheckedChange={(x) => save('voice.sendOnStop', x)} aria-label="Send when I stop talking" /></PrefRow>
      <PrefRow id="voice.commands"><Switch checked={v.commands} onCheckedChange={(x) => save('voice.commands', x)} aria-label="Spoken commands" /></PrefRow>
    </>
  )
}

// ------------------------------------------------------------------ Chat

export function ChatGroup() {
  const c = usePrefs().chat
  const save = useSave()
  const setMe = useSetMe()
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  return (
    <>
      <PrefRow id="chat.dock"><Segmented label="Open Ask trace on wide screens" value={c.dock} onChange={(x) => save('chat.dock', x)} options={[{ value: 'always', label: 'Always docked' }, { value: 'asked', label: 'Only when asked' }]} /></PrefRow>
      <PrefRow id="chat.enter">
        <RadioGroup value={c.enter} onValueChange={(x) => save('chat.enter', x)} className="gap-2">
          <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="enter" /> Enter sends, Shift+Enter adds a line</Label>
          <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="mod-enter" /> Enter adds a line, {mod}+Enter sends</Label>
        </RadioGroup>
      </PrefRow>
      <PrefRow id="chat.recall"><Switch checked={c.recall} onCheckedChange={(x) => save('chat.recall', x)} aria-label="Up and down recall" /></PrefRow>
      <PrefRow id="chat.toolRows"><Segmented label="Tool rows" value={c.toolRows} onChange={(x) => save('chat.toolRows', x)} options={[{ value: 'folded', label: 'Folded' }, { value: 'open', label: 'Open' }]} /></PrefRow>
      <PrefRow id="chat.reasoning"><Segmented label="Show reasoning" value={c.reasoning} onChange={(x) => save('chat.reasoning', x)} options={[{ value: 'hidden', label: 'Hidden' }, { value: 'folded', label: 'Folded' }]} /></PrefRow>
      <PrefRow id="chat.terms">
        <Select value={c.terms} onValueChange={(x) => save('chat.terms', x)}>
          <SelectTrigger className="w-64" aria-label="Explain technical terms"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Underline every time</SelectItem>
            <SelectItem value="first">First time in a conversation</SelectItem>
            <SelectItem value="never">Never</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow id="chat.recommendations"><Segmented label="Recommendations" value={c.recommendations} onChange={(x) => save('chat.recommendations', x)} options={[{ value: 'short', label: 'Short' }, { value: 'full', label: 'Full' }]} /></PrefRow>
      <PrefRow id="chat.tables">
        <Button variant="outline" onClick={() => setMe.mutate({ key: 'views', value: {} }, { onSuccess: () => { markSaved('chat.tables'); toast('Every table is back to its default view.') } })}>Reset all table views</Button>
      </PrefRow>
    </>
  )
}

// ------------------------------------------------------------------ Display

/** Theme pictures are fixed colours on purpose: they show each theme whichever one is on. */
const THEME_PICTURE: Record<Prefs['display']['theme'], CSSProperties> = {
  system: { background: 'linear-gradient(90deg, #ffffff 50%, #0a0a0a 50%)' },
  light: { background: '#ffffff' },
  dark: { background: '#0a0a0a' },
}

export function ThemeChooser() {
  const d = usePrefs().display
  const save = useSave()
  return (
    <RadioGroup value={d.theme} onValueChange={(x) => save('display.theme', x)} className="grid w-full grid-cols-3 gap-2" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((t) => (
        <Label key={t} htmlFor={`theme-${t}`} className="flex cursor-pointer flex-col gap-2 rounded-lg border p-2 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:ring-1 has-[[data-state=checked]]:ring-primary">
          <span className="relative block h-12 w-full overflow-hidden rounded-md border" style={THEME_PICTURE[t]} aria-hidden>
            <span className="absolute left-2 top-2 h-1.5 w-8 rounded-full" style={{ background: t === 'dark' ? '#525252' : '#d4d4d4' }} />
            <span className="absolute left-2 top-5 h-1.5 w-6 rounded-full bg-primary" />
          </span>
          <span className="flex items-center gap-2"><RadioGroupItem id={`theme-${t}`} value={t} /> {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}</span>
        </Label>
      ))}
    </RadioGroup>
  )
}

export function DisplayGroup() {
  const d = usePrefs().display
  const save = useSave()
  return (
    <>
      <PrefRow id="display.theme"><ThemeChooser /></PrefRow>
      <PrefRow id="display.density"><Segmented label="Density" value={d.density} onChange={(x) => save('display.density', x)} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /></PrefRow>
      <PrefRow id="display.textSize">
        <span className="text-xs text-muted-foreground">90%</span>
        <Slider className="w-48" min={0.9} max={1.25} step={0.05} value={[d.textSize]} onValueChange={([x]) => save('display.textSize', Math.round(x! * 100) / 100)} aria-label="Text size" />
        <span className="text-xs text-muted-foreground">125%</span>
        <span className="w-12 text-sm tabular-nums">{Math.round(d.textSize * 100)}%</span>
      </PrefRow>
      <PrefRow id="display.motion"><Segmented label="Motion" value={d.motion} onChange={(x) => save('display.motion', x)} options={[{ value: 'system', label: 'Follow the system' }, { value: 'reduced', label: 'Reduced' }, { value: 'full', label: 'Full' }]} /></PrefRow>
      <PrefRow id="display.contrast">
        <Segmented label="Status colours" value={d.contrast} onChange={(x) => save('display.contrast', x)} options={[{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High-contrast' }]} />
        <span className="flex gap-2" aria-hidden>
          <Badge variant="outline" className="border-verified/40 text-verified">Verified</Badge>
          <Badge variant="outline" className="border-warning/50 text-warning-foreground">Warning</Badge>
          <Badge variant="outline" className="border-destructive/40 text-destructive">Failing</Badge>
        </span>
      </PrefRow>
    </>
  )
}

// ------------------------------------------------------------------ Formats

const CURRENCIES = [['USD', 'US dollars, as JLCPCB quotes'], ['AUD', 'Australian dollars'], ['EUR', 'Euros'], ['GBP', 'British pounds'], ['JPY', 'Japanese yen'], ['CNY', 'Chinese yuan']]

export function FormatsGroup() {
  const f = usePrefs().formats
  const save = useSave()
  const weekStart = usePrefValue<number>('formats.weekStart', 1)
  const sample = new Date(2026, 9, 27, 14, 5)
  return (
    <>
      <PrefRow id="formats.dates" line={`12 or 24 hour, and the first day of the week. Now: ${sample.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: !!f.hour12 })}.`}>
        <Segmented label="Clock" value={f.hour12 ? '12' : '24'} onChange={(x) => save('formats.hour12', x === '12', { row: 'formats.dates' })} options={[{ value: '24', label: '24 hour' }, { value: '12', label: '12 hour' }]} />
        <Select value={String(weekStart)} onValueChange={(x) => save('formats.weekStart', Number(x), { row: 'formats.dates' })}>
          <SelectTrigger className="w-44" aria-label="First day of the week"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Week starts Monday</SelectItem>
            <SelectItem value="0">Week starts Sunday</SelectItem>
            <SelectItem value="6">Week starts Saturday</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow id="formats.units"><Segmented label="Board dimensions" value={f.units} onChange={(x) => save('formats.units', x)} options={[{ value: 'mm', label: 'Millimetres' }, { value: 'mil', label: 'Mils' }, { value: 'in', label: 'Inches' }]} /></PrefRow>
      <PrefRow id="formats.currency">
        <Select value={f.currency} onValueChange={(x) => save('formats.currency', x)}>
          <SelectTrigger className="w-64" aria-label="Currency for costs"><SelectValue /></SelectTrigger>
          <SelectContent>{CURRENCIES.map(([v, l]) => <SelectItem key={v} value={v!}>{l}</SelectItem>)}</SelectContent>
        </Select>
      </PrefRow>
      <PrefRow id="formats.numbers"><Segmented label="Number style" value={f.numbers} onChange={(x) => save('formats.numbers', x)} options={[{ value: 'engineering', label: 'Engineering (4.7 kΩ)' }, { value: 'plain', label: 'Plain (4,700 Ω)' }]} /></PrefRow>
    </>
  )
}

// ------------------------------------------------------------------ Work

export function WorkGroup() {
  const w = usePrefs().work
  const save = useSave()
  const projects = useProjects()
  const [bench, setBench] = useState(() => readDevice('bench', false))
  const all = (projects.data ?? []).map((p) => p.repo)
  const pinned = w.pinned.filter((r) => all.includes(r))
  const move = (repo: string, by: number) => {
    const i = pinned.indexOf(repo)
    const j = i + by
    if (i < 0 || j < 0 || j >= pinned.length) return
    const next = [...pinned]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    save('work.pinned', next, { row: 'work.home' })
  }
  return (
    <>
      <PrefRow id="work.home">
        <div className="w-full max-w-md space-y-2">
          <ul className="divide-y rounded-lg border">
            {all.map((repo) => {
              const on = pinned.includes(repo)
              return (
                <li key={repo} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Checkbox id={`pin-${repo}`} checked={on} onCheckedChange={(v) => save('work.pinned', v ? [...pinned, repo] : pinned.filter((x) => x !== repo), { row: 'work.home' })} />
                  <Label htmlFor={`pin-${repo}`} className="flex-1 font-normal">{projectName(repo)}</Label>
                  {on && (
                    <span className="flex gap-0.5">
                      <Button size="sm" variant="ghost" className="h-7 px-2" disabled={pinned.indexOf(repo) === 0} onClick={() => move(repo, -1)} aria-label={`Move ${projectName(repo)} up`}>↑</Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2" disabled={pinned.indexOf(repo) === pinned.length - 1} onClick={() => move(repo, 1)} aria-label={`Move ${projectName(repo)} down`}>↓</Button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          <label className="flex items-center gap-2 text-sm"><Switch checked={w.hideFinished} onCheckedChange={(x) => save('work.hideFinished', x, { row: 'work.home' })} aria-label="Hide finished projects" /> Hide finished projects</label>
        </div>
      </PrefRow>
      <PrefRow id="work.start"><Segmented label="Start screen" value={w.start} onChange={(x) => save('work.start', x)} options={[{ value: 'home', label: 'Home' }, { value: 'last', label: 'The last project' }]} /></PrefRow>
      <PrefRow id="work.tour">
        <Button variant="outline" onClick={() => save('work.tourSeen', false, { row: 'work.tour' })}>Show the tour again</Button>
        <span className="text-xs text-muted-foreground">It runs the next time you open a project.</span>
      </PrefRow>
      <PrefRow id="work.shortcuts" line={`${SHORTCUTS.length} shortcuts, such as ${SHORTCUTS[0]!.keys.join(' ')} to search. Changing them is not possible yet.`}>
        <Button variant="outline" onClick={() => shortcutsOpen.set(true)}>View shortcuts</Button>
      </PrefRow>
      <PrefRow id="work.bench" device>
        <Switch checked={bench} onCheckedChange={(x) => { setBench(x); writeDevice('bench', x); document.documentElement.dataset.bench = x ? 'on' : 'off'; markSaved('work.bench') }} aria-label="Bench mode on this device" />
      </PrefRow>
    </>
  )
}

// ------------------------------------------------------------------ Your data

export function DataGroup() {
  const retention = usePrefValue<string>('data.chatRetention', 'keep')
  const save = useSave()
  const projects = useProjects()
  const { user } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)

  const download = async () => {
    setBusy('Reading your preferences')
    try {
      const me = await call('me.get', {})
      const out: Record<string, unknown> = { exported: new Date().toISOString(), person: { email: user?.email, sub: user?.sub, class: user?.class }, preferences: me, projects: [] as unknown[] }
      const partial: string[] = []
      for (const p of projects.data ?? []) {
        setBusy(`Reading ${projectName(p.repo)}'s conversations`)
        try {
          const threads = await call('chats.list', { repo: p.repo })
          const full = []
          for (const t of threads) {
            const g = await call('chats.get', { repo: p.repo, id: t.id, limit: 500 })
            const mine = g.messages.filter((m) => m.role === 'user' && (!m.author || m.author === user?.email || m.author === user?.name))
            if (mine.length) full.push({ thread: t.title, id: t.id, messages: g.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, at: m.at, author: m.author, content: m.content })) })
          }
          ;(out.projects as unknown[]).push({ repo: p.repo, threads: full })
        } catch (e) {
          partial.push(`${projectName(p.repo)} (${e instanceof Error ? e.message : String(e)})`)
        }
      }
      out.decisions = 'Decisions you made are kept in each project\'s record (Decisions tab); the API has no read of them by person yet.'
      if (partial.length) out.notIncluded = partial
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `trace-my-data-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000)
      if (partial.length) toast.warning(`Downloaded, without ${partial.join(', ')}.`)
      else toast('Your data is downloaded.')
    } catch (e) {
      toast.error(`Could not make the file: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PrefRow id="data.retention" line="Keep your threads, or delete those you started once they are older than a period. trace applies it to new threads once the API supports deleting them; until then threads are kept.">
        <Select value={retention} onValueChange={(x) => save('data.chatRetention', x, { row: 'data.retention' })}>
          <SelectTrigger className="w-72" aria-label="Chat history"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="keep">Keep</SelectItem>
            <SelectItem value="30">Delete my threads older than 30 days</SelectItem>
            <SelectItem value="90">Delete my threads older than 90 days</SelectItem>
            <SelectItem value="365">Delete my threads older than 365 days</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow id="data.download">
        <Button variant="outline" disabled={!!busy} onClick={() => void download()}>{busy ? <Loader2 className="animate-spin" /> : <Download />} Download my data</Button>
        {busy && <span className="text-xs text-muted-foreground" aria-live="polite">{busy}…</span>}
        <p className="w-full text-xs text-muted-foreground">A JSON file of your preferences and the conversations you took part in, made in this browser.</p>
      </PrefRow>
    </>
  )
}

/** Reset to defaults: the group's stored values go; the defaults apply at once. */
export function useResetGroup() {
  const m = useSetMe()
  return (group: string, onDone?: () => void) => {
    m.mutate({ key: `prefs.${group}`, value: {} }, { onSuccess: () => { toast(`${group.charAt(0).toUpperCase() + group.slice(1)} is back to its defaults.`); onDone?.() } })
  }
}
