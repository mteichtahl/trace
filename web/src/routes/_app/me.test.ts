import { describe, expect, it } from 'vitest'
import { groupFrom } from './me'

describe('Preferences addresses', () => {
  it('opens the group of the setting ⌘K picked', () => {
    expect(groupFrom({ setting: 'display.theme' })).toBe('display')
    expect(groupFrom({ group: 'voice' })).toBe('voice')
    expect(groupFrom({ group: 'nonsense' })).toBe('profile')
  })
})
