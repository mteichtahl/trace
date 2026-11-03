/**
 * Push notifications on this device (docs/push.md): the service worker (public/sw.js), the browser's permission and
 * subscription, and the server's side (GET /api/push/key, src/web/push-routes.ts; push.subscribe and push.unsubscribe,
 * src/api/actions-push.ts).
 *
 *   support    the browser has service workers, PushManager and Notification. On an iPhone or iPad, only once trace
 *              is added to the Home Screen and opened from there (Safari's rule): `needsHomeScreen` says so, and the
 *              app tells the person how
 *   turnOn     asks permission (only ever from a tap: browsers refuse otherwise), subscribes with the installation's
 *              public key, and tells the server this device (its time zone for quiet hours, a short label)
 *   turnOff    unsubscribes this device, here and on the server
 *   keepFresh  on every start: when permission is granted and this device should be subscribed but the browser
 *              dropped it (or the key changed), subscribes again, quietly
 *
 * Whether a kind is pushed at all is a preference (notifications.kinds.<kind>.push): the caller sets those.
 */
import { api, call } from './api'

export type PushState = 'unsupported' | 'needs-home-screen' | 'denied' | 'off' | 'on'

const LOCAL = 'trace.push'

const isIos = (): boolean => typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const standalone = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)

export const pushSupported = (): boolean =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/** An iPhone or iPad in Safari, not opened from the Home Screen: push needs trace added there first. */
export const needsHomeScreen = (): boolean => isIos() && !standalone()

/** A short name for this device, for the person's list of devices ("iPhone · Safari"). */
export function deviceLabel(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'This device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'
  return `${device} · ${browser}`
}

const b64ToBytes = (s: string): Uint8Array => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
const sameKey = (a: ArrayBuffer | null | undefined, key: string): boolean => {
  if (!a) return false
  const x = new Uint8Array(a)
  const y = b64ToBytes(key)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

let registration: Promise<ServiceWorkerRegistration> | null = null
/** The service worker, registered once (it caches nothing: the app always loads fresh). */
export function registerWorker(): Promise<ServiceWorkerRegistration> | null {
  if (!pushSupported() || import.meta.env.VITE_MOCK === '1' && !import.meta.env.VITE_PUSH_IN_MOCK) return null
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready)
  return registration
}

/** Where push stands on this device. */
export async function pushState(): Promise<PushState> {
  if (needsHomeScreen()) return 'needs-home-screen'
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  const reg = await registerWorker()
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/** Ask, subscribe, and tell the server. Call from a tap. Answers the state it ends in. */
export async function turnOn(): Promise<PushState> {
  if (needsHomeScreen()) return 'needs-home-screen'
  if (!pushSupported()) return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const reg = await registerWorker()
  if (!reg) return 'unsupported'
  const { publicKey } = await api<{ publicKey: string | null }>('/api/push/key')
  if (!publicKey) throw new Error('Push is not set up on this installation yet.')
  let sub = await reg.pushManager.getSubscription()
  // subscribed with another key (the installation's was made again): start over
  if (sub && !sameKey(sub.options.applicationServerKey, publicKey)) {
    await sub.unsubscribe().catch(() => undefined)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) as BufferSource })
  await call('push.subscribe', { subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null, label: deviceLabel() })
  try { localStorage.setItem(LOCAL, 'on') } catch { /* private mode: keepFresh just does nothing */ }
  return 'on'
}

/** Unsubscribe this device, here and on the server. */
export async function turnOff(): Promise<PushState> {
  try { localStorage.setItem(LOCAL, 'off') } catch { /* nothing to remember */ }
  const reg = await registerWorker()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await call('push.unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined)
    await sub.unsubscribe().catch(() => undefined)
  }
  return 'off'
}

/** On start: re-subscribe quietly when this device was on and the browser dropped it. Never asks permission. */
export async function keepFresh(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted' || localStorage.getItem(LOCAL) !== 'on') return
    await turnOn()
  } catch {
    /* tried again on the next start */
  }
}
