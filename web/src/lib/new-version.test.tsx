/**
 * After a deploy, an open tab's page whose code is gone (test-esp32 #216) reloads the tab once to the same address; a
 * failure soon after that reload says a new version is ready instead of reloading again, and never the router's bare
 * "Something went wrong!".
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEW_VERSION, RELOAD_GUARD_MS, RELOAD_KEY, isChunkLoadError, listenForNewVersion, reloadOnce, resetReloading } from './new-version'

vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: vi.fn() }) }))
const { RouteError } = await import('@/components/route-error')

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}
const CHUNK = new TypeError('Failed to fetch dynamically imported module: https://trace.example/assets/_app-D--0zeBw.js')

beforeEach(() => { resetReloading(); try { sessionStorage.clear() } catch { /* none */ } })
afterEach(() => { vi.restoreAllMocks() })

describe('a page whose code a deploy replaced', () => {
  it('is told from other failures, in every browser\'s words', () => {
    expect(isChunkLoadError(CHUNK)).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true)
    expect(isChunkLoadError(new Error('Could not load this project'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })

  it('reloads once; a second failure soon after that reload does not reload again', () => {
    const store = memory()
    const reload = vi.fn()
    expect(reloadOnce({ store, now: 1_000, reload })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(store.m.get(RELOAD_KEY)).toBe('1000')
    // the new page loaded, and failed again within the guard: no loop
    resetReloading()
    expect(reloadOnce({ store, now: 1_000 + RELOAD_GUARD_MS - 1, reload })).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
    // a later deploy, long after: reloads again
    expect(reloadOnce({ store, now: 1_000 + RELOAD_GUARD_MS + 1, reload })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('a tab that cannot keep the time (storage blocked) never reloads on its own', () => {
    const reload = vi.fn()
    expect(reloadOnce({ store: null, reload })).toBe(false)
    const throws = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(reloadOnce({ store: throws, reload })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('Vite\'s preload failure reloads once instead of failing', () => {
    const listeners: Record<string, (e: Event) => void> = {}
    const reload = vi.fn()
    listenForNewVersion({ addEventListener: ((t: string, f: (e: Event) => void) => { listeners[t] = f }) as never }, { store: memory(), reload })
    const ev = new Event('vite:preloadError', { cancelable: true })
    listeners['vite:preloadError']!(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('the router\'s error page', () => {
  it('a chunk failure after a reload already happened says a new version is ready, with Reload', async () => {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    render(<RouteError error={CHUNK} reset={() => {}} />)
    expect(await screen.findByText((t) => t.startsWith(NEW_VERSION))).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy()
    expect(screen.queryByText(/Something went wrong/)).toBeNull()
  })

  it('anything else is said in words, with Try again', () => {
    render(<RouteError error={new Error('boom')} reset={() => {}} />)
    expect(screen.getByText('This page could not be shown.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy()
  })
})
