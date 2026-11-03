import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFY, isQuiet, localTime, notifyPrefs, wantsPush } from '../../src/core/notify-prefs.js'

describe('notification preferences on the server', () => {
  it('merges what the app saved over the same defaults the app has, and ignores anything malformed', () => {
    expect(notifyPrefs({})).toEqual(DEFAULT_NOTIFY)
    const p = notifyPrefs({ notifications: { kinds: { gate: { push: true }, question: { push: 'yes' } }, quiet: { on: true, from: '25:00', days: [1, 9] }, projects: { 'Acme/Board': 'gates-spend', x: 'loud' } } })
    expect(p.kinds.gate).toEqual({ app: true, email: true, push: true })
    expect(p.kinds.question.push).toBe(false)
    expect(p.quiet).toEqual({ on: true, from: '19:00', to: '07:00', days: [1] })
    expect(p.projects).toEqual({ 'acme/board': 'gates-spend' })
  })

  it('a project on gates and spend pushes only those', () => {
    const p = notifyPrefs({ notifications: { kinds: { gate: { push: true }, question: { push: true } }, projects: { 'acme/board': 'gates-spend' } } })
    expect(wantsPush(p, 'gate', 'acme/board')).toBe(true)
    expect(wantsPush(p, 'question', 'acme/board')).toBe(false)
    expect(wantsPush(p, 'question', 'acme/other')).toBe(true)
    expect(wantsPush(p, 'spend', 'acme/other')).toBe(false)
  })

  it('reads the clock in the device\'s own zone', () => {
    // 2026-11-03 is a Tuesday; 11:30 UTC is 22:30 in Melbourne (daylight time)
    expect(localTime(Date.parse('2026-11-03T11:30:00Z'), 'Australia/Melbourne')).toEqual({ day: 2, minutes: 22 * 60 + 30 })
    expect(localTime(Date.parse('2026-11-03T11:30:00Z'), 'Not/AZone')).toEqual({ day: 2, minutes: 11 * 60 + 30 })
  })

  it('quiet hours past midnight belong to the day they start', () => {
    const q = { on: true, from: '19:00', to: '07:00', days: [5] } // Fridays
    const mel = (iso: string) => isQuiet(q, Date.parse(iso), 'Australia/Melbourne')
    expect(mel('2026-11-06T09:00:00Z')).toBe(true)   // Friday 20:00
    expect(mel('2026-11-06T18:00:00Z')).toBe(true)   // Saturday 05:00, Friday's night
    expect(mel('2026-11-06T21:00:00Z')).toBe(false)  // Saturday 08:00
    expect(mel('2026-11-05T09:00:00Z')).toBe(false)  // Thursday 20:00
    expect(isQuiet({ ...q, on: false }, Date.parse('2026-11-06T09:00:00Z'), 'Australia/Melbourne')).toBe(false)
    expect(isQuiet({ on: true, from: '12:00', to: '14:00', days: [2] }, Date.parse('2026-11-03T02:30:00Z'), 'Australia/Melbourne')).toBe(true) // Tuesday 13:30
  })
})
