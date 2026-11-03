/*
 * trace's service worker: push notifications only (docs/push.md). It caches nothing, so the app always loads fresh.
 *
 * A push carries JSON from the server's push sender: { id, kind, title, body, url, tag }. It is shown as a
 * notification whose tap opens (or focuses) trace on that item's card. When the server rotates its push key or the
 * browser drops the subscription, `pushsubscriptionchange` re-subscribes and tells the server.
 */
/* eslint-disable no-restricted-globals */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'trace'
  const options = {
    body: data.body || 'Something needs you.',
    // the same item replaces its earlier notification rather than stacking
    tag: data.tag || data.id || undefined,
    renotify: !!data.tag,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    data: { url: data.url || '/next', id: data.id || null },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/next', self.location.origin).href
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // a trace window already open: take it to the card rather than opening another
      for (const c of open) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          await c.focus()
          if ('navigate' in c) await c.navigate(target).catch(() => c.postMessage({ type: 'trace.open', url: target }))
          return
        }
      }
      await self.clients.openWindow(target)
    })(),
  )
})

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      // the page stored the server's public key when it subscribed; without it the page re-subscribes on next open
      const cache = await caches.open('trace-push')
      const res = await cache.match('/__trace_push_key')
      if (!res) return
      const key = await res.text()
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) })
      await fetch('/api/push/resubscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ old: event.oldSubscription ? event.oldSubscription.endpoint : null, subscription: sub.toJSON() }),
      }).catch(() => undefined)
    })(),
  )
})

function urlB64(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}
