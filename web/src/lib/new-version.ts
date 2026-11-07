/**
 * After a deploy, a tab opened before it still runs the old app, whose pages load their code from files the new build
 * replaced (test-esp32 #216: "Failed to fetch dynamically imported module …/assets/_app-D--0zeBw.js" when the Build page
 * was opened). Such a failure is a new version, not a fault: the tab reloads itself once to the same address, which
 * loads the new app. A reload that did not cure it (within RELOAD_GUARD_MS of the last one) is not tried again, so a
 * tab never reloads in a loop: the page says a new version is ready, with a Reload button.
 */

/** How long after a reload of ours another chunk failure counts as the same one (no second reload). */
export const RELOAD_GUARD_MS = 60_000

/** Where the time of the last reload is kept: this tab only. */
export const RELOAD_KEY = 'trace.new-version-reload'

/** What the page says when the reload did not bring the new version. */
export const NEW_VERSION = 'A new version of trace is ready. Reload to use it.'

/** True for the browsers' words for a page's code that could not be fetched (Chrome, Firefox, Safari) and Vite's. */
export function isChunkLoadError(e: unknown): boolean {
  if (!e) return false
  const name = typeof e === 'object' ? String((e as { name?: unknown }).name ?? '') : ''
  const msg = e instanceof Error ? e.message : typeof e === 'object' ? String((e as { message?: unknown }).message ?? '') : String(e)
  if (name === 'ChunkLoadError') return true
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i.test(msg)
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

const session = (): Store | null => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Set once this page has asked for its reload. */
let reloading = false

/**
 * Reload this tab to the same address once for a chunk that failed to load. True when it reloads; false when a reload
 * of ours was less than RELOAD_GUARD_MS ago (or this tab cannot keep the time, so it could not tell), and the page
 * should say a new version is ready instead.
 */
export function reloadOnce(o: { store?: Store | null; now?: number; reload?: () => void } = {}): boolean {
  // asked again while this tab is already reloading (a second failure, React's double effects in development)
  if (reloading) return true
  const store = o.store === undefined ? session() : o.store
  const now = o.now ?? Date.now()
  if (!store) return false
  try {
    const last = Number(store.getItem(RELOAD_KEY) ?? 0)
    if (last && now - last < RELOAD_GUARD_MS) return false
    store.setItem(RELOAD_KEY, String(now))
  } catch {
    return false
  }
  reloading = true
  ;(o.reload ?? (() => window.location.reload()))()
  return true
}

/** For tests: forget a reload asked for in this page. */
export const resetReloading = (): void => { reloading = false }

/**
 * Vite's own event for a page's code (or its styles) that failed to preload: reload once instead of failing. When a
 * reload already happened, the failure goes on to the router's error page, which says a new version is ready.
 */
export function listenForNewVersion(target: Pick<Window, 'addEventListener'> = window, o: Parameters<typeof reloadOnce>[0] = {}): void {
  target.addEventListener('vite:preloadError', (ev) => {
    if (reloadOnce(o)) ev.preventDefault()
  })
}
