import { describe, expect, it } from 'vitest'
import { CONTEXT_VALUE_MAX, contextValue } from './context'

describe('contextValue', () => {
  it('passes strings through and turns objects into JSON', () => {
    expect(contextValue('hello')).toBe('hello')
    expect(contextValue({ a: 1 })).toBe('{"a":1}')
  })
  it('cuts a value past the limit short, says so, and stays within it', () => {
    const big = { statements: Array.from({ length: 2000 }, (_, i) => ({ id: `I-${i}`, words: 'x'.repeat(80) })) }
    const out = contextValue(big)
    expect(out.length).toBeLessThanOrEqual(CONTEXT_VALUE_MAX)
    expect(out).toMatch(/cut short: \d+ more characters not shown\]$/)
  })
  it('honours a smaller limit', () => {
    expect(contextValue('y'.repeat(500), 100).length).toBe(100)
  })
})
