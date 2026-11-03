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

  it('says a browser without push cannot have it', async () => {
    vi.stubGlobal('navigator', { userAgent: UA.android, platform: 'Linux', maxTouchPoints: 5 })
    expect(await pushState()).toBe('unsupported')
  })
})
