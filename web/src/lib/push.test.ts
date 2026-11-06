import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceLabel, needsHomeScreen, pushState } from './push'

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
}

describe('push on this device', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names the device for the person\'s list', () => {
    expect(deviceLabel(UA.iphone)).toBe('iPhone · Safari')
    expect(deviceLabel(UA.android)).toBe('Android · Chrome')
    expect(deviceLabel(UA.mac)).toBe('Mac · Edge')
  })

  it('on an iPhone in Safari, says trace must be on the Home Screen first', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 })
    expect(needsHomeScreen()).toBe(true)
    expect(await pushState()).toBe('needs-home-screen')
  })

  /** A browser with push, its service worker container recording what is registered. */
  const pushBrowser = (permission: NotificationPermission, register = vi.fn(async () => ({}))) => {
    const reg = { pushManager: { getSubscription: vi.fn(async () => null) } }
    vi.stubGlobal('navigator', { userAgent: UA.android, platform: 'Linux', maxTouchPoints: 5, serviceWorker: { register, ready: Promise.resolve(reg) } })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission, requestPermission: vi.fn(async () => permission) })
    return register
  }

  it('registers the service worker on start, though push was never turned on on this device', async () => {
    localStorage.removeItem('trace.push')
    const register = pushBrowser('default')
    vi.resetModules()
    const { keepFresh } = await import('./push')
    await keepFresh()
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('tries a failed registration again rather than remembering the failure', async () => {
    const register = pushBrowser('default', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({}))
    vi.resetModules()
    const { registerWorker } = await import('./push')
    await expect(registerWorker()).rejects.toThrow('offline')
    await expect(registerWorker()).resolves.toBeDefined()
    expect(register).toHaveBeenCalledTimes(2)
  })

  it('says a browser without push cannot have it', async () => {
    vi.stubGlobal('navigator', { userAgent: UA.android, platform: 'Linux', maxTouchPoints: 5 })
    expect(await pushState()).toBe('unsupported')
  })
})
