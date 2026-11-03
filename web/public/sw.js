/*
 * trace's service worker: push notifications only (docs/push.md). It caches nothing, so the app always loads fresh.
 *
 * A push carries JSON from the server's push sender: { id, kind, title, body, url, tag }. It is shown as a
 * notification whose tap opens (or focuses) trace on that item's card. When the browser drops the subscription, the
 * app subscribes again the next time it opens (web/src/lib/push.ts keepFresh).
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
          // the window moves to the card (the app's router takes it from the address)
          if ('navigate' in c) {
            const moved = await c.navigate(target).catch(() => null)
            if (moved) return
          }
          c.postMessage({ type: 'trace.open', url: target })
          return
        }
      }
      await self.clients.openWindow(target)
    })(),
  )
})

// the browser dropped or renewed the subscription: the app subscribes again the next time it opens
// (web/src/lib/push.ts keepFresh), signed in as the person; nothing is sent from here, which has no sign-in
self.addEventListener('pushsubscriptionchange', () => undefined)
