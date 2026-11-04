# Push notifications

trace can tap a person on the shoulder when something needs them: a gate is ready to sign, a question is holding up work, money is about to be spent, or an agent is stuck. Each notification opens straight on its card, so most things are answered from the lock screen in a tap or two. It also says when a revision's renders are ready (`renders`), which opens the project's Renders tab: news rather than a request, so it is never emailed by default and leaves Next once the person opens the renders.

Push is standard Web Push. It works in Chrome, Edge and Firefox on desktop and Android, and in Safari on macOS. On an iPhone or iPad, trace must first be added to the Home Screen (Share, then Add to Home Screen) and opened from there. That is Apple's rule for web apps, and the app explains it when it applies.

## For people using trace

- **Turning it on.** After a person answers something in one tap, trace offers notifications once on that device. People can also turn them on any time in Preferences, Notifications, by switching on Push for a kind.
- **What is pushed.** Exactly what Next shows that person, of the four kinds above, on each of their projects. Changes to review are not pushed; they are in Next.
- **Once.** Each item is pushed once per person. A gate that becomes ready again within 30 days is not pushed again; it is in Next.
- **Quiet hours.** Set in Preferences, on each device's own clock. Nothing is pushed in them. An item still waiting afterwards is pushed at the project's next change.
- **Per project.** A project set to "gates and spend" pushes only those.
- **Turning it off.** Switch Push off in Preferences, or block notifications in the browser's site settings.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| Service worker | `web/public/sw.js` | Shows a push as a notification. A tap opens or focuses trace on the item. It caches nothing. |
| Manifest and icons | `web/public/manifest.webmanifest` | Make trace installable, which iPhone push needs. |
| Device subscriptions | `src/core/push-subscriptions.ts` | One row per browser, in the access store beside preferences: endpoint, keys, time zone, label. At most 10 per person. |
| API | `src/api/actions-push.ts`, `src/web/push-routes.ts` | `push.subscribe`, `push.unsubscribe`, `push.devices` (always the asker's own devices), and `GET /api/push/key` for the public key. |
| Key pair | Secrets Manager `<prefix>/web/push-keys` | Made by the web backend the first time any app asks for it (`src/web/push-keys.ts`), then never changed. No installer step, so an installation that updates itself gets push with its next deploy. |
| Sender | `src/web/push-sender.ts`, run by `<prefix>-journey-events` | On every write of a project's journey record or its agents' facts: works out what Next shows each subscribed person, and pushes what is new. |
| Ledger | DynamoDB `<prefix>-web-push` | What was pushed to whom (30 days), and devices the push service says are gone (90 days). Expires by TTL. |
| Protocol | `src/web/web-push.ts` | RFC 8291 encryption and RFC 8292 identification, on Node's own crypto. No library. |

**What leaves the installation.** Each message holds the project's name, the kind, and the item's summary as Next shows it. It is encrypted end to end to the device, so the push service (Apple, Google or Mozilla) sees only ciphertext. Live events in the app stay as they were, with fixed lines and no project content.

**When a device goes away.** The push service answers 404 or 410. The ledger marks that device dead and stops using it. A browser that subscribes again gets a new endpoint. When the browser drops a subscription by itself, the app subscribes again the next time it opens (`keepFresh` in `web/src/lib/push.ts`).

**Failures.** A push service that answers 429 or 5xx gets the item retried at the project's next change. A failure never stops live events.

## Operating it

- **Logs.** The `<prefix>-journey-events` log group records an `event: "push"` line whenever something was sent, refused or gone, plus warnings when the keys cannot be read.
- **Rotating the keys.** Delete the secret `<prefix>/web/push-keys`. The next app that asks makes a new pair. Each device then subscribes again with the new key the next time its app opens; until then its pushes are refused and logged. Rotate only if the private key may have leaked.
