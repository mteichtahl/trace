import { describe, expect, it } from 'vitest'
import { GROUPS, SETTINGS, notifyLock, notifyPrefs, searchSettings } from './settings-catalog'

describe('Preferences catalog', () => {
  it('has the nine groups of the design, in order', () => {
    expect(GROUPS.map((g) => g.label)).toEqual(['Profile', 'Sign-in and security', 'Notifications', 'Voice', 'Chat', 'Display', 'Formats', 'Work', 'Your data'])
    for (const g of GROUPS) expect(SETTINGS.some((s) => s.group === g.id)).toBe(true)
  })
  it('finds settings by name, explanation, group or keyword', () => {
    expect(searchSettings('dark').map((s) => s.id)).toContain('display.theme')
    expect(searchSettings('2fa').map((s) => s.id)).toEqual(['security.password'])
    expect(searchSettings('voice speed').map((s) => s.id)).toEqual(['voice.rate'])
  })
  it('keeps spend notifications on in the app for admins', () => {
    expect(notifyLock('spend', 'app', true)).toMatch(/Admins/)
    expect(notifyLock('spend', 'app', false)).toBeNull()
    expect(notifyLock('gate', 'app', true)).toBeNull()
  })
  it('defaults: in app and email on, push off, email after an hour', () => {
    const n = notifyPrefs({ kinds: { gate: { push: true } } })
    expect(n.kinds.gate).toEqual({ app: true, email: true, push: true })
    expect(n.kinds.stuck.push).toBe(false)
    expect(n.emailAfter).toBe('1h')
  })
})
