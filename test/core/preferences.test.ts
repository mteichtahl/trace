import { describe, expect, it } from 'vitest'
import { MAX_PREFERENCES_BYTES, getPath, getPreferences, setPath, setPreference, unsetPath } from '../../src/core/preferences.js'

describe('preference paths', () => {
  it('set, get and unset dotted keys without touching the original', () => {
    const a = { display: { theme: 'dark' } }
    const b = setPath(a, 'views.requirements.columns', ['id', 'text'])
    expect(a).toEqual({ display: { theme: 'dark' } })
    expect(getPath(b, 'views.requirements.columns')).toEqual(['id', 'text'])
    expect(getPath(b, 'display.missing')).toBeUndefined()
    const c = unsetPath(b, 'views.requirements.columns')
    expect(c).toEqual({ doc: { display: { theme: 'dark' } }, removed: true })
    expect(unsetPath(c.doc, 'nope.here').removed).toBe(false)
    expect(setPath({ display: 'flat' }, 'display.theme', 'light')).toEqual({ display: { theme: 'light' } })
  })
})

describe('a person\'s preferences', () => {
  it('are their own, set one key at a time, and kept to 64 KB', async () => {
    expect((await getPreferences('p1')).preferences).toEqual({})
    const r = await setPreference('p1', { key: 'display.theme', value: 'dark' })
    expect(r).toMatchObject({ changed: true, preferences: { display: { theme: 'dark' } }, limit: MAX_PREFERENCES_BYTES })
    expect((await setPreference('p1', { key: 'display.theme', value: 'dark' })).changed).toBe(false)
    await setPreference('p1', { key: 'voice.rate', value: 1.25 })
    expect((await getPreferences('p2')).preferences).toEqual({})
    expect((await getPreferences('p1')).preferences).toEqual({ display: { theme: 'dark' }, voice: { rate: 1.25 } })
    expect((await setPreference('p1', { key: 'voice.rate', unset: true })).preferences).toEqual({ display: { theme: 'dark' } })
    await expect(setPreference('p1', { key: 'views.big', value: 'x'.repeat(70_000) })).rejects.toThrow(/at most 64 KB/)
    await expect(setPreference('p1', { key: '__proto__.x', value: 1 })).rejects.toThrow()
    await expect(setPreference('p1', { key: 'a' })).rejects.toThrow(/give a value/)
    expect((await getPreferences('p1')).preferences).toEqual({ display: { theme: 'dark' } })
  })
})
