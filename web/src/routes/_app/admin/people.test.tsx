import { describe, expect, it } from 'vitest'
import { allowedParts, classChangeAllowed, parseEmails } from './people'

describe('People and access rules', () => {
  it('caps the part by the class: a guest can only review', () => {
    expect(allowedParts('guest')).toEqual(['reviewer'])
    expect(allowedParts('user')).toEqual(['contributor', 'reviewer'])
  })
  it('never lets a person remove their own admin class', () => {
    const me = { sub: 'me', class: 'admin' as const }
    expect(classChangeAllowed('me', me, 'user')).toBe(false)
    expect(classChangeAllowed('me', me, 'admin')).toBe(true)
    expect(classChangeAllowed('other', me, 'user')).toBe(true)
  })
  it('takes several addresses separated by commas and flags the bad ones', () => {
    expect(parseEmails('a@x.com, b@y.org a@x.com')).toEqual({ ok: ['a@x.com', 'b@y.org'], bad: [] })
    expect(parseEmails('a@x.com, nope').bad).toEqual(['nope'])
  })
})
